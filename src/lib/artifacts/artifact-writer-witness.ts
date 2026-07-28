import "server-only";

// ---------------------------------------------------------------------------
// The ARTIFACT WRITER PROVENANCE WITNESS — one definition, one place.
//
// A host artifact writer that mints a blob-backed `representation` emits, in
// the SAME transaction as the representation it describes, an append-only
// `artifact_audit` row with `action = 'create'` carrying that exact
// `representation_revision_id`. That row is the WITNESS: it says "this host's
// artifact writer authored these bytes", and it is the ONLY signal the claimed-row
// read paths accept as a substitute for a policy-keyed content snapshot.
//
// WHY A WITNESS AT ALL. A CLAIMED row (one carrying an eligible BINDING
// assertion) normally exposes its content only through the cinatra#1430
// `object_content_snapshots` representation — the policy-keyed, redaction-gated
// serialization of `objects.data` that keeps one claimant from reading another
// claimant's view of the same mutable row. cinatra#1868 made the artifact writer
// compose the binding reconcile into its creation transaction, so a GENUINE FILE
// artifact produced on a claim-holding org carries an eligible binding too — and
// its bytes are AUTHORED CONTENT, not a rendering of the mutable row, so there is
// no snapshot policy for it to bypass and no claimant boundary for it to cross.
// The witness is what tells those two row classes apart.
//
// WHY THIS SIGNAL. `objects.data` is NOT usable: `objects_save` / `objects_update`
// merge caller-supplied fields into it, so any marker placed there (a
// `data.artifactType` discriminator, say) is caller-forgeable and a claimed
// typed-DATA row could mint one to serve its unredacted row content. The
// `artifact_audit` table is append-only and no objects / MCP write path, route,
// extension DB port, migration or trigger writes it. It is a TRUST-BOUNDARY
// witness, not a DB-enforced one: trusted server code or direct SQL could mint
// one, the same trust boundary every server-only store already sits behind.
//
// THE INVARIANT THIS MODULE EXISTS TO KEEP: every host writer that mints a
// blob-backed representation emits the witness, and every claimed-row read path
// (serve, context candidacy, selection finalization) tests for it through
// `artifactWriterWitnessExistsSql` — so a writer and a reader can never drift
// apart into "authored bytes that no read path will admit".
// ---------------------------------------------------------------------------

/** The `artifact_audit.action` value that IS the witness. */
export const ARTIFACT_WRITER_WITNESS_ACTION = "create" as const;

export interface ArtifactWriterWitnessFacts {
  orgId: string;
  artifactId: string;
  /** The representation this witness vouches for — the audit row's
   * `representation_revision_id`. */
  representationRevisionId: string;
  /** The acting principal, when the writer has one (audit display only). */
  actor?: string | null;
  /** Free-form provenance detail (mime / size / origin …). Never authorization
   * input — the witness is the EXISTENCE of the row, never its payload. */
  detail?: Record<string, unknown>;
}

export interface ArtifactWriterWitnessOp {
  text: string;
  values: unknown[];
}

/**
 * The witness INSERT, as one op to splice into a writer's transaction query
 * list. `schema` is the ALREADY-ESCAPED postgres schema identifier (the
 * `postgresSchema.replaceAll('"', '""')` form every store leaf computes).
 *
 * MUST ride the same transaction as the `representation` INSERT it describes —
 * a witness that can commit without its representation (or vice versa) is not a
 * witness. Every call site splices it into the one transactional query list that
 * writes the representation.
 */
export function buildArtifactWriterWitnessOp(
  schema: string,
  f: ArtifactWriterWitnessFacts,
): ArtifactWriterWitnessOp {
  return {
    text: `INSERT INTO "${schema}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES (gen_random_uuid()::text, $1::text, $2::text, $3::text, '${ARTIFACT_WRITER_WITNESS_ACTION}', $4::text, $5::jsonb)`,
    values: [
      f.orgId,
      f.artifactId,
      f.representationRevisionId,
      f.actor ?? null,
      JSON.stringify(f.detail ?? {}),
    ],
  };
}

/**
 * The witness PREDICATE, as a SQL `EXISTS (…)` fragment for a read path's WHERE
 * clause. `schema` is the already-escaped schema identifier; the three column
 * arguments are SQL expressions (usually qualified column references) for the
 * org, the artifact and the representation being tested.
 *
 * Every claimed-row read gate expresses the witness THROUGH THIS FUNCTION, so
 * the serve arm, the context-candidate rule, the resolver and both
 * selection-finalizer statements can never disagree about what "host-authored"
 * means.
 */
export function artifactWriterWitnessExistsSql(
  schema: string,
  cols: { orgId: string; artifactId: string; representationRevisionId: string },
): string {
  return `EXISTS (
  SELECT 1 FROM "${schema}"."artifact_audit" aud
  WHERE aud.org_id = ${cols.orgId}
    AND aud.artifact_id = ${cols.artifactId}
    AND aud.representation_revision_id = ${cols.representationRevisionId}
    AND aud.action = '${ARTIFACT_WRITER_WITNESS_ACTION}'
)`;
}
