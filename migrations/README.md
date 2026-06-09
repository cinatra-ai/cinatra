# Schema migrations

This directory holds the **one-shot migration artifacts for the first-party
core store schema** — the hand-mirrored DDL in
`buildCreateStoreSchemaQueries` and the Drizzle table definitions in
[`src/lib/drizzle-store.ts`](../src/lib/drizzle-store.ts).

Cinatra talks to PostgreSQL raw via `pg`. There is no ORM-managed migration
runner: the bootstrap DDL in `buildCreateStoreSchemaQueries` is **idempotent**
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded `DO`
blocks) and re-runs on every dev setup. That covers additive evolution.
What it does *not* cover is transformational change to tables that already
hold user data — drops, renames, retypes, backfills. Those are applied by
hand when a release calls for them (see
[CONTRIBUTING.md](../CONTRIBUTING.md), "Keeping your checkout up to date"),
and this directory is where they live.

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
- **Extension-owned DDL** (`src/lib/extension-migration-dsl.ts`,
  `src/lib/extension-migration-runner.ts`). Extensions declare their own
  constrained JSON migration specs; the host-side runner ledger applies them.

## What counts as a migration artifact

A migration artifact is **both** of:

1. **A SQL file at `migrations/NNNN_short-description.sql`**, where
   - `NNNN` is a zero-padded, strictly increasing 4-digit sequence number
     (`0001`, `0002`, …). The sequence is append-only: never renumber, never
     edit a migration that has shipped — supersede it with a new one.
   - `short-description` is lowercase, hyphen-separated, and names the change
     (e.g. `0001_narrow-usage-events-cost-usd.sql`).
2. **An entry appended to [`migrations/manifest.json`](manifest.json)**
   describing the migration (see the `_doc` block in that file for the entry
   shape).

A PR that needs a migration must add both pieces **in the same PR** as the
schema change.

### SQL file format

- Plain PostgreSQL, applied with `psql`. The core store schema name is not
  fixed (worktree schemas exist alongside `cinatra`), so reference it through
  the psql variable `:"schema"`:

  ```sql
  -- 0001_narrow-usage-events-cost-usd.sql
  ALTER TABLE :"schema"."usage_events"
    ALTER COLUMN cost_usd TYPE numeric(12,4);
  ```

  Applied by hand per the release notes:

  ```bash
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v schema=cinatra -f migrations/0001_narrow-usage-events-cost-usd.sql
  ```

- Migrations should be **safe to re-run** (`IF EXISTS` / `IF NOT EXISTS`
  where the statement supports it). Re-running an already-applied migration
  must not error. Beware that psql does **not** interpolate variables inside
  dollar-quoted strings, so `:"schema"` is unusable inside a `DO $$ … $$`
  block — when a migration needs procedural guards, pass the schema through a
  session setting (`SET cinatra.schema = :'schema';` then
  `current_setting('cinatra.schema')` + `format()`/`EXECUTE` inside the
  block).
- One migration per concern. Bundle the statements one schema change needs;
  do not bundle unrelated changes.

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
them up. A contributor *may* still ship an artifact for an additive change
(e.g. a long-running backfill that should not run at boot), but is not
required to.

Edge case: a table both created and dropped within the same PR never existed
on `main`, so touching it is additive overall.

## Enforcement

This convention will be enforced by a `scripts/audit`-style CI gate (landing
separately) that fails a PR which makes a destructive in-scope schema change
without shipping a migration artifact. The labelled sample diffs that gate's
classifier must reproduce live in
[`scripts/audit/__fixtures__/schema-migration/`](../scripts/audit/__fixtures__/schema-migration/)
— they are the executable form of the definitions above, and are authoritative
ahead of the gate itself.
