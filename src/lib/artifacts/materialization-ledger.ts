import "server-only";
import { createHash, randomUUID } from "node:crypto";
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
  // produces-scoped capture of an UNBOUND run's final output. RETIRED as a
  // WRITING path by cinatra#3029 (item 0.17); the value stays in the vocabulary
  // because rows written by it are still readable.
  | "derived_output"
  // cinatra#3029 (epic #3023 W5): the DEFAULT ROAD. One row per end-node output
  // at or above the document floor that no binding named, under the reserved
  // `cinatra:run-output:<name>` id family, carrying the rung that decided the
  // form and the verdict it decided on.
  | "default_road";

/**
 * The default road's verdict, as it lands on the ledger row (plan §8.2: "the
 * rung that decided the form and the verdict it decided on — the detected form,
 * the model's answer and confidence where the model rung ran"). Structurally
 * `DetectionVerdict` from ./output-detection-ladder; typed loosely here so the
 * ledger stays a data module with no dependency on the ladder.
 */
export type MaterializationDecidedVerdict = {
  form: string;
  rung: string;
  reason: string;
  modelAnswer?: string;
  confidence?: number;
  modelSkipped?: string;
  /**
   * WHY NO ARTIFACT (cinatra#3029, forward + fix leg 1). Present only on a row
   * the road settled WITHOUT one: the ladder named a form, and no installed base
   * could house it (`no_base_installed`), or two claimed it (`ambiguous`), or
   * the write itself refused the bytes (`write_refused`). The row exists so the
   * decision is readable; these three fields are what it says.
   */
  refusalReason?: string;
  refusalDetail?: string;
  refusalRung?: string;
};

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
  /** The default road's ladder verdict (cinatra#3029). Written on the CLAIM, so
   *  it is on the row even when the write that follows never commits — the rung
   *  that decided is a fact about the decision, not about the artifact. */
  decidedRung?: string;
  decidedVerdict?: MaterializationDecidedVerdict;
}): Promise<MaterializationClaim> {
  ensurePostgresSchema();
  const s = schema();
  const id = randomUUID();
  const inserted = await pool().query(
    `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash, phase,
    decided_rung, decided_verdict)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'claimed', $9, $10)
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
      input.decidedRung ?? null,
      input.decidedVerdict ? JSON.stringify(input.decidedVerdict) : null,
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

/**
 * Finalize a claim against an artifact that ALREADY exists — the same-bytes
 * case of the default road (plan §3: "Two outputs with the same bytes in one
 * run are one artifact with two ledger rows"). The first item writes its
 * artifact through the write path and finalizes inside that write's Tx2; every
 * later item with the same content hash claims its OWN reserved ledger id and
 * points it at the first item's refs through this call. Phase-guarded, so a
 * concurrent driver that finalized first simply wins and this returns false.
 */
export async function finalizeMaterializationAgainstExistingArtifact(input: {
  orgId: string;
  ledgerId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<boolean> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `UPDATE "${s}"."artifact_materializations"
        SET phase = 'finalized', artifact_id = $3, representation_revision_id = $4
      WHERE id = $1 AND org_id = $2 AND phase = 'claimed'
      RETURNING id`,
    [input.ledgerId, input.orgId, input.artifactId, input.representationRevisionId],
  );
  return res.rows.length === 1;
}

// ---------------------------------------------------------------------------
// THE PER-OUTPUT CONVERGENCE LOCK (cinatra#3029, forward + fix leg 1).
//
// The row's unique key is FOUR parts (run, output_id, extension, content_hash),
// and on the default road the EXTENSION is not an input -- it is derived, by a
// detection ladder whose answer may legitimately move between drives (the model
// rung's per-organisation switch flips, a base is installed or taken down, a
// runtime is reconfigured). So "read the finalized row, then type, then claim"
// is not exactly-once: two drivers whose leases overlap both read no finalized
// row, then resolve DIFFERENT extensions, then claim two different keys, and one
// output of one run reaches two artifacts.
//
// A read cannot close that window, because the window is between the read and
// the claim. A LOCK can: one output of one run is one critical section, taken
// BEFORE anything is typed and held until the write has settled, so whatever the
// ladder says the second time, the second driver enters only after the first has
// finalized -- and then finds the finalized row and stops.
//
// A SESSION-scoped Postgres advisory lock is what that is: it is held by a
// connection rather than by a transaction (the write inside spans several of its
// own transactions), it is released when the connection is returned, and it is
// released BY THE SERVER if the holder dies, which is exactly the crash
// behaviour the road already relies on -- a dead driver must not fence the
// output out of every later re-drive.
// ---------------------------------------------------------------------------

/** The advisory-lock key of one (run, output) pair, as a signed 64-bit pair.
 *  Derived from a digest so the two halves are stable across processes. */
export function outputConvergenceLockKey(
  runId: string,
  outputId: string,
): { hi: number; lo: number } {
  const digest = createHash("sha256")
    .update(`default-road-convergence\u0000${runId}\u0000${outputId}`, "utf8")
    .digest();
  // Two signed 32-bit halves: `pg_advisory_lock(int, int)`.
  return { hi: digest.readInt32BE(0), lo: digest.readInt32BE(4) };
}

/**
 * Run `fn` while holding the per-output convergence lock.
 *
 * The whole per-output window -- the finalized-row read, the detection, the
 * target resolution, the claim and the write -- runs inside it, so per-output
 * exactly-once no longer depends on the extension the ladder happens to pick.
 * The lock is taken on a DEDICATED pooled connection and released in a `finally`
 * that also releases the connection, so neither a thrown write nor a crashed
 * process can leave an output fenced.
 */
export async function withOutputConvergenceLock<T>(
  input: { runId: string; outputId: string },
  fn: () => Promise<T>,
): Promise<T> {
  ensurePostgresSchema();
  const { hi, lo } = outputConvergenceLockKey(input.runId, input.outputId);
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [hi, lo]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [hi, lo]);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// SETTLED WITHOUT AN ARTIFACT (cinatra#3029, forward + fix leg 1).
//
// Item 0.17 asks for "one ledger row per item". The road used to write NO row at
// all when no installed base could take the detected form: the outcome existed
// only in the drive's return value, and a family of such items settled as
// `no_match` with an empty ledger -- indistinguishable, to every later reader,
// from a run that produced nothing. A decision that was made is a fact, and a
// fact the ledger does not carry is a fact nobody can read.
//
// The row is `finalized` with NULL artifact refs: the road is DONE with that
// output (a re-drive must not re-run a model over it) and there is no artifact,
// which is precisely what the two NULLs say. `decided_verdict` carries the
// ladder's verdict and the refusal beside it, so the row states WHY.
// ---------------------------------------------------------------------------

/**
 * Settle a claimed row as finished WITHOUT an artifact, carrying the refusal.
 * Phase-guarded like every other finalize, so a concurrent driver that settled
 * first simply wins and this returns false.
 */
export async function settleMaterializationWithoutArtifact(input: {
  orgId: string;
  ledgerId: string;
  decidedVerdict: MaterializationDecidedVerdict;
}): Promise<boolean> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `UPDATE "${s}"."artifact_materializations"
        SET phase = 'finalized', decided_verdict = $3
      WHERE id = $1 AND org_id = $2 AND phase = 'claimed'
      RETURNING id`,
    [input.ledgerId, input.orgId, JSON.stringify(input.decidedVerdict)],
  );
  return res.rows.length === 1;
}

/**
 * The road's own row for ONE output, ARTIFACT OR NOT -- the read that makes the
 * per-output guard total.
 *
 * `findFinalizedMaterializationForOutput` answers only for a row that reached an
 * artifact, so an output the road settled WITHOUT one would be re-detected,
 * re-asked of the model and re-settled on every later drive. This read sees both
 * kinds: `artifactId === null` is the settled-without-artifact row.
 */
export async function findSettledMaterializationForOutput(input: {
  orgId: string;
  runId: string;
  outputId: string;
  path: MaterializationPath;
}): Promise<{
  artifactId: string | null;
  representationRevisionId: string | null;
  extension: string;
  decidedRung: string | null;
  decidedVerdict: MaterializationDecidedVerdict | null;
} | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT artifact_id, representation_revision_id, extension, decided_rung, decided_verdict
       FROM "${s}"."artifact_materializations"
      WHERE org_id = $1 AND run_id = $2 AND output_id = $3 AND path = $4
        AND phase = 'finalized'
      ORDER BY (artifact_id IS NULL), created_at ASC
      LIMIT 1`,
    [input.orgId, input.runId, input.outputId, input.path],
  );
  const row = res.rows[0] as
    | {
        artifact_id: string | null;
        representation_revision_id: string | null;
        extension: string;
        decided_rung: string | null;
        decided_verdict: MaterializationDecidedVerdict | null;
      }
    | undefined;
  if (!row) return null;
  return {
    artifactId: row.artifact_id ?? null,
    representationRevisionId: row.representation_revision_id ?? null,
    extension: row.extension,
    decidedRung: row.decided_rung ?? null,
    decidedVerdict: row.decided_verdict ?? null,
  };
}

