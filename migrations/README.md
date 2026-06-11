# Schema migrations

This directory holds the **versioned migrations for the first-party core
store schema** — the hand-mirrored DDL in `buildCreateStoreSchemaQueries` and
the Drizzle table definitions in
[`src/lib/drizzle-store.ts`](../src/lib/drizzle-store.ts).

Cinatra talks to PostgreSQL raw via `pg`. Two mechanisms evolve the schema:

1. **The idempotent bootstrap** (`buildCreateStoreSchemaQueries`, run by
   `ensurePostgresSchema` at boot and mirrored by the setup CLI's base-table
   pass): `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded
   `DO` blocks. It re-runs on every boot/setup and covers **additive**
   evolution.
2. **node-pg-migrate** (cinatra#116, the core arm of the org-wide decision in
   cinatra#115): versioned **code-module migrations** in
   [`migrations/core/`](core/), applied programmatically and recorded in the
   **`pgmigrations` ledger inside the app schema** (`SUPABASE_SCHEMA`,
   default `cinatra` — each worktree/branch schema carries its own ledger).
   This covers **transformational** change to tables that already hold user
   data — drops, renames, retypes, backfills, file/API/data steps.

## How migrations run

- **App boot** (`src/instrumentation.node.ts` →
  `src/lib/core-migrations.ts`): after the bootstrap DDL, before cache warm /
  extension activation / queue workers. Dev mode logs a failure loudly and
  keeps booting; **production aborts boot on a failed migration** — serving
  new code against a half-migrated schema is unsafe.
- **Setup** (`cinatra setup dev|prod`, `setup branch`, `make refresh`):
  the CLI runs the same runner right after its base-table pass. On a **fresh
  schema** (no `metadata` table yet) the chain is **ledger-faked** — recorded
  without executing — because the bootstrap produces the current,
  post-migration shape on fresh databases.
- **Ops / rollback**: `pnpm db:migrate` / `pnpm db:migrate:down` (or
  `node packages/cli/bin/cinatra.mjs db migrate [--down] [--count=N]`, which
  also works inside the production image via `docker exec`). `--down` calls
  the migration's `down()` and pops its ledger row; it refuses to run if the
  newest ledger rows belong to another source (see "One ledger" below). For a
  NON-core source, `cinatra db migrate --down --dir <abs> --namespace <ns>`
  is the operator escape hatch — point it at the owning extension's
  materialized migrations directory to revert its newest rows first.
- **Existing deployments** (operator upgrade path): nothing to do beyond a
  normal upgrade. The first post-upgrade boot or `cinatra setup …` creates
  `<schema>.pgmigrations` and applies the pending chain (`core__0001`…
  `core__0003`); on databases that already carry those changes every
  statement is guarded, so the run only backfills the ledger. `psql`-applied release-note
  migrations are retired going forward — new changes auto-apply at boot/setup.

The runner (single implementation:
[`packages/cli/src/core-migrations.mjs`](../packages/cli/src/core-migrations.mjs))
drives node-pg-migrate's programmatic `runner()` on a dedicated short-lived
`pg` client created inside the call — never a top-level pool — and serializes
under the same database-global advisory lock the bootstrap DDL and the
extension migration host use (`pg_advisory_lock(hashtext('cinatra-schema-init'))`,
with node-pg-migrate's own lock disabled via `noLock`).

### One ledger, namespaced sources (#115)

The `pgmigrations` ledger is shared org-wide: core migrations are named
`core__NNNN_…`; extension migrations (#118) use `ext_<scope>_<pkg>__NNNN_…`
(the namespace derives from the package name: `@cinatra-ai/foo-connector` →
`ext_cinatra-ai_foo-connector__`). node-pg-migrate's `checkOrder` is disabled
because it assumes a single-source ledger; its safety is replaced by the
runner's per-namespace filename/seq preflight and, for core, this
convention's CI gate (append-only, strictly increasing seqs). Rolling back
(`--down`) is fenced per namespace for the same reason.

## Scope

The convention covers the **first-party core store schema only** — the
executed `CREATE`/`ALTER` DDL in `buildCreateStoreSchemaQueries`
(`src/lib/drizzle-store.ts`). The Drizzle table definitions in
`createStoreTables` (same file) are in scope where they mirror one of those
tables: a change there is a schema change exactly when the executed DDL for
that table changes with it.

**Out of scope** — these are owned elsewhere and never require an artifact
here, even when touched in the same pull request:

- **Better Auth schema** (`src/lib/better-auth-schema.ts`,
  `src/lib/better-auth-plugins.ts`, `scripts/better-auth-migrate.mts`).
  Owned by Better Auth's `getMigrations()` and guarded by the
  `auth-schema-drift` CI job.
- **Extension-shipped migrations** (#118). Trusted-signed extensions ship
  standard node-pg-migrate modules INSIDE their own package (a directory
  declared via `cinatra.migrationsDir`, modules named
  `ext_<scope>_<pkg>__NNNN_<short-description>.mjs`); the host applies them
  through the same shared runner into the same `pgmigrations` ledger
  (`src/lib/extension-migration-host.ts`) at boot / install / hot-activate.
  Their artifacts live in the extension's own repository — never here — so
  this directory's artifact convention does not apply to them. The authoring
  contract for extension authors lands in `packages/sdk-extensions/README.md`
  with cinatra#119.

## What counts as a migration artifact

A migration artifact is **both** of:

1. **A node-pg-migrate code module at
   `migrations/core/core__NNNN_short-description.mjs`**, where
   - `core__` is the fixed per-source ledger namespace (never omit it),
   - `NNNN` is a zero-padded, strictly increasing 4-digit sequence number
     (`0001`, `0002`, …). The sequence is append-only: never renumber, never
     edit, rename, or delete a migration that has shipped — supersede it with
     a new one.
   - `short-description` is lowercase, hyphen-separated, and names the change.
2. **An entry appended to [`migrations/manifest.json`](manifest.json)**
   describing the migration (see the `_doc` block in that file for the entry
   shape; `file` is relative to `migrations/`, e.g.
   `core/core__0003_….mjs`).

A PR that needs a migration must add both pieces **in the same PR** as the
schema change.

> **Legacy artifacts.** `migrations/0001_*.sql` and `migrations/0002_*.sql`
> are the pre-runner psql artifacts (applied by hand per release notes;
> `psql … -v schema=cinatra -f migrations/NNNN_….sql`). They remain in place
> as shipped history — never delete them — and their runner forms
> (`core/core__0001_…`, `core/core__0002_…`) re-express them 1:1 so the
> ledger covers the full chain. The loose-SQL form is **retired for new
> migrations**: the runner never executes it, and the CI gate rejects it.

### Authoring a migration

A migration is a plain ESM module exporting `up(pgm)` and `down(pgm)`
(node-pg-migrate's `MigrationBuilder`):

```js
// migrations/core/core__0003_narrow-usage-events-cost-usd.mjs
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE usage_events
  ALTER COLUMN cost_usd TYPE numeric(12,4);`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`ALTER TABLE usage_events
  ALTER COLUMN cost_usd TYPE numeric(12,8);`);
}
```

