# Cinatra WordPress dev image — pinned community-stack MCP gateway fixture (#2016 S1).
#
# WHY THIS EXISTS (#260 Step 6): the stock `wordpress:` image ships no
# git/composer/wp-cli and no MCP plugins, so the dev entrypoint used to apt-get
# those tools AND fetch WordPress/mcp-adapter (+ the old abilities-api) at FIRST
# BOOT — inside the uat-gate's ~5-minute "core installed + cinatra plugin active"
# readiness window, pushing a fresh CI container past that window.
#
# This image BAKES the slow work at BUILD time (mirroring docker/drupal/Dockerfile):
# tools + the pinned MCP plugins land in the image. `docker compose up` builds a
# missing image BEFORE the readiness poll begins, so the slow network work no
# longer competes with the readiness window. The runtime entrypoint then only
# waits for core+DB, runs `wp core install`, and activates the plugins.
#
# PINNED, CHECKSUMMED STACK (#2016 S1): every third-party artifact is pinned +
# checksum-verified. Versions/URLs/sha256/digest are the single source of truth
# in docker/wordpress/pins.lock; the version + sha256 ARG defaults below MUST
# match it (enforced by scripts/audit/wordpress-fixture-pins-gate.mjs, a required
# PR check). This is where the REMOTE-artifact hashes are actually verified — the
# base image is pulled BY DIGEST and each plugin ZIP + the wp-cli phar are
# `sha256sum -c`'d (fail-closed) on the runner during --build.
#
# WP 6.9 ships the WordPress Abilities API in CORE (wp_register_ability() is
# always present), so the separate WordPress/abilities-api plugin is DROPPED —
# both the build bake and the runtime activation ordering it required are gone.
#
# IMPORTANT — staging dir, not the volume: the official WP entrypoint copies
# `/usr/src/wordpress` into the (empty) `/var/www/html` named volume on first
# boot, EXCLUDING any `wp-content/*/*/` dir that already exists in the volume
# (docker-library/wordpress#506). So the plugins MUST be baked into
# `/usr/src/wordpress/wp-content/plugins/<plugin>` (the staging tree), NOT
# `/var/www/html` (which the named volume mount hides at runtime). Baked there,
# they are tarred into a fresh volume automatically and preserved on warm ones.
# The runtime entrypoint keeps an idempotent fetch-if-missing fallback for warm
# volumes created before this image existed (the bake never reaches them).
#
# The readable tag is kept inline; the @sha256 digest is the binding pin
# (re-resolve at bump time: `docker buildx imagetools inspect
# wordpress:6.9-php8.3-apache`).
FROM wordpress:6.9-php8.3-apache@sha256:5d2c212561c4b5442ebc4d98933a9cbadcf3dee8888ed3fd9ed44667c27cc905

# Third-party pins. Versions are bare (no leading "v"); the git tag / release
# URL is derived as v<version>. This keeps the source-leak-gate
# SLG_MILESTONE_VERSION rule (net-new vX.Y.Z literals read as internal milestone
# markers) from tripping on third-party release pins. The version + sha256 pairs
# below MUST equal docker/wordpress/pins.lock (pin gate enforces lockstep). The
# runtime entrypoint reads the SAME defaults so a warm-volume fallback fetch
# resolves the identical artifact.
ARG MCP_ADAPTER_VERSION=0.5.0
ARG MCP_ADAPTER_SHA256=a13f253c7bf4314b6cce7e238be2d5857eee66242bfe5ff5cb5576f74dc41593
ARG EAFM_VERSION=2.0.20
ARG EAFM_SHA256=5c3a2b287c73d85503e5118957475fbec598c548f50bc873f05f0293a131553a
ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA256=ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c

# Composer runs as root inside the build; this is the documented opt-in. Kept for
# the operator toolbox + the entrypoint's stock-image fallback (no bake step runs
# `composer install` — see below — but the binary stays available).
ENV COMPOSER_ALLOW_SUPERUSER=1

# Build-time tools the entrypoint used to apt-get on first boot. less +
# default-mysql-client mirror the old install_tools set so an operator shelling
# into the container keeps the same toolbox.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git unzip less ca-certificates default-mysql-client; \
    rm -rf /var/lib/apt/lists/*

# Composer 2 (copied from the official composer image — no network installer).
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# wp-cli phar, pinned to a tagged release + sha256-verified (fail-closed). The
# old unpinned builds-channel URL made "exact pinned stack" overclaim (#2016 S1).
RUN set -eux; \
    curl -fsSLo /usr/local/bin/wp \
        "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    echo "${WP_CLI_SHA256}  /usr/local/bin/wp" | sha256sum -c -; \
    chmod +x /usr/local/bin/wp

# Bake mcp-adapter + enable-abilities-for-mcp into the STAGING tree from their
# pinned, checksummed release ZIPs. No `composer install`: mcp-adapter 0.5.0
# ships a committed vendor/autoload.php in the release ZIP (pins.lock
# mcpAdapter.bundlesVendor=true) and the enable-abilities-for-mcp WordPress.org
# distribution ships built — so the fail-closed `sha256sum -c` + unzip is the
# whole bake. The ZIPs unpack to `mcp-adapter/` and `enable-abilities-for-mcp/`
# top-level dirs, landing at $plugins_dir/<slug> directly.
RUN set -eux; \
    plugins_dir=/usr/src/wordpress/wp-content/plugins; \
    curl -fsSLo /tmp/mcp-adapter.zip \
        "https://github.com/WordPress/mcp-adapter/releases/download/v${MCP_ADAPTER_VERSION}/mcp-adapter.zip"; \
    echo "${MCP_ADAPTER_SHA256}  /tmp/mcp-adapter.zip" | sha256sum -c -; \
    unzip -q /tmp/mcp-adapter.zip -d "$plugins_dir"; \
    rm -f /tmp/mcp-adapter.zip; \
    curl -fsSLo /tmp/eafm.zip \
        "https://downloads.wordpress.org/plugin/enable-abilities-for-mcp.${EAFM_VERSION}.zip"; \
    echo "${EAFM_SHA256}  /tmp/eafm.zip" | sha256sum -c -; \
    unzip -q /tmp/eafm.zip -d "$plugins_dir"; \
    rm -f /tmp/eafm.zip; \
    chown -R www-data:www-data \
        "$plugins_dir/mcp-adapter" "$plugins_dir/enable-abilities-for-mcp"

# Re-assert the official image defaults — FROM resets nothing here, but being
# explicit documents that our entrypoint is layered on by docker-compose
# (entrypoint: cinatra-wp-entrypoint.sh), which still exec's docker-entrypoint.sh.
CMD ["apache2-foreground"]