/**
 * The FINALIZED row of ONE run output on ONE path, whatever extension and
 * whatever content hash it settled under.
 *
 * The 4-part unique key (run, output_id, extension, content_hash) makes a claim
 * idempotent only while the CHOSEN EXTENSION is stable. On the default road the
 * extension is derived from the detection ladder's verdict, and a verdict can
 * legitimately differ between drives — the model rung's per-organisation switch
 * can be turned off, an extension can be installed or taken down, a runtime can
 * be reconfigured. A re-drive after a crashed settle would then claim a
 * DIFFERENT key and write a SECOND artifact for one output. This read is the
 * per-output guard the road takes BEFORE it types anything: one output of one
 * run reaches at most one artifact on one path, whatever the ladder says the
 * second time.
 */
export async function findFinalizedMaterializationForOutput(input: {
  orgId: string;
  runId: string;
  outputId: string;
  path: MaterializationPath;
}): Promise<{
  artifactId: string;
  representationRevisionId: string;
  extension: string;
  decidedRung: string | null;
  decidedVerdict: MaterializationDecidedVerdict | null;
} | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT artifact_id, representation_revision_id, extension, decided_rung, decided_verdict
       FROM "${s}"."artifact_materializations"
      WHERE org_id = $1 AND run_id = $2 AND output_id = $3 AND path = $4
        AND phase = 'finalized'
        AND artifact_id IS NOT NULL AND representation_revision_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [input.orgId, input.runId, input.outputId, input.path],
  );
  const row = res.rows[0] as
    | {
        artifact_id: string;
        representation_revision_id: string;
        extension: string;
        decided_rung: string | null;
        decided_verdict: MaterializationDecidedVerdict | null;
      }
    | undefined;
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    representationRevisionId: row.representation_revision_id,
    extension: row.extension,
    decidedRung: row.decided_rung ?? null,
    decidedVerdict: row.decided_verdict ?? null,
  };
}