Rules the runner and the deployment lineages impose:

- **Raw SQL via `pgm.sql`** is the default; the full `pgm.*` builder API and
  arbitrary async work (file moves, API calls, data transforms) are
  available. Use `pgm.noTransaction()` when a statement cannot run inside a
  transaction (e.g. `CREATE INDEX CONCURRENTLY`); otherwise each migration
  runs in its own transaction.
- **Unqualified table names.** The runner sets `search_path` to the app
  schema, which is what keeps worktree/branch schemas working. Reference
  shared Better Auth objects explicitly as `public."…"`.
- **Safe to re-run on a schema already at target shape** (`IF EXISTS` /
  `IF NOT EXISTS` guards). Fresh databases bootstrap at the CURRENT shape
  and ledger-fake the chain; reset/seed flows can re-encounter applied
  states. A migration must also tolerate the bootstrap lineage it shipped
  against — when in doubt, guard cheaply (see the `information_schema` guard
  in `core__0001` for the pattern).
- **Plain runtime ESM only**: no `@/` imports, no TS, no repo files outside
  `migrations/` — the module also runs inside the production image, where
  only `migrations/` and the traced `node_modules` exist.
- **Write a real `down()`** (or document why it is irreversible). `down` is
  the rollback path for `cinatra db migrate --down`.
