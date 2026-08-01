# WordPress settings-catalog UAT

The acceptance suite for cinatra-ai/cinatra#2022 S7's final criterion:

> Settings catalog viewer + health badges verified on a live rendered build
> (Playwright) with screenshots on the PR.

It drives the "Site tools & access" card that ships in
`@cinatra-ai/wordpress-mcp-connector` (`src/wordpress-site-tools-card.tsx`) and
renders on the connector's settings surface, one card per configured site.

## What it asserts

| Panel | Assertions |
| --- | --- |
| Catalog viewer | one card per configured site; per-row identity (`label ?? serverId`) and provenance line (`source · v<version>`); the no-servers empty state |
| Health badges | the per-connection header badge (which replaced the static "Connected"), per-server-row health, and per-pipeline readiness — each checked for **both** its label and its semantic `data-variant` |
| Hydration | the access-mode toggle (open-mode warning appears, Save arms/disarms against the persisted record) and the quick-fix/editor interlock |

Every badge assertion pins the semantic variant as well as the text, so a badge
that says the right words in the wrong colour fails.

## What it deliberately does not do

It never submits **Save tool selection** or **Allow required tools**. Those are
the card's write surface — gated host-side by `manage` + org-admin on the
instance's owning org — and they are covered by the connector's own unit suite
(`src/__tests__/wordpress-site-tools-card.test.tsx` and
`src/__tests__/setup-actions.test.ts`). Staying read-only keeps the shared
fixture matrix stable across tests and keeps the acceptance claim scoped to the
criterion actually being certified: the viewer and its badges.

## Fixtures

The badge state space is reached by seeding the two persisted stores the card
reads, plus the connector's instance list. Nothing is stubbed and no route is
intercepted — the real host reads, the real server components and real client
hydration all run.

| Store | Purpose |
| --- | --- |
| `cinatra.metadata` @ `connector_config:wordpress` | the connector's instance list (a plain JSON blob — only the `nango` connector-config has sealed secret fields) |
| `cinatra.connector_instance_server` | the discovered-server health matrix |
| `cinatra.connector_instance_tool_policy` | the per-instance allow/deny record |

Five sites cover what is deterministically assertable against an unroutable
host (see **Determinism** below):

| Site | Header badge | Notes |
| --- | --- | --- |
| Catalog Editorial Site | `No MCP servers enrolled` | four **non-enrolled** rows carry the per-row health labels: Available / Authentication error / Not checked yet / Retired |
| Blocked Campaign Site | `Unreachable` | policy allows nothing → all three pipelines read `Blocked`, because policy gaps outrank server health |
| Unreachable Archive Site | `Unreachable` | full allow, so readiness demotes on **server** health instead |
| Denied Staging Site | `No MCP servers enrolled` | a denied ability is listed as always-blocked |
| No Servers Site | `No MCP servers enrolled` | zero rows → the empty-state copy |

The last two pin a designed asymmetry: readiness is policy-driven and only a
known-bad **enrolled** default server demotes it, so both read `Ready` while
their header badges decline to claim "Connected".

### Determinism

`listInstanceServers` returns the current store rows and then kicks a
fire-and-forget re-probe of every **enrolled** row. The fixture sites are
unroutable `.invalid` hosts (RFC 2606), so that probe rewrites each enrolled
row's `last_status` to `unreachable`.

None of the obvious levers suppress it:

* the 60s per-instance debounce is an in-process `Map` that does **not** hold
  across renders here — rows are observably re-probed on every navigation;
* the probe's own guard (`refreshEnrolledServerHealth` returns early unless the
  instance resolves `siteUrl` + `username` + `applicationPassword`) reads the
  **same** instance row the settings page renders from, so blanking a credential
  to disable the probe also removes the connection card entirely; and
* per-test instance ids are invisible to the app for 10s, because the instance
  list is read through the connector-config cache
  (`CONNECTOR_CONFIG_CACHE_TTL_MS`, `src/lib/database.ts`).

So the fixture is built to be **invariant** under the probe rather than to race
it:

1. every **enrolled** row is seeded `unreachable` — the exact verdict the probe
   writes — so a render before the probe and a render after it are identical;
2. the richer per-row health labels are covered on **non-enrolled** rows, which
   the refresh skips outright (`row.status !== "enrolled"`) and whose seeded
   `last_status` is therefore stable; and
3. policy-driven state (summary badge, pipeline readiness, the allow/deny
   editor) never depends on the probe at all.

Each test still re-seeds before it navigates, and seeding is scoped to the
fixture id prefix, so local WordPress instances survive a run.

#### Known coverage gap

The header-badge states that require a **healthy enrolled** server — `Connected`
and `Connected — health unverified` — and the `success` variant of a per-row
health badge are **not** asserted here, and are not faked. The probe demotes any
enrolled row to `unreachable` before the assertion runs, so covering them needs a
**reachable** fixture site that answers the MCP discovery probe (the repo already
runs a WordPress container for the wp-drupal UAT), not a seeded status.
`deriveSiteConnectionBadge`'s healthy branches are unit-covered in the
connector's own suite; what is missing here is the live-render proof.

## Running it

Against a production-equivalent build — this is what the acceptance evidence was
captured on, and what CI should use (same shape as the RBAC gate's job):

```sh
pnpm build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cp .env.local .next/standalone/.env.local    # standalone reads its OWN cwd
(cd .next/standalone && PORT=3000 HOSTNAME=127.0.0.1 \
   CINATRA_E2E_SETUP_BYPASS=true node server.js &)
# wait for /api/auth/get-session to return 200 — the instrumentation hook
# provisions the cinatra schema on first query
E2E_REUSE_SERVER=1 pnpm test:e2e:wp-settings-catalog
```

Against a dev server instead:

```sh
pnpm dev                                  # in another shell (port 3000)
CI= pnpm test:e2e:wp-settings-catalog     # CI= forces reuseExistingServer
```

Useful env: `E2E_PORT` / `E2E_BASE_URL` to point at a clone band or a
lane-scoped server, and `E2E_WP_SETTINGS_SHOT_DIR` to redirect the screenshots
(default `test-results/wp-settings-catalog-evidence/`).

Two environment prerequisites are easy to miss, because each one surfaces as a
confusing "Connections tab not found" rather than as itself:

* **`CINATRA_E2E_SETUP_BYPASS=true` is required on the production server too**,
  not only on the `pnpm dev` fallback. Without it a freshly provisioned instance
  redirects every authenticated route to `/setup`, and the suite lands on the
  setup **wizard** — whose progress rail carries its own "Connections" step, so
  even the failure message points at the wrong element.
* **The port must be one the auth config trusts.** Better Auth answers
  `403 INVALID_ORIGIN` for an untrusted origin, which shows up as a
  sign-up/sign-in failure inside the setup project.

## Prerequisite: the connector pin

The connector must be synced at a revision that ships the card (PR #103,
`479364d` or later). With an older pin the settings page renders the previous
static "Connected" badge and this suite fails at the first health-badge
assertion — which is the intended signal, not a flake.

At `479364d` itself the settings surface does not render at all: `settings-page.tsx`
is a server component that imports and calls `deriveSiteConnectionBadge` from
`wordpress-site-tools-card.tsx`, a `"use client"` module, so React throws

```
Attempted to call deriveSiteConnectionBadge() from the server but
deriveSiteConnectionBadge is on the client.
```

and the whole Connections tab renders the "Application Error" boundary. The fix
is to move the pure derivation into a directive-free module both sides import.
This suite is what surfaced that, and it stays red until the connector ships the
fix.