/**
 * Every FINALIZED materialization of one run, newest last — the read behind the
 * run page's "what this run made" list (plan §6 step 6; issue #3002's artifact
 * half). Org-scoped; the caller has already proved the person may read the run.
 */
export async function listFinalizedMaterializationsForRun(input: {
  orgId: string;
  runId: string;
}): Promise<
  Array<{
    ledgerId: string;
    outputId: string;
    path: string;
    extension: string;
    artifactId: string;
    representationRevisionId: string;
    decidedRung: string | null;
    decidedVerdict: MaterializationDecidedVerdict | null;
  }>
> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT id, output_id, path, extension, artifact_id, representation_revision_id,
            decided_rung, decided_verdict
       FROM "${s}"."artifact_materializations"
      WHERE run_id = $1 AND org_id = $2 AND phase = 'finalized'
        AND artifact_id IS NOT NULL AND representation_revision_id IS NOT NULL
      ORDER BY created_at ASC, id ASC`,
    [input.runId, input.orgId],
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    ledgerId: String(row.id),
    outputId: String(row.output_id),
    path: String(row.path),
    extension: String(row.extension),
    artifactId: String(row.artifact_id),
    representationRevisionId: String(row.representation_revision_id),
    decidedRung: row.decided_rung == null ? null : String(row.decided_rung),
    decidedVerdict:
      row.decided_verdict == null
        ? null
        : (row.decided_verdict as MaterializationDecidedVerdict),
  }));
}
