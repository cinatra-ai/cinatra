#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Cinatra Drupal 11 dev container entrypoint.
#
# Drupal code is pre-installed in the image at /drupal (recommended-project
# layout with web/ subdir). This script only handles runtime configuration:
# waits for MariaDB, runs drush site:install if not yet installed, installs
# drupal/mcp_tools, enables the cinatra module, and creates the Bearer key.
# Apache starts immediately in the foreground; bootstrap runs in background.
#
# SECURITY NOTE: Default admin password is `cinatra` — dev-only.
# -----------------------------------------------------------------------------

DRUPAL_ADMIN_USER="${DRUPAL_ADMIN_USER:-admin}"
DRUPAL_ADMIN_PASS="${DRUPAL_ADMIN_PASS:-cinatra}"
DRUPAL_SITE_URL="${DRUPAL_SITE_URL:-http://localhost:8082}"
CINATRA_BASE_URL="${CINATRA_BASE_URL:-http://localhost:3000}"

# Drupal code lives at /drupal (recommended-project, baked into the image).
DRUPAL_PATH=/drupal
WEB_ROOT="$DRUPAL_PATH/web"
SITES_DIR="$WEB_ROOT/sites/default"

log() { printf "[cinatra-drupal] %s\n" "$*"; }

write_php_opcache_ini() {
  cat > /usr/local/etc/php/conf.d/cinatra-dev.ini <<'EOF'
opcache.revalidate_freq=0
opcache.validate_timestamps=1
EOF
}

wait_for_db() {
  log "Waiting for drupal-db..."
  for i in $(seq 1 60); do
    if mysql -h drupal-db -u drupal -pdrupal -e "SELECT 1" drupal >/dev/null 2>&1; then
      log "drupal-db ready"
      return 0
    fi
    sleep 1
  done
  log "drupal-db never came up"
  return 1
}

install_drupal_if_needed() {
  cd "$DRUPAL_PATH"
  if [ ! -f "$SITES_DIR/settings.php" ] || ! drush --root="$WEB_ROOT" status --field=bootstrap 2>/dev/null | grep -q "Successful"; then
    log "Installing Drupal..."
    drush --root="$WEB_ROOT" site:install standard \
      --db-url=mysql://drupal:drupal@drupal-db/drupal \
      --account-name="$DRUPAL_ADMIN_USER" \
      --account-pass="$DRUPAL_ADMIN_PASS" \
      --site-name="Cinatra Dev Drupal" -y
  else
    log "Drupal already installed"
  fi
}

write_settings_local() {
  if [ ! -f "$SITES_DIR/settings.local.php" ]; then
    cat > "$SITES_DIR/settings.local.php" <<'EOF'
<?php
$settings['cache']['default'] = 'cache.backend.null';
$settings['cache']['bins']['render'] = 'cache.backend.null';
$settings['cache']['bins']['dynamic_page_cache'] = 'cache.backend.null';
$settings['cache']['bins']['page'] = 'cache.backend.null';
$config['system.performance']['css']['preprocess'] = FALSE;
$config['system.performance']['js']['preprocess'] = FALSE;
// Config sync dir is bind-mounted from the repo (docker/drupal/config/sync)
// so module/field/content-type config survives fresh volume resets.
$settings['config_sync_directory'] = '/drupal/config/sync';
EOF
  fi
  if ! grep -q "settings.local.php" "$SITES_DIR/settings.php"; then
    cat >> "$SITES_DIR/settings.php" <<'EOF'

if (file_exists($app_root . '/' . $site_path . '/settings.local.php')) {
  include $app_root . '/' . $site_path . '/settings.local.php';
}
EOF
  fi
  if [ ! -f "$WEB_ROOT/sites/development.services.yml" ]; then
    cat > "$WEB_ROOT/sites/development.services.yml" <<'EOF'
parameters:
  twig.config:
    debug: true
    cache: false
EOF
  fi
}

