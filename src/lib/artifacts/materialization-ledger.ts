import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  isReservedLedgerOutputId,
  MATERIALIZE_RESERVED_NODE_ID_MESSAGE,
  MATERIALIZE_RESERVED_NODE_ID_PREFIX,
} from "@cinatra-ai/agents/artifact-binding";
import {
  maybeBuildProducedEventInsertOp,
  producerAttemptForRun,
  producerRunLockOps,
  publishCallInFlightOr,
} from "@/lib/lifecycle/lifecycle-emit";

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

/** The ledger namespace of a list filing's rows is no claim's: every claim and record of the ledger refuses an
 *  output id inside it, whoever the producer is (a node id, an output name, a step id). Only the set's own
 *  statements (`buildToolSetRowQueries`) write it. */
function assertOutputIdNotReserved(outputId: string): void {
  if (isReservedLedgerOutputId(outputId)) throw new Error(MATERIALIZE_RESERVED_NODE_ID_MESSAGE);
}

export type MaterializationPath =
  | "end_node_binding"
  | "materialize_tool"
  | "llm_emit"
  // cinatra#1893 (epic #1883 A5): the post-terminal derivation job's path — the
  // produces-scoped capture of an UNBOUND run's final output. RETIRED as a
  // write path by cinatra#3029 (the response-text derivation retires); the
  // value stays legal so historical rows keep reading.
  | "derived_output"
  // cinatra#3029 (epic #3023 W5): THE DEFAULT ROAD — one row per end-node
  // output at or above the document floor that no binding names, carrying the
  // detection ladder's deciding rung.
  | "default_road"
  // cinatra#3089 (epic #3087 W1): the email fan-out's own path — one markdown
  // revision per draft item of a send, `output_id` = the message identity.
  | "email_fanout";

/** The detection ladder's recorded verdict, journalled on the row that write
 *  produced (cinatra#3029 item 0.18: "the verdict, model and rung recorded on
 *  the ledger row"). Absent on every path that does not run the ladder. */
