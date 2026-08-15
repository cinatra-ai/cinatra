# cinatra#2534 — the precise Funnel-preview reason, proven end to end

The last leg of #2534. The host seam (batch PR #2563) renders a cause-specific
notice **when the connector reports a reason code**; tailscale-connector#65
(merged as `9061f2c3`) makes the connector report one. This repo's dev lock
still pinned the connector at `c866f9a5` — four commits before that emitter —
so `getDevTunnelStatus()` kept reading `null` and the honest cause-agnostic
branch kept rendering. This branch moves that one pin, and this directory is
the live proof that moving it is what flips the surface.

**Verdict: PASS, with a control arm.** Same host, same database, same seeded
row, same host-side code — only the connector checkout SHA differs between the
two arms, and it alone decides which branch renders.

| Arm | tailscale-connector SHA | `data-funnel-preview-state` | Captures |
|-----|-------------------------|------------------------------|----------|
| control (the pin before this PR) | `c866f9a5` | `unknown` — cause-agnostic | `oldpin-control-*` |
| **under test (this PR's pin)** | `9061f2c3` | **`unregistered-identity`** — precise | `newpin-*` |

## Surface

- Host: a lane host (`<lane-host>`, macOS 15.4.1, **x86_64**) — installed
  fresh per `<lane-checkout>/RECIPE.md`; no artifact was copied from an arm64
  machine.
- Checkout: `<lane-checkout>/lane-2534` at this branch's commit
  `1bd786fa6952437e131337303c577bda2059b2f7`.
- Companion tree: `node scripts/ci/sync-dev-extensions.mjs --pinned` →
  `111/111`, `extensions/cinatra-ai/tailscale-connector` detached at
  `9061f2c3c3fee63fd77d12cb21a62a825892f490` (the lock's own sha).
- `pnpm install --frozen-lockfile` succeeded on that tree — the pin and
  `pnpm-lock.yaml` are not skewed, which is the check CI would run.
- Lane isolation: port 3534, database `lane2534` on the standing dev Postgres,
  Redis db 6, queue `cinatra-lane2534-jobs`. Migrations by the app's own
  `pnpm setup:dev` (`Cinatra dev setup complete.`, 164 `cinatra` tables, all
  111 extensions linked).
- One Chromium, one page, `workers=1`. `domcontentloaded` + selector waits
  (`networkidle` never fires under Next dev).

## The condition seeded — and how it differs from the #2563 UAT

`evidence/batch-225/README.md` seeded `connector_config:tailscale` to
`{"connected":true}` with **no tailnet**. That is the right condition for the
branch that run was checking, but it is the wrong condition for this one:
`getTailscaleFunnelUrlPreviewReason()` returns `null` when the tailnet is
unresolved (that cause has no minted code), so a no-tailnet instance renders
the cause-agnostic branch **even on the new pin**. Reproducing #2534's actual
report — "Tailscale connected, tailnet resolved, still no Funnel URL, because
this instance has no sanctioned identity" — requires a resolved tailnet plus an
unsanctioned identity. So the row seeded here is:

```sql
INSERT INTO cinatra.metadata (key, value) VALUES
  ('connector_config:tailscale',
   '{"connected":true,"tailnet":"tail8a34f1.ts.net","authMode":"api_key"}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

The identity half is not seeded at all — it is the instance's own shape, which
is exactly the plain-install shape the issue was filed on:

```json
{ "currentDatabase": "lane2534", "SUPABASE_SCHEMA": null, "CINATRA_DEV_MAIN_DATABASE": null }
```

`classifyDevTailscaleIdentity` sees a database that is not `cinatra_clone_*`,
no `cinatra_*` schema and no main declaration, and falls through to
`DEV_TAILSCALE_UNREGISTERED_CODE`. The issue reported `database "postgres"`;
this lane runs an isolated `lane2534` so it cannot disturb the host's other
checkouts. Both land on the identical branch and the identical code — the
connector's own log line on this run says so:

```
[connector-tailscale] no Funnel URL preview: tailscale.unregistered_dev_identity —
This dev instance has no sanctioned Tailscale tunnel identity (database "lane2534", schema "(unset)").
```

That line appears in **both** arms. It is the point of the whole issue: the
connector always *computed* the precise reason and only logged it. What the new
pin changes is that it now *reports* it to the host through the optional
`getFunnelUrlPreviewReason` getter, so the surface can stop guessing.

## What the browser asserted

`newpin-assertions.json` (arm under test), read off the live DOM after clicking
the field the way an operator does:

```
state = "unregistered-identity"
"TAILSCALE: This instance has no sanctioned Tailscale identity, so no Funnel URL
 is derived for it. Reconnecting the connector will not change that. Paste an
 externally reachable HTTPS URL below — for example a Funnel you already run on
 this host. To get an auto-derived URL instead, run this instance as a clone or
 a worktree."
```

- `data-funnel-preview-state="unregistered-identity"` — the precise branch.
- Says the identity is unsanctioned, and says **reconnecting will not help** —
  the dead-end instruction the issue was filed about is gone.
- Offers the paste remediation and the clone/worktree route.
- The cause-agnostic sentence is **absent** — the `unknown` branch did not
  render.
- The original blanket copy ("tailnet not resolved yet — reconnect the Tailscale
  connector to refresh") is absent.
- Zero console errors.

`oldpin-control-assertions.json` (control arm), identical everything except the
connector checkout:

```
state = "unknown"
"TAILSCALE: No Funnel URL is available for this instance. The tailnet may not be
 resolved yet, or this instance may have no sanctioned Tailscale identity —
 reconnecting the connector does not help in the second case. Paste an
 externally reachable HTTPS URL below — for example a Funnel you already run on
 this host."
```

- `data-funnel-preview-state="unknown"`, precise identity copy absent.
- Zero console errors.

The control is what makes this a proof rather than a screenshot: with the pin
rolled back in place, the same seeded instance renders the cause-agnostic
branch, and rolling it forward again reproduces the precise branch (the
`newpin-*` captures here are from that second, post-control run).

## Captures

| File | What it shows |
|---|---|
| `newpin-tunnel-tab.png` | the whole tunnel tab, new pin, flyout closed |
| `newpin-tunnel-flyout.png` | the flyout open with the precise identity copy |
| `newpin-flyout-notice.png` | the notice element alone |
| `newpin-assertions.json` | the measured DOM state + every assertion |
| `newpin-identity-inputs.json` | the identity inputs and the seeded row |
| `oldpin-control-*` | the same five, on the pre-PR pin |

## Harness

Lane-local and deliberately not committed (same choice as `evidence/batch-225`):
this branch carries the pin and the evidence, no test-surface changes. The
script lived at `capture-2534.mjs` in the lane checkout (a capture script must
live inside the repo — node ESM resolves bare specifiers from the file's
location) and is `.git/info/exclude`d there. It:

1. mints a platform-admin session with the repo's own render-smoke pattern
   (`tests/e2e/render-smoke/auth.setup.ts`): sign-up, promote
   `public."user".role` to include `admin` **before** sign-in, ensure an org
   membership, sign in, set the active org, save the storage state;
2. drives one Chromium at 1440x900 to
   `/configuration/development?tab=tunnel`, clicks `#publicBaseUrl` (retrying
   until hydration lands, since the flyout is client state), and reads
   `[data-funnel-preview-state]` plus its text;
3. writes the assertions JSON and the screenshots, and exits non-zero on any
   failed assertion.

Nothing on the path under test is stubbed: the connector activates from the
pinned tree, registers the real `dev-tunnel-status` provider, and the page
resolves it at request time.

Two environment facts about the run, stated plainly:

- `CINATRA_E2E_SETUP_BYPASS=true` was set on the dev server. It is the repo's
  own documented browser-e2e switch (`src/lib/setup-wizard.ts`, used by
  `tests/e2e/config/render-smoke.config.ts`) and it clears only the setup-wizard
  redirect; it does not authenticate, and it touches nothing on the tunnel tab.
  It is required here because completing the wizard for real needs an LLM
  provider key, and no credential may exist on a lane host.
- `BETTER_AUTH_URL` was pointed at the lane port so Better Auth's origin check
  accepts requests on 3534 instead of 3000.

## Teardown

`pnpm dev:stop` (SIGTERM to the recorded wrapper/child pids), `lsof -nP
-iTCP:3534 -sTCP:LISTEN` confirmed empty, no process left under the lane
checkout. The standing shared Postgres/Redis containers were left running as
found; the disposable `lane2534` database and the lane checkout remain for
re-verification.