ensure_content_types() {
  # Drupal 11.4's Standard install profile no longer ships the article/page
  # node types, but the dev fixtures (docker/drupal/seed-content.php) and the
  # wp-drupal UAT seed article/page nodes — and rendering a node whose bundle
  # is missing 500s in core's node preprocess. Create the types (with the
  # standard body field) when absent. Idempotent: existing types (including
  # ones from an older volume or a config:import) are left untouched.
  log "Ensuring article/page content types exist..."
  drush --root="$WEB_ROOT" php:eval '
    // Drupal 11.4 Standard also no longer ships the node `body` FIELD STORAGE
    // (it came with the removed default types) — node_add_body_field() dies
    // with "Attempt to create a field without a field_name" without it.
    if (\Drupal\field\Entity\FieldStorageConfig::loadByName("node", "body") === NULL) {
      \Drupal\field\Entity\FieldStorageConfig::create([
        "field_name" => "body",
        "entity_type" => "node",
        "type" => "text_with_summary",
      ])->save();
      fwrite(STDERR, "[cinatra-drupal] created missing node body field storage\n");
    }
    foreach (["article" => "Article", "page" => "Basic page"] as $type => $name) {
      $node_type = \Drupal\node\Entity\NodeType::load($type);
      if ($node_type === NULL) {
        $node_type = \Drupal\node\Entity\NodeType::create(["type" => $type, "name" => $name]);
        $node_type->save();
        fwrite(STDERR, "[cinatra-drupal] created missing content type: {$type}\n");
      }
      // Idempotent in core (returns the existing field when present), and
      // called unconditionally so a partially-created type self-heals its
      // missing body field on the next boot.
      node_add_body_field($node_type);
    }
  ' || log "WARNING: content-type ensure failed (seeded fixture nodes may not render)"
}

install_german() {
  if ! drush --root="$WEB_ROOT" pm:list --status=enabled --field=name 2>/dev/null | grep -qx "language"; then
    log "Installing language + locale modules..."
    drush --root="$WEB_ROOT" en language locale -y
    drush --root="$WEB_ROOT" language:add de || log "WARNING: German language add failed (may already exist)"
  else
    log "language module already enabled"
  fi
}

install_paragraphs() {
  cd "$DRUPAL_PATH"
  # Check file presence AND DB state — module files can be absent even if the DB thinks
  # the module is enabled (happens when the container layer is reset after recreation).
  if [ ! -f "$WEB_ROOT/modules/contrib/paragraphs/paragraphs.module" ] || \
     ! drush --root="$WEB_ROOT" pm:list --status=enabled --field=name 2>/dev/null | grep -qx "paragraphs"; then
    log "Installing drupal/paragraphs (files or DB state missing)..."
    composer require drupal/paragraphs --no-interaction
    drush --root="$WEB_ROOT" en paragraphs entity_reference_revisions -y
  else
    log "paragraphs already enabled and files present"
  fi
}

apply_mcp_tools_patches() {
  # drupal/mcp_tools ^1.0 has a PHP 8 bug in AuditLogger::sanitizeDetails where
  # strtolower() is called on integer array keys (from array_keys($updates)).
  # This makes mcp_update_content return success:false even when the node save succeeded.
  # Patch applies (string) cast. Filed upstream.
  # TODO: upstream issue filed at https://www.drupal.org/project/mcp_tools (check for fix in next release)
  AUDIT_FILE="$WEB_ROOT/modules/contrib/mcp_tools/src/Service/AuditLogger.php"
  if [ -f "$AUDIT_FILE" ] && grep -q 'strtolower($key)' "$AUDIT_FILE"; then
    log "Applying mcp_tools AuditLogger PHP 8 strtolower patch..."
    sed -i 's/\$lowerKey = strtolower(\$key);/\$lowerKey = strtolower((string) \$key); \/\/ PHP 8 fix: array keys can be int/' "$AUDIT_FILE"
    drush --root="$WEB_ROOT" cr >/dev/null 2>&1 || true
    log "AuditLogger patch applied"
  fi
  # drupal/mcp_tools ^1.0 ContentAnalysisService::getRecentContent() calls date() with
  # $node->getCreatedTime() / $node->getChangedTime() which may return string on PHP 8.3
  # — date() requires ?int, so passes TypeError. Used by mcp_tools_get_recent_content
  # (drupal_node_get / drupal_node_list). Patch applies (int) cast.
  # TODO: upstream issue at https://www.drupal.org/project/mcp_tools
  CONTENT_FILE="$WEB_ROOT/modules/contrib/mcp_tools/src/Service/ContentAnalysisService.php"
  if [ -f "$CONTENT_FILE" ] && grep -q "date('Y-m-d H:i:s', \$node->getCreatedTime())" "$CONTENT_FILE"; then
    log "Applying mcp_tools ContentAnalysisService PHP 8 date() int cast patch..."
    sed -i "s/date('Y-m-d H:i:s', \\\$node->getCreatedTime())/date('Y-m-d H:i:s', (int) \\\$node->getCreatedTime())/g" "$CONTENT_FILE"
    sed -i "s/date('Y-m-d H:i:s', \\\$node->getChangedTime())/date('Y-m-d H:i:s', (int) \\\$node->getChangedTime())/g" "$CONTENT_FILE"
    drush --root="$WEB_ROOT" cr >/dev/null 2>&1 || true
    log "ContentAnalysisService date() patch applied"
  fi
}

