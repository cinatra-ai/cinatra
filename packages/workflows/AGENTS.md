# @cinatra-ai/workflows — AGENTS.md

The **Workflows** package provides a versioned, scoped, calendar-driven
workflow spec in Postgres (single source of truth), a DST-correct schedule
resolver, transition/gate state machines, a BullMQ reconciler, and a
step-executor registry. **A workflow is a first-class process DAG — not an
agent.**

## Layout

| Path | Purpose |
|------|---------|
| `src/db.ts` | Lazy `pg.Pool` + Drizzle (Proxy value-exports). |
| `src/schema.ts` | 10 Drizzle tables (workflow_template, workflow, workflow_task, workflow_dependency, workflow_gate, workflow_event, workflow_task_attempt, workflow_dispatch_lease, workflow_artifact, workflow_approval). |
| `src/spec/` | Shared Zod spec (template/draft/instance), resource limits, 3 validation tiers. |
| `src/schedule/resolver.ts` | Server-side schedule resolver (`@date-fns/tz`) + cascade diff. |
| `src/state/` | Transition matrices + roll-up; gate-ledger model. |
| `src/scope/` | Read-visibility (auth-derived org), resource-ref, delegated execution actor. |
| `src/lint/` | Trigger-bundling lint. |
| `src/store.ts` | Persistence (server-only). |
| `src/integration/register-object-types.ts` | Object-layer registration. |

## Non-negotiable invariants

1. **Fresh-schema-safe DDL.** New tables/columns are declared in BOTH `src/schema.ts`
   (Drizzle, drives reads/writes) AND `src/lib/drizzle-store.ts`
   `buildCreateStoreSchemaQueries` (raw DDL, drives fresh-schema boot). **The two
   must agree** (columns, NOT NULL, FK CASCADE vs RESTRICT, indexes). Emit tables
   **base → FK-dependent**. Validate with `pnpm check:fresh-schema` (applies the
   full DDL to a throwaway schema). A mis-ordered statement crashes Next
   instrumentation on every fresh worktree/clone boot.
2. **Lazy DB pool.** Never `new Pool()` at module top level — create it inside the
   getter (`db.ts`). Guarded by `src/lib/__tests__/db-pool-lazy-init.test.ts`.
3. **Postgres is the source of truth.** The engine is a thin driver.
4. **Auth-derived org is the tenant boundary.** Read-visibility and the execution
   actor key off `session.activeOrganizationId` — NEVER a body id.
5. **Evidence is immutable.** `workflow_task_attempt` / `_approval` / `_artifact`
   FK the task with `ON DELETE RESTRICT` (a task with run/approval/artifact
   evidence cannot be deleted); structural tables (`_dependency`/`_gate`) CASCADE.
6. **Leaf package.** Host authz/archive functions are INJECTED (no `@/lib` import in
   `src/`); only object registration imports `@cinatra-ai/objects/registry` (the
   light subpath, not the heavy barrel).
7. **agent_task is host-injected + idempotent + crash-safe.** The package defines
   the executor contract (`engine/executors.ts`) but the `agent_task` executor +
   child-run poller live in the host (`src/lib/workflow-agent-executor.ts`, wired
   at boot in `src/instrumentation.node.ts`) — they reach the app-layer agent-run
   enqueue chokepoint the leaf can't import. Child dispatch is keyed by the
   per-attempt idempotency key `${workflowId}:${taskId}:${attemptNo}` (passed to
   `createAgentRun`, which is race-safe on the partial-unique
   `agent_runs_idempotency_key_uniq`). The reconciler reads child status OUTSIDE
   the advisory lock and settles UNDER it with a CAS that requires the task still
   `running` and the attempt's `child_run_id` unchanged.
8. **Paused edit = FK-safe diff-and-apply, not delete-reinsert.** `updateWorkflowDraftSpec`
   edits drafts via delete-reinsert (no evidence) but paused workflows via
   `diffApplySpecRows`: UPDATE existing tasks in place (preserving id/status/`actual*`/
   attempts), INSERT new, DELETE a removed task ONLY when it has zero evidence across
   ALL three RESTRICT FKs (attempts + artifacts + acted-upon approval) — else throw a
   sentinel to roll back (the workflow-row CAS must not half-commit). Evidence-bearing /
   non-`idle`/`scheduled` tasks have their execution identity FROZEN (columns + deps +
   approval definition + timing; planning/display fields stay editable). Runs under the
   per-workflow advisory lock so the reconciler's claim is serialized against it. Approval
   decisions are advisory-lock-serialized + reject `invalidatedAt` rows; the diff-apply
   applies review-packet staleness SYNCHRONOUSLY (the reconciler skips paused
   workflows) — reopening an opened, not-yet-consumed approval whose packet changed.
   `computeReviewPacketHash` is shared via `state/review-packet.ts`. Hermetic browser
   coverage: `pnpm test:e2e:workflows`.

## Validation tiers

`template-valid` (structural DAG, placeholders OK) → `draft-valid` (concrete:
release date, no placeholders, resolvable schedules, within horizon) →
`start-valid` (startable now; rejects approval-gated workflows until the
approval start path is implemented). All errors are structured
`{code, message, path?, limit?, actual?}`.

## DST policy (resolver)

Relative offsets are calendar durations applied in the task/release tz, then →
UTC via `@date-fns/tz` `TZDate`. Spring-forward gap → roll forward + `DST_GAP`
warning; fall-back ambiguity → earlier offset. Wall-clock local time is preserved
across DST boundaries.

## Tests

- `pnpm test` — unit (no DB, `pool:"forks"`).
- `pnpm test:integration` — store CRUD + fresh-schema assertions against the
  isolated schema. Run `cinatra setup branch` first (provisions `cinatra_<slug>`),
  then `pnpm --filter @cinatra-ai/workflows test:integration`.
- `pnpm test:e2e:workflows` (from the repo root) — hermetic Playwright suite for
  the `/workflows` management surface (`tests/e2e/workflows/`,
  `tests/e2e/config/workflows.config.ts`). Seeds an org-scoped paused/attempt-bearing
  workflow via `pg` (no LLM/connector keys needed) and walks the index + detail
  pages. Opt-in, not on the build-image.yml merge gate; the unit + integration
  jobs are the always-on CI gates for this package.

## DB-schema preflight

Adding tables here changes the app schema. Per the repo DB-change protocol, before
shipping schema changes to a live instance: (1) `cinatra backup create`,
(2) `cinatra backup export-api-configs`, (3) decide the migration type. These
tables are **additive** (new `CREATE TABLE IF NOT EXISTS` only — no ALTER/DROP on
existing tables), so a fresh boot creates them idempotently and existing data is
untouched; no data migration is required.
