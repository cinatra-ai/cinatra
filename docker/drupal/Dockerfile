# Cinatra Drupal dev/demo companion — built ON TOP of the OFFICIAL `drupal`
# library image (cinatra#2178).
#
# WHY THIS SHAPE: this file used to hand-build the whole stack from a bare
# `php:8.3-apache` — system dev headers, GD/PDO/zip/opcache compiled with
# docker-php-ext-*, a Composer copy, and a `drupal/recommended-project` install.
# Every one of those lines was an upkeep obligation (PHP majors, extension
# build flags, Drupal core currency) on an image that is dev/demo-only and
# deliberately NOT on the upgrade track. Basing on the official image moves that
# entire class upstream: docker-library/drupal owns PHP + Apache + the
# extensions + the core codebase, and we own exactly one image reference plus
# the Cinatra-specific bake (Drush + the contrib modules the entrypoint needs).
#
# This mirrors the sibling companion, docker/wordpress/Dockerfile, which already
# builds on the official `wordpress:` image the same way.
#
# The readable tag is kept inline; the @sha256 is the binding pin. It is the
# MULTI-ARCH OCI INDEX digest (amd64 + arm64 + …), so the same reference builds
# on an arm64 laptop and an amd64 CI runner. Re-resolve at bump time with:
#   docker buildx imagetools inspect drupal:11-apache
FROM drupal:11-apache@sha256:7a93ee9c8bec6a780cc25ec4e1610ae6dde483368db3d5aa0ac477567a645d6b

# ---------------------------------------------------------------------------
# LAYOUT BRIDGE — /drupal is the Cinatra-side contract path.
#
# The official image installs drupal/recommended-project at /opt/drupal and
# points the Apache docroot there via the symlink /var/www/html -> /opt/drupal/web
# (with `AllowOverride All` on /var/www/ from the php:apache base, so Drupal's
# .htaccess clean-URL rewrites work out of the box — nothing to re-do here).
#
# Cinatra addresses the project as /drupal in THREE places that stay unchanged:
#   - scripts/drupal-entrypoint.sh   (DRUPAL_PATH=/drupal, WEB_ROOT=/drupal/web,
#                                     CONFIG_SYNC_DIR=/drupal/config/sync)
#   - docker-compose.yml             (the four mounts under /drupal/…)
#   - tests/e2e/wp-drupal-uat/…      (UAT_DRUPAL_ROOT default /drupal/web)
# so /drupal is published as a symlink onto the official layout instead of
# rewriting those contracts. Docker resolves mount destinations THROUGH
# in-rootfs symlinks, so `-v cinatra-drupal:/drupal/web/sites/default` and the
# module/config bind mounts land on /opt/drupal/… exactly as before (verified on
# the real compose arm, not assumed).
RUN ln -s /opt/drupal /drupal

# ---------------------------------------------------------------------------
# The only OS packages the official image does not already carry that our
# runtime needs. Everything the old file installed for the PHP build
# (libpng/libjpeg/libfreetype/libzip/libwebp dev headers) is gone with the
# docker-php-ext-* steps; `curl` and the gd/pdo_mysql/zip/opcache extensions
# ship in the base.
#   git, unzip            — Composer VCS/dist handling for the bake + the
#                           entrypoint's warm-volume `composer require` fallback
#   default-mysql-client  — the entrypoint's wait_for_db() probes MariaDB with
#                           `mysql -h drupal-db …`
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git unzip default-mysql-client; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/drupal

# Drush must be installed INSIDE the project (not globally) — Drush preflight
# requires drupal/core to be present in the same Composer context. The official
# image already puts /opt/drupal/vendor/bin on PATH; the /usr/local/bin symlink
# is kept so a bare `drush` also resolves for anything that resets PATH.
RUN set -eux; \
    composer require drush/drush:^13 --no-interaction 2>&1 | tail -3; \
    ln -sf /opt/drupal/vendor/bin/drush /usr/local/bin/drush

# Bake the required contrib modules into the image so they survive container
# recreation. The entrypoint enables them at runtime; having the files here
# means `composer require` is a no-op on first boot and the modules are always
# present even after `docker compose up --force-recreate`. Constraints match the
# entrypoint's own install_paragraphs/install_mcp_tools fallbacks.
RUN set -eux; \
    composer config minimum-stability dev --no-interaction; \
    composer config prefer-stable true --no-interaction; \
    composer require \
        drupal/paragraphs \
        drupal/tool \
        "drupal/mcp_tools:^1.0" \
        --no-interaction 2>&1 | tail -5; \
    chown -R www-data:www-data web/sites web/modules web/themes

# Confirm everything is wired up — through the /drupal contract path, so a
# broken symlink fails the BUILD rather than the first boot.
RUN set -eux; \
    test -f /drupal/composer.json; \
    test -d /drupal/web/core; \
    test -d /drupal/web/modules/contrib/mcp_tools; \
    test -d /drupal/web/modules/contrib/paragraphs; \
    test -L /var/www/html; \
    drush --root=/drupal/web --version; \
    mysql --version; \
    echo "Drupal + Drush + contrib modules OK"

# Runtime: only sites/default (settings.php + files) needs to persist.
#
# SPELL THIS EXACTLY AS THE COMPOSE MOUNT DESTINATION (/drupal/…, not /opt/…).
# Docker matches a `-v` override against the declared VOLUME path as a STRING,
# BEFORE resolving symlinks: declaring /opt/drupal/web/sites/default while
# compose mounts /drupal/web/sites/default makes the daemon treat them as two
# different targets and attach BOTH — a fresh anonymous volume per container
# create, plus the named one, racing for the same directory. Verified: the
# aliased spelling yields two Mounts entries, this spelling yields one.
VOLUME ["/drupal/web/sites/default"]

# Re-assert the official image default. docker-compose overrides `entrypoint`
# with scripts/drupal-entrypoint.sh, which ends in `exec apache2-foreground`.
CMD ["apache2-foreground"]