install_mcp_tools() {
  cd "$DRUPAL_PATH"
  # Check file presence AND DB state — module files can be absent even if the DB thinks
  # the module is enabled (happens when the container layer is reset after recreation).
  if [ ! -f "$WEB_ROOT/modules/contrib/mcp_tools/mcp_tools.module" ] || \
     ! drush --root="$WEB_ROOT" pm:list --status=enabled --field=name 2>/dev/null | grep -qx "mcp_tools"; then
    log "Installing drupal/mcp_tools (files or DB state missing)..."
    composer config minimum-stability dev --no-interaction
    composer config prefer-stable true --no-interaction
    composer require drupal/tool drupal/mcp_tools:^1.0 --no-interaction
    drush --root="$WEB_ROOT" en mcp_tools mcp_tools_remote mcp_tools_content -y
    # TODO: upstream issue — drupal/mcp_tools ships with remote endpoint disabled
    # (enabled=false, uid=0) by default. No setup wizard exists; these three config:set
    # calls are required to activate the MCP HTTP endpoint. Filed/tracked at:
    # https://www.drupal.org/project/mcp_tools (file issue if not yet present).
    drush --root="$WEB_ROOT" config:set mcp_tools_remote.settings enabled true -y || true
    drush --root="$WEB_ROOT" config:set mcp_tools_remote.settings uid 1 -y || true
    drush --root="$WEB_ROOT" config:set mcp_tools_remote.settings allow_uid1 true -y || true
    drush --root="$WEB_ROOT" mcp-tools:remote-key-create --label="cinatra-dev" --scopes=read,write || \
      log "WARNING: key may already exist (idempotent skip)"
  else
    log "mcp_tools already enabled"
  fi
}

# Set to 1 by activate_widget_module only when the cinatra module is confirmed
# enabled this boot. bootstrap() gates export_config on it so a boot that could
# NOT enable the widget never persists a cinatra-less config to config/sync.
WIDGET_ENABLED=0

activate_widget_module() {
  if drush --root="$WEB_ROOT" pm:list --status=enabled --field=name 2>/dev/null | grep -qx "cinatra"; then
    WIDGET_ENABLED=1
  else
    # ROOT CAUSE (cinatra#1238): on a clean `make setup-demo` boot the Drupal
    # container is brought up BEFORE the dev clone-back populates the
    # bind-mounted module dir dev/drupal-module/cinatra, so the module can be
    # absent (or, when present but freshly mounted, not yet in Drupal's cached
    # extension list). A bare `drush en cinatra` then fails with "Unable to
    # install modules cinatra due to missing modules cinatra". A cache rebuild
    # rescans modules/custom so a present-but-freshly-mounted module becomes
    # discoverable before we enable it.
    log "Rebuilding cache so the bind-mounted cinatra module is discovered..."
    drush --root="$WEB_ROOT" cr || true
    log "Enabling cinatra module..."
    # NON-FATAL: the cinatra module is the display-side editing WIDGET; it is not
    # a prerequisite for seed_content (which creates article/page nodes via
    # drush php:script and only needs the content types ensured earlier). Guard
    # the enable so a not-yet-mounted widget module can never abort the background
    # bootstrap (`set -e`) before seed_content runs. The connector still
    # auto-connects; the widget re-enables idempotently on the next boot.
    if drush --root="$WEB_ROOT" en cinatra -y; then
      WIDGET_ENABLED=1
    else
      log "WARNING: enabling the cinatra widget module failed (non-fatal) — continuing to seed_content; the module re-enables on the next boot"
    fi
  fi
  # NOTE: cinatra_url is intentionally NOT set here. It is the BROWSER-reachable
  # widget origin (e.g. http://localhost:3000), which a container-side
  # CINATRA_BASE_URL (http://host.docker.internal:3000) would get wrong. The
  # cinatra dev-auto-setup (src/lib/dev-auto-setup.ts) owns cinatra_url + api_key
  # + instance_id and pushes the browser-safe values on each dev-server boot.
  # The server-side import Drush command reads CINATRA_BASE_URL on its own.
  drush --root="$WEB_ROOT" cr || true
}

