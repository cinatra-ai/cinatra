# Schema migrations sit ABOVE per-org write policy

> Companion to the org-write kernel (`packages/org-write-kernel`) and the
> non-registry system writer manifest
> ([`scripts/audit/system-writer-manifest-gate.mjs`](../../../scripts/audit/system-writer-manifest-gate.mjs)).
> This contract states — and justifies — why numbered schema migrations are the
> ONE org-data-touching surface that is deliberately outside per-org write
> policy, and draws the boundary that keeps that exception from becoming a
> loophole.

## The statement

Cinatra's org-write kernel rules every runtime write to an org-axis table: a
writer must hold a capability, the write is scoped to an org, and it fails
closed when the org's lifecycle (archive / epoch) forbids it
(`guardOrgMutation`, the capability table, org archive leases).

**Schema migrations do not go through any of that, and that is correct.**
Versioned migrations — the node-pg-migrate code modules in
[`migrations/core/`](../../../migrations/core/), plus the idempotent bootstrap
`buildCreateStoreSchemaQueries` — execute DDL *and* data backfills with:

- **no `guardOrgMutation`** wrapping their statements,
- **no capability ruling** (they hold no `OrgWriteCapability`; there is no
  actor frame),
- **no per-org lifecycle check** — a migration rewrites every org's rows in one
  pass, archived orgs included,
- **no org locks** beyond whatever the migration itself takes.

A migration's backfill can `UPDATE cinatra.objects` across all tenants; the
kernel never sees it. This document exists so that fact is a *documented
contract* rather than a silent gap someone later "fixes" by bolting per-org
policy onto the migration runner (which would deadlock it — see below).

## Why this is correct, not a gap

**1. Migrations run at a privilege boundary above tenancy.** They *define the
tables the kernel rules over.* The capability table cannot rule on a column
that does not exist yet; an org archive lease cannot protect rows in a table a
migration is still creating or reshaping. Ordering makes the point: the schema
must exist before per-org policy can be expressed against it, so the surface
that establishes the schema is necessarily upstream of the surface that polices
it. This is the same reason the bootstrap and migrations run at **app boot**
([`src/instrumentation.node.ts`](../../../src/instrumentation.node.ts) → boot
orchestrator) before any request-time writer is reachable.

**2. They are serialized, not concurrent.** node-pg-migrate applies migrations
one at a time and records each in the **`pgmigrations` ledger inside the app
schema** (`SUPABASE_SCHEMA`, default `cinatra`; each worktree/branch schema
carries its own ledger). There is exactly one migrator, in a known order, with
a durable applied-migration record — the properties per-org concurrency control
exists to provide are already supplied structurally.

**3. They cannot consult per-org lifecycle mid-flight without deadlocking.** A
migration that tried to take the archive/epoch locks it might legitimately need
to *migrate* — the very rows those locks guard — would contend with itself: the
lock protecting an org's rows is a row the migration is reshaping. Per-org
gating inside a migration is not merely unnecessary, it is unsafe. The correct
place for a per-org *decision* is a reconciler that runs after the schema is in
place (see the boundary rule).

## The compensating controls (by name)

Migrations are unpoliced by the kernel, but they are not unreviewed. Four
named controls stand in:

| Control | What it enforces |
| --- | --- |
| [`scripts/audit/schema-migration-gate.mjs`](../../../scripts/audit/schema-migration-gate.mjs) | A **destructive** change to the core-store schema (drops/renames/retypes in `buildCreateStoreSchemaQueries` / `createStoreTables`) fails CI unless it ships the migration artifact the [`migrations/README.md`](../../../migrations/README.md) convention requires — a `migrations/core/core__NNNN_*.mjs` runner module PLUS its `migrations/manifest.d/*.json` fragment. Shape review, before the migration can land. |
| The org-write raw-SQL sweep ([`scripts/audit/org-write-table-sweep.mjs`](../../../scripts/audit/org-write-table-sweep.mjs)) | Scans `src/` + `packages/` + `scripts/` for new raw org-axis DML and **allowlists `packages/migrations/`** while never scanning the top-level `migrations/` tree at all. That allowlist is the deliberate statement that **migrations own their backfill DML** — it is accounted for here, not an escape. |
| This issue's non-registry writer manifest ([`scripts/audit/system-writer-manifest-gate.mjs`](../../../scripts/audit/system-writer-manifest-gate.mjs)) | Enumerates and freezes every non-registry system writer in the boot / instrumentation / CLI scan roots. Its scan roots **deliberately exclude every migration tree** — migrations are this contract's exception, not manifest rows. The exclusion is documented in the gate header and here so the two agree. |
| The migration ledger (`pgmigrations`) | Every applied migration is durably recorded in the app schema, in order. The audit trail of *what schema change ran* is the ledger; the audit trail of *runtime org writes* is `audit_events`. Migrations belong to the former by design. |

## The boundary rule (the loophole-closer)

The exception is scoped to schema evolution and data *shape* change. The moment
a backfill needs a **per-org policy decision**, it is no longer a migration:

> A migration backfill that must make per-org decisions — e.g. *skip archived
> orgs*, *apply only to orgs on epoch N*, *branch on an org's lifecycle state* —
> is **not** a migration. It must be a **boot-phase or CLI reconciler**.

Such a reconciler:

1. runs **after** the schema is in place (boot phase / one-shot CLI), so the
   tables and the per-org policy it reads both exist;
2. lands as a row in the **non-registry writer manifest** above — it is exactly
   the population that manifest enumerates (a backfill / reconciler that reaches
   org data outside both registries); and
3. **mints system authority** for its writes through the org-write kernel (post
   the #1941 wave-3 wiring, via the job-system authority seam), so its per-org
   decisions are capability-bound, org-scoped, and archive-safe — the policing a
   migration correctly cannot do.

Put plainly: *shape the table in a migration; decide per-org in a reconciler.*
If you find yourself wanting to read an org's archive state inside
`migrations/core/`, stop — that write belongs in a boot phase or CLI, on the
manifest, under minted authority.
