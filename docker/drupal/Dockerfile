# php 8.5 (8.5.8-apache-trixie), digest-pinned to the multi-arch OCI index —
# same shape as docker/wordpress/Dockerfile's `FROM wordpress:…@sha256:…`. The
# tag component stays for human readability; the `@sha256:` is the binding pin.
# Re-resolve at bump time with `docker buildx imagetools inspect php:8.5-apache`
# (take the top-level index Digest, NOT a per-platform manifest digest — this
# image is a real multi-arch index and pinning one platform would break the
# other). Previous pin: the floating tag `php:8.3-apache`.
FROM php:8.5-apache@sha256:eacc0d98992683cb46e4f8f44b2418a0323855dc8b59d32dc54f7a9b90a966dd

# System deps required by Drupal
RUN apt-get update && apt-get install -y --no-install-recommends \
    git unzip curl default-mysql-client \
    libpng-dev libjpeg-dev libfreetype-dev libzip-dev libwebp-dev \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions Drupal needs.
#
# `opcache` is deliberately NOT in this list. Upstream php-src made OPcache a
# static-only extension: ext/opcache/config.m4 now declares
# `PHP_NEW_EXTENSION([opcache], …, [no], …)` (was `$ext_shared`), so a phpize
# build produces no `modules/*.so` and `docker-php-ext-install opcache` dies
# with `cp: cannot stat 'modules/*'` — this exact line was the first failure of
# the 8.5 build. Nothing is lost: the official image already compiles OPcache
# IN and enables it (`php -v` reports "with Zend OPcache", `opcache.enable =>
# On`), on 8.3 as well as 8.5 — the old `opcache` argument was building a
# redundant second copy. So the entrypoint's opcache ini
# (`/usr/local/etc/php/conf.d/cinatra-dev.ini`) still applies, and reverting
# the FROM line alone is still a complete rollback.
RUN docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install gd pdo pdo_mysql zip \
    && php -r 'exit(extension_loaded("Zend OPcache") && ini_get("opcache.enable") ? 0 : 1);'

# Composer 2
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Create Drupal 11 recommended-project at build time — the image ships with a
# fully-installed codebase. At runtime, the entrypoint only needs to run
# drush site:install (DB setup), install mcp_tools, and enable cinatra.
# Baking at build time avoids first-boot download delays and --no-empty-dir issues.
WORKDIR /drupal
RUN composer create-project drupal/recommended-project:^11 . --no-interaction 2>&1 | tail -5

# Drush 13 must be installed INSIDE the project (not globally) — Drush 13 preflight
# requires drupal/core to be present in the same Composer context.
RUN composer require drush/drush:^13 --no-interaction 2>&1 | tail -3 \
    && ln -sf /drupal/vendor/bin/drush /usr/local/bin/drush

# Bake required contrib modules into the image so they survive container recreation.
# The entrypoint enables them at runtime; having the files here means composer require
# is a no-op on first boot and the modules are always present even after `docker compose up --force-recreate`.
RUN composer config minimum-stability dev --no-interaction \
    && composer config prefer-stable true --no-interaction \
    && composer require \
        drupal/paragraphs \
        drupal/tool \
        "drupal/mcp_tools:^1.0" \
        --no-interaction 2>&1 | tail -5

# Confirm everything is wired up
RUN test -f /drupal/composer.json && test -d /drupal/web/core \
    && test -d /drupal/web/modules/contrib/mcp_tools \
    && test -d /drupal/web/modules/contrib/paragraphs \
    && drush --root=/drupal/web --version \
    && echo "Drupal + Drush + contrib modules OK"

# Apache: serve from web/ subdir with AllowOverride All so Drupal .htaccess works
RUN sed -i 's|/var/www/html|/drupal/web|g' \
        /etc/apache2/sites-available/000-default.conf \
    && a2enmod rewrite \
    && printf '<Directory /drupal/web>\n  AllowOverride All\n  Require all granted\n</Directory>\n' \
       >> /etc/apache2/sites-available/000-default.conf

# Runtime: only sites/default/files and settings.php need to persist
VOLUME ["/drupal/web/sites/default"]

CMD ["apache2-foreground"]
