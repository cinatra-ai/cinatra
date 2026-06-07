# Twenty CRM cutover runbook

One-shot, operator-run procedure that completes the Twenty CRM migration by
wiping the legacy CRM pointer rows from `cinatra.objects` and letting the
provider-agnostic CRM facade (`crm_*` → Twenty) own account/contact/list data
going forward.

This is a **destructive, one-shot** operation. CI never runs it. It runs once,
by an operator, against the local dev / target dev database, as the last step
of the migration.

## What it does

`scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs`:

1. Refuses to run against a non-dev database (`assertDevDatabase` blocks remote
   hosts + non-`cinatra` schemas unless `--i-know-this-is-dev` is passed —
   test-DB only).
2. Confirms there are no in-flight CRM-touching agent runs.
3. Drains the Graphiti projection outbox.
4. Deletes every `@cinatra-ai/entity-accounts:account`,
   `@cinatra-ai/entity-contacts:contact`, and `@cinatra-ai/lists:list` pointer
   row from `cinatra.objects` (in the configured `SUPABASE_SCHEMA` only) in a
   single transaction.

The wipe is **schema-scoped** — it touches only the `cinatra.objects` table in
`SUPABASE_SCHEMA`. It deletes only the **cinatra-side pointer rows**; Twenty's
own data is whatever the operator put there before the cutover.

## Preconditions

- The legacy CRM surfaces are already retired: agents + the list-picker route through the
  `crm_*` facade; the `lists_*` MCP primitives are unregistered; the
  entity/list UI routes are deleted (no cinatra-side CRM browse — CRM lives
  in Twenty); the `entity-accounts` / `entity-contacts` / `lists` packages
  are deleted from the repo. (The `crm-pointer-gate --strict` CI check
  enforces that no legacy CRM read/primitive has crept back.)
- Twenty is reachable and the `twenty-workspace` external-MCP row is configured
  (so post-cutover reads resolve).
- `SUPABASE_DB_URL` + `SUPABASE_SCHEMA` point at the target dev database.

> Branch-mode caveat (read before step 2): in the default light worktree model
> a worktree's data lives in a `cinatra_<slug>` SCHEMA inside the SHARED
> `postgres` database, and the Better Auth tables live in the shared `public`
> schema (see `AGENTS.md` → Worktree Setup). The wipe is schema-scoped and safe
> there, but a FULL-database backup/restore is NOT — restoring a whole-DB dump
> would clobber every other worktree's schema + the shared auth tables. So the
> snapshot in step 2 must be SCHEMA-SCOPED, or you must run the cutover against
> a dedicated isolated database (a deep-fork clone via `cinatra setup clone`, or
> a managed DB with its own snapshot facility).

## Procedure

### 1. Dry-run probe (read-only — always do this first)

```bash
node scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs --dry-run
```

The dry-run surfaces any blockers (active agent runs, undrained outbox,
non-dev DB) and reports the row counts that the destructive run would delete.
Resolve any blocker before proceeding. If the outbox is the only blocker, you
can drain it inline with `--drain-outbox-now`.

> Non-localhost test DB only: if `SUPABASE_DB_URL` points at a remote test
> database (not localhost / 127.0.0.1) you must add `--i-know-this-is-dev` to
> every invocation below — it relaxes the dev-DB host/schema guard. NEVER pass
> it against a production database; it is the explicit "I accept this is not a
> localhost dev DB" escape hatch, not part of the default command.

### 2. Take a pre-cutover SCHEMA-SCOPED snapshot (mandatory — this IS the rollback)

The wipe is a one-shot, irreversible delete. Capture a snapshot you can restore
from BEFORE the destructive step, and record its id / path. Snapshot ONLY the
configured schema (never a full-DB dump on a shared branch-mode database — see
the caveat above):

