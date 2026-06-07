# Cinatra Drupal Dev Environment

A Drupal 11 instance used as a live CMS connected to Cinatra. It runs as a Docker service and is pre-configured with the Paragraphs module, the MCP Tools remote endpoint, and the `cinatra` module.

## Start

```bash
docker compose up drupal drupal-db
```

Drupal will be available at **http://localhost:8082** (admin / cinatra).

On first boot the entrypoint script runs automatically and:
1. Waits for MariaDB
2. Installs Drupal 11 (if not already installed)
3. Installs `drupal/paragraphs` via Composer
4. Installs `drupal/mcp_tools` and activates the remote MCP endpoint
5. Imports all config YAML from `docker/drupal/config/sync/` — this restores all content types, paragraph types, fields, and form/view displays
6. Enables the `cinatra` module and sets the Cinatra URL

A fresh `docker compose up` with no existing volume results in a fully wired Drupal instance with the correct structure but no content nodes.

## Cinatra widget — post-install setup

The Cinatra Drupal widget module ships with empty `cinatra_url` and `api_key` config
by design — the API key is per-Cinatra-instance and must NOT be committed to source
control. After running `drush config:import` (or on a fresh `drupal:` profile bring-up),
follow these steps to enable the widget:

1. Open Cinatra in a browser (e.g. `http://localhost:3000`) and sign in as an admin.
2. Visit `/settings/assistants/drupal-widget`. The page shows a generated API key UUID for
   this Cinatra instance — copy the full UUID.
3. Open the Drupal admin (e.g. `http://localhost:8082/user/login` — Drupal is on port 8082; WordPress is on 8080) and sign in as an
   admin user.
4. Visit `/configuration/config/cinatra/widget-settings`. Two fields are shown:
   - **Cinatra URL** — set to `http://localhost:3000` for local dev (or your Cinatra
     deployment URL). Use `localhost`, NOT `host.docker.internal` — the widget runs
     in the user's BROWSER, not in the Drupal container.
   - **API key** — paste the UUID copied from step 2.
5. Save. Reload any Drupal node page; the Cinatra widget chat bubble should now appear.

Verification: open browser DevTools, network tab, and confirm the widget's first
request to Cinatra returns 200 (not 401). If 401, double-check the API key was pasted
in full with no leading/trailing whitespace.

Why these aren't in the install yml: the API key is generated per-Cinatra-instance and
leaking it into committed config would defeat its purpose. The hostname is environment-
specific (`localhost` for dev, real domain for prod).

Re-import safety: `drush config:import` does NOT overwrite the runtime config DB values
once they're set unless the import yml itself is non-empty. As long as
`dev/drupal-module/cinatra/config/install/cinatra.settings.yml` stays empty,
re-imports preserve the operator's configured values.

## Import website content

The `cinatra:import-website` Drush command crawls a public website, uses the Cinatra LLM bridge to map each page's content to Drupal paragraph types, and creates `landing_page` nodes.

**Cinatra must be running** (`pnpm dev`) for the LLM bridge call to succeed.

### Basic usage

```bash
# Shell into the container first
docker exec -it cinatra-drupal-1 bash

# Then run the import
drush --root=/drupal/web cinatra:import-website https://example.com/de \
  --lang=de \
  --limit=20
```

Or as a one-liner from the host:

```bash
docker exec cinatra-drupal-1 drush --root=/drupal/web \
  cinatra:import-website https://example.com/de --lang=de --limit=20
```

### Options

| Option | Default | Description |
|---|---|---|
| `--lang` | `de` | Drupal langcode for created nodes |
| `--limit` | `20` | Max pages to import (0 = unlimited) |
| `--update` | off | Update nodes that already exist (default: skip) |
| `--delete-existing` | off | Delete all `landing_page` nodes before import |
| `--node-type` | `landing_page` | Drupal content type to create |

### Examples

```bash
# Import up to 20 pages, skip any that already exist
drush --root=/drupal/web cinatra:import-website https://example.com/de --lang=de --limit=20

# Re-import and overwrite existing nodes
drush --root=/drupal/web cinatra:import-website https://example.com/de --lang=de --update

# Wipe everything and re-import from scratch
drush --root=/drupal/web cinatra:import-website https://example.com/de --lang=de --delete-existing

# Import English pages into a different content type
drush --root=/drupal/web cinatra:import-website https://example.com --lang=en --node-type=landing_page
```

### How it works

1. **Discovery** — tries `<origin>/sitemap.xml` first, then `sitemap_index.xml`, then crawls `<a>` links from the start URL. Only URLs that share the same path prefix are included.
2. **Extraction** — fetches each page's HTML, strips `<nav>`, `<footer>`, `<script>`, etc., and sends the cleaned text to the Cinatra LLM bridge (`/api/llm-bridge`).
3. **Structuring** — the LLM maps the text to the available paragraph types (hero, feature cards, benefits, stats, contact, downloads, text sections) and returns JSON.
4. **Node creation** — paragraph entities are created, images are downloaded to `public://imported/`, and a `landing_page` node is saved with a URL alias matching the source path.

### Paragraph types

| Type | Fields |
|---|---|
| `hero_section` | headline, subheadline, image |
| `feature_cards_section` | cards_title |
| `feature_card` | title, body |
| `benefits_section` | benefits_title |
| `benefit_item` | title, body |
| `cloud_features_section` | features_headline, features_list, image |
| `stats_section` | 3× number + label |
| `contact_section` | name, phone, email, image |
| `downloads_section` | title, body |
| `text_section` | title, body |

## Config sync

Drupal config is exported to `docker/drupal/config/sync/` and imported automatically on fresh boot. After making structural changes (new fields, content types, display modes) export them so the next fresh install picks them up:

```bash
docker exec cinatra-drupal-1 drush --root=/drupal/web config:export --destination=/drupal/config/sync -y
docker cp cinatra-drupal-1:/drupal/config/sync/. docker/drupal/config/sync/
```

## MCP endpoint

The Drupal MCP endpoint is available at:

```
http://localhost:8082/mcp
```

The default API key is `dev-mcp-key` (set via `MCP_TOOLS_API_KEY` env var or in the Cinatra admin at **Settings → Connectors → Drupal**).
