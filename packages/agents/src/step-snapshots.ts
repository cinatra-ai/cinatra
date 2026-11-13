import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// THE STEP SNAPSHOTS OF A RUN (cinatra#4264, slice B1a).
//
// A Regenerate reruns ONE step of the run that produced a reviewed revision,
// with every input but the note exactly as that run gave it. This module is the
// application's half of recording those inputs:
//
//   - NODE LIST. The nodes whose inputs are recorded: the union of `step` and
//     `artifactNode` over the template's stored `lifecycleConfig.regenerate`,
//     deduped and sorted. It rides the run's initial message and every resume
//     (`mintResumeRunTokenMetadata`) as message metadata, never for a
//     lifecycle repair run. No declaration -> no key -> the message is
//     byte-identical to what it was before this module.
//   - CLAIMS. The flow runtime (docker/wayflow/step_snapshot.py) serializes a
//     listed top-level node's FULL resolved input once, canonically, and puts
//     `{node, inputs_json, sha256, flow_sha256, attestation}` on the leg's last
//     message metadata. attestation = "n1:" + HMAC-SHA256(CINATRA_CONTEXT_ATTEST_KEY,
//     "n1\n<runId>\n<node>\n<sha256>\n<flow_sha256>").
//   - PERSIST. The task handler verifies each claim against ITS OWN runId
//     argument (never an id read from the response) BEFORE the task/context
//     resync, recomputes sha256 over the received UTF-8 bytes, and inserts the
//     row ON CONFLICT DO NOTHING; a second, different value of the same
//     (run, node) marks the row ambiguous. An unverified claim is dropped and
//     logged.
//
// ONE SERIALIZATION. The runtime's bytes are canonical; the application never
// re-serializes: it stores `inputs_json` verbatim (JSON.parse only checks it is
// an object) and hashes `Buffer.from(s, "utf8")`. The shared vectors live in
// docker/wayflow/tests/fixtures/step-snapshot-vectors.json.
// ---------------------------------------------------------------------------

/** Message metadata: the sorted node list the runtime records. */
export const CINATRA_SNAPSHOT_NODES_METADATA_KEY = "cinatra_snapshot_nodes";
/** Message metadata: the run id the runtime signs each snapshot for. */
export const CINATRA_SNAPSHOT_RUN_METADATA_KEY = "cinatra_snapshot_run_id";
/** Last-message metadata of a leg: the runtime's snapshot claims. */
export const CINATRA_STEP_SNAPSHOTS_METADATA_KEY = "cinatra_step_snapshots";
/** The message id prefix of the carrier message the runtime adds to a leg that
 *  has no message of its own to carry the claims. */
export const CINATRA_STEP_SNAPSHOTS_CARRIER_PREFIX = "cinatra-step-snapshots-";
/** The runtime drops a capture larger than this; the application refuses it too. */
export const STEP_SNAPSHOT_MAX_BYTES = 512 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_ATTESTATION = /^n1:([0-9a-f]{64})$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The node list.
// ---------------------------------------------------------------------------

/**
 * The nodes to record, read from a template's stored lifecycle config (its JSON
 * text, or the parsed object): the union of `step` and `artifactNode` over the
 * `regenerate` entries, deduped and sorted. The `regenerate` key is written by
 * the A1 slice of cinatra#4264 (`serializeLifecycleConfig`); this reader takes
 * the stored shape as it is and needs nothing else of A1. An entry that is not
 * an object with two non-empty string members is skipped; no list -> [].
 */
