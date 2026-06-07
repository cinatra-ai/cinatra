# @cinatra-ai/notifications

Subtree-specific guidance for the notifications package. These constraints are load-bearing for boot-graph correctness, client-bundle purity, and DDL/writer drift safety.

## Four entry points (NEVER add a fifth mixed barrel)

| Entry | File | `server-only`? | Purpose |
|---|---|---|---|
| `@cinatra-ai/notifications/types` | `src/types.ts` | no | Pure types (`NotificationKind`, `NotificationRecipient`, `NotificationInput`, `NotificationRecord`, `AppNotification`) + structural `ActorContext` + `BetterAuthSessionLike` re-export from the leaf. Zero runtime deps. |
| `@cinatra-ai/notifications/client` | `src/client.ts` -> `flyout-state.ts` + `notifications-flyout.tsx` | no, `"use client"` | Pure collapse logic + the flyout component. Browser-safe. |
| `@cinatra-ai/notifications/server` | `src/server.ts` -> service / realtime / recipient-policy / request-actor / agent-run-href | yes (each module keeps `import "server-only"`) | All server-side writers/readers/realtime. Re-exports `setNotificationsHostAdapters` for ergonomic non-boot callers only. |
| `@cinatra-ai/notifications/host-adapters` | `src/host-adapters.ts` | no, **TRUE LEAF** | `NotificationsHostAdapters` contract + package-local `ActorContext` + `BetterAuthSessionLike` + idempotent setter/getter singleton. **MUST stay leaf-pure: no `@/`, no `server-only`, no transitive import of `./service|./realtime|./recipient-policy|./request-actor|./server`.** |

Mirror the `@cinatra-ai/agents` convention: each entry has its own tsconfig path alias, its own `vitest.config.ts` alias, and its own line in `packages/notifications/package.json` `exports`. **Subpath imports require the `exports` map** -- root tsconfig/vitest aliases mask the gap in dev, but Next/pnpm native subpath resolution fails `MODULE_NOT_FOUND` without it (see [[feedback_subpath_workspace_pkg_needs_exports]] -- generalized memory entry).

## Host adapters -- explicit contract, not a god-port

The package never imports `@/lib/database`, `@/lib/postgres-sync`, `@/lib/auth-session`, or `@/lib/authz/enforce` directly. The host wires the explicit `NotificationsHostAdapters` (DB primitives + `postgresSchema` + lazy `getAuthSession`/`buildActorContext`) at `src/lib/notifications-host.ts`, which is side-effect-imported on **every direct `/server` entry path**:

