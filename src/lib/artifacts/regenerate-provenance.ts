import "server-only";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// ---------------------------------------------------------------------------
// THE VERIFIED FILING NODE OF A REVISION (cinatra#4264, slice B1a).
//
// A Regenerate of a reviewed (artifact, revision) reruns the step that produced
// THAT revision, in the run that produced it. This reader answers which run and
// which node filed the revision, from facts the application recorded itself:
//
//   1. EXACT. The ledger rows of the revision (same org, artifact and
//      representation revision, path `materialize_tool`, phase `finalized`)
//      whose `verified_step_id` is set: the runtime signed the filing node and
//      it equals the row's node. One row -> the candidate. Two or more -> null
//      (two writers claim one revision; neither is trusted).
//   2. WALK. No exact row: the revision is a refiled repair successor. The
//      `lifecycle_repair` rows of the org with status `repaired` naming it as
//      successor: exactly one -> continue at its base revision; zero or two or
//      more -> null. At most REGENERATE_PROVENANCE_MAX_DEPTH steps -> null.
//   3. BIND. The candidate's run exists in the same org and runs the template of
//      the repair being dispatched; otherwise null.
//
// Never "the latest": a revision written before core__0127, or by a node the
// runtime did not sign, has no provenance and a Regenerate of it is refused.
// ---------------------------------------------------------------------------

export const REGENERATE_PROVENANCE_MAX_DEPTH = 64;

export type VerifiedFilingNode = { runId: string; nodeId: string };

/** The query seam: the pooled database by default, a test's own client else. */
export type ProvenanceDb = {
  query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  /** The application schema the tables live in (unquoted). */
  schema: string;
};

function defaultDb(): ProvenanceDb {
  ensurePostgresSchema();
  const pool: Pool = getPooledDb({
    name: "regenerate-provenance",
    connectionString: () => getPostgresConnectionString(),
  });
  return { query: (text, values) => pool.query(text, values), schema: postgresSchema };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Which run and node filed (orgId, artifactId, representationRevisionId), for
 * a repair of `templateId`; null when that cannot be proven. See the header for
 * the three steps.
 */
export async function readVerifiedFilingNode(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    /** The template of the repair being dispatched; the candidate run must run it. */
    templateId: string;
  },
  db: ProvenanceDb = defaultDb(),
): Promise<VerifiedFilingNode | null> {
  const s = db.schema.replaceAll('"', '""');
  let artifactId = input.artifactId;
  let revisionId = input.representationRevisionId;
  for (let depth = 0; depth <= REGENERATE_PROVENANCE_MAX_DEPTH; depth += 1) {
    const exact = await db.query(
      `SELECT run_id, verified_step_id
         FROM "${s}"."artifact_materializations"
        WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3
          AND path = 'materialize_tool' AND phase = 'finalized'
          AND verified_step_id IS NOT NULL
        LIMIT 2`,
      [input.orgId, artifactId, revisionId],
    );
    if (exact.rows.length > 1) return null;
    if (exact.rows.length === 1) {
      const runId = str(exact.rows[0]!.run_id);
      const nodeId = str(exact.rows[0]!.verified_step_id);
      if (!runId || !nodeId) return null;
      const run = await db.query(
        `SELECT 1 FROM "${s}"."agent_runs" WHERE id = $1 AND org_id = $2 AND template_id = $3 LIMIT 1`,
        [runId, input.orgId, input.templateId],
      );
      return run.rows.length === 1 ? { runId, nodeId } : null;
    }
    const repairs = await db.query(
      `SELECT base_artifact_id, base_representation_revision_id
         FROM "${s}"."lifecycle_repair"
        WHERE org_id = $1 AND status = 'repaired'
          AND successor_artifact_id = $2 AND successor_representation_revision_id = $3
        LIMIT 2`,
      [input.orgId, artifactId, revisionId],
    );
    if (repairs.rows.length !== 1) return null;
    const baseArtifact = str(repairs.rows[0]!.base_artifact_id);
    const baseRevision = str(repairs.rows[0]!.base_representation_revision_id);
    if (!baseArtifact || !baseRevision) return null;
    artifactId = baseArtifact;
    revisionId = baseRevision;
  }
  return null;
}
