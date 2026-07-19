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
| 1 | Upload MIME→typed pack; uncovered/ambiguous/empty MIME refused fail-closed | PROVEN (integration/unit), **re-proven Stage 2** | `item1-upload-mime-type-map.proof.txt` (16/16 now REGISTRY-ROUTED + coupling-ban gate OK) |
| 2 | `/artifacts` library lists typed rows; chat context + recall resolve typed artifacts | PROVEN (integration/unit) | `item2-library-recall.proof.txt` (41/41 readers/serve/dispatch + 74/74 recall/disposition/identity/projector) |
| 3 | Purge dry-run + real run on a seeded fixture DB; DB write-guard rejection | **PROVEN LIVE** on the real schema, **re-proven Stage 2** | `item3-purge-cascade-guard.proof.txt` (38/38 fresh post-merge) + shape unit test 19/19 |
| 4 | Clean boot WITHOUT default-artifact | **NOT PROVABLE on this branch** (unchanged Stage 2) | retirement deferred (see below); app still boots WITH default-artifact |

## Stage 2 re-prove (branch head `851139ca7`, after the clean `origin/main` merge `4d36cdb36`)

The completing wave changed three things that bear on the battery; each was re-proven
against the merged tip:

- **Item 1 — mime-map now REGISTRY-ROUTED (commit `420598c40`).** The upload
  MIME→type resolver was re-routed OFF the hardcoded `SYSTEM_BASE_ARTIFACT_PACKS`
  pack-name literal (which tripped the `core-extension-instance-coupling-ban` gate)
  ONTO the data-driven required set — the installed `isArtifact` object types whose
  defining package is `isPackageRequiredInProd`, read from the in-process registry by
  provenance, minus the retired `*/*` floor. Re-proven: the unit suite is **16/16**
  (adds `selectRequiredArtifactUploadCandidates` with an injected registry snapshot:
  required / non-required / host / floor / no-accepts exclusion paths) and the
  `core-extension-instance-coupling-ban` gate is **OK (exit 0)**. Evidence:
  `item1-upload-mime-type-map.proof.txt`.
- **Item 3 — purge migration unchanged by the merge.** The `core__0059` live
  fixture proof was re-run FRESH on a newly-created lane DB (`prove_1785_purge` on the
  verify Postgres `127.0.0.1:5634`) via the COMMITTED scripts verbatim after the merge:
  still **38/38** (full generic-lineage cascade, precise orphan sweeps, living history
  intact, nothing dangling, shared storage untouched, guard rejects generic
  INSERT/UPDATE + allows a typed insert, idempotent). Evidence:
  `item3-purge-cascade-guard.proof.txt`.
- **Item 4 — STILL NOT PROVABLE, precisely.** "Clean boot WITHOUT default-artifact"
  requires the `@cinatra-ai/default-artifact` EXTENSION retirement (removing it from
  the equality **triple** `systemExtensions` + `requiredExtensions` +
  `cinatra-required-extensions.lock.json`). That is the deliberately-DEFERRED
  A5-remainder (couple-with-A6) and was **not started** — it is the mapped-but-not-begun
  completing wave. On this branch `default-artifact` is still `"resolution":"required"`
  in `src/lib/generated/extensions.server.ts` and present in the lock, so the app boots
  WITH it; removing it from the lock alone would fail the `required-extensions-lock`
  invariant test and the boot-time equality assertion. There is no "retired lock" on
  this branch. `registerAllObjectTypes()` (`src/lib/register-all-object-types.ts`)
  does confirm the generic `@cinatra-ai/artifact:object` catch-all TYPE is no longer
  registered at boot (A3 retirement) — but that is the type retirement, not the
  extension retirement, and does not make "boot WITHOUT the extension" demonstrable
  here. A live app boot was therefore not run; doing so would only demonstrate boot
  WITH `default-artifact`, a different claim. This is reported honestly rather than
  fabricated.

### Route-graph ratchet re-anchor (`851139ca7`)

The item-1 registry re-route adds exactly one narrowed subpath import
(`@cinatra-ai/extensions/required-in-prod` → `isPackageRequiredInProd`). That single
module is the SAME +1 newly-reachable first-party module on every tracked route
(uniform +1, MEASURED by CI with the companion extensions cloned pinned, missingCount
0). It is a required consequence of the IoC de-coupling and is not host-narrowable
short of lazy-loading a pure predicate, so the five tracked ceilings were re-anchored
+1 with annotated `#1854` absorb records (`from` = `origin/main` current ceiling,
`to` = +1), retiring the carried `#1848` records as a re-raise per the baseline's
documented pattern. The gate's own `validateAbsorbRecords` + `classifyRaises` pure
functions accept all five raises vs `origin/main` with zero violations. The file-size
ratchet is unaffected (10 files tracked, none over ceiling).

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

`origin/main` (`7706bcf1f`) has been merged into the branch (`4d36cdb36`), so
`core__0058_auditor-review-companion` is now present alongside this lane's
`core__0059_purge-default-artifact-floor`; the tree carries both. `0059 > 0058` so
the sequence is valid and the branch is up to date with the merged `origin/main`.
If a concurrent lane claims `0059` on `main` before this PR merges, renumber-at-merge
to the next free seq is the standard remedy (not a defect in the migration).
