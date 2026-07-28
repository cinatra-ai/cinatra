#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Cinatra WordPress dev container entrypoint wrapper — pinned MCP gateway fixture
# (#2016 S1).
#
# Runs BEFORE the official wordpress image's docker-entrypoint.sh, then
# backgrounds a watcher that waits for core files + DB, runs `wp core install`
# if needed, ENSURES the pinned MCP plugins (mcp-adapter + enable-abilities-for-mcp)
# are present, and activates: mcp-adapter, the fixture third-party plugin,
# enable-abilities-for-mcp, and cinatra. Finally exec's the original
# docker-entrypoint.sh so Apache boots normally.
#
# WP 6.9 ships the WordPress Abilities API in CORE (wp_register_ability() is
# always loaded before plugins), so the separate WordPress/abilities-api plugin
# is DROPPED — and with it the old "abilities-api MUST activate before
# mcp-adapter" ordering constraint. Abilities/servers register per-request on the
# `wp_abilities_api_init` / `mcp_adapter_init` actions.
#
# BOOT SPEED (#260 Step 6): the cinatra dev image (docker/wordpress/Dockerfile)
# BAKES git/wp-cli + the pinned plugins at build time into the /usr/src/wordpress
# staging tree. On a fresh volume the official entrypoint tars them into
# /var/www/html, so by the time this watcher runs the plugins already exist —
# install_tools + ensure_* below are then fast no-ops (guarded on what already
# exists). The ensure_* fetch-if-missing/repair-if-incomplete path is the
# FALLBACK for (a) warm named volumes created before this image existed (the bake
# never reaches an already-populated volume), and (b) the stock `wordpress:`
# image if someone runs compose without building. It is idempotent: a complete
# plugin dir is left untouched; an incomplete/absent dir is re-fetched from the
# pinned, checksummed release ZIP.
# -----------------------------------------------------------------------------

# Pinned third-party artifacts. Versions are bare (no leading "v"); the release
# URL is derived as v<version>. This keeps the source-leak-gate
# SLG_MILESTONE_VERSION rule (net-new vX.Y.Z literals read as internal milestone
# markers) from tripping on third-party release pins, while preserving *_URL /
# *_SHA256 overrides. The version + sha256 values MUST equal
# docker/wordpress/pins.lock (scripts/audit/wordpress-fixture-pins-gate.mjs
# enforces lockstep). The Dockerfile bakes these; this is the warm-volume /
# stock-image fallback that resolves the identical, checksum-verified artifact.
MCP_ADAPTER_VERSION="${MCP_ADAPTER_VERSION:-0.5.0}"
MCP_ADAPTER_SHA256="${MCP_ADAPTER_SHA256:-a13f253c7bf4314b6cce7e238be2d5857eee66242bfe5ff5cb5576f74dc41593}"
MCP_ADAPTER_URL="${MCP_ADAPTER_URL:-https://github.com/WordPress/mcp-adapter/releases/download/v${MCP_ADAPTER_VERSION}/mcp-adapter.zip}"
# enable-abilities-for-mcp exposes WP-core `ewpa/*` + registered abilities as MCP
# tools; the WordPress.org distribution ships built (no vendor tree required).
EAFM_VERSION="${EAFM_VERSION:-2.0.20}"
EAFM_SHA256="${EAFM_SHA256:-5c3a2b287c73d85503e5118957475fbec598c548f50bc873f05f0293a131553a}"
EAFM_URL="${EAFM_URL:-https://downloads.wordpress.org/plugin/enable-abilities-for-mcp.${EAFM_VERSION}.zip}"
# wp-cli pinned to a tagged release + sha256 (was the unpinned builds channel).
WP_CLI_VERSION="${WP_CLI_VERSION:-2.12.0}"
WP_CLI_SHA256="${WP_CLI_SHA256:-ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c}"
WP_CLI_URL="${WP_CLI_URL:-https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar}"

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
EAFM_DIR="$PLUGINS_DIR/enable-abilities-for-mcp"

