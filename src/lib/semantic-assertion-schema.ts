// Bootstrap DDL for `semantic_assertion` — the ONLY semantic identity of an
// artifact — EXTRACTED from drizzle-store.ts into a pure-strings leaf
// (cinatra#1426; the artifact-claim-schema.ts / skill-lifecycle-schema.ts
// extract-leaf pattern that holds the drizzle-store file-size ratchet).
//
// DB-level guards (generalizing the partial-index lesson — service
// enforcement alone is insufficient against a raw-SQL/MCP bypass):
//   - asserted_by ∈ user|authoring_skill|agent|matcher|system; eligibility ∈
//     eligible|draft|archived (enum CHECKs). 'system' (cinatra#1429) is the
//     service/worker principal binding reconciliation writes bindings under —
//     never a human/agent/skill classification; existing deployments widen the
//     CHECK via migration core__0040 / the guarded bootstrap reconcile in
//     bindingWritePathSchemaQueries (src/lib/artifact-claim-schema.ts);
//   - a `matcher` row may ONLY be draft|archived — NEVER eligible (so a
//     matcher draft can never become eligible by UPDATE either);
//   - a non-matcher row is NEVER `draft` (draft is the matcher-pending state
//     only);
//   - ≤1 ACTIVE (non-archived) assertion per (org,artifact,extension)
//     (partial-unique `sa_active_unique_idx`);
//   - the BEFORE UPDATE trigger freezes the identity columns
//     (reclassification = a NEW row, never a mutation — replay-safety).
//
// BINDING BASIS (cinatra#1426, epic #1424 — mirrored by migration
// core__0036 on existing deployments; the two paths converge, idempotent):
//   - `assertion_basis` discriminant: 'classic' (the existing assertion flow
//     — matcher/agent/authoring_skill/user classification + the floor; every
//     existing row backfills 'classic' via the column DEFAULT, metadata-only,
//     and existing INSERTs keep working because none name the column) vs
//     'binding' (extension-required identity written ONLY by binding
//     reconciliation — the cinatra#1429 write path).
//   - A binding is anchored to the exact claim ROW it was written under
//     (`binding_claim_id` → artifact_type_claims.id, plain text, never an FK)
//     plus its claim-activation `binding_generation`. Generations are
//     PER-CLAIM counters restarting at 1, so the claim-row anchor is what
//     stops a retired claim's binding revalidating against a new same-package
//     claim (the effective-identity service ignores a binding whose
//     (claim row, generation) pair is not the current winner's).
//   - `sa_one_active_binding_idx` — ONE ACTIVE binding per artifact ACROSS
//     ALL extensions: a second concurrent binding insert rejects at the DB,
//     never a service race.
//   - `sa_binding_generation_chk` / `sa_binding_claim_chk` — a binding ALWAYS
//     carries its generation + claim row; a classic row NEVER does.
//   - `sa_binding_never_matcher_chk` — matcher drafts never produce bindings
//     (and a binding can therefore never be 'draft' either).
//   - `sa_extension_artifact_idx` — the (org, extension, artifact) lookup
//     index serving per-extension identity scans.
//   - The frozen trigger also freezes assertion_basis / binding_claim_id /
//     binding_generation: binding mutations are the defined reconciliations,
//     each an INSERT of a new row (append-only doctrine).
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous composition (same contract as
// artifact-claim-schema.ts). The assertion_basis vocabulary is a schema
// contract mirrored by ASSERTION_BASES in the pure
// @cinatra-ai/objects/effective-identity leaf; the core__0036 contract test
// asserts migration/bootstrap/vocabulary stay in sync.

/** Idempotent guarded ADD CONSTRAINT fragment (Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`) — local copy of drizzle-store's private
 * helper so this leaf keeps zero imports. */
function addConstraintIfAbsent(
  schemaName: string,
  table: string,
  constraint: string,
  ddl: string,
): string {
  return `IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = '${table}'
            AND constraint_name = '${constraint}'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."${table}"
            ADD CONSTRAINT ${constraint}
            ${ddl};
        END IF;`;
}

export function semanticAssertionSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."semantic_assertion" (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  artifact_id           text NOT NULL,
  extension             text NOT NULL,
  asserted_by           text NOT NULL,
  eligibility           text NOT NULL,
  confidence            double precision,
  asserted_by_principal text,
  asserted_at           timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  assertion_basis       text NOT NULL DEFAULT 'classic',
  binding_claim_id      text,
  binding_generation    integer,
  CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher','system')),
  CONSTRAINT sa_elig_chk CHECK (eligibility IN ('eligible','draft','archived')),
  CONSTRAINT sa_matcher_draft_chk CHECK (asserted_by <> 'matcher' OR eligibility IN ('draft','archived')),
  CONSTRAINT sa_nonmatcher_nodraft_chk CHECK (asserted_by = 'matcher' OR eligibility <> 'draft'),
  CONSTRAINT sa_basis_chk CHECK (assertion_basis IN ('binding','classic')),
  CONSTRAINT sa_binding_generation_chk CHECK ((assertion_basis = 'binding') = (binding_generation IS NOT NULL)),
  CONSTRAINT sa_binding_claim_chk CHECK ((assertion_basis = 'binding') = (binding_claim_id IS NOT NULL)),
  CONSTRAINT sa_binding_never_matcher_chk CHECK (assertion_basis <> 'binding' OR asserted_by <> 'matcher')
)` },
    // Live-schema path (pre-#1426 deployments): idempotent ALTERs; existing
    // rows backfill 'classic' via the column DEFAULT (metadata-only on
    // PG11+).
    { text: `ALTER TABLE "${q}"."semantic_assertion" ADD COLUMN IF NOT EXISTS assertion_basis text NOT NULL DEFAULT 'classic'` },
    { text: `ALTER TABLE "${q}"."semantic_assertion" ADD COLUMN IF NOT EXISTS binding_claim_id text` },
    { text: `ALTER TABLE "${q}"."semantic_assertion" ADD COLUMN IF NOT EXISTS binding_generation integer` },
    { text: `DO $$ BEGIN
        ${addConstraintIfAbsent(schemaName, "semantic_assertion", "sa_basis_chk", `CHECK (assertion_basis IN ('binding','classic'))`)}
        ${addConstraintIfAbsent(schemaName, "semantic_assertion", "sa_binding_generation_chk", `CHECK ((assertion_basis = 'binding') = (binding_generation IS NOT NULL))`)}
        ${addConstraintIfAbsent(schemaName, "semantic_assertion", "sa_binding_claim_chk", `CHECK ((assertion_basis = 'binding') = (binding_claim_id IS NOT NULL))`)}
        ${addConstraintIfAbsent(schemaName, "semantic_assertion", "sa_binding_never_matcher_chk", `CHECK (assertion_basis <> 'binding' OR asserted_by <> 'matcher')`)}
      END $$` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS sa_active_unique_idx ON "${q}"."semantic_assertion" (org_id, artifact_id, extension) WHERE eligibility <> 'archived'` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS sa_one_active_binding_idx ON "${q}"."semantic_assertion" (org_id, artifact_id) WHERE assertion_basis = 'binding' AND eligibility <> 'archived'` },
    { text: `CREATE INDEX IF NOT EXISTS sa_artifact_idx ON "${q}"."semantic_assertion" (org_id, artifact_id)` },
    { text: `CREATE INDEX IF NOT EXISTS sa_eligible_idx ON "${q}"."semantic_assertion" (org_id, artifact_id) WHERE eligibility = 'eligible'` },
    { text: `CREATE INDEX IF NOT EXISTS sa_extension_artifact_idx ON "${q}"."semantic_assertion" (org_id, extension, artifact_id)` },
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_semantic_assertion_frozen"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.extension <> OLD.extension OR NEW.asserted_by <> OLD.asserted_by
     OR NEW.asserted_at <> OLD.asserted_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.artifact_id <> OLD.artifact_id OR NEW.org_id <> OLD.org_id
     OR NEW.assertion_basis <> OLD.assertion_basis
     OR NEW.binding_claim_id IS DISTINCT FROM OLD.binding_claim_id
     OR NEW.binding_generation IS DISTINCT FROM OLD.binding_generation THEN
    RAISE EXCEPTION 'semantic_assertion identity is immutable: extension/asserted_by/asserted_at/confidence/artifact_id/org_id/assertion_basis/binding_claim_id/binding_generation cannot change — reclassification must INSERT a new assertion';
  END IF;
  -- The ONLY legal eligibility UPDATE is a
  -- transition INTO 'archived' from a non-archived state. No resurrection
  -- (archived -> eligible/draft), no eligible<->draft re-write, no
  -- archived no-op churn. Becoming eligible/draft happens ONLY via INSERT
  -- This preserves raw-SQL and MCP defense-in-depth.
  IF NEW.eligibility <> OLD.eligibility THEN
    IF OLD.eligibility = 'archived' OR NEW.eligibility <> 'archived' THEN
      RAISE EXCEPTION 'semantic_assertion eligibility may only transition to archived from a non-archived state: % -> % forbidden — becoming eligible/draft requires a new INSERT', OLD.eligibility, NEW.eligibility;
    END IF;
  END IF;
  RETURN NEW;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_semantic_assertion_frozen ON "${q}"."semantic_assertion"` },
    { text: `CREATE TRIGGER trg_semantic_assertion_frozen BEFORE UPDATE ON "${q}"."semantic_assertion" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_semantic_assertion_frozen"()` },
  ];
}
