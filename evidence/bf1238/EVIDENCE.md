# cinatra#1238 — boot-fix lane: isolated-boot proofs

Fixes the two boot defects the exclusive-window acceptance recorded (the R5 gap
that keeps #1238 open, plus the Plane MCP-bridge profile finding). Each fix is
proven **in isolation** — the full 4-app acceptance re-run happens at the next
exclusive window; these are honest single-surface boot proofs, not that re-run.

Isolated Drupal boot: the `drupal` + `drupal-db` services only, in a throwaway
compose project (`bf1238drupal`) on free ports (8092/3318), fully torn down
(`down -v` + image removed) afterward. The persistent verify stack and sibling
lanes were never touched.

## Defect 1 — Drupal in-app demo content never seeds on a clean boot

**Root cause (an ordering race, not a seeder bug).** `make setup-demo` brings up
the Drupal container (`scripts/setup.sh`) *before* the dev clone-back populates
the bind-mounted module dir `dev/drupal-module/cinatra`. So at container boot
that dir can be **empty**. The entrypoint's `activate_widget_module()` ran an
**unguarded** `drush en cinatra -y`; under `set -euo pipefail` in the background
`bootstrap()` subshell, its failure —

    Unable to install modules cinatra due to missing modules cinatra.

— aborted `bootstrap()` **before** `seed_content()`, so zero demo nodes were
created. The seeder itself is fine: `seed_content()` creates article/page nodes
via `drush php:script` and depends only on the content types `ensure_content_types()`
creates earlier, **not** on the cinatra widget module.

**Fix (`scripts/drupal-entrypoint.sh`).** Rebuild the cache before enabling so a
freshly-mounted module is discovered, and make the enable **non-fatal** so a
not-yet-mounted widget module can never abort bootstrap before the independent
content seed. The widget still enables when present; it re-enables idempotently
on the next boot when it was absent. A boot that could NOT enable the widget also
**skips `config:export`** (Codex-flagged): otherwise it would overwrite the
writable `config/sync` bind mount with a cinatra-less `core.extension.yml`, and a
later `config:import` would then keep the widget disabled even once the module IS
present. Skipping leaves the last good config in place.

| Boot | Module at boot | Entrypoint | Result |
|---|---|---|---|
| BEFORE | empty (the race) | origin/main | abort at widget step, **0 nodes**, no "Bootstrap complete" — `bf1238-drupal-BEFORE-abort.log` |
| AFTER  | empty (the race) | fixed | non-fatal skip → **config export skipped (config/sync not poisoned)** → seed runs → **created=3** → "Bootstrap complete" — `bf1238-drupal-AFTER-seeded.log` |
| AFTER  | present (happy path) | fixed | widget **enabled** + config exported (with `cinatra`) + **created=3** — `bf1238-drupal-AFTER-happypath.log` |

Seeded nodes (verified in the DB, front page HTTP 200): `article` "Welcome to
your demo site", `article` "Product update: faster content workflows", `page`
"About this demo".

## Defect 2 — Plane MCP bridge dependency undefined on the first pass

**Root cause.** The bridge (`plane-mcp` service, profile `plane-mcp`) declares
`depends_on: plane-api`, and `plane-api` lives in the `plane` profile. `setup.sh`
brought the bridge up with `--profile plane-mcp` **alone**, so `plane-api` was an
undefined service in that activation set.

**Fix (`scripts/setup.sh` + `docker/plane-mcp/README.md`).** Activate both
profiles in one pass (`--profile plane --profile plane-mcp`). The already-running
`plane` containers are untouched (`up -d` no-ops healthy services); the bridge
stays in only the `plane-mcp` profile so it remains opt-in (it needs the
provisioned PAT env to boot).

Proof (`bf1238-defect2-compose-config.txt`):
- `docker compose --profile plane-mcp config` → `service "plane-mcp" depends on
  undefined service "plane-api": invalid compose project` (compose refuses it).
- `docker compose --profile plane --profile plane-mcp config` → **valid**;
  `plane-api` and `plane-mcp` both resolve, `plane-mcp depends_on plane-api`
  wired, in one activation set.
