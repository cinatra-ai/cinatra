# WordPress + Drupal assistant UATs

Proves the Cinatra assistant round-trips end-to-end inside the live docker
WordPress (`:8080`) + Drupal (`:8082`) stacks against a **real cinatra dev
backend**, with only the LLM provider swapped for the deterministic scripted
provider (`CINATRA_TEST_LLM_PROVIDER=scripted` — offline, key-free).

Scope: after the S5 iframe cutover (`wordpress-plugin`/`drupal-module` #1221) the
CMS bundle mounts the Cinatra-served AG-UI surface (`/embed/assistant`) in a
sandboxed cross-origin `<iframe class="cw-frame">`; the composer + streaming
render live INSIDE the iframe. This suite proves that integration end-to-end
(button → panel → required-login → iframe bootstrap → prompt → in-frame AG-UI
reply). The unified `/api/assistants/chat` stream carries **no** field-level
`changes` diff card (retired in #87); an edit turn's content-edit signal is the
`*_content_editor_run` `TOOL_CALL_START` on the wire. It does **not** exercise a
real CMS mutation via WayFlow — the scripted provider stands in for the
content-editor agent.

## Scenarios (12)

Per CMS (`wordpress/` + `drupal/`): (1) admin config page renders, (2) assistant
button renders on seeded content, (3) click → panel opens + the in-frame composer
goes active (also the live frame-ancestors check), (4) prompt → in-frame AG-UI
reply (asserts the `CINATRA_UAT_OK` sentinel in `[data-embed-content]`), (5) edit
prompt → a `*_content_editor_run` tool round-trip against the seeded page/node
with **no direct CMS egress** (cinatra#1214), fenced on the client-consumed
`RUN_FINISHED` terminal, (6) invalid API key → graceful non-500 admin-facing
error.

## Operator runbook (live green)

> **Status: VERIFICATION-PENDING.** A live 12-green run requires the full dev
> stack below and is an operator/CI step (the companion repos must be
> cloneable).

1. Provision the DB + clone the plugin/module (no dev server needed):
   ```bash
   cinatra setup dev          # clones dev/wordpress-plugin/ + dev/drupal-module/cinatra/ + DB setup
   docker compose --profile wordpress --profile drupal up -d
   ```
2. Confirm the plugin/module are active:
   ```bash
   docker exec cinatra-wordpress-1 wp plugin list --allow-root | grep cinatra
   docker exec cinatra-drupal-1 drush pml --status=enabled | grep cinatra
   ```
3. Run the UATs. The config boots its OWN dev server carrying the scripted
   provider + the non-prod actor-gate bypass (`reuseExistingServer: false`), so
   stop any dev server already on `E2E_WP_DRUPAL_PORT` (default 3000) first. That
   boot also runs dev-auto-setup, which mints + pushes the widget auth keys to
   the WP/Drupal side:
   ```bash
   pnpm dev:stop   # free the port if a main dev server is running
   pnpm test:e2e:wp-drupal
   ```
   The CMS admin creds default to the docker stack's values (WP `admin`/`admin`,
   Drupal `admin`/`cinatra`); override via `UAT_WP_ADMIN_PASS` /
   `UAT_DRUPAL_ADMIN_PASS` if your stack differs.

`global-setup.ts` seeds one WP page + one Drupal node (idempotent, by title
marker) and writes their IDs to `.uat/seed.json` (gitignored).

## Tunables (env)

| Var | Default | Purpose |
|---|---|---|
| `E2E_WP_DRUPAL_PORT` | `3000` | cinatra dev server port the suite boots |
| `UAT_WP_BASE_URL` | `http://localhost:8080` | docker WordPress |
| `UAT_DRUPAL_BASE_URL` | `http://localhost:8082` | docker Drupal |
| `UAT_WP_ADMIN_USER` / `_PASS` | `admin` / `admin` | WP admin login (matches compose `WP_DEV_ADMIN_PASS`) |
| `UAT_DRUPAL_ADMIN_USER` / `_PASS` | `admin` / `cinatra` | Drupal admin login |

If the widget DOM selectors drift, refine them in `helpers.ts` (`SEL`). The
CMS-origin shell contract is `#cinatra-root` + the `.cw-*` launcher/panel/login
chrome + the `.cw-frame` iframe; the composer/output contract lives INSIDE the
iframe (`[data-embed-assistant]`, `[data-embed-content]`, the `Message` input) —
drive it via `page.frameLocator(SEL.frame)`.
