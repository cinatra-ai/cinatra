# Default-off feature flags

A handful of runtime environment flags gate **opt-in, preview/experimental
surfaces** that ship in the code but are **off by default**. They are not dead
code — each gates a real production route that a deployment must deliberately
turn on. They default off so a deployment never exposes an external ingress (or
a not-yet-finished capability) it did not choose to enable.

Each flag is read from `process.env` at request time and is enabled **only** by
the exact string `"true"`. Any other value (unset, empty, `"1"`, `"TRUE"`) leaves
the surface disabled. Set them in the deployment environment (not in the app UI).

| Flag | Gates | Default (unset) behavior | Enable with |
| --- | --- | --- | --- |
| `CINATRA_A2A_HTTP_ENABLED` | The external Agent-to-Agent HTTP surface — `POST /api/a2a` (non-streaming JSON-RPC + streaming SSE). | Route returns **404** ("A2A HTTP surface disabled"). | `CINATRA_A2A_HTTP_ENABLED=true` |
| `CINATRA_AGUI_EXTERNAL_ENABLED` | (a) AG-UI execution-event passthrough multiplexed into the `/api/a2a` SSE stream; (b) the external HITL approval gate `POST /api/a2a/resume`. | `/api/a2a/resume` returns **404**; the AG-UI passthrough is skipped, so `/api/a2a` serves the plain A2A stream only. | `CINATRA_AGUI_EXTERNAL_ENABLED=true` |
| `CINATRA_TOKEN_BROKER_ENABLED` | The token-broker capability advertised by `POST /api/connect/token`. | `tokenBrokerAvailable()` reports **false**, so the CMS falls back to the legacy direct-stream path. | `CINATRA_TOKEN_BROKER_ENABLED=true` |

## Details

### `CINATRA_A2A_HTTP_ENABLED`

- **Surface:** `src/app/api/a2a/route.ts` (`POST /api/a2a`).
- **When unset:** the handler short-circuits with a `404` before auth, so the
  external A2A JSON-RPC / streaming surface is invisible.
- **When `true`:** requests are authenticated with a Bearer JWT (verified against
  Better Auth's OAuth provider plugin, canonical origin used for
  audience/issuer) exactly like `/api/mcp`.
- **Why gated:** the external agent-to-agent ingress is opt-in preview — a
  deployment must consciously expose it. Turning it on does not change the auth
  requirement; unauthenticated callers are still rejected.

### `CINATRA_AGUI_EXTERNAL_ENABLED`

- **Surfaces:** `src/app/api/a2a/route.ts` (AG-UI passthrough branch) and
  `src/app/api/a2a/resume/route.ts` (`POST /api/a2a/resume`).
- **When unset:** `/api/a2a/resume` returns `404`; the `/api/a2a` stream does not
  multiplex AG-UI execution events (it falls back to the plain A2A stream, which
  is also the failure-safe path if AG-UI multiplexing ever errors).
- **When `true`:** Bearer-JWT external consumers can (a) receive live AG-UI
  execution events over the A2A SSE response, and (b) approve a pending
  human-in-the-loop review task to resume a paused agent run. Per-run access is
  still authorization-checked for the verified actor before any event stream is
  tapped or any review task is resolved — the flag exposes the surface, it does
  not bypass authorization.
- **Why gated:** it opens live execution telemetry and an external HITL resume
  path to programmatic callers; a deployment opts in explicitly.

### `CINATRA_TOKEN_BROKER_ENABLED`

- **Surface:** `src/app/api/connect/token/route.ts` (`tokenBrokerAvailable()`).
- **When unset:** the capability is reported `false`, and the CMS falls back to
  the legacy direct-stream path — the safe, shipped default.
- **When `true`:** the route advertises token-broker availability. The flag is a
  simple switch wired ahead of the broker fully landing, so it can be turned on
  without editing the handler once the broker is ready.
- **Why gated:** the broker capability is preview/not-yet-complete; the default
  keeps deployments on the proven direct-stream path.

## Not on this page: the lifecycle activation switches

`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` and
`CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW` are **not** default-off flags and
have never been listed here. They are the inverse posture — **default ON with an
explicit opt-out**, deactivated only by the exact value `off` (cinatra#2047,
owner ruling 2026-07-27). They gate product behaviour that ships enabled, not an
opt-in preview ingress, so the doctrine on this page does not apply to them.
They are specified in
[the lifecycle review policy, §6 Activation](../governance/lifecycle-review-policy.md),
and implemented in `src/lib/lifecycle/lifecycle-activation.ts`. Do not add a
default-ON switch to the table above.

## Adding a new default-off flag

If you introduce another `CINATRA_*_ENABLED`-style opt-in gate, add a row here so
the flag is discoverable rather than silently dormant. Keep the doctrine
consistent: default off, enabled only by the exact string `"true"`, fail closed
(disabled / 404 / legacy fallback) when unset, and never let the flag bypass an
authorization or auth check — it should gate *exposure*, not *security*.