export function snapshotNodesFromLifecycleConfig(lifecycleConfig: unknown): string[] {
  let parsed: unknown = lifecycleConfig;
  if (typeof lifecycleConfig === "string") {
    try {
      parsed = JSON.parse(lifecycleConfig);
    } catch {
      return [];
    }
  }
  if (!plainObject(parsed)) return [];
  const list = parsed.regenerate;
  if (!Array.isArray(list)) return [];
  const nodes = new Set<string>();
  for (const entry of list) {
    if (!plainObject(entry)) continue;
    if (!nonEmptyString(entry.step) || !nonEmptyString(entry.artifactNode)) continue;
    nodes.add(entry.step);
    nodes.add(entry.artifactNode);
  }
  return [...nodes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The message metadata that asks the runtime to record the listed nodes of
 * this run: `{}` for a lifecycle repair run and for a template with no
 * `regenerate` declaration (the message then carries no new key).
 */
export function snapshotNodesMetadata(input: {
  runId: string;
  sourceType: string | null | undefined;
  lifecycleConfig: unknown;
}): Record<string, unknown> {
  if (input.sourceType === "lifecycle_repair") return {};
  const nodes = snapshotNodesFromLifecycleConfig(input.lifecycleConfig);
  if (nodes.length === 0) return {};
  return {
    [CINATRA_SNAPSHOT_NODES_METADATA_KEY]: nodes,
    [CINATRA_SNAPSHOT_RUN_METADATA_KEY]: input.runId,
  };
}

export type SnapshotNodesDeps = {
  readRun: (runId: string) => Promise<{ templateId: string; sourceType?: string | null } | null>;
  readTemplate: (templateId: string) => Promise<{ lifecycleConfig?: string | null } | null>;
};

async function defaultSnapshotNodesDeps(): Promise<SnapshotNodesDeps> {
  // Named, read-only bindings: the store module's writers stay out of reach.
  const { readAgentRunById, readAgentTemplateById } = await import("./store");
  return {
    readRun: (runId) => readAgentRunById(runId),
    readTemplate: (templateId) => readAgentTemplateById(templateId),
  };
}

/**
 * The node-list metadata for a RESUME of `runId`, read from the run and its
 * template. A read fault gives `{}` (logged): the resume goes on and the leg
 * records no snapshot, which a later Regenerate refuses with a plain reason.
 */
export async function readSnapshotNodesMetadataForRun(
  runId: string,
  deps?: SnapshotNodesDeps,
): Promise<Record<string, unknown>> {
  try {
    const d = deps ?? (await defaultSnapshotNodesDeps());
    const run = await d.readRun(runId);
    if (!run || run.sourceType === "lifecycle_repair") return {};
    const template = await d.readTemplate(run.templateId);
    return snapshotNodesMetadata({
      runId,
      sourceType: run.sourceType,
      lifecycleConfig: template?.lifecycleConfig ?? null,
    });
  } catch (err) {
    console.warn(
      `[step-snapshots] run=${runId} node list unreadable on resume: ${err instanceof Error ? err.name : "error"}`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Claims.
// ---------------------------------------------------------------------------

/** sha256 hex over the UTF-8 bytes of `inputsJson`, exactly as received. */
export function stepSnapshotSha256(inputsJson: string): string {
  return createHash("sha256").update(Buffer.from(inputsJson, "utf8")).digest("hex");
}

/** The runtime's attestation of one snapshot (`n1:<hex>`). */
export function stepSnapshotAttestation(
  key: string,
  runId: string,
  node: string,
  sha256: string,
  flowSha256: string,
): string {
  const material = `n1\n${runId}\n${node}\n${sha256}\n${flowSha256}`;
  return `n1:${createHmac("sha256", key).update(material, "utf8").digest("hex")}`;
}

export type VerifiedStepSnapshot = {
  nodeId: string;
  inputsJson: string;
  inputsSha256: string;
  flowSha256: string;
};

/**
 * Verify one claim for `runId` (the handler's own run). Answers the snapshot,
 * or null when the key is blank, the claim has another shape (sha256 and
 * flow_sha256 are each 64 lowercase hex), the bytes are
 * over STEP_SNAPSHOT_MAX_BYTES or are not a JSON object, the sha256 does not
 * match the received bytes, or the attestation does not verify over
 * (runId, node, sha256, flow_sha256).
 */
export function verifyStepSnapshotClaim(input: {
  key: string | null | undefined;
  runId: string;
  claim: unknown;
}): VerifiedStepSnapshot | null {
  const { key, runId, claim } = input;
  if (!nonEmptyString(key) || key.trim() === "" || !nonEmptyString(runId)) return null;
  if (!plainObject(claim)) return null;
  const { node, inputs_json, sha256, flow_sha256, attestation } = claim;
  if (!nonEmptyString(node) || typeof inputs_json !== "string") return null;
  if (!nonEmptyString(sha256) || !SHA256_HEX.test(sha256)) return null;
  if (!nonEmptyString(flow_sha256) || !SHA256_HEX.test(flow_sha256)) return null;
  if (!nonEmptyString(attestation)) return null;
  const bytes = Buffer.from(inputs_json, "utf8");
  if (bytes.length > STEP_SNAPSHOT_MAX_BYTES) return null;
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return null;
  try {
    if (!plainObject(JSON.parse(inputs_json))) return null;
  } catch {
    return null;
  }
  const match = SNAPSHOT_ATTESTATION.exec(attestation);
  if (!match) return null;
  const expected = stepSnapshotAttestation(key, runId, node, sha256, flow_sha256).slice(3);
  const a = Buffer.from(match[1]!, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { nodeId: node, inputsJson: inputs_json, inputsSha256: sha256, flowSha256: flow_sha256 };
}

type HistoryLike = { role?: unknown; metadata?: unknown; messageId?: unknown; message_id?: unknown };

/**
 * Every snapshot claim on the agent messages of `history`, in order. None is
 * left out: the node list is the complete union the template declares, so a
 * leg carries one claim per recorded node and every one is verified.
 */
export function extractStepSnapshotClaims(history: ReadonlyArray<HistoryLike> | undefined): unknown[] {
  const out: unknown[] = [];
  for (const message of history ?? []) {
    if (message?.role !== "agent" && message?.role !== "assistant") continue;
    const metadata = message.metadata;
    if (!plainObject(metadata)) continue;
    const claims = metadata[CINATRA_STEP_SNAPSHOTS_METADATA_KEY];
    if (!Array.isArray(claims)) continue;
    for (const claim of claims) out.push(claim);
  }
  return out;
}

/**
 * `history` without the snapshot claims (removed from every message's
 * metadata) and without the runtime's carrier messages; applied before a run's
 * history is stored, so the inputs live only in agent_run_step_snapshots.
 */
export function stripStepSnapshotClaims<T extends HistoryLike>(
  history: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined {
  if (!history) return history;
  const out: T[] = [];
  for (const message of history) {
    const id = message?.messageId ?? message?.message_id;
    if (typeof id === "string" && id.startsWith(CINATRA_STEP_SNAPSHOTS_CARRIER_PREFIX)) continue;
    const metadata = message?.metadata;
    if (!plainObject(metadata) || !(CINATRA_STEP_SNAPSHOTS_METADATA_KEY in metadata)) {
      out.push(message);
      continue;
    }
    const rest = { ...metadata };
    delete rest[CINATRA_STEP_SNAPSHOTS_METADATA_KEY];
    const copy = { ...message } as T & { metadata?: unknown };
    if (Object.keys(rest).length > 0) copy.metadata = rest;
    else delete copy.metadata;
    out.push(copy);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persist.
// ---------------------------------------------------------------------------

export type StepSnapshotRow = VerifiedStepSnapshot & { orgId: string; runId: string };
export type StepSnapshotWriteOutcome = "inserted" | "equal" | "ambiguous";
export type StepSnapshotWriter = (row: StepSnapshotRow) => Promise<StepSnapshotWriteOutcome>;

/** The store write: insert once per (run, node); a different second value marks the row ambiguous. */
export async function writeStepSnapshotRow(row: StepSnapshotRow): Promise<StepSnapshotWriteOutcome> {
  const { db } = await import("./db");
  const { agentRunStepSnapshots: t } = await import("./schema");
  const { and, eq } = await import("drizzle-orm");
  const inserted = await db
    .insert(t)
    .values({
      orgId: row.orgId,
      runId: row.runId,
      nodeId: row.nodeId,
      inputsJson: row.inputsJson,
      inputsSha256: row.inputsSha256,
      flowSha256: row.flowSha256,
    })
    .onConflictDoNothing({ target: [t.runId, t.nodeId] })
    .returning({ nodeId: t.nodeId });
  if (inserted.length > 0) return "inserted";
  const where = and(eq(t.runId, row.runId), eq(t.nodeId, row.nodeId));
  const [existing] = await db
    .select({ inputsSha256: t.inputsSha256, flowSha256: t.flowSha256 })
    .from(t)
    .where(where)
    .limit(1);
  if (existing && existing.inputsSha256 === row.inputsSha256 && existing.flowSha256 === row.flowSha256) {
    return "equal";
  }
  await db.update(t).set({ ambiguous: true }).where(where);
  return "ambiguous";
}

/**
 * Verify and store the snapshot claims a leg's response carries, for `runId`
 * (the handler's own argument). Never throws: a store fault is logged and the
 * leg goes on. Returns what happened to each claim, for the log and the tests.
 */
export async function persistStepSnapshots(input: {
  runId: string;
  orgId: string | null | undefined;
  history: ReadonlyArray<HistoryLike> | undefined;
  key?: string | null;
  write?: StepSnapshotWriter;
}): Promise<{ stored: StepSnapshotWriteOutcome[]; dropped: number }> {
  const claims = extractStepSnapshotClaims(input.history);
  const result = { stored: [] as StepSnapshotWriteOutcome[], dropped: 0 };
  if (claims.length === 0) return result;
  const key = input.key === undefined ? process.env.CINATRA_CONTEXT_ATTEST_KEY : input.key;
  const write = input.write ?? writeStepSnapshotRow;
  const orgId = nonEmptyString(input.orgId) ? input.orgId : null;
  for (const claim of claims) {
    const verified = verifyStepSnapshotClaim({ key, runId: input.runId, claim });
    if (!verified || orgId === null) {
      result.dropped += 1;
      console.warn(`[step-snapshots] run=${input.runId} dropped an unverified snapshot claim`);
      continue;
    }
    try {
      result.stored.push(await write({ ...verified, orgId, runId: input.runId }));
    } catch (err) {
      result.dropped += 1;
      console.warn(
        `[step-snapshots] run=${input.runId} node=${verified.nodeId} store failed: ${err instanceof Error ? err.name : "error"}`,
      );
    }
  }
  return result;
}