- One migration per concern. Bundle the statements one schema change needs;
  do not bundle unrelated changes.
- **The bootstrap DDL must end up describing the fresh, post-migration
  shape** in the same PR (e.g. a dropped column disappears from the `CREATE`
  text). Destructive *operational* SQL belongs in the migration module, not
  in new guarded bootstrap statements — the legacy guarded drops that
  predate the runner stay as documented history.

## When a migration artifact is required

An artifact is required when a change to the in-scope schema **affects
user-land data** — i.e. it can lose, corrupt, or invalidate rows that already
exist in a deployed database. The bootstrap DDL alone cannot express such a
change safely, because `CREATE TABLE IF NOT EXISTS` is a no-op on existing
tables.

**Destructive (artifact required):**

- `DROP TABLE` / `DROP COLUMN` on a table that exists on `main` (including
  removing a table or column from the `CREATE` DDL text — the deployed
  database still has it).
- Renaming a table or column.
- Retyping a column (`ALTER COLUMN … TYPE`), including narrowing a type's
  precision or scale (e.g. `numeric(12,8)` → `numeric(12,4)`,
  `text` → `varchar(n)`).
- Adding `NOT NULL` to an existing column, or adding/tightening a `CHECK`,
  `UNIQUE`, or foreign-key constraint over rows that already exist. A
  **unique** index on an existing table counts here too — it can fail outright
  on existing duplicates and needs a dedup pass first (see the `member` dedup
  block in the bootstrap DDL for what that costs).
- Changing an existing foreign key's `ON DELETE` rule.
- Data rewrites against existing tables (`UPDATE` / `DELETE` /
  `INSERT … SELECT` backfills).

**Additive (no artifact required):**

- A new table.
- A new nullable column (`ADD COLUMN IF NOT EXISTS … <type>`), or a
  `NOT NULL` column on a table created in the same change.
- A new **non-unique** index, including partial indexes.
- New constraints and unique indexes scoped to a table created in the same
  change (no pre-existing rows to violate them).

Additive changes ride the idempotent bootstrap DDL — `make refresh` picks
them up. A contributor *may* still ship a migration module for an additive
change (e.g. a long-running backfill that should not run at boot), but is not
required to.

Edge case: a table both created and dropped within the same PR never existed
on `main`, so touching it is additive overall.

## Enforcement

This convention is enforced by
[`scripts/audit/schema-migration-gate.mjs`](../scripts/audit/schema-migration-gate.mjs)
(the `schema-migration-gate` job in `build-image.yml`): it diffs a PR against
its base, classifies in-scope schema changes per the definitions above, and
fails when a destructive change ships no migration artifact (or ships the
retired loose-SQL form). Independently of any schema change, it also fails a
PR that tampers with shipped migration state — deleting, renaming, or editing
a shipped artifact, rewriting a manifest entry, or adding a
`migrations/core/` file (malformed name, re-used sequence number) that would
break the runner's boot preflight — and any migration-state inconsistency in
the diff itself: a valid executable `migrations/core/` module without its
manifest entry (the runner executes every valid module regardless of the
manifest), a manifest entry without its module, or sequence drift. The labelled sample diffs its classifier must
reproduce live in
[`scripts/audit/__fixtures__/schema-migration/`](../scripts/audit/__fixtures__/schema-migration/)
— they are the executable form of the definitions above, and the gate's test
suite replays every one of them. When the convention gains a new
destructive/additive case, add the fixture and the classifier rule in the
same PR.

At runtime, the runner preflights `migrations/core/` (filename contract,
unique seqs) before applying anything — the replacement for node-pg-migrate's
single-source `checkOrder`.
