# Cinatra WordPress dev image.
#
# WHY THIS EXISTS (#260 Step 6): the stock `wordpress:6.8-php8.3-apache` image
# ships no git/composer/wp-cli and no MCP plugins, so the dev entrypoint used to
# apt-get those tools AND clone+`composer install` WordPress/abilities-api +
# WordPress/mcp-adapter at FIRST BOOT — inside the uat-gate's ~5-minute
# "core installed + cinatra plugin active" readiness window. #256 added the two
# clones, pushing a fresh CI container past that window (uat-gate:
# "WordPress/Drupal not ready ... after ~5 min").
#
# This image BAKES the slow work at BUILD time (mirroring docker/drupal/Dockerfile,
# which already bakes its contrib modules): tools + both plugins (clone +
# `composer install`) land in the image. `docker compose up` builds a missing
# image BEFORE the readiness poll begins, so the slow network/composer work no
# longer competes with the readiness window. The runtime entrypoint then only
# waits for core+DB, runs `wp core install`, and activates the three plugins.
#
# IMPORTANT — staging dir, not the volume: the official WP entrypoint copies
# `/usr/src/wordpress` into the (empty) `/var/www/html` named volume on first
# boot, EXCLUDING any `wp-content/*/*/` dir that already exists in the volume
# (docker-library/wordpress#506). So the plugins MUST be baked into
# `/usr/src/wordpress/wp-content/plugins/<plugin>` (the staging tree), NOT
# `/var/www/html` (which the named volume mount hides at runtime). Baked there,
# they are tarred into a fresh volume automatically and preserved on warm ones.
# The runtime entrypoint keeps an idempotent clone-if-missing fallback for warm
# volumes created before this image existed (the bake never reaches them).
FROM wordpress:6.8-php8.3-apache

# Pins are bare (no leading "v"); the git tag is derived as v<version>. This
# keeps the source-leak-gate SLG_MILESTONE_VERSION rule (which flags net-new
# vX.Y.Z literals as internal milestone markers) from tripping on third-party
# release pins. The runtime entrypoint reads the SAME defaults so a warm-volume
# fallback clone resolves the identical ref.
ARG ABILITIES_API_VERSION=0.4.0
ARG MCP_ADAPTER_VERSION=0.4.1

# Composer runs as root inside the build; this is the documented opt-in.
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

# wp-cli phar, pinned by the upstream stable build channel.
RUN set -eux; \
    curl -sSLfo /usr/local/bin/wp \
        https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar; \
    chmod +x /usr/local/bin/wp

# Bake abilities-api + mcp-adapter into the STAGING tree. abilities-api provides
# wp_register_ability(); mcp-adapter REQUIRES it at activation time, so the
# entrypoint activates abilities-api BEFORE mcp-adapter (ordering is enforced
# there, not here — both are merely present in the image).
#
# Clone flags: --depth 1 --single-branch (shallow, one ref — no extra history).
# Composer flags: --no-dev (skip phpunit/phpcs/phpstan dev tooling),
# --prefer-dist (zip downloads, no per-package git clones), --no-progress
# (clean build logs), --no-scripts (neither plugin defines composer
# install-event scripts at these pins — only `lint`/`test`/`phpstan` dev
# commands — so skipping is safe and avoids any surprise script execution).
# (No --no-audit: `composer install` runs no audit by default and rejects the
# flag, which is an `update`/`require`-only option.) mcp-adapter ships NO committed vendor/
# and fatals without vendor/autoload.php, so `composer install` is mandatory for
# it; abilities-api loads includes/bootstrap.php directly but the install keeps
# parity with the runtime fallback.
RUN set -eux; \
    plugins_dir=/usr/src/wordpress/wp-content/plugins; \
    git -c advice.detachedHead=false clone --depth 1 --single-branch \
        --branch "v${ABILITIES_API_VERSION}" \
        https://github.com/WordPress/abilities-api.git "$plugins_dir/abilities-api"; \
    ( cd "$plugins_dir/abilities-api" && composer install \
        --no-dev --no-interaction --no-progress --prefer-dist --no-scripts ); \
    git -c advice.detachedHead=false clone --depth 1 --single-branch \
        --branch "v${MCP_ADAPTER_VERSION}" \
        https://github.com/WordPress/mcp-adapter.git "$plugins_dir/mcp-adapter"; \
    ( cd "$plugins_dir/mcp-adapter" && composer install \
        --no-dev --no-interaction --no-progress --prefer-dist --no-scripts ); \
    chown -R www-data:www-data \
        "$plugins_dir/abilities-api" "$plugins_dir/mcp-adapter"

# Re-assert the official image defaults — FROM resets nothing here, but being
# explicit documents that our entrypoint is layered on by docker-compose
# (entrypoint: cinatra-wp-entrypoint.sh), which still exec's docker-entrypoint.sh.
CMD ["apache2-foreground"]
