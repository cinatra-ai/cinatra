# Wave PROVE — deep-slice verify-stack proof battery (epic cinatra#1785, A1–A6 + retirement)

Verification evidence for the `lane/1785-deep-slice` bot PR (#1854). Captured against the
verify Postgres (`127.0.0.1:5634`) on the REAL store schema. Reproduction scripts and
captured console output are committed alongside this note. All four items are now proven
at the final branch tip.

## Scope reality of this branch (READ FIRST)

`lane/1785-deep-slice` carries the deep slice **A1–A6** — the type-driven disposition
seam (A1), the effective-identity resolver rework (A2), the writer cutover to a REQUIRED
validated `objectType` + MIME→pack map (A3), the type-driven readers (A4), the dead
claim-arbitration deletion (A5-safe-slice), the `core__0059` purge migration + DB
write-guard (A6) — **and the completing `@cinatra-ai/default-artifact` EXTENSION
retirement**: the extension is removed from the equality **triple** (`cinatra.systemExtensions`
+ `cinatra.extensions`/requiredExtensions + `cinatra-required-extensions.lock.json`, now
13 entries each), `extensions/cinatra-ai/default-artifact/` is deleted, the generated
`packages/objects/src/generated/artifact-floor.ts` const is deleted, and the ~7 live floor
writers + importers are swept. This branch therefore **boots WITHOUT** `@cinatra-ai/default-artifact`
— which is what proof item 4 below demonstrates live.

## Per-item status

| # | Proof item | Status | Evidence |
|---|------------|--------|----------|
| 1 | Upload MIME→typed pack; uncovered/ambiguous/empty MIME refused fail-closed | **PROVEN**, re-proven Stage 3 | `item1-upload-mime-type-map.proof.txt` (16/16 registry-routed + coupling-ban gate OK) + live in `item4-clean-boot.proof.txt` Part C |
| 2 | `/artifacts` library lists typed rows; chat context + recall resolve typed artifacts | **PROVEN**, re-confirmed Stage 3 | `item2-library-recall.proof.txt` (41/41 readers/serve/dispatch + 74/74 recall/identity/projector; green in full `test:root` at final tip) + live serve in `item4-clean-boot.proof.txt` Part D |
| 3 | Purge dry-run + real run on a seeded fixture DB; DB write-guard rejection | **PROVEN LIVE**, re-proven Stage 3 | `item3-purge-cascade-guard.proof.txt` (38/38 fresh at final tip) |
| 4 | Clean boot WITHOUT default-artifact | **PROVEN LIVE (Stage 3)** | `item4-clean-boot.proof.txt` (26/26 on a lane DB) |

## Item 4 — clean-boot methodology (the retirement's boot-safety proof)

The retirement is complete, so "clean boot WITHOUT default-artifact" is now demonstrable.
`reproduce-boot-schema.mts` builds the REAL store schema (`buildCreateStoreSchemaQueries`)
— including the canonical `installed_extension` store and the `objects` table — into a
throwaway lane DB (`prove_1785_boot`). `reproduce-clean-boot.mts` then drives the REAL
boot-path modules and asserts 26/26:

- **Part A — the REAL extension-closure BOOT GATE against the lane DB, PROD posture.**
  The lane `installed_extension` store is seeded with the branch's real required set (the
  13 lock packages, active + required-in-prod). `enforceExtensionClosureAtBoot()` reads
  that store and, with `CINATRA_RUNTIME_MODE` unset (fail-CLOSED prod posture), does **not
  throw**; `verifyRequiredInProdInstalled()` is ok with no missing/mismatched packages;
  `default-artifact` is absent from the required set and `isPackageRequiredInProd` returns
  false. A **counterfactual** (deleting one required row) makes the SAME gate fail
  verification and THROW — proving the green boot is not vacuous.
- **Part B — the equality triple, computed live from the branch files.** `cinatra.extensions`
  == `cinatra.systemExtensions` == the required-lock (13 each), with `default-artifact`
  absent from all three legs; the extension dir and the generated floor const are gone.