log() { printf "[cinatra-wp] %s\n" "$*"; }

install_tools() {
  # Install wp-cli, git, unzip if missing. apt updates on first boot of a fresh
  # container (not volume — these live in the image layer).
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

  if ! command -v wp >/dev/null 2>&1; then
    log "Installing pinned wp-cli ${WP_CLI_VERSION}..."
    curl -fsSLo /usr/local/bin/wp "$WP_CLI_URL"
    echo "${WP_CLI_SHA256}  /usr/local/bin/wp" | sha256sum -c -
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

configure_permalinks() {
  # WordPress serves pretty /wp-json/ REST URLs only when a NON-plain permalink
  # structure is active. A fresh `wp core install` defaults to PLAIN, so
  # /wp-json/mcp/mcp-adapter-default-server 301-redirects (canonical) instead of
  # routing to the REST API — the MCP adapter route is then unreachable at its
  # pretty URL. (The widget uat-gate only avoided this because the cinatra
  # companion plugin flushed rewrites; the light capture boot has no cinatra
  # plugin, so the entrypoint must set the structure itself.) Idempotent + safe
  # for every consumer of this entrypoint.
  log "Configuring pretty permalinks (so /wp-json/ REST routes serve)..."
  wp --path="$WP_PATH" --allow-root rewrite structure '/%postname%/' --hard \
    >/dev/null 2>&1 || log "WARN: rewrite structure failed"
  wp --path="$WP_PATH" --allow-root rewrite flush --hard \
    >/dev/null 2>&1 || log "WARN: rewrite flush failed"
}

plugin_is_complete() {
  # Completeness signal for a baked/copied/fetched plugin dir. A dir is COMPLETE
  # when its main plugin file exists AND (if it needs a composer vendor tree)
  # vendor/autoload.php exists. A baked image may strip provenance, and an
  # interrupted fetch can leave a partial dir. Args: <dir> <main-file-basename>
  # <needs-vendor:0|1>.
  local dir="$1" main_file="$2" needs_vendor="$3"
  [ -f "$dir/$main_file" ] || return 1
  if [ "$needs_vendor" = "1" ] && [ ! -f "$dir/vendor/autoload.php" ]; then
    return 1
  fi
  return 0
}

ensure_plugin() {
  # Idempotent ensure-at-pinned-artifact via a checksummed release ZIP. FAST-PATH:
  # when the cinatra dev image baked the plugin, the official entrypoint has
  # already copied a COMPLETE dir into the volume, so we skip without any network
  # call. FALLBACK (warm pre-bake volume, or stock `wordpress:` image): download
  # the pinned ZIP, verify sha256 (fail-closed), unzip, and — only when the ZIP
  # does NOT bundle a vendor tree AND one is required — run composer install. An
  # incomplete/absent dir is removed and re-fetched.
  #
  # Args: <name> <dir> <url> <sha256> <main-file-basename> <needs-vendor:0|1> <bundles-vendor:0|1>
  local name="$1" dir="$2" url="$3" sha256="$4" main_file="$5" needs_vendor="$6" bundles_vendor="$7"

  if plugin_is_complete "$dir" "$main_file" "$needs_vendor"; then
    log "$name complete (baked/warm), skipping fetch."
    return 0
  fi

  log "$name incomplete or absent — fetching pinned ZIP $url ..."
  local tmpzip tmpdir inner
  tmpzip="$(mktemp)"
  tmpdir="$(mktemp -d)"
  curl -fsSLo "$tmpzip" "$url"
  # Fail-closed checksum verification (the authoritative remote-artifact check
  # also runs in the Dockerfile bake; this covers the fallback path). The
  # existing dir is only replaced AFTER download + checksum + unzip succeed, so
  # a failed fetch leaves any partially-usable plugin tree in place.
  echo "${sha256}  ${tmpzip}" | sha256sum -c -
  unzip -q "$tmpzip" -d "$tmpdir"
  # The release ZIP contains a single top-level plugin dir; move it into place so
  # the target slug is correct regardless of the archive's inner dir name.
  inner="$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  if [ -z "$inner" ]; then
    log "ERROR: $name ZIP contained no top-level directory — leaving existing tree untouched."
    rm -rf "$tmpzip" "$tmpdir"
    return 1
  fi
  rm -rf "$dir"
  mv "$inner" "$dir"
  rm -rf "$tmpzip" "$tmpdir"

  if [ "$needs_vendor" = "1" ] && [ "$bundles_vendor" != "1" ] && [ ! -f "$dir/vendor/autoload.php" ]; then
    log "Running composer install inside $name (ZIP did not bundle vendor)..."
    # --prefer-dist (zip, no per-package git clones), --no-scripts (no install-event
    # scripts at these pins). (No --no-audit: `composer install` runs no audit by
    # default and rejects the flag — it is update/require-only.)
    (cd "$dir" && COMPOSER_ALLOW_SUPERUSER=1 composer install \
      --no-dev --no-interaction --no-progress --prefer-dist --no-scripts)
  fi

  chown -R www-data:www-data "$dir"
}

ensure_mcp_adapter() {
  # mcp-adapter's Autoloader fatals if vendor/autoload.php is missing, so vendor
  # IS required — needs_vendor=1. The 0.5.0 release ZIP bundles vendor/autoload.php
  # (pins.lock mcpAdapter.bundlesVendor=true), so bundles_vendor=1 → no composer.
  ensure_plugin "mcp-adapter" "$ADAPTER_DIR" \
    "$MCP_ADAPTER_URL" "$MCP_ADAPTER_SHA256" \
    "mcp-adapter.php" "1" "1"
}

ensure_enable_abilities_for_mcp() {
  # enable-abilities-for-mcp loads its includes directly (no vendor tree needed —
  # needs_vendor=0); the WordPress.org distribution ships built (bundles_vendor=1).
  ensure_plugin "enable-abilities-for-mcp" "$EAFM_DIR" \
    "$EAFM_URL" "$EAFM_SHA256" \
    "enable-abilities-for-mcp.php" "0" "1"
}

activate_plugins() {
  log "Activating mcp-adapter + fixture-thirdparty-mcp + scale-smoke-plugin + enable-abilities-for-mcp + cinatra..."
  # Deterministic order (WP 6.9 core Abilities API is always loaded before
  # plugins, so there is no abilities-api-before-adapter constraint):
  #   1. mcp-adapter                — MCP server infrastructure / route factory
  #   2. fixture-thirdparty-mcp     — registers fixturelabs/* abilities + a
  #                                    dedicated MCP server (activated BEFORE eafm
  #                                    so its abilities pre-exist regardless of
  #                                    eafm's discovery lifecycle — #2016 S1)
  #   3. scale-smoke-plugin         — registers scalesmoke/* read abilities + its
  #                                    own dedicated first-class MCP server
  #                                    (activated BEFORE eafm for the same reason;
  #                                    cinatra#2019 provider-scale proof)
  #   4. enable-abilities-for-mcp   — exposes WP-core + registered abilities as MCP tools
  #   5. cinatra                    — companion glue (bind-mounted)
  # Activate individually so one failure doesn't block the rest; log result.
  wp --path="$WP_PATH" --allow-root plugin activate mcp-adapter 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate fixture-thirdparty-mcp 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate scale-smoke-plugin 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate enable-abilities-for-mcp 2>&1 \
    | grep -v "already active" || true
  wp --path="$WP_PATH" --allow-root plugin activate cinatra 2>&1 \
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
  configure_permalinks || log "WARN: permalink config failed"
  ensure_mcp_adapter || log "WARN: mcp-adapter ensure failed"
  ensure_enable_abilities_for_mcp || log "WARN: enable-abilities-for-mcp ensure failed"
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
