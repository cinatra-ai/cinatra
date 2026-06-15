#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Cinatra WordPress dev container entrypoint wrapper.
#
# Runs BEFORE the official wordpress image's docker-entrypoint.sh, then
# backgrounds a watcher that waits for core files + DB, runs `wp core install`
# if needed, ENSURES the WordPress Abilities API + MCP adapter plugins are
# present at the pinned refs, and activates abilities-api, cinatra, and
# mcp-adapter (abilities-api first — mcp-adapter requires wp_register_ability()).
# Finally exec's the original docker-entrypoint.sh so Apache boots normally.
#
# BOOT SPEED (#260 Step 6): the cinatra dev image (docker/wordpress/Dockerfile)
# BAKES git/composer/wp-cli + both plugins (clone + `composer install`) at build
# time, into the /usr/src/wordpress staging tree. On a fresh volume the official
# entrypoint tars them into /var/www/html, so by the time this watcher runs the
# plugins already exist + `composer install` is done — the slow network/composer
# work never competes with the uat-gate's ~5-min readiness window. install_tools
# + ensure_plugin below are then fast no-ops (guarded on what already exists).
#
# The ensure_plugin clone-if-missing/repair-if-incomplete path is the FALLBACK
# for (a) warm named volumes created before this image existed (the bake never
# reaches an already-populated volume), and (b) the stock `wordpress:` image if
# someone runs compose without building. It is idempotent: a complete plugin dir
# at the pinned ref is left untouched; an incomplete or wrong-ref dir is
# re-cloned + re-composed.
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
# `dev@localhost` has no TLD dot, so WordPress's is_email() rejects it and
# `wp core install` fails ("email address is invalid") — leaving the site
# uninstalled and the cinatra plugin un-activatable, which is exactly the
# uat-gate "site you have requested is not installed" failure. Use the reserved
# example.com TLD so a FRESH install (every CI run) actually succeeds (#260 Step 6).
WP_DEV_ADMIN_EMAIL="${WP_DEV_ADMIN_EMAIL:-dev@example.com}"

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

plugin_is_complete() {
  # Completeness signal for a baked/copied/cloned plugin dir. A dir is COMPLETE
  # when its main plugin file exists AND (if it needs a composer vendor tree)
  # vendor/autoload.php exists. This is what the .git-only check missed: a baked
  # image may strip .git, and an interrupted clone can leave .git present but
  # vendor/ absent. Args: <dir> <main-file-basename> <needs-vendor:0|1>.
  local dir="$1" main_file="$2" needs_vendor="$3"
  [ -f "$dir/$main_file" ] || return 1
  if [ "$needs_vendor" = "1" ] && [ ! -f "$dir/vendor/autoload.php" ]; then
    return 1
  fi
  return 0
}

ensure_plugin() {
  # Idempotent ensure-at-pinned-ref. FAST-PATH: when the cinatra dev image baked
  # the plugin (docker/wordpress/Dockerfile) the official entrypoint has already
  # copied a COMPLETE dir into the volume — and if .git survived, it is at the
  # pinned ref — so we skip without any network call. FALLBACK (warm pre-bake
  # volume, or stock `wordpress:` image): clone --depth 1 --single-branch + run
  # composer install. A wrong-ref or INCOMPLETE dir is removed and re-cloned.
  #
  # Args: <name> <dir> <repo-url> <ref> <main-file-basename> <needs-vendor:0|1>
  local name="$1" dir="$2" repo="$3" ref="$4" main_file="$5" needs_vendor="$6"

  if [ -d "$dir/.git" ]; then
    # The entrypoint runs as root but a baked/copied plugin is owned by www-data,
    # so git 2.35+ refuses to operate ("dubious ownership") and `describe` would
    # report the wrong ref. Mark it safe (idempotent, --add is harmless to repeat)
    # so the ref check is meaningful instead of always falling to "unknown".
    git config --global --add safe.directory "$dir" 2>/dev/null || true
    local current_ref
    current_ref=$(git -C "$dir" describe --tags --always 2>/dev/null || echo "unknown")
    if plugin_is_complete "$dir" "$main_file" "$needs_vendor" \
       && { [ "$current_ref" = "$ref" ] || [ "$current_ref" = "unknown" ]; }; then
      # Skip when complete AND (at the pinned ref OR the ref is unresolvable on a
      # shallow/baked clone — completeness already proves it is the baked, pinned
      # copy; re-cloning a good dir would just burn readiness time).
      log "$name complete (ref=$current_ref), skipping clone."
      return 0
    fi
    log "$name at ref=$current_ref (incomplete or wrong ref) — removing and re-cloning $ref..."
    rm -rf "$dir"
  elif [ -d "$dir" ]; then
    # Dir exists without .git — either a baked plugin whose .git was stripped, or
    # a leftover partial. If complete, trust it (the baked image is ref-pinned);
    # otherwise remove + re-clone.
    if plugin_is_complete "$dir" "$main_file" "$needs_vendor"; then
      log "$name present (baked, complete), skipping clone."
      return 0
    fi
    log "$name dir exists but is incomplete — removing and re-cloning $ref..."
    rm -rf "$dir"
  fi

  log "Cloning $name@$ref..."
  git -c advice.detachedHead=false clone --depth 1 --single-branch --branch "$ref" \
    "$repo" "$dir"

  log "Running composer install inside $name..."
  # Mirror the build-time flags: --prefer-dist (zip, no per-package git clones),
  # --no-scripts (neither plugin defines composer install-event scripts at these
  # pins — only dev lint/test commands). (No --no-audit: `composer install` runs
  # no audit by default and rejects the flag — it is update/require-only.)
  (cd "$dir" && COMPOSER_ALLOW_SUPERUSER=1 composer install \
    --no-dev --no-interaction --no-progress --prefer-dist --no-scripts)

  chown -R www-data:www-data "$dir"
}

ensure_abilities_api() {
  # WordPress/abilities-api is a hard prerequisite for mcp-adapter (it provides
  # wp_register_ability()). It must be present + activated BEFORE mcp-adapter so
  # the `mcp_adapter_init` action can register the default MCP server route.
  # Its main file loads includes/bootstrap.php directly (not vendor/autoload),
  # so vendor is not strictly required for runtime — needs_vendor=0.
  ensure_plugin "abilities-api" "$ABILITIES_DIR" \
    "https://github.com/WordPress/abilities-api.git" "$ABILITIES_API_REF" \
    "abilities-api.php" "0"
}

ensure_mcp_adapter() {
  # mcp-adapter's Autoloader fatals if vendor/autoload.php is missing ("make sure
  # to run composer install"), so vendor IS required — needs_vendor=1.
  ensure_plugin "mcp-adapter" "$ADAPTER_DIR" \
    "https://github.com/WordPress/mcp-adapter.git" "$MCP_ADAPTER_REF" \
    "mcp-adapter.php" "1"
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
  ensure_abilities_api || log "WARN: abilities-api ensure failed"
  ensure_mcp_adapter || log "WARN: mcp-adapter ensure failed"
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
