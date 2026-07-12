// core__0036 — semantic_assertion binding basis (cinatra#1426, epic #1424).
//
// The `assertion_basis` discriminant lands on `semantic_assertion`:
//   - 'classic' — the existing assertion flow (matcher / agent /
//     authoring_skill / user classification plus the default-artifact floor).
//     Every existing row backfills 'classic' via the column DEFAULT
//     (metadata-only on PG11+), and every existing INSERT keeps working
//     unchanged because none of them name the column.
//   - 'binding' — extension-required identity written by binding
//     reconciliation (the cinatra#1429 write path). A binding row is anchored
//     to the exact claim ROW it was written under (`binding_claim_id` →
//     artifact_type_claims.id, plain text, never an FK — bindings must
//     survive registry surgery and archive independently) plus the
//     claim-activation `binding_generation` (transition safety: the
//     effective-identity service ignores a binding whose (claim row,
//     generation) pair is no longer the current winner's — generation alone
//     is a PER-CLAIM counter that restarts at 1 on a fresh claim, so it
//     cannot distinguish a retired claim's binding from a new same-package
//     claim's).
//
// Constraint-backed arbitration + guards:
//   - `sa_one_active_binding_idx` — ONE ACTIVE binding per artifact ACROSS
//     ALL EXTENSIONS (partial unique on (org_id, artifact_id) WHERE
//     assertion_basis = 'binding' AND eligibility <> 'archived'); a second
//     concurrent binding insert rejects at the DB, never a service race.
//   - `sa_basis_chk` — the basis vocabulary ('binding' | 'classic'), mirrored
//     by ASSERTION_BASES in @cinatra-ai/objects/effective-identity (the
//     contract test asserts sync).
//   - `sa_binding_generation_chk` / `sa_binding_claim_chk` — a binding
//     ALWAYS carries its generation + claim row; a classic row NEVER does.
//   - `sa_binding_never_matcher_chk` — matcher drafts never produce bindings
//     (and therefore a binding can never be 'draft' either — draft is
//     matcher-only by the existing sa_nonmatcher_nodraft_chk).
//   - `fn_semantic_assertion_frozen` is REPLACED to also freeze
//     assertion_basis + binding_generation: a basis flip / generation rewrite
//     by UPDATE is forbidden — binding mutations are the defined
//     reconciliations, each an INSERT of a new row (append-only doctrine).
//   - `sa_extension_artifact_idx` — the (org, extension, artifact) lookup
//     index serving per-extension identity scans (listArtifactIdsForExtension
//     and the #1429 reconciliation sweeps).
//
// Gate class DESTRUCTIVE (a NOT-NULL column lands on an existing user-data
// table and a unique index is created on it), though operationally safe: the
// NOT NULL rides a DEFAULT (metadata-only on PG11+ — every existing row reads
// 'classic'), and the partial unique index matches ZERO existing rows (no
// 'binding' rows exist before the cinatra#1429 write path lands, so it cannot
// fail on existing duplicates). The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts) — a no-op on a
// bootstrap-seeded schema — keeping fresh-bootstrap and operator-upgrade
// aligned (the core__0034 precedent). No `noTransaction()` (guarded DDL; the
// column add is metadata-only). Unqualified names ride the runner's
// search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const semanticAssertionBindingBasisDdlSql = `
  ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS assertion_basis text NOT NULL DEFAULT 'classic';
  ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS binding_claim_id text;
  ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS binding_generation integer;
  DO $guard$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'semantic_assertion' AND constraint_name = 'sa_basis_chk'
    ) THEN
      ALTER TABLE semantic_assertion ADD CONSTRAINT sa_basis_chk CHECK (assertion_basis IN ('binding','classic'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'semantic_assertion' AND constraint_name = 'sa_binding_generation_chk'
    ) THEN
      ALTER TABLE semantic_assertion ADD CONSTRAINT sa_binding_generation_chk CHECK ((assertion_basis = 'binding') = (binding_generation IS NOT NULL));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'semantic_assertion' AND constraint_name = 'sa_binding_claim_chk'
    ) THEN
      ALTER TABLE semantic_assertion ADD CONSTRAINT sa_binding_claim_chk CHECK ((assertion_basis = 'binding') = (binding_claim_id IS NOT NULL));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'semantic_assertion' AND constraint_name = 'sa_binding_never_matcher_chk'
    ) THEN
      ALTER TABLE semantic_assertion ADD CONSTRAINT sa_binding_never_matcher_chk CHECK (assertion_basis <> 'binding' OR asserted_by <> 'matcher');
    END IF;
  END $guard$;
  CREATE UNIQUE INDEX IF NOT EXISTS sa_one_active_binding_idx ON semantic_assertion (org_id, artifact_id) WHERE assertion_basis = 'binding' AND eligibility <> 'archived';
  CREATE INDEX IF NOT EXISTS sa_extension_artifact_idx ON semantic_assertion (org_id, extension, artifact_id);
  CREATE OR REPLACE FUNCTION fn_semantic_assertion_frozen() RETURNS trigger LANGUAGE plpgsql AS $body$
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
  IF NEW.eligibility <> OLD.eligibility THEN
    IF OLD.eligibility = 'archived' OR NEW.eligibility <> 'archived' THEN
      RAISE EXCEPTION 'semantic_assertion eligibility may only transition to archived from a non-archived state: % -> % forbidden — becoming eligible/draft requires a new INSERT', OLD.eligibility, NEW.eligibility;
    END IF;
  END IF;
  RETURN NEW;
END;
$body$;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(semanticAssertionBindingBasisDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape: restore the pre-0036 frozen-trigger body FIRST (it
  // must stop referencing the columns before they drop), then remove the
  // indexes/constraints/columns. HONEST COST: any binding rows written after
  // up() lose their discriminant + generation and become indistinguishable
  // from classic assertions — an operator-initiated `--down` deliberately
  // accepts that (the binding write path lands with cinatra#1429; at THIS
  // slice no production writer emits bindings).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION fn_semantic_assertion_frozen() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.extension <> OLD.extension OR NEW.asserted_by <> OLD.asserted_by
     OR NEW.asserted_at <> OLD.asserted_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.artifact_id <> OLD.artifact_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'semantic_assertion identity is immutable: extension/asserted_by/asserted_at/confidence/artifact_id/org_id cannot change — reclassification must INSERT a new assertion';
  END IF;
  IF NEW.eligibility <> OLD.eligibility THEN
    IF OLD.eligibility = 'archived' OR NEW.eligibility <> 'archived' THEN
      RAISE EXCEPTION 'semantic_assertion eligibility may only transition to archived from a non-archived state: % -> % forbidden — becoming eligible/draft requires a new INSERT', OLD.eligibility, NEW.eligibility;
    END IF;
  END IF;
  RETURN NEW;
END;
$body$;
    DROP INDEX IF EXISTS sa_one_active_binding_idx;
    DROP INDEX IF EXISTS sa_extension_artifact_idx;
    ALTER TABLE semantic_assertion
      DROP CONSTRAINT IF EXISTS sa_basis_chk,
      DROP CONSTRAINT IF EXISTS sa_binding_generation_chk,
      DROP CONSTRAINT IF EXISTS sa_binding_claim_chk,
      DROP CONSTRAINT IF EXISTS sa_binding_never_matcher_chk;
    ALTER TABLE semantic_assertion
      DROP COLUMN IF EXISTS assertion_basis,
      DROP COLUMN IF EXISTS binding_claim_id,
      DROP COLUMN IF EXISTS binding_generation;
  `);
}
