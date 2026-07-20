# Proof — core\_\_0060 guarded dynamic-types ENGINE teardown (#1793)

Live proof that `migrations/core/core__0060_drop-dynamic-object-types.mjs` — the
guarded destructive drop of the `dynamic_object_types` registry table (owner
ruling 2026-07-18; epic cinatra#1785 entry 95; closes #1793) — does exactly what
it claims against **real Postgres**, on the verify stack, running the migration's
**own SQL** in one all-or-nothing transaction.

Branch: `lane/1793-engine-teardown` @ `5741a758999676faa810d933b8e76e76a8a4c649`.
Stack: verify Postgres `127.0.0.1:5634`, fresh lane DB `verify_1793`.

## What the migration does (in brief)

The type model is now the dependency model: a live object type exists only as a
registry-declared definition from an installed `kind:artifact` extension. The
auto-registrar that wrote `dynamic_object_types` and every read of it are deleted
in this same PR, so the table is dead substrate and is dropped. The drop is
**guarded**: it `RAISE`s (aborting the transaction, leaving the table intact)
unless three entry-95 preconditions hold, each a distinct message so the operator
sees which one blocked:

- **(a)** zero non-retired `artifact_type_claims` reference a type still present in `dynamic_object_types`;
- **(b)** the `artifact_binding_reconcile_queue` is drained of unfinished (`pending`/`failed`) dynamic-type work;
- **(c)** the #1792 projection purge has converged — no unfinished (`status <> 'done'`, incl. `processing`) `graphiti_projection_outbox` row remains for a dynamic-typed object.

Completed history (`retired` claim, `done` queue/outbox) never blocks. On a DB
that never had the table the whole guard is skipped and `DROP TABLE IF EXISTS` is
a no-op; a second run is idempotent.

## The two captures

### `proof-1-db-gated-integration.txt` — authoritative, on the REAL store schema

The committed DB-gated suite
`src/lib/__tests__/integration/drop-dynamic-object-types.test.ts` builds the
**real store schema** via `buildCreateStoreSchemaQueries` (`src/lib/drizzle-store.ts`),
seeds engine-table fixtures, and runs the **real migration `up()`** through an
owned-connection pgm shim in one transaction. **12/12 passed**, covering:

- AC#4 — no-op on a DB that never had the table; drop on a populated table; idempotent re-run.
- legacy `id`/`payload`-shaped table (no `type` column) — dropped without the by-type guards erroring.
- AC#1 — REFUSES individually on (a) a non-retired claim, (b) a pending queue row, (c) a processing outbox row; the `retired`/`done` counterparts do **not** block; all-clean runs CLEAN.
- shape — exports `up()` + a refusing `down()`; ships the append-only ledger fragment (seq `0060`, destructive, `tables: [dynamic_object_types]`).

### `proof-2-teardown-assertions.txt` — the acceptance list, spelled out row-by-row

`reproduce-teardown-assertions.mjs` imports the **real migration module**
(`buildGuardSql` / `buildDropSql` / `up`), seeds a dynamic-type row + completed-history
coupling **and** living registered-type rows, runs `up()` in one transaction, and
asserts the list the task calls out explicitly, in two parts. **12/12 passed**:

Success path:

- the engine table + its type-definition rows are **GONE**;
- **no dangling refs** — zero inbound FKs targeted the table (drop orphans nothing structurally); string-keyed history rows remain intact;
- **living typed rows UNTOUCHED** — registered-type objects byte-identical, their `active` claim and a `pending` (live, non-dynamic) queue row untouched;
- **idempotent** second run is a clean no-op.

Guard teeth (so a dropped/weakened guard cannot slip past this proof alone):

- each precondition **(a)** non-retired claim, **(b)** pending queue row, **(c)** processing outbox row REFUSES — `up()` rejects with the exact `precondition (x)` message, the transaction rolls back, and `dynamic_object_types` **survives**.

## Reproduce

```sh
# cwd = worktree root; verify Postgres up on :5634
docker exec verify-cinatra-postgres-1 psql -U postgres -c "CREATE DATABASE verify_1793;"
SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1793 node scripts/apply-public-schema.mjs

# proof 1 — DB-gated integration suite on the real store schema
CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1793 \
  pnpm exec vitest run --config vitest.config.ts --no-coverage \
  src/lib/__tests__/integration/drop-dynamic-object-types.test.ts --reporter=verbose

# proof 2 — supplemental teardown assertions via the migration's own SQL
SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1793 \
  node docs/internals/proofs/1793-teardown/reproduce-teardown-assertions.mjs
```

## Files

- `proof-1-db-gated-integration.txt` — captured vitest run (12/12) on the real store schema.
- `proof-2-teardown-assertions.txt` — captured supplemental run (9/9).
- `reproduce-teardown-assertions.mjs` — the committed proof-2 script (imports the real migration).
