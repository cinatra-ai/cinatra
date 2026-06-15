#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Cinatra WordPress dev container entrypoint wrapper.
#
# Runs BEFORE the official wordpress image's docker-entrypoint.sh. Installs
# wp-cli + git + composer (idempotent), then backgrounds a watcher that waits
# for core files + DB, runs `wp core install` if needed, clones the WordPress
# Abilities API + MCP adapter plugins, and activates abilities-api, cinatra, and
# mcp-adapter (abilities-api first — mcp-adapter requires wp_register_ability()).
# Finally exec's the original docker-entrypoint.sh so Apache boots normally.
# -----------------------------------------------------------------------------

# Version pins are bare (no leading "v"); the git tag is derived as v<version>.
# This keeps the source-leak-gate SLG_MILESTONE_VERSION rule (which flags net-new
# vX.Y.Z literals as internal milestone markers) from tripping on third-party
# release pins, while preserving the *_REF override (callers may still pass a
# branch / SHA / full ref via *_REF).
MCP_ADAPTER_VERSION="${MCP_ADAPTER_VERSION:-0.4.1}"
MCP_ADAPTER_REF="${MCP_ADAPTER_REF:-v${MCP_ADAPTER_VERSION}}"
# WordPress/mcp-adapter REQUIRES the WordPress Abilities API (it provides
# wp_register_ability(); without it mcp-adapter's DefaultServerFactory cannot
# create the `mcp/mcp-adapter-default-server` REST route, so /wp-json/mcp 404s
# and the external-MCP toolbox resolves 0 tools). Pin the matching release line.
ABILITIES_API_VERSION="${ABILITIES_API_VERSION:-0.4.0}"
ABILITIES_API_REF="${ABILITIES_API_REF:-v${ABILITIES_API_VERSION}}"
WP_DEV_URL="${WP_DEV_URL:-http://localhost:8080}"
WP_DEV_ADMIN_USER="${WP_DEV_ADMIN_USER:-admin}"
WP_DEV_ADMIN_PASS="${WP_DEV_ADMIN_PASS:-admin}"
WP_DEV_ADMIN_EMAIL="${WP_DEV_ADMIN_EMAIL:-dev@localhost}"

WP_PATH=/var/www/html
PLUGINS_DIR="$WP_PATH/wp-content/plugins"
ADAPTER_DIR="$PLUGINS_DIR/mcp-adapter"
ABILITIES_DIR="$PLUGINS_DIR/abilities-api"

log() { printf "[cinatra-wp] %s\n" "$*"; }