- **Part C — the object-type registry warmed from the REAL `extensions/` tree.** Only the
  four file-upload base packs (pdf/audio/video/image) register a typed object type; the
  generic `@cinatra-ai/artifact:object` catch-all is NOT registered; the REAL registry-routed
  upload resolver maps `application/pdf` to the one typed pack, refuses `text/markdown` and
  the empty MIME, and never admits the `*/*` floor as a candidate. (The `[artifacts:bridge]
  … declares no objectTypes` lines are expected — derived/umbrella artifacts mint no object
  type, entry 95.)
- **Part D — the library serves typed rows.** Two upload-RESOLVED typed rows (pdf/image)
  seeded into the lane DB `objects` table are served through the registry's artifact
  type-id set (the library's serve predicate); zero generic rows exist to serve.

Vehicle note: a full Next.js HTTP dev server was NOT the vehicle — the `.env` template is
guardrail-blocked from reads and the local extension universe is degraded to the 18
workspace packages, so the boot MODULES were exercised directly against the lane DB (the
same proof class as item 3, which runs the real migration SQL against the real schema rather
than through a full app boot). This is reported honestly rather than substituting a
different claim.

### Reproduce (cwd = worktree root)

```
docker exec verify-cinatra-postgres-1 psql -U postgres -c "CREATE DATABASE prove_1785_boot;"
node --conditions=react-server --import tsx docs/internals/proofs/1785-a6/reproduce-boot-schema.mts
node --conditions=react-server --import tsx docs/internals/proofs/1785-a6/reproduce-clean-boot.mts
```

## Item 3 — live cascade + guard methodology (the crown-jewel destructive change)

`reproduce-build-schema.mts` builds the **REAL** store schema via
`buildCreateStoreSchemaQueries` (the exact boot-path DDL) into a throwaway DB, so every
one of the ~20 cascade tables and all three append-only delete-rejection triggers
(`trg_representation_append_only`, `trg_run_context_selections_append_only`,
`trg_artifact_uninstall_op_assertions_append_only`) exist exactly as production.

`reproduce-purge-cascade-guard.mts` then seeds a fixture — a RETIRED generic floor
artifact `@cinatra-ai/artifact:object` with full lineage across every cascade table +
change-event/remote-effect history, a LIVING pack-typed `@cinatra-ai/pdf:document`
artifact with its own lineage sharing a resource, an uninstall op shared by both,
change_sets that are retired-only / mixed / living-only, and a surviving child object
parented at the retired row — and executes the migration's OWN exported `buildPurgeSql()`
+ `buildGenericWriteGuardSql()` in a single transaction (as `up()` does). 38/38 assertions
confirm the full generic-lineage cascade, precise orphan sweeps, living history intact,
nothing dangling, shared storage untouched, the guard rejects generic INSERT/UPDATE +
allows a typed insert, and idempotency.

### Reproduce

```
docker exec verify-cinatra-postgres-1 psql -U postgres -c "CREATE DATABASE prove_1785_purge;"
npx tsx docs/internals/proofs/1785-a6/reproduce-build-schema.mts
npx tsx docs/internals/proofs/1785-a6/reproduce-purge-cascade-guard.mts
```

The build script stubs the two Better-Auth tables the store FKs reference
(`public."user"`, `public."organization"`) and the cascade script drops the single
`authoring_step_artifacts` convenience FK — both are throwaway-DB conveniences that do not
alter the migration's behavior. (The 12 skipped `public.team`/`member` DDL statements in
the schema build are unrelated auth-side tables, not part of the object/extension store.)

## Merge prerequisite (coordinator)

Migration `core__0059_purge-default-artifact-floor` sits above the shipped `core__0058`
(`0059 > 0058`). If a concurrent lane claims `0059` on `main` before this PR merges,
renumber-at-merge to the next free seq is the standard remedy (not a defect in the
migration).
