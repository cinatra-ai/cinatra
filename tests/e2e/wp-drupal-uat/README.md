# WordPress + Drupal assistant UATs

Proves the Cinatra assistant round-trips end-to-end inside the live docker
WordPress (`:8080`) + Drupal (`:8082`) stacks against a **real cinatra dev
backend**, with only the LLM provider swapped for the deterministic scripted
provider (`CINATRA_TEST_LLM_PROVIDER=scripted` — offline, key-free).

Scope: after the S5 iframe cutover (`wordpress-plugin`/`drupal-module` #1221) the
CMS bundle mounts the Cinatra-served AG-UI surface (`/embed/assistant`) in a
sandboxed cross-origin `<iframe class="cw-frame">`; the composer + streaming
render live INSIDE the iframe. Since **protocol 2** (cinatra#2674;
`wordpress-plugin` #108 / `drupal-module` #100) the parent page hands that frame
only PUBLIC context and the **frame owns the sign-in**: it opens a top-level
Cinatra popup, runs its own PKCE ceremony against
`/api/widget-auth/frame/{init,token}`, and keeps the credential in a closure on
the Cinatra origin. The retired site-mediated pair (`/api/widget-auth/{init,token}`)
answers **410 Gone**, and the parent's `.cw-login` gate no longer exists. This
suite proves that integration end-to-end (button → panel + frame mount →
frame-owned sign-in → prompt → in-frame AG-UI reply). The unified
`/api/assistants/chat` stream carries **no** field-level `changes` diff card
(retired in #87); an edit turn's content-edit signal is the
`*_content_editor_run` `TOOL_CALL_START` on the wire. It does **not** exercise a
real CMS mutation via WayFlow — the scripted provider stands in for the
content-editor agent.

## Scenarios (14)

Per CMS (`wordpress/` + `drupal/`): (1) admin config page renders, (2) assistant
button renders on seeded content, (3) click → panel opens, the frame mounts, the
frame-owned sign-in ceremony completes and the in-frame composer goes active
(also the live frame-ancestors check), (4) prompt → in-frame AG-UI reply (asserts
the `CINATRA_UAT_OK` sentinel in `[data-embed-content]`) over the real
frame-owned auth path, (5) edit prompt → a `*_content_editor_run` tool round-trip
against the seeded page/node with **no direct CMS egress** (cinatra#1214), fenced
on the client-consumed `RUN_FINISHED` terminal, (6) invalid API key → graceful
non-500 admin-facing error, (7) **credential egress** — after a real sign-in and
a real turn, no Cinatra credential is on any parent-origin surface (network, DOM,
storage, cookies, URL/history, console), each class with its own canary and
positive control (cinatra#2674 S8e AC-2, reworked by cinatra#2708).

### The ceremony budget

The protocol-2 ceremony was measured at **19.7s** uninstrumented. `openWidget`
bounds the whole of it with `UAT_CEREMONY_BUDGET_MS` (default 60s) and every wait
inside draws from what is left, so a stalled ceremony fails naming the phase it
died in instead of drifting to the per-test timeout. Raise the env var on a
slower host; do not raise the per-test timeout instead.

### Do not re-instrument `postMessage`

The credential-egress harness is **passive on purpose**. Active
`Window.postMessage` / `MessagePort` instrumentation breaks the protocol-2
ceremony it observes (180s timeout on both CMSes vs 19.7s clean; a
handler-wrapping rewrite still stalled at 120s) — see cinatra#2708 and the file
headers in `credential-egress-harness.ts` and the two `credential-egress-uat.spec.ts`.

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
| `UAT_CEREMONY_BUDGET_MS` | `60000` | Bound on the protocol-2 sign-in ceremony (~20s measured) |
| `CINATRA_DEV_FIXTURE_PASSWORD` | *(none)* | The dev UAT account's password — set it on the dev server AND on this run (the boot mints one per boot and prints it once). At least 24 characters: a shorter value is ignored by the boot, which mints its own, and this suite refuses it rather than signing in with a password the instance never had |

If the widget DOM selectors drift, refine them in `helpers.ts` (`SEL`). The
CMS-origin shell contract is `#cinatra-root` + the `.cw-*` launcher/panel chrome
+ the `.cw-frame` iframe; the sign-in affordance and the composer/output contract
live INSIDE the iframe (`[data-embed-state="signin"]`, `[data-embed-signin]`,
`[data-embed-assistant]`, `[data-embed-content]`) — drive them via
`page.frameLocator(SEL.frame)`. The sign-in popup is a separate top-level page on
the Cinatra origin; it is driven with the seeded actor from `.uat/dev-actor.json`
and that boot's password from `CINATRA_DEV_FIXTURE_PASSWORD` — the handoff file
carries the account's identity only — typed key-by-key (`fill()` does not
register with the popup's controlled inputs under Firefox).

One honest limit of that typing: Playwright records the typed value in the
trace it keeps for a FAILED test (`trace: "retain-on-failure"`), so a local run
that fails leaves the password in `test-results/` until that directory is
cleared. Nothing publishes it — the UAT workflow uploads only the resource
snapshot and the compose logs, both of which run through the artifact scrubber
and its fail-closed scan, and the value there is a throwaway minted for that one
run. On a workstation the value is likewise this boot's and dies with it.