CONFIG_SYNC_DIR="/drupal/config/sync"

import_config_if_available() {
  # If the repo's config/sync dir has YAML files, import them so a fresh install
  # gets the correct modules, content types, and fields without manual setup.
  if [ -d "$CONFIG_SYNC_DIR" ] && [ "$(ls -A "$CONFIG_SYNC_DIR" 2>/dev/null | grep -c '\.yml$')" -gt 0 ]; then
    log "Config YAML files found — running drush config:import..."
    drush --root="$WEB_ROOT" config:import --source="$CONFIG_SYNC_DIR" -y || \
      log "WARNING: config:import had errors (partial import may be OK on first run)"
  else
    log "No config YAML files in $CONFIG_SYNC_DIR — skipping config:import"
  fi
}

export_config() {
  # Only persist config when the cinatra widget module actually enabled this
  # boot (cinatra#1238). On a boot where the module was not yet mounted, the
  # active config lists NO cinatra module; exporting it would overwrite
  # config/sync (a writable bind mount) with a cinatra-less core.extension.yml,
  # and a later config:import would then keep the widget disabled even once the
  # module IS present. Skipping the export leaves the last good config in place;
  # the seeded content is in the DB regardless, and the next boot with the module
  # present enables the widget and re-exports a complete config.
  if [ "$WIDGET_ENABLED" != "1" ]; then
    log "Skipping config export — cinatra widget module not enabled this boot (would persist an incomplete config)"
    return 0
  fi
  log "Exporting config to $CONFIG_SYNC_DIR for fresh-setup reproducibility..."
  drush --root="$WEB_ROOT" config:export --destination="$CONFIG_SYNC_DIR" -y || \
    log "WARNING: config:export failed — check permissions on $CONFIG_SYNC_DIR"
}

SEED_CONTENT_SCRIPT="/opt/cinatra-dev-content/seed-content.php"
SEED_CONTENT_JSON="/opt/cinatra-dev-content/external-instances.dev-content.json"

seed_content() {
  # Seed generic, fictional demo nodes (idempotent) + one-shot OpenCloud
  # cleanup. The script + manifest are bind-mounted by docker-compose; if the
  # mount is absent (e.g. minimal compose override), skip cleanly.
  if [ ! -f "$SEED_CONTENT_SCRIPT" ]; then
    log "No dev-content seed script at $SEED_CONTENT_SCRIPT — skipping content seed"
    return 0
  fi
  log "Seeding generic dev content via drush php:script..."
  CINATRA_DEV_CONTENT_JSON="$SEED_CONTENT_JSON" \
    drush --root="$WEB_ROOT" php:script "$SEED_CONTENT_SCRIPT" || \
    log "WARNING: dev content seeding failed (non-fatal)"
}

bootstrap() {
  wait_for_db || return 0
  install_drupal_if_needed
  write_settings_local
  ensure_content_types
  install_paragraphs
  install_mcp_tools
  apply_mcp_tools_patches
  install_german
  import_config_if_available
  activate_widget_module
  export_config
  seed_content
  log "Bootstrap complete. Drupal at $DRUPAL_SITE_URL (admin / $DRUPAL_ADMIN_PASS)"
}

main() {
  write_php_opcache_ini
  bootstrap &
  exec apache2-foreground
}

main "$@"
