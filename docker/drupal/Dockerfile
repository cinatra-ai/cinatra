FROM php:8.3-apache

# System deps required by Drupal
RUN apt-get update && apt-get install -y --no-install-recommends \
    git unzip curl default-mysql-client \
    libpng-dev libjpeg-dev libfreetype-dev libzip-dev libwebp-dev \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions Drupal needs
RUN docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install gd pdo pdo_mysql zip opcache

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
