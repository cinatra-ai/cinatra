# Attribution-record correction — d624a19 (enforce tenant scoping on legacy sync-table routes)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `d624a19272277b54c7aeed43b94f8390285ba115`
("fix(api): enforce tenant scoping on legacy sync-table routes (#861)"), which the
post-merge `truthful-attribution-gate` failed on: the squash body carried the
`Assisted-by` records but the **machine verification arm was omitted**.

## What landed

d624a19 (PR #861) enforces tenant/owner authorization in-handler on a set of API
routes over the legacy JSON "sync" tables (chat threads, agent runs) that
previously relied on the cookie-existence route-guard middleware as their only
gate:

- `src/app/api/agents/runs/[runId]/route.ts` + `.../stream/route.ts`: thread the
  caller through `readAgentRunById` so `enforceRunAccess` runs the real per-run
  access check before run messages are read or the SSE stream is opened.
- `src/app/api/chat/thread/[threadId]/route.ts` + `src/app/api/chat/save/route.ts`
  + `src/lib/chat-thread-store.ts` + `src/lib/chat-thread-access.ts`: tenant-scoped
  chat-thread read/write (owner / team-org-membership / admin; server-derived
  ownership, no body spoofing).
- `src/app/api/wizard/[resourceType]/[resourceId]/activate/route.ts` +
  `src/app/api/development/logs/route.ts`: validated-session + platform-admin gate
  on those privileged mutations.
- `src/app/api/agents/instance-name/route.ts`: validated-session requirement.
- `src/app/api/assistants/list/route.ts`: active-org-scoped human directory.
- `src/lib/postgres-sync-inventory.ts` + `docs/architecture/postgres-sync-inventory.json`:
  classify the extracted sync-table reader (inventory ratchet upkeep).
- Unit + route-handler tests for every route.

## Non-high-risk classification

None of the changed files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`. In particular: none live under `**/auth/**`, `**/permissions/**`,
`**/session/**`, `src/lib/auth*`, `**/migrations/**`, `.github/**`,
`packages/sdk-extensions/**`, the extension trust/registry trees, or the
release/publish-script set. The API routes are `src/app/api/**` handlers, the new
libs are `src/lib/chat-thread-*.ts`, and the inventory artifacts are
`src/lib/postgres-sync-inventory.ts` + a `docs/architecture/*.json` file — all
non-high-risk. (Reading a session inside a handler is not the same as matching a
`session*` / `auth/**` PATH.)

## Resolution

The change is non-high-risk and its full gate-suite ran green on the reviewed head
`fb22a909ba68757aa425e2fe67227de96d98ae0c` (every required check concluded
success, including the typecheck/unit suite, the RBAC authz suite, the route-graph
/ file-size / postgres-sync-inventory ratchets, source-leak, and CodeQL). The
machine arm is therefore the correct and sufficient verification for this merge;
it was simply omitted from the squash body. This note records that forward
correction; the corrective squash carries the machine arm below.
