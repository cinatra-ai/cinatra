import "server-only";

// ---------------------------------------------------------------------------
// THE EDIT OPERATION ON THE ARTIFACT LEDGER (enabler 0.20 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3026).
//
// The plan: "Editing needs write rights on the artifact and is recorded as an
// EDIT OPERATION WITH THE BASE AND THE NEW REVISION". §8.9: "every editor save
// records its base and its result".
//
// TWO ROWS RIDE ONE APPEND, and both are here so a reader finds them together.
//
//   `edit`   — the operation itself: the revision it produced, and, in its
//              detail, the revision it was made against and both revision
//              NUMBERS. That pair is the whole record of a compare-and-set: it
//              says which revision the editor had open, which one the store
//              wrote, and therefore that no revision in between was passed over.
//
//   `create` — the WRITER PROVENANCE WITNESS defined in
//              `artifact-writer-witness.ts`. Its invariant is "every host writer
//              that mints a blob-backed representation emits the witness", and
//              every claimed-row read gate (serve, context candidacy, selection
//              finalization) admits a representation ONLY through it. An edited
//              revision is blob-backed and host-authored exactly as a created
//              one is, so it carries the witness too — without it an artifact
//              would stop being readable by those gates the moment somebody
//              edited it, which is a silent, delayed failure of the worst kind.
//              The witness is emitted THROUGH the canonical builder so the
//              writer and the reader cannot drift apart.
//
// BOTH MUST RIDE THE SAME TRANSACTION AS THE `representation` INSERT they
// describe. A ledger row that can commit without its revision (or a revision
// without its ledger row) is not a record of anything, and the plan's
// "the append is one transaction with its ledger row" says so.
// ---------------------------------------------------------------------------

import {
  buildArtifactWriterWitnessOp,
  type ArtifactWriterWitnessOp,
} from "./artifact-writer-witness";

/** The `artifact_audit.action` value that IS the editor's operation. */
export const ARTIFACT_EDIT_AUDIT_ACTION = "edit" as const;

export interface ArtifactEditAuditFacts {
  orgId: string;
  artifactId: string;
  /** The revision this edit PRODUCED. */
  representationRevisionId: string;
  /** The revision the editor opened — the expected base of the append. */
  baseRepresentationRevisionId: string;
  /** The base's number, and the number written. Both, so the record reads
   *  without a second query. */
  baseRevision: number;
  revision: number;
  /** The acting principal (audit display only — never authorization input). */
  actor?: string | null;
}

/**
 * The EDIT row, as one op to splice into the append's transaction query list.
 * `schema` is the ALREADY-ESCAPED postgres schema identifier (the
 * `postgresSchema.replaceAll('"', '""')` form every store leaf computes).
 */
export function buildArtifactEditAuditOp(
  schema: string,
  f: ArtifactEditAuditFacts,
): ArtifactWriterWitnessOp {
  return {
    text: `INSERT INTO "${schema}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES (gen_random_uuid()::text, $1::text, $2::text, $3::text, '${ARTIFACT_EDIT_AUDIT_ACTION}', $4::text, $5::jsonb)`,
    values: [
      f.orgId,
      f.artifactId,
      f.representationRevisionId,
      f.actor ?? null,
      JSON.stringify({
        baseRepresentationRevisionId: f.baseRepresentationRevisionId,
        baseRevision: f.baseRevision,
        revision: f.revision,
        origin: "artifact-page-editor",
      }),
    ],
  };
}

/**
 * The WITNESS row for an edited revision — the same op every other host writer
 * emits, through the same builder, so "host-authored" means one thing.
 */
export function buildArtifactEditWitnessOp(
  schema: string,
  f: { orgId: string; artifactId: string; representationRevisionId: string; actor?: string | null },
): ArtifactWriterWitnessOp {
  return buildArtifactWriterWitnessOp(schema, {
    orgId: f.orgId,
    artifactId: f.artifactId,
    representationRevisionId: f.representationRevisionId,
    actor: f.actor ?? null,
    detail: { origin: "artifact-page-editor" },
  });
}