- `src/lib/notifications.ts` (the facade)
- `src/app/api/notifications/stream/route.ts` (bypasses the facade)
- `src/lib/background-jobs.ts` (top-level `@/lib/notifications-host` import -- the worker path from `instrumentation.node.ts` -- **NOT** a package import; it's a host module that side-effect-registers adapters)

`recipient-policy.ts` is **host-schema-aware by design** (it knows Better-Auth `public."user"` / `"teamMember"` / `"member"` + `{schema}."project_co_owners"` schemas). The SQL strings stay inside the package; the DB *access primitives* are injected. Don't introduce a generic PostgresPort that hides this coupling -- it was an explicit BLOCKER.

## Boot-graph rules (load-bearing -- break these and dev boots ESM/TDZ)

1. **`background-jobs.ts` MUST keep `@cinatra-ai/notifications/server` imports DYNAMIC** at all three sites (`:824` `resolveImplicitActorContext`, `:1062` `notifyJobLifecycle`, `:1114` `notifyJobStarted`). No top-level package-server import. Grep gate: `! grep -q "^import .* from \"@cinatra-ai/notifications/server\"$" src/lib/background-jobs.ts`.
2. **`notifications-host.ts` MUST import the setter ONLY from the TRUE-LEAF `/host-adapters`**, never `/server`. Else the boot-time top-level import drags the entire server graph (service/realtime/recipient-policy/request-actor) onto `instrumentation.node.ts`'s eager worker bootstrap. Grep gate: `! grep -q "@cinatra-ai/notifications/(server|client|types)" src/lib/notifications-host.ts`.
3. **Auth adapters MUST be LAZY** -- `getAuthSession`/`buildActorContext` are `async () => (await import("@/lib/auth-session"))...`. A static `@/lib/auth-session` import pulls `@/lib/auth` and its top-level async Google-OAuth config onto the boot graph.
4. **HARD post-change gate after ANY module-topology edit:** `rm -rf .next && nohup pnpm dev > /tmp/dev.log 2>&1 & ; sleep 18 ; grep -iE "error|reference|tdz|cannot access|module not found|host adapters not set" /tmp/dev.log` must return empty. Teardown the dev server with `SIGTERM` only -- `SIGKILL` corrupts `.next`.

## ActorContext drift assertion (compile-time)

`host-adapters.ts` carries a **FULL field-for-field structural copy** of the host `ActorContext` from `src/lib/authz/actor-context.ts` (incl. required `authSource` + `policyVersion` + the `Principal` discriminated union -- NOT a minimal subset, because `background-jobs.ts` returns the package resolver's result into a slot typed as host `ActorContext`, requiring package -> host assignability).

`src/lib/notifications-host.ts` contains a **bidirectional** type-level assertion (`HostActorContext = {} as PackageActorContext` AND the reverse, no casts). Any future host-side ActorContext change that breaks assignability either way fails `pnpm typecheck`. Host type stays source of truth; the package copy is the drift-guarded mirror.

## DDL stays in `drizzle-store.ts`; schema-contract test guards drift

The notifications table DDL + `AFTER INSERT` trigger live in `src/lib/drizzle-store.ts::buildCreateStoreSchemaQueries()` (DO NOT move them out). `src/lib/notifications/__tests__/schema-contract.test.ts` calls the real generator and pins a **fixed `EXPECTED_COLUMNS` set** (incl. `href`, `metadata`, `source_job_id`) + the `ON CONFLICT (user_id, source_job_id, kind)` literal + the AFTER-INSERT trigger byte-for-byte against the writer SQL in `packages/notifications/src/service.ts`. **Neither side is derived from the other** -- a silent `href`/`metadata` drop on either side fails CI.

## Test files stay under `src/` (root vitest constraint)

Root `vitest.config.ts` `test.include` is `src/**/__tests__/**` only -- there is NO per-package vitest config. Moving test files into `packages/*` would silently drop them from the runner (the inverse of the mass-rename-drops-tests hazard). When changing test contracts: keep files under `src/lib/notifications/__tests__/` (server modules) / `src/app/api/notifications/__tests__/` (route) / `src/components/__tests__/` (flyout import guard) / `src/lib/__tests__/` (`background-jobs-auto-attribution.test.ts`, `background-jobs-actor-context.test.ts`), repoint imports to the package entries, and update the root-vitest alias list (4 entries: `/types` / `/client` / `/server` / `/host-adapters`).

## After-write invariants

- AFTER INSERT trigger + `ON CONFLICT DO NOTHING` => **first write wins forever**. There is NO UPDATE/repair path that reaches open SSE tabs. Any field that must reach the client (canonical example: `href` from `agent-run-href.ts`) MUST be correct on the very first insert.
- `notifyJobStarted` (`worker.on("active")`) fires BEFORE the dispatcher runs. Anything the inserted row needs (e.g. resolved `href`) must be synchronously awaited before the insert.

## Agent-run href resolver -- canonical from `run.templateId`, never jobData

`agent-run-href.ts` builds the deep-link href from `job.data.runId -> readAgentRunById -> run.templateId -> readAgentTemplateById -> template.packageName -> buildAgentInstancePath`. **NEVER read a slug/packageName carried in jobData** -- stale or parent slugs render the run under the wrong agent shell. **NEVER read from `job.id`** -- BullMQ job ids are inconsistent (`runId` / `agent-builder-${runId}` / `resume-${reviewTaskId}` / A2A auto-assigned). The whole resolver body is wrapped in `try/catch -> undefined` so the worker never breaks on a writer-path failure.
