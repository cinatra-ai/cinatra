// Vertical DDL slice extracted from drizzle-store.ts (file-size ratchet —
// cinatra#923): the artifact SEMANTIC-identity store (`semantic_assertion` +
// its immutability trigger) and the artifact-materialization idempotency
// ledger (`artifact_materializations`). Pure move: the queries splice back
// into `buildCreateStoreSchemaQueries` at the exact original position, so
// the emitted DDL list is byte-identical in content and order.

type QueryInput = {
  text: string;
  values?: unknown[];
};

export function buildSemanticArtifactStoreDdl(schemaName: string): QueryInput[] {
  return [
    // `semantic_assertion` — the ONLY semantic identity of an artifact.
    // DB-level guards, generalizing the partial-index
    // lesson — service enforcement alone is insufficient against a raw-SQL/
    // MCP bypass):
    //  - asserted_by ∈ user|authoring_skill|agent|matcher; eligibility ∈
    //    eligible|draft|archived (enum CHECKs);
    //  - a `matcher` row may ONLY be draft|archived — NEVER eligible (so a
    //    matcher draft can never become eligible by UPDATE either);
    //  - a non-matcher row is NEVER `draft` (draft is the matcher-pending
    //    state only);
    //  - ≤1 ACTIVE (non-archived) assertion per (org,artifact,extension)
    //    (partial-unique);
    //  - BEFORE UPDATE trigger freezes extension/asserted_by/asserted_at/
    //    confidence (reclassification = a NEW row, never a mutation —
    //    replay-safety).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (
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
  CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher')),
  CONSTRAINT sa_elig_chk CHECK (eligibility IN ('eligible','draft','archived')),
  CONSTRAINT sa_matcher_draft_chk CHECK (asserted_by <> 'matcher' OR eligibility IN ('draft','archived')),
  CONSTRAINT sa_nonmatcher_nodraft_chk CHECK (asserted_by = 'matcher' OR eligibility <> 'draft')
)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS sa_active_unique_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id, extension) WHERE eligibility <> 'archived'` },
    { text: `CREATE INDEX IF NOT EXISTS sa_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id)` },
    { text: `CREATE INDEX IF NOT EXISTS sa_eligible_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id) WHERE eligibility = 'eligible'` },
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_semantic_assertion_frozen"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.extension <> OLD.extension OR NEW.asserted_by <> OLD.asserted_by
     OR NEW.asserted_at <> OLD.asserted_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.artifact_id <> OLD.artifact_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'semantic_assertion identity is immutable: extension/asserted_by/asserted_at/confidence/artifact_id/org_id cannot change — reclassification must INSERT a new assertion';
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
    { text: `DROP TRIGGER IF EXISTS trg_semantic_assertion_frozen ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion"` },
    { text: `CREATE TRIGGER trg_semantic_assertion_frozen BEFORE UPDATE ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_semantic_assertion_frozen"()` },
    // ---- artifact_materializations idempotency ledger (cinatra#923) ----

    // Claim-then-write-then-finalize journal for declarative artifact
    // materialization (the install-op-journal shape). One row per attempted
    // materialization; the 4-part unique key is the RETRY-idempotency
    // guarantee: a run re-drive (BullMQ retry / duplicate terminal dispatch)
    // hits the same key, reads the finalized row's refs and returns them
    // instead of writing a second artifact. `phase` transitions
    // claimed→finalized INSIDE createSemanticArtifact's Tx2 (atomic with the
    // artifact write — no window in which a committed artifact is invisible
    // to the ledger). An unfinalized (crashed) claim is re-used by the next
    // re-drive.
    //
    // `output_id` identity per path: the EndNode output name for
    // `end_node_binding`; the calling node id for `materialize_tool` (#925);
    // the authoring step id for `llm_emit` provenance rows (unique per emit,
    // so legitimately distinct same-byte emits never collide on the key).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_materializations" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  run_id                      text NOT NULL,
  output_id                   text NOT NULL,
  node_id                     text,
  path                        text NOT NULL CHECK (path IN ('end_node_binding','materialize_tool','llm_emit')),
  extension                   text NOT NULL,
  content_hash                text NOT NULL,
  artifact_id                 text,
  representation_revision_id  text,
  phase                       text NOT NULL DEFAULT 'claimed' CHECK (phase IN ('claimed','finalized')),
  created_at                  timestamptz NOT NULL DEFAULT now()
)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_materializations_identity_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_materializations" (run_id, output_id, extension, content_hash)` },
    // Advisory cross-path lookup (the WARN-phase LLM-emit dedupe): finalized
    // declarative rows of one run by extension + content hash.
    { text: `CREATE INDEX IF NOT EXISTS artifact_materializations_run_ext_hash_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_materializations" (run_id, extension, content_hash)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_materializations_org_run_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_materializations" (org_id, run_id)` },
  ];
}