```bash
# schema-scoped dump (local docker Postgres example — adjust to your deployment):
pg_dump "$SUPABASE_DB_URL" -Fc -n "$SUPABASE_SCHEMA" \
  -f "twenty-cutover-pre-$(date +%Y%m%d-%H%M%S).dump"
# record the resulting file path (or, on a dedicated/managed DB, the snapshot id):
#   SNAPSHOT = ____________________________
```

If you are on a dedicated isolated database (deep-fork clone or managed DB),
a whole-DB snapshot is also fine — but on the shared branch-mode `postgres`
database use the schema-scoped form above. Do not proceed until you have a
verified snapshot.

### 3. Stop the app + workers

```bash
# stop the dev server + the BullMQ worker (or the production app + workers)
```

Stopping the workers prevents a new CRM-touching run from starting mid-wipe.

### 4. Run the destructive cutover

```bash
node scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs --yes
```

`--yes` is the only flag the destructive path requires (the historical
`--unlock-destructive` second gate was removed once the legacy paths were
retired). With `--yes` alone the dev-DB guard enforces localhost / 127.0.0.1 +
a `cinatra*` schema and aborts otherwise — do NOT add `--i-know-this-is-dev`
unless you are deliberately targeting a non-localhost test DB (see the note in
step 1).

Exit codes: `0` completed · `1` blocker (active agent runs / undrained outbox /
non-dev DB) · `2` invocation error (missing env / bad flags) · `3` runtime
error during the delete.

### 5. Restart + smoke (manual)

```bash
pnpm dev   # or restart the production app + workers
# wait for /api/health to return 200
```

The script has no smoke flag — run these checks by hand:

1. UI: `/entities/accounts`, `/entities/contacts`, and `/lists` 404 (the
   cinatra-side CRM browse was deleted; humans go to Twenty
   directly).
2. CRM read: a find-contact-by-email through the chat resolves against Twenty.
3. A new CRM-touching agent run (e.g. contact-discovery) persists through the
   `crm_*` facade without error.

## Rollback

There is no in-place rollback for the deleted pointer rows (the wipe is a
one-shot reset by design — D7 wipe-and-reseed). The ONLY rollback is to restore
the pre-cutover snapshot captured in step 2.

Restore must REPLACE the schema-scoped state, not merge into it. The step-2
archive is a custom-format (`-Fc`) single-schema dump that carries both the
schema DDL and all table data, so restoring it onto the still-populated schema
without cleaning first would collide with the existing relations and duplicate
every row the wipe did not remove. Use `--clean --if-exists` so `pg_restore`
drops and recreates each object before reloading it, and keep it
`-n "$SUPABASE_SCHEMA"` so the DROPs only ever touch the configured schema —
never the other worktree schemas or the shared `public` (Better Auth) schema:

```bash
# replace the schema's contents with the step-2 schema-scoped snapshot:
pg_restore --clean --if-exists --no-owner \
  --single-transaction --exit-on-error \
  -n "$SUPABASE_SCHEMA" \
  -d "$SUPABASE_DB_URL" \
  "<SNAPSHOT from step 2>"
# (on a dedicated/managed DB you may instead roll back to the whole-DB snapshot)
```

`--single-transaction` wraps the whole restore so any error rolls the schema
back to its pre-restore state instead of leaving a half-restored schema. Do NOT
run a `--clean` restore from a WHOLE-DB dump against the shared branch-mode
`postgres` database — that would drop every other worktree's schema and the
shared auth tables; the `-n "$SUPABASE_SCHEMA"` scoping above is what makes
`--clean` safe here.

This is why step 1 (dry-run), step 2 (schema-scoped snapshot), and step 3
(stop workers) are mandatory and must run in that order before step 4.

## Seeding note

Post-cutover, `pnpm seed` no longer populates CRM fixtures via the
`cinatra.objects` pointer rows — those are wiped. CRM-native reseeding is the
cutover path's responsibility (records land in Twenty through the `crm_*`
facade); the demo seed script only populates the non-CRM fixtures.