export type MaterializationDetection = {
  rung: string;
  reason: string;
  confidence: number | null;
  model: string | null;
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
 * cinatra#4264: the value of `verified_step_id` for a claim — the verified step
 * when it is the claim's own node, else null. A request's `node_id` alone never
 * names the filing step; only the runtime's signature over it does.
 */
export function verifiedFilingStep(
  nodeId: string | null,
  verifiedStepId: string | null | undefined,
): string | null {
  return typeof verifiedStepId === "string" &&
    verifiedStepId.length > 0 &&
    verifiedStepId === nodeId
    ? verifiedStepId
    : null;
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
  /** The detection ladder's verdict (the `default_road` path only). */
  detection?: MaterializationDetection | null;
  /** cinatra#4264: the runtime's signed step of the call, when it verified.
   *  Stored as `verified_step_id` only when it equals `nodeId` (the request's
   *  node, never a composite `outputId`); otherwise NULL. The first claim's
   *  value stays: a re-drive hits the key and writes nothing. */
  verifiedStepId?: string | null;
}): Promise<MaterializationClaim> {
  assertOutputIdNotReserved(input.outputId);
  ensurePostgresSchema();
  const s = schema();
  const id = randomUUID();
  const inserted = await pool().query(
    `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash, phase,
    detection_rung, detection_reason, detection_confidence, detection_model, verified_step_id)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'claimed', $9, $10, $11, $12, $13)
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
      input.detection?.rung ?? null,
      input.detection?.reason ?? null,
      input.detection?.confidence ?? null,
      input.detection?.model ?? null,
      verifiedFilingStep(input.nodeId, input.verifiedStepId),
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
 * cinatra#4762 — THE restamp of a revision a write of the run REUSES instead of writing: a ledger hit finalized by an
 * earlier attempt (a retry that reproduced identical bytes), the winner of a concurrent double drive, a body bound
 * from a mid-run filing, a declared binding an emit is absorbed into, a reused object snapshot. Such a write writes
 * no revision, so no writer emits a produced event for it. Every reuse road calls this one function before it hands
 * the reused revision back: the revision's existing event records the attempt the write runs in (lifecycle-emit
 * buildProducedEventInsertOp: the same event id, only a NEWER generation of the same run moves it), so a review of
 * exactly these bytes counts for that attempt (artifact-review-gate-store listReviewLineageForRun). Only an existing
 * event is restamped: a revision that never had one gains none, and nothing else of the event changes (the emitter
 * and origin below are never written). Nothing when the review orchestration is off, no run is named, or the write
 * runs in no attempt (its event could record only -1, which restamps nothing).
 *
 * One transaction of two statements: the run row FOR KEY SHARE first (producerRunLockOps), then the event statement.
 * A publish check holds that row FOR UPDATE until its in-flight claim commits; in one statement the claim lookup would
 * keep the snapshot taken before the lock wait and miss that claim, so the restamp could move an older review into
 * the current attempt during the checked call. The event statement starts after the lock is held, so under READ
 * COMMITTED it sees the committed claim and refuses: the caller receives PublishCallInFlightError.
 */
export async function restampReusedRevision(input: {
  runId: string | null | undefined;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<void> {
  await restampReusedRevisions({
    runId: input.runId,
    orgId: input.orgId,
    revisions: [{ artifactId: input.artifactId, representationRevisionId: input.representationRevisionId }],
  });
}

/**
 * The restamp of SEVERAL revisions of one run (the members of a stored set), ALL in one transaction or none: the run
 * row FOR KEY SHARE once, then each revision's event statement, then COMMIT. The run row lock is held to the commit,
 * so a publish check cannot begin its in-flight claim between two members; a claim that committed earlier is seen by
 * the first event statement, which aborts the transaction, so no member moves and the caller receives
 * PublishCallInFlightError. A set is therefore never visible to publishing or review partly restamped.
 */
export async function restampReusedRevisions(input: {
  runId: string | null | undefined;
  orgId: string;
  revisions: ReadonlyArray<{ artifactId: string; representationRevisionId: string }>;
}): Promise<void> {
  if (!input.runId || input.revisions.length === 0) return;
  const producerAttempt = producerAttemptForRun(input.runId);
  if (!producerAttempt) return;
  const s = schema();
  const ops = input.revisions.flatMap((revision) => {
    const op = maybeBuildProducedEventInsertOp(s, {
      orgId: input.orgId,
      artifactId: revision.artifactId,
      representationRevisionId: revision.representationRevisionId,
      emitter: "createSemanticArtifact",
      originKind: "agent_generated",
      producerRunId: input.runId,
      producerAgentId: null,
      producerAttempt,
    }, {
      whereExistsSql: `EXISTS (SELECT 1 FROM "${s}"."artifact_produced_outbox" WHERE event_id = $1::text)`,
    });
    return op ? [op] : [];
  });
  if (ops.length === 0) return;
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const lock of producerRunLockOps(s, input.runId, ops[0]!)) await client.query(lock.text, lock.values);
    for (const op of ops) await client.query(op.text, op.values);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw publishCallInFlightOr(err);
  } finally {
    client.release();
  }
}

/** The query seam of `readRevisionImagePrompt`: this module's pool by default,
 * a caller's own client (and the schema it reads) else. */
export type RevisionImagePromptDb = {
  query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  /** The application schema the tables live in (unquoted). */
  schema: string;
};

function ledgerDb(): RevisionImagePromptDb {
  ensurePostgresSchema();
  return { query: (text, values) => pool().query(text, values), schema: postgresSchema };
}

function onlyPrompt(rows: Array<Record<string, unknown>>): string | null {
  if (rows.length !== 1) return null;
  const prompt: unknown = rows[0]?.image_prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : null;
}

/** Producer prompt on the exact FINALIZED revision the gate pinned (§VI).
 * Authorization belongs to the caller's artifact/run read ladder. This query
 * never substitutes the current revision, another org, or an unfinalized claim.
 * Ambiguous provenance is absent rather than guessed.
 *
 * A REFILED REVISION (cinatra#4264). A repair's answer is written by its run
 * on an artifact of its own and then refiled onto the reviewed artifact
 * (`refileRevisionOntoArtifact`): a new representation row and no ledger row.
 * The repair that finalized it records both ends: its successor (the refiled
 * revision) and its source (the revision the run wrote). The prompt of a
 * refiled revision is the one recorded for that source, read only through
 * exactly one `repaired` repair of the org that names the revision as its
 * successor and records a source; two such repairs are ambiguous and read
 * nothing. A revision no repair names (a direct write,
 * with a ledger row or without one) never reads another revision's prompt,
 * whatever bytes it shares. The repair link is read only when the revision
 * has no prompt row of its own, and it too must name exactly one row.
 *
 * The one rule for the review surface's prefill and for the review store,
 * which keeps a submitted prompt exactly when this read returns one. A read
 * fault throws. */
export async function readRevisionImagePrompt(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  },
  db: RevisionImagePromptDb = ledgerDb(),
): Promise<string | null> {
  const s = db.schema.replaceAll('"', '""');
  const ownPrompt = (artifactId: string, revisionId: string) =>
    db.query(
      `SELECT image_prompt FROM "${s}"."artifact_materializations"
       WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3
         AND phase = 'finalized' AND image_prompt IS NOT NULL
       LIMIT 2`,
      [input.orgId, artifactId, revisionId],
    );
  const exact = await ownPrompt(input.artifactId, input.representationRevisionId);
  if (exact.rows.length > 0) return onlyPrompt(exact.rows);
  // The repair links are counted before any prompt is read: two repairs naming
  // the revision are ambiguous provenance, whatever their sources recorded.
  const links = await db.query(
    `SELECT rr.source_artifact_id, rr.source_representation_revision_id
       FROM "${s}"."lifecycle_repair" rr
      WHERE rr.org_id = $1 AND rr.successor_artifact_id = $2
        AND rr.successor_representation_revision_id = $3
        AND rr.status = 'repaired'
        AND rr.source_artifact_id IS NOT NULL AND rr.source_representation_revision_id IS NOT NULL
      LIMIT 2`,
    [input.orgId, input.artifactId, input.representationRevisionId],
  );
  if (links.rows.length !== 1) return null;
  const source = links.rows[0];
  const sourceArtifactId: unknown = source?.source_artifact_id;
  const sourceRevisionId: unknown = source?.source_representation_revision_id;
  if (typeof sourceArtifactId !== "string" || typeof sourceRevisionId !== "string") return null;
  return onlyPrompt((await ownPrompt(sourceArtifactId, sourceRevisionId)).rows);
}

/**
 * THE STORED FACTS OF A FILED PICTURE (cinatra#4223): the provider and model
 * the finalized ledger row of exactly this revision recorded, read when a
 * re-drive of the same node with the same bytes is answered with that
 * revision. A re-drive is served by the first write, so it reports the facts
 * stored with that write and never those of the attempt that found it.
 *
 * Scoped like `readRevisionImagePrompt`: organisation, artifact and revision,
 * finalized, with an image provider recorded. Anything but exactly one such
 * row is null: the caller refuses rather than guess.
 */
export async function readRevisionImageProvenance(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<{ provider: string; model: string | null } | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT image_provider, image_model FROM "${s}"."artifact_materializations"
     WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3
       AND phase = 'finalized' AND image_provider IS NOT NULL
     LIMIT 2`,
    [input.orgId, input.artifactId, input.representationRevisionId],
  );
  if (res.rows.length !== 1) return null;
  const row = res.rows[0] as { image_provider: unknown; image_model: unknown };
  if (typeof row.image_provider !== "string" || row.image_provider.length === 0) return null;
  return {
    provider: row.image_provider,
    model:
      typeof row.image_model === "string" && row.image_model.length > 0 ? row.image_model : null,
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
 * The finalized MID-RUN materialization of this run + extension + content
 * hash, or null (cinatra#3089). A mid-run row — the `artifact_materialize`
 * tool (`materialize_tool`) or a declared binding (`end_node_binding`) — is the
 * drafting step's own filing of a body; the email fan-out resolves to it
 * instead of writing a second artifact of the same bytes. Its `output_id` is
 * the node id or the output name, never the fan-out's message identity, so the
 * run + extension + content hash is the key both rows share. A mid-run artifact
 * already bound to a message of this run (a finalized `email_fanout` row) is
 * never handed to a second message: two messages with the same bytes keep one
 * body each.
 */
export async function findFinalizedMidRunMaterialization(input: {
  orgId: string;
  runId: string;
  extension: string;
  contentHash: string;
  /** Artifacts the caller has already considered and set aside (two bodies of one run may share their bytes). */
  excludeArtifactIds?: readonly string[];
}): Promise<{ artifactId: string; representationRevisionId: string } | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT m.artifact_id, m.representation_revision_id
   FROM "${s}"."artifact_materializations" m
  WHERE m.run_id = $1 AND m.extension = $2 AND m.content_hash = $3
    AND m.org_id = $4 AND m.path IN ('materialize_tool', 'end_node_binding')
    AND m.phase = 'finalized'
    AND NOT EXISTS (
      SELECT 1 FROM "${s}"."artifact_materializations" f
       WHERE f.run_id = $1 AND f.org_id = $4 AND f.path = 'email_fanout'
         AND f.artifact_id = m.artifact_id
    )
    AND NOT (m.artifact_id = ANY($5::text[]))
  ORDER BY m.created_at ASC, m.output_id ASC
  LIMIT 1`,
    [input.runId, input.extension, input.contentHash, input.orgId, [...(input.excludeArtifactIds ?? [])]],
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
 * The finalized `email_fanout` row of ONE message of a send (cinatra#3089):
 * the message identity + extension + content hash, or null. A retried message
 * resolves to its own mapping before any mid-run lookup, so its artifact never
 * changes between drives.
 */
export async function findFinalizedFanoutMessageMaterialization(input: {
  orgId: string;
  runId: string;
  outputId: string;
  extension: string;
  contentHash: string;
}): Promise<{ artifactId: string; representationRevisionId: string } | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT artifact_id, representation_revision_id
   FROM "${s}"."artifact_materializations"
  WHERE run_id = $1 AND output_id = $2 AND extension = $3 AND content_hash = $4
    AND org_id = $5 AND path = 'email_fanout' AND phase = 'finalized'
  LIMIT 1`,
    [input.runId, input.outputId, input.extension, input.contentHash, input.orgId],
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

// ---------------------------------------------------------------------------
// THE LEDGER IDENTITY OF A LIST FILING'S SET (cinatra#3089).
//
// One set per (run, node, extension), decided by the database, not by a read. A set is written by ONE
// transaction that inserts, already finalized, a HEADER row and one row per member:
//   header  output_id = <prefix><json(node)>/header   content_hash = "set"
//   member  output_id = <prefix><json(node)>/<position>  content_hash = the member's bytes
// The table's unique key (run, output id, extension, content hash) therefore holds ONE header per
// (run, node, extension) (it has no hash and no position in it): two calls that file different sets
// concurrently insert the same header key, the second blocks until the first commits and then fails with
// a unique violation, and its whole transaction rolls back. The encoding cannot be confused with an
// ordinary node's output id (a node id is the output id as it is): the prefix is reserved
// (MATERIALIZE_RESERVED_NODE_ID_PREFIX, refused for node ids at compile time and at the road), and the node
// is JSON-quoted, which is self-delimiting, so two different (node, suffix) pairs never produce one string.
// ---------------------------------------------------------------------------

/** The sentinel content hash of a set's header row (a member's is a 64-hex sha256). */
export const TOOL_SET_HEADER_HASH = "set";

function toolSetPrefix(nodeId: string): string {
  return `${MATERIALIZE_RESERVED_NODE_ID_PREFIX}${JSON.stringify(nodeId)}/`;
}

/** The output id of a member of a node's set: its 1-based position. */
export function toolSetOutputId(nodeId: string, position: number): string {
  return `${toolSetPrefix(nodeId)}${position}`;
}

/** The output id of a node's set header. */
export function toolSetHeaderOutputId(nodeId: string): string {
  return `${toolSetPrefix(nodeId)}header`;
}

export type ToolSetRow = {
  outputId: string;
  contentHash: string;
  artifactId: string;
  representationRevisionId: string;
};

/** The finalized set one node filed in a run: whether its header exists and its member rows. */
export type ToolSetRead = { header: boolean; members: ToolSetRow[] };

/**
 * The set one node filed in a run (cinatra#3089): its header and member rows. Rows are only ever written
 * finalized, by the one transaction that writes the set, so what is read is a whole set or nothing.
 */
export async function readToolSetRows(input: {
  orgId: string;
  runId: string;
  nodeId: string;
  extension: string;
}): Promise<ToolSetRead> {
  ensurePostgresSchema();
  const s = schema();
  const prefix = toolSetPrefix(input.nodeId);
  const res = await pool().query(
    `SELECT output_id, content_hash, artifact_id, representation_revision_id
   FROM "${s}"."artifact_materializations"
  WHERE run_id = $1 AND org_id = $2 AND extension = $3 AND path = 'materialize_tool' AND phase = 'finalized'
    AND left(output_id, length($4::text)) = $4::text`,
    [input.runId, input.orgId, input.extension, prefix],
  );
  const header = toolSetHeaderOutputId(input.nodeId);
  const rows = res.rows as Array<{
    output_id: string; content_hash: string; artifact_id: string | null; representation_revision_id: string | null;
  }>;
  return {
    header: rows.some((row) => row.output_id === header),
    members: rows
      .filter((row) => row.output_id !== header && typeof row.artifact_id === "string" && typeof row.representation_revision_id === "string")
      .map((row) => ({
        outputId: row.output_id,
        contentHash: row.content_hash,
        artifactId: row.artifact_id as string,
        representationRevisionId: row.representation_revision_id as string,
      })),
  };
}

/**
 * The ledger statements of ONE member of a set, for the set's transaction (the caller splices them in
 * through `additionalTx2Queries`): the member's row, already finalized, and, for the FIRST member only, the
 * set's header row ahead of it. Plain INSERTs, no ON CONFLICT: a second set for the same (run, node,
 * extension) hits the header's key and aborts the whole transaction.
 */
export function buildToolSetRowQueries(input: {
  orgId: string;
  runId: string;
  nodeId: string;
  extension: string;
  verifiedStepId?: string | null;
  position: number;
  contentHash: string;
  artifactId: string;
  representationRevisionId: string;
}): Array<{ text: string; values: unknown[] }> {
  const s = schema();
  const insert = (outputId: string, hash: string, artifactId: string | null, revisionId: string | null, verified: string | null) => ({
    text: `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash, artifact_id, representation_revision_id, phase, verified_step_id)
 VALUES ($1, $2, $3, $4, $5, 'materialize_tool', $6, $7, $8, $9, 'finalized', $10)`,
    values: [randomUUID(), input.orgId, input.runId, outputId, input.nodeId, input.extension, hash, artifactId, revisionId, verified],
  });
  return [
    ...(input.position === 1
      ? [insert(toolSetHeaderOutputId(input.nodeId), TOOL_SET_HEADER_HASH, null, null, null)]
      : []),
    insert(
      toolSetOutputId(input.nodeId, input.position),
      input.contentHash,
      input.artifactId,
      input.representationRevisionId,
      verifiedFilingStep(input.nodeId, input.verifiedStepId),
    ),
  ];
}

/** Whether an error of the set's transaction is the unique key of the ledger firing: another set of this
 *  (run, node, extension) committed first (or an aliasing row exists). The transaction rolled back as a whole. */
export function isToolSetIdentityConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes("artifact_materializations_identity_idx");
}

/**
 * Bind a mid-run body the fan-out reused to its message (cinatra#3089): a
 * finalized `email_fanout` row under the message identity pointing at the
 * drafting step's artifact. The retry then reads it as the message's own
 * mapping, and no other message of the run is handed the same artifact.
 *
 * The bind is ONE atomic step that at most one message can win per artifact: a transaction that takes the
 * artifact's advisory lock (the lock its creation transaction and every later writer of it take) and then runs
 * ONE conditional insert, `INSERT … SELECT … WHERE NOT EXISTS` a row of the run that already binds this artifact
 * to a message. The message identity's unique key alone cannot do it (two messages have two identities), and a
 * check-then-insert without the lock lets two transactions both see "unbound". The second message waits on the
 * lock, then its statement (a new snapshot under READ COMMITTED) sees the first's committed row and inserts
 * nothing. Returns whether THIS call inserted the row; false means the artifact is taken by another message, or
 * this message already has its own mapping (the caller reads it).
 */
export async function recordFanoutReuseMaterialization(input: {
  orgId: string;
  runId: string;
  outputId: string;
  extension: string;
  contentHash: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<boolean> {
  assertOutputIdNotReserved(input.outputId);
  ensurePostgresSchema();
  const s = schema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.artifactId]);
    const res = await client.query(
      `INSERT INTO "${s}"."artifact_materializations"
   (id, org_id, run_id, output_id, node_id, path, extension, content_hash,
    artifact_id, representation_revision_id, phase)
 SELECT $1, $2, $3, $4, NULL, 'email_fanout', $5, $6, $7, $8, 'finalized'
  WHERE NOT EXISTS (
    SELECT 1 FROM "${s}"."artifact_materializations" f
     WHERE f.run_id = $3 AND f.org_id = $2 AND f.path = 'email_fanout' AND f.artifact_id = $7
  )
 ON CONFLICT (run_id, output_id, extension, content_hash) DO NOTHING
 RETURNING id`,
      [
        randomUUID(),
        input.orgId,
        input.runId,
        input.outputId,
        input.extension,
        input.contentHash,
        input.artifactId,
        input.representationRevisionId,
      ],
    );
    await client.query("COMMIT");
    return (res.rows?.length ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  assertOutputIdNotReserved(input.authoringStepId);
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

// ---------------------------------------------------------------------------
// THE PICTURE'S PROVENANCE ON ITS LEDGER ROW (plan (C) item 0.28, cinatra#3032).
//
//   item 0.28: "[...] and, per revision, since a regenerated picture has a
//   prompt of its own, the prompt, the provider and the model on the ledger row
//   of that write [...]"
//
// A picture is the first artifact whose CONTENT is not the record of how it was
// asked for: the bytes carry no prompt, and a regeneration produces different
// bytes from the same artifact with a different prompt. The materialization
// ledger already carries one row per write, keyed by (run, output, extension,
// content hash), so the three facts belong on THAT row and nowhere else — a
// second table would be a second answer to "what produced this revision".
//
// ONE WRITER. Both write paths — the create in `artifact-image-tool.ts` and the
// append in `artifact-revision-append.ts` — compose the query this module
// builds into the SAME transaction that finalizes the ledger row, so a row can
// never be finalized without the provenance of the write that finalized it.

/** What was asked of which provider, and which model answered. */
export type ImageGenerationProvenance = {
  /** The prompt THIS revision was generated from — never a previous one's. */
  prompt: string;
  /** The deployment's configured image provider that served the call. */
  provider: string;
  /** The model the adapter ADDRESSED (which need not be the one asked for). */
  model: string | null;
};

/**
 * The provenance write for one ledger row, as a composable query.
 *
 * Phase-guarded on the row's identity only: the callers build it against the
 * ledger id their own claim returned, inside the transaction that finalizes
 * that claim, so a lost race rolls this back with the write it describes.
 */
export function buildImageGenerationProvenanceQuery(input: {
  /** The already-quote-escaped schema identifier. */
  schema: string;
  ledgerId: string;
  orgId: string;
  provenance: ImageGenerationProvenance;
}): { text: string; values: unknown[] } {
  return {
    text: `UPDATE "${input.schema}"."artifact_materializations"
              SET image_prompt = $1, image_provider = $2, image_model = $3
            WHERE id = $4 AND org_id = $5`,
    values: [
      input.provenance.prompt,
      input.provenance.provider,
      input.provenance.model,
      input.ledgerId,
      input.orgId,
    ],
  };
}
