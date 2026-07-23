import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// ---------------------------------------------------------------------------
// Artifact-materialization idempotency ledger (cinatra#923).
//
// Claim-then-write-then-finalize journal over the `artifact_materializations`
// table (DDL in drizzle-store.ts). The DB identity is the 4-part unique key
// (run_id, output_id, extension, content_hash):
//   - `output_id` = the EndNode output name (path `end_node_binding`), the
//     calling node id (path `materialize_tool`, #925), or the authoring step
//     id (path `llm_emit` provenance rows — unique per emit, so legitimately
//     distinct same-byte emits never collide).
//
// Lifecycle: `claimMaterialization` INSERTs a `claimed` row (or resolves the
// existing row on key conflict); the caller then passes
// `buildFinalizeMaterializationQuery(...)` INTO createSemanticArtifact's Tx2
// so claimed→finalized commits ATOMICALLY with the artifact write. Crash
// before Tx2 ⇒ no artifact + an unfinalized claim the next re-drive re-uses;
// crash after Tx2 ⇒ artifact AND finalized row both exist — the re-drive
// reads the finalized refs and never writes a second artifact.
//
// The cross-path WARN-phase dedupe (`findFinalizedDeclarativeMaterialization`)
// is an ADVISORY read used ONLY by the LLM-emit path: a finalized
// `end_node_binding` row of the SAME run + extension + content hash proves
// the emit is transcription residue of a declared binding (only the
// declarative path writes that provenance), so the emit returns the existing
// refs instead of creating a duplicate.
// ---------------------------------------------------------------------------

export type MaterializationPath =
  | "end_node_binding"
  | "materialize_tool"
  | "llm_emit"
  // cinatra#1893 (epic #1883 A5): the post-terminal derivation job's path — the
  // produces-scoped capture of an UNBOUND run's final output.
  | "derived_output";

export type MaterializationClaim =
  | {
      /** Fresh claim, or a re-used unfinalized claim from a crashed drive. */
      kind: "claimed";
      ledgerId: string;
      /** The claimed row's `path` (cinatra#1893 Q3). Absent on a FRESH insert
       *  (the caller's own path, no possible alias); present on a RE-USED
       *  unfinalized row so the caller can refuse to finalize a foreign-path
       *  collision (the 4-part unique key excludes `path`). */
      path?: string;
    }
  | {
      /** The key already finalized — return these refs, do NOT write. */
      kind: "finalized";
      artifactId: string;
      representationRevisionId: string;
      /** The winning row's `path` (cinatra#1893 Q3): the 4-part unique key
       *  excludes `path`, so a caller that must not alias a foreign-path row of
       *  the same (run, output_id, extension, content_hash) verifies this. */
      path: string;
    };