install_tools() {
  # Install wp-cli, git, composer, unzip if missing. apt updates on first boot
  # of a fresh container (not volume — these live in the image layer).
  local need_apt=0
  command -v git >/dev/null 2>&1 || need_apt=1
  command -v unzip >/dev/null 2>&1 || need_apt=1

  if [ "$need_apt" = "1" ]; then
    log "Installing git, unzip via apt-get..."
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git unzip less ca-certificates default-mysql-client >/dev/null
    rm -rf /var/lib/apt/lists/*
  fi

  if ! command -v composer >/dev/null 2>&1; then
    log "Installing composer..."
    curl -sSLf https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
  fi

  if ! command -v wp >/dev/null 2>&1; then
    log "Installing wp-cli..."
    curl -sSLfo /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
    chmod +x /usr/local/bin/wp
  fi
}

wait_for_core_files() {
  log "Waiting for WordPress core files at $WP_PATH/wp-includes/version.php..."
  local tries=0
  while [ ! -f "$WP_PATH/wp-includes/version.php" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      log "ERROR: core files did not appear after 120s, giving up"
      return 1
    fi
    sleep 1
  done
  log "Core files ready."
}

wait_for_config() {
  log "Waiting for wp-config.php (created by official entrypoint)..."
  local tries=0
  while [ ! -f "$WP_PATH/wp-config.php" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 60 ]; then
      log "ERROR: wp-config.php did not appear after 60s"
      return 1
    fi
    sleep 1
  done
  log "wp-config.php ready."
}

wait_for_db() {
  log "Waiting for DB connection..."
  local tries=0
  # Use SELECT 1 — simpler than db check which runs mysqlcheck and fails on empty DB
  while ! wp --path="$WP_PATH" --allow-root db query "SELECT 1" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 60 ]; then
      log "ERROR: DB not reachable after 60s"
      return 1
    fi
    sleep 1
  done
  log "DB reachable."
}

install_wp_core_if_needed() {
  if wp --path="$WP_PATH" --allow-root core is-installed >/dev/null 2>&1; then
    log "WP core already installed, skipping install."
    return 0
  fi
  log "Running wp core install..."
  wp --path="$WP_PATH" --allow-root core install \
    --url="$WP_DEV_URL" \
    --title="Cinatra Dev" \
    --admin_user="$WP_DEV_ADMIN_USER" \
    --admin_password="$WP_DEV_ADMIN_PASS" \
    --admin_email="$WP_DEV_ADMIN_EMAIL" \
    --skip-email
}

install_abilities_api() {
  # WordPress/abilities-api is a hard prerequisite for mcp-adapter (it provides
  # wp_register_ability()). It must be present + activated BEFORE mcp-adapter so
  # the `mcp_adapter_init` action can register the default MCP server route.
  if [ -d "$ABILITIES_DIR/.git" ]; then
    local current_ref
    current_ref=$(git -C "$ABILITIES_DIR" describe --tags --always 2>/dev/null || echo "unknown")
    if [ "$current_ref" = "$ABILITIES_API_REF" ]; then
      log "abilities-api already at $ABILITIES_API_REF, skipping clone."
      return 0
    fi
    log "abilities-api at $current_ref, removing and re-cloning $ABILITIES_API_REF..."
    rm -rf "$ABILITIES_DIR"
  fi

  log "Cloning WordPress/abilities-api@$ABILITIES_API_REF..."
  git -c advice.detachedHead=false clone --depth 1 --branch "$ABILITIES_API_REF" \
    https://github.com/WordPress/abilities-api.git "$ABILITIES_DIR"

  log "Running composer install inside abilities-api..."
  (cd "$ABILITIES_DIR" && composer install --no-dev --no-interaction --no-progress)

  chown -R www-data:www-data "$ABILITIES_DIR"
}

install_mcp_adapter() {
  if [ -d "$ADAPTER_DIR/.git" ]; then
    local current_ref
    current_ref=$(git -C "$ADAPTER_DIR" describe --tags --always 2>/dev/null || echo "unknown")
    if [ "$current_ref" = "$MCP_ADAPTER_REF" ]; then
      log "mcp-adapter already at $MCP_ADAPTER_REF, skipping clone."
      return 0
    fi
    log "mcp-adapter at $current_ref, removing and re-cloning $MCP_ADAPTER_REF..."
    rm -rf "$ADAPTER_DIR"
  fi

  log "Cloning WordPress/mcp-adapter@$MCP_ADAPTER_REF..."
  git -c advice.detachedHead=false clone --depth 1 --branch "$MCP_ADAPTER_REF" \
    https://github.com/WordPress/mcp-adapter.git "$ADAPTER_DIR"

  log "Running composer install inside mcp-adapter..."
  (cd "$ADAPTER_DIR" && composer install --no-dev --no-interaction --no-progress)

  chown -R www-data:www-data "$ADAPTER_DIR"
}

activate_plugins() {
  log "Activating abilities-api + cinatra + mcp-adapter..."
  # Activate individually so one failure doesn't block the other; log result.
  # abilities-api MUST activate before mcp-adapter — mcp-adapter's
  # `mcp_adapter_init` registration needs wp_register_ability() to exist.
  wp --path="$WP_PATH" --allow-root plugin activate abilities-api 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate cinatra 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate mcp-adapter 2>&1 \
    | grep -v "already active" || true
}

SEED_CONTENT_SCRIPT="/opt/cinatra-dev-content/seed-content.php"
SEED_CONTENT_JSON="/opt/cinatra-dev-content/external-instances.dev-content.json"

seed_content() {
  # Seed generic, fictional demo posts/pages (idempotent), layered on top of
  # WordPress core's default Hello-world post + Sample Page. The script +
  # manifest are bind-mounted by docker-compose; skip cleanly if absent.
  if [ ! -f "$SEED_CONTENT_SCRIPT" ]; then
    log "No dev-content seed script at $SEED_CONTENT_SCRIPT — skipping content seed"
    return 0
  fi
  log "Seeding generic dev content via wp eval-file..."
  CINATRA_DEV_CONTENT_JSON="$SEED_CONTENT_JSON" \
    wp --path="$WP_PATH" --allow-root eval-file "$SEED_CONTENT_SCRIPT" \
    || log "WARN: dev content seeding failed (non-fatal)"
}

bootstrap() {
  wait_for_core_files || return 0
  wait_for_config || return 0
  wait_for_db || return 0
  install_wp_core_if_needed || log "WARN: wp core install failed"
  install_abilities_api || log "WARN: abilities-api install failed"
  install_mcp_adapter || log "WARN: mcp-adapter install failed"
  activate_plugins
  seed_content
  log "Bootstrap complete."
}

main() {
  install_tools
  # Run the plugin bootstrap in the background so Apache can start immediately.
  # Output still goes to docker compose logs via stdout.
  bootstrap &
  # Hand off to the official wordpress entrypoint.
  exec docker-entrypoint.sh "$@"
}

main "$@"
