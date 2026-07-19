# Wave PROVE — deep-slice verify-stack proof battery (epic cinatra#1785, A6 branch)

Verification evidence for the `lane/1785-deep-slice` bot PR. Captured against the
verify Postgres (`127.0.0.1:5634`) on the REAL store schema. Reproduction scripts
and captured console output are committed alongside this note.

## Scope reality of this branch (READ FIRST)

`lane/1785-deep-slice` carries the deep slice **A1–A6**: the type-driven
disposition seam (A1), the effective-identity resolver rework (A2), the writer
cutover to a REQUIRED validated `objectType` + MIME→pack map (A3), the type-driven
readers (A4), the dead claim-arbitration deletion (A5-safe-slice), and the
`core__0059` purge migration + DB write-guard (A6).

The **default-artifact EXTENSION retirement** (removing `@cinatra-ai/default-artifact`
from the equality triple, deleting the generated `artifact-floor.ts`, and sweeping
the ~7 live floor writers + ~24 importers) is **DEFERRED by design** to a coupled
follow-up — see the `core__0059` header comment ("the fresh-install bootstrap
mirror + the generic-seeding fixture sweep are the COUPLED A5-remainder follow-up")
and `.planning/A5-OUTCOME.md`. This branch therefore still boots WITH
`@cinatra-ai/default-artifact` (`"resolution":"required"` in `extensions.server.ts`
and present in `cinatra-required-extensions.lock.json`). This directly bounds
proof item 4 below.

## Per-item status

| # | Proof item | Status | Evidence |
|---|------------|--------|----------|
| 1 | Upload MIME→typed pack; uncovered/ambiguous/empty MIME refused fail-closed | PROVEN (integration/unit) | `item1-upload-mime-type-map.proof.txt` (11/11) |
| 2 | `/artifacts` library lists typed rows; chat context + recall resolve typed artifacts | PROVEN (integration/unit) | `item2-library-recall.proof.txt` (41/41 readers/serve/dispatch + 74/74 recall/disposition/identity/projector) |
| 3 | Purge dry-run + real run on a seeded fixture DB; DB write-guard rejection | **PROVEN LIVE** on the real schema | `item3-purge-cascade-guard.proof.txt` (38/38) + shape unit test 19/19 |
| 4 | Clean boot WITHOUT default-artifact | NOT PROVABLE on this branch | retirement deferred (see above); app still boots WITH default-artifact |

Items 1 and 2 are proven at the integration/unit boundary (the landed A3 writer +
A4 reader suites), NOT via a live Playwright chat-flyout browser walk — the app
dev server + browser were not brought up in this wave. The writer suite
`packages/objects/.../handlers-fail-closed-writes.test.ts` shows 12/13 under the
package-local vitest; the single miss is a package-isolation alias artifact
(`@/lib/objects/draftable-lock-gate`, an app-src dynamic import byte-identical to
`origin/main`, resolved under the app config) — not a lane regression.

## Item 3 — live cascade + guard methodology (the crown-jewel destructive change)

`reproduce-build-schema.mts` builds the **REAL** store schema via
`buildCreateStoreSchemaQueries` (the exact boot-path DDL) into a throwaway DB, so
every one of the ~20 cascade tables and all three append-only delete-rejection
triggers (`trg_representation_append_only`,
`trg_run_context_selections_append_only`,
`trg_artifact_uninstall_op_assertions_append_only`) exist exactly as production.

`reproduce-purge-cascade-guard.mts` then seeds a fixture — a RETIRED generic floor
artifact `@cinatra-ai/artifact:object` with full lineage across every cascade
table + change-event/remote-effect history, a LIVING pack-typed
`@cinatra-ai/pdf:document` artifact with its own lineage sharing a resource, an
uninstall op shared by both, change_sets that are retired-only / mixed /
living-only, and a surviving child object parented at the retired row — and
executes the migration's OWN exported `buildPurgeSql()` + `buildGenericWriteGuardSql()`
in a single transaction (as `up()` does). 38/38 assertions confirm:

- legacy generic rows + their FULL lineage gone (every artifact_id/object_id child,
  representation, run_context_selections, uninstall assertions, change events,
  remote-effect attempts);
- orphan sweeps precise — the retired-only uninstall op and the retired-only
  change_set are swept; the shared uninstall op and the mixed/living-only
  change_sets SURVIVE;
- living rows + their history intact;
- nothing dangles (the surviving child's `parent_id`/`parent_type` NULLed; zero
  dangling child references anywhere);
- shared content-addressed storage (`resource` / `artifact_blobs`) never touched
  (reachability-delegated);
- the DB write-guard REJECTS a hand INSERT and an UPDATE to the retired generic
  type and ALLOWS a valid pack-typed INSERT;
- a second purge run is a clean no-op (idempotent).

### Reproduce

```
SUPABASE stack up (pg 127.0.0.1:5634). Then from the repo root:
docker exec verify-cinatra-postgres-1 psql -U postgres -c "CREATE DATABASE prove_1785_purge;"
npx tsx docs/internals/proofs/1785-a6/reproduce-build-schema.mts
npx tsx docs/internals/proofs/1785-a6/reproduce-purge-cascade-guard.mts
```

The build script stubs the two Better-Auth tables the store FKs reference
(`public."user"`, `public."organization"`) and the cascade script drops the single
`authoring_step_artifacts` convenience FK (the object graph is app-integrity, not
DB-FK; the purge SQL is FK-agnostic) — both are throwaway-DB conveniences that do
not alter the migration's behavior.

## Merge prerequisite (coordinator)

`origin/main` has advanced to `core__0058_auditor-review-companion`; this branch's
tree jumps `0057 → 0059`. `0059 > 0058` so the sequence is valid, but the branch
must be brought up to date with `main` (so `0058` is present) before an
admin-merge — an up-to-date-only merge prerequisite, not a defect in `0059`.