function pool(): Pool {
  return getPooledDb({
    name: "artifact-materialization-ledger",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

/**
 * Claim a materialization identity. Exactly one of:
 *   - fresh INSERT (phase `claimed`) → `{kind:"claimed", ledgerId}`;
 *   - existing FINALIZED row → `{kind:"finalized", ...refs}` (idempotent hit);
 *   - existing UNFINALIZED row (crashed earlier drive) → re-used
 *     `{kind:"claimed", ledgerId}` — the finalize op is phase-guarded, so
 *     re-driving the write against the same claim is safe.
 *
 * Throws on infra failure (DB down) — the caller records the output as a
 * failed materialization; it never blocks the run's terminal transition.
 */
export async function claimMaterialization(input: {
  orgId: string;
  runId: string;
  outputId: string;
  nodeId: string | null;
  path: MaterializationPath;
  extension: string;
  contentHash: string;
}): Promise<MaterializationClaim> {
  ensurePostgresSchema();
  const s = schema();
  const id = randomUUID();
  const inserted = await pool().query(
    `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash, phase)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'claimed')
 ON CONFLICT (run_id, output_id, extension, content_hash) DO NOTHING
 RETURNING id`,
    [
      id,
      input.orgId,
      input.runId,
      input.outputId,
      input.nodeId,
      input.path,
      input.extension,
      input.contentHash,
    ],
  );
  if (inserted.rows.length > 0) {
    return { kind: "claimed", ledgerId: String(inserted.rows[0].id) };
  }
  // Key conflict — read the winner. org_id is re-checked so a cross-org
  // run-id collision (not reachable through the callers, which derive the
  // run's own org) can never leak another org's refs.
  const existing = await pool().query(
    `SELECT id, phase, path, artifact_id, representation_revision_id
   FROM "${s}"."artifact_materializations"
  WHERE run_id = $1 AND output_id = $2 AND extension = $3 AND content_hash = $4
    AND org_id = $5
  LIMIT 1`,
    [input.runId, input.outputId, input.extension, input.contentHash, input.orgId],
  );
  const row = existing.rows[0] as
    | {
        id: string;
        phase: string;
        path: string;
        artifact_id: string | null;
        representation_revision_id: string | null;
      }
    | undefined;
  if (!row) {
    throw new Error(
      "artifact_materializations claim conflicted but the winning row is not readable (cross-org run id collision?)",
    );
  }
  if (
    row.phase === "finalized" &&
    typeof row.artifact_id === "string" &&
    typeof row.representation_revision_id === "string"
  ) {
    return {
      kind: "finalized",
      artifactId: row.artifact_id,
      representationRevisionId: row.representation_revision_id,
      path: row.path,
    };
  }
  // Unfinalized claim from a crashed drive — re-use it. Carry its `path` so the
  // caller can refuse to finalize a FOREIGN-path row that aliased the 4-part key
  // (cinatra#1893 Q3): the key excludes `path`, so a same-key row of a different
  // materialization intent must never be re-used across paths.
  return { kind: "claimed", ledgerId: String(row.id), path: row.path };
}

/**
 * Error marker raised (via a failed cast) when the finalize guard fires —
 * i.e. the claim was already finalized by a CONCURRENT writer by the time
 * this transaction's UPDATE ran. Callers match on it to recover the
 * winner's refs instead of reporting a failure.
 */
export const MATERIALIZATION_FINALIZE_CONFLICT_MARKER =
  "materialization-finalize-conflict";

/** True when an error is the finalize-conflict guard firing (the loser of a
 *  concurrent double-drive; the winner's refs are readable in the ledger). */
export function isMaterializationFinalizeConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes(MATERIALIZATION_FINALIZE_CONFLICT_MARKER)
  );
}

/**
 * Tx-composable finalize op. Splice into createSemanticArtifact's Tx2 (via
 * `additionalTx2Queries`) so claimed→finalized commits atomically with the
 * artifact write.
 *
 * SINGLE-WINNER GUARD (codex round 0): two concurrent drives can both hold
 * the same re-used `claimed` ledger id (claim re-use is what makes a
 * CRASHED drive recoverable). The UPDATE's row lock serializes them: the
 * second writer's `phase = 'claimed'` predicate re-evaluates after the
 * first commit (READ COMMITTED) and matches ZERO rows — the CASE arm then
 * forces a failed text→int cast carrying MATERIALIZATION_FINALIZE_CONFLICT_MARKER,
 * which aborts the WHOLE Tx2 (the loser's artifact write rolls back; no
 * second visible artifact). The caller recovers by re-reading the ledger
 * row (now finalized with the winner's refs).
 */
export function buildFinalizeMaterializationQuery(input: {
  ledgerId: string;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): { text: string; values: unknown[] } {
  const s = schema();
  return {
    text: `WITH finalized AS (
  UPDATE "${s}"."artifact_materializations"
     SET phase = 'finalized', artifact_id = $3, representation_revision_id = $4
   WHERE id = $1 AND org_id = $2 AND phase = 'claimed'
   RETURNING id
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM finalized) THEN 1
  -- The concat with the CTE-dependent subquery keeps this cast out of
  -- plan-time constant folding: it only evaluates (and fails, aborting the
  -- whole Tx2) when the UPDATE transitioned zero rows.
  ELSE ('${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}: claim already finalized by a concurrent writer; rows=' || (SELECT count(*)::text FROM finalized))::int
END`,
    values: [
      input.ledgerId,
      input.orgId,
      input.artifactId,
      input.representationRevisionId,
    ],
  };
}

/**
 * Read a ledger row's finalized refs (the concurrent-loser recovery read).
 * Null when the row is missing or not finalized.
 */
export async function readFinalizedMaterialization(input: {
  orgId: string;
  ledgerId: string;
}): Promise<{ artifactId: string; representationRevisionId: string } | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT artifact_id, representation_revision_id
   FROM "${s}"."artifact_materializations"
  WHERE id = $1 AND org_id = $2 AND phase = 'finalized'
  LIMIT 1`,
    [input.ledgerId, input.orgId],
  );
  const row = res.rows[0] as
    | { artifact_id: string | null; representation_revision_id: string | null }
    | undefined;
  if (
    !row ||
    typeof row.artifact_id !== "string" ||
    typeof row.representation_revision_id !== "string"
  ) {
    return null;
  }
  return {
    artifactId: row.artifact_id,
    representationRevisionId: row.representation_revision_id,
  };
}

/**
 * Advisory WARN-phase lookup for the LLM-emit path: the finalized
 * DECLARATIVE (`end_node_binding`) materialization of this run + extension +
 * content hash, or null. A hit proves the run's template package declared a
 * binding for the extension (only the declarative path writes that
 * provenance) AND the declared intent already materialized these bytes.
 */
export async function findFinalizedDeclarativeMaterialization(input: {
  orgId: string;
  runId: string;
  extension: string;
  contentHash: string;
}): Promise<{ artifactId: string; representationRevisionId: string } | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT artifact_id, representation_revision_id
   FROM "${s}"."artifact_materializations"
  WHERE run_id = $1 AND extension = $2 AND content_hash = $3
    AND org_id = $4 AND path = 'end_node_binding' AND phase = 'finalized'
  LIMIT 1`,
    [input.runId, input.extension, input.contentHash, input.orgId],
  );
  const row = res.rows[0] as
    | { artifact_id: string | null; representation_revision_id: string | null }
    | undefined;
  if (
    !row ||
    typeof row.artifact_id !== "string" ||
    typeof row.representation_revision_id !== "string"
  ) {
    return null;
  }
  return {
    artifactId: row.artifact_id,
    representationRevisionId: row.representation_revision_id,
  };
}

/**
 * Best-effort `llm_emit` provenance row (already-finalized — the emit's
 * artifact write committed before this runs). Feeds the #924 double-path
 * lint/dashboards; a failure here NEVER fails the emit (log-and-continue at
 * the caller). `output_id` = the authoring step id (unique per emit).
 */
export async function recordLlmEmitMaterialization(input: {
  orgId: string;
  runId: string;
  authoringStepId: string;
  extension: string;
  contentHash: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<void> {
  ensurePostgresSchema();
  const s = schema();
  await pool().query(
    `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash,
    artifact_id, representation_revision_id, phase)
 VALUES ($1, $2, $3, $4, NULL, 'llm_emit', $5, $6, $7, $8, 'finalized')
 ON CONFLICT (run_id, output_id, extension, content_hash) DO NOTHING`,
    [
      randomUUID(),
      input.orgId,
      input.runId,
      input.authoringStepId,
      input.extension,
      input.contentHash,
      input.artifactId,
      input.representationRevisionId,
    ],
  );
}
