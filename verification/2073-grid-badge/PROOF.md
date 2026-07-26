# cinatra#2073 — connectors grid badge resolves workspace-scoped connectors from the workspace, not personal, scope

Production-equivalent build (`next build` + `next start`, Turbopack, `CINATRA_E2E_SETUP_BYPASS`
only), driven with Playwright against the local verify stack (postgres:5634 / redis:6579), isolated
per-lane DB `gb2073`, server on port 3077. Session minted through the real Better-Auth
email/password sign-in flow.

## Fixture world (org `Default` / `ab5ef50f-…`)

| Fact | Value |
|---|---|
| Signed-in actor | `cinatra-uat@example.com` — **member** role of `Default` |
| Actor's PERSONAL connection rows | **0** (`external_mcp_servers WHERE user_id = <actor>` → 0) |
| Twenty workspace connection | `external_mcp_servers` id `twenty-workspace`, `scope=workspace`, `enabled=t`, bound Nango connection, `org_id=Default` |
| Twenty install | `installed_extension @cinatra-ai/twenty-connector` status `active` |

Fixture provenance (disclosed): the DB is cloned from a prior render proof DB (Twenty/Plane already
installed) and migrated; the workspace-scoped `twenty-workspace` row was seeded directly (enabled +
bound connection — the exact shape `saveTwentyConnection` writes, and the exact signal the Twenty
setup page reads via `getTwentyConnectionState`); the actor's credential was reset to a known value
through Better-Auth's own hasher so the sign-in is the real flow. The actor holds **no** personal
connection row in any scope — the whole point of AC1.

The badge does NOT depend on a live upstream: both the grid probe and the connector's status page
resolve "connected" from the persisted workspace row (`enabled && bound connection`), never a
live `tools/list`. No Twenty/Plane containers are needed to prove the display-layer defect.

## Resolution mechanism

Two host-owned, workspace-scoped readiness probes registered in
`src/lib/connector-readiness.server.ts`:

- **Twenty** → `getExternalMcpServerById(TWENTY_WORKSPACE_ROW_ID)`, connected iff
  `row.scope === "workspace" && row.enabled && bound Nango connection`. The
  `enabled + bound-connection` signal mirrors the connector's own status page
  (`getTwentyConnectionState`); the explicit `scope === "workspace"` guard is a
  codex fail-CLOSED hardening — the fixed id is not reserved from the generic
  external-MCP write handler (caller-supplied id + personal scope), so a spoofed
  personal row named `twenty-workspace` can never light the workspace badge.
- **Plane** → the instance-global connector-config row on the connector's own
  namespaced key (`@cinatra-ai/plane-connector:instance`), read through the host
  connector-config store — the exact path the connector's `register(ctx)` deps
  bind `loadInstanceConfig()` to. No user/org selector exists; missing/error →
  disconnected.

Both read a fixed workspace locus by id/key; the viewer's personal scope is
never consulted, and neither can fail open to another org.

## BEFORE — origin/main (`GATV72fn89NJmZsqjEZZY`)

Twenty has **no** registered readiness probe → the registry `DEFAULT_PROBE` (`{connected:false}`).

- `01-before-connected-empty.png` — the default **Connected** filter renders **"No connected
  services yet"** even though the workspace Twenty connection is enabled + healthy in the DB.
- `02-before-twenty-not-connected.png` — the **Disconnected** filter lists **Twenty CRM →
  "Not connected"** (DOM `aria-label="Not connected"`), alongside 12 genuinely-unconnected
  connectors. The connector's own status page (unchanged) shows Connected — the grid badge
  disagreed. This is the reported defect.

## AFTER — lane/2073-grid-badge (`uhEF8eVH9vEctm_3OAVIc`)

Host-owned, workspace-scoped readiness probes registered for `twenty-connector` (via
`getTwentyConnectionState()`) and `plane-connector` (via the instance-global connector-config row).

- `03-after-connected-twenty.png` — the default **Connected** filter renders **Twenty CRM →
  "Connected"** (DOM `aria-label="Connected"`) for the member whose personal scope holds **no**
  connection row. **AC1.**
- `04-after-disconnected-control.png` — the **Disconnected** filter lists **12** connectors as
  "Not connected" (Apify, Apollo, Drupal MCP, Gmail, Google Calendar, LinkedIn, MCP Clients, …) and
  **Twenty CRM is absent** — the badge discriminates correctly rather than blanket-connecting.
  **AC2** (a connector with no connection in any applicable scope still shows Not connected).

## DOM evidence (Playwright `evaluate`, live page)

| Build | Filter | Twenty CRM badge |
|---|---|---|
| BEFORE (origin/main) | Connected | absent — "No connected services yet" |
| BEFORE (origin/main) | Disconnected | **Not connected** |
| AFTER (lane/2073) | Connected | **Connected** |
| AFTER (lane/2073) | Disconnected | absent (correctly filtered out) |

## AC3 — per-connector status pages unchanged

No status-page code was touched. The probes read the SAME workspace-scoped signals those pages
already read (the `twenty-workspace` external-MCP row for Twenty; the
`@cinatra-ai/plane-connector:instance` connector-config row for Plane), so the grid badge and the
status page now agree on the same source of truth. (The Twenty probe adds a `scope === "workspace"`
guard the status page does not have — strictly fail-CLOSED, a no-op for the legitimate row, which
`saveTwentyConnection` always writes as `scope: "workspace"`.)

## AC (behavioral test)

`src/lib/__tests__/connector-readiness-probes.test.ts` — AC1 (a healthy workspace connection →
Connected for a viewer with `userId:null`, i.e. no personal scope) and AC2 (no connection → Not
connected) for both Twenty and Plane. 8/8 pass.
