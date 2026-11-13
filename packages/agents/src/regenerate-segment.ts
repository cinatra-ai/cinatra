import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { writeStepSnapshotRow, type StepSnapshotWriter } from "./step-snapshots";

// ---------------------------------------------------------------------------
// THE REGENERATE SEGMENT RUN, the application's half (cinatra#4264, slice B1b).
//
// A Regenerate on a reviewed (artifact, revision) runs ONE new run that
// executes only the declared `step` and its `artifactNode`, of the flow version
// that produced that revision: the note goes to (`step`, `noteInput`), every
// other input of the two nodes comes from the producing run's step snapshots
// (slice B1a), and the filing node's single write becomes the next revision of
// the reviewed artifact through the existing completer, under one gate.
//
//   - RESOLUTION. A run is a segment run iff its `source_type` is
//     `lifecycle_repair`, its id names a repair whose `regenerate_node_id` is
//     set (written by the Regenerate press; NULL = an ordinary repair, run as
//     before), and the re-derivation agrees: the verified filing node of the
//     repair's base revision (`readVerifiedFilingNode`) IS that node; the
//     template's stored `regenerate` list has an entry for it; and the
//     provenance run holds one non-ambiguous snapshot of `step` and of the node
//     with one flow version. Any disagreement refuses the run before dispatch
//     with a plain reason. No `input_params` key ever makes a segment run.
//   - FENCE. Before anything is sent, the runtime's `/.health` must list
//     `regenerate_segment/1`; else the run fails REGENERATE_RUNTIME_UNSUPPORTED.
//   - MESSAGE. The input params hold the note and the typed request only; the
//     metadata `cinatra_regenerate_segment` carries {step, artifactNode,
//     noteInput, flowSha256, snapshots: [{node, inputs_json, sha256}]}, the
//     snapshot strings exactly as stored (never re-serialized).
//   - RECEIPT. A finished segment's last message carries
//     `cinatra_segment_receipt` {step, artifactNode, flowSha256, attestation},
//     attestation = "g1:" + HMAC-SHA256(CINATRA_CONTEXT_ATTEST_KEY,
//     "g1\n<runId>\n<step>\n<artifactNode>\n<flowSha256>"). The task handler
//     verifies it against ITS OWN runId before the resync and persists it; the
//     completer refiles only with a valid persisted receipt.
//   - CLAIM. The completer claims a segment run's production only when the run
//     has exactly one non-CMS production, its ledger row in this run has
//     `verified_step_id = regenerate_node_id`, and the receipt is valid;
//     otherwise the repair stays open (`unresolved`).
// ---------------------------------------------------------------------------

/** First-message metadata: the segment the runtime runs. */
export const REGENERATE_SEGMENT_METADATA_KEY = "cinatra_regenerate_segment";
/** Last-message metadata of a finished segment: the runtime's signed receipt. */
export const SEGMENT_RECEIPT_METADATA_KEY = "cinatra_segment_receipt";
/** What `/.health` must list before a segment run is sent. */
export const REGENERATE_SEGMENT_CAPABILITY = "regenerate_segment/1";
/** The fence's refusal. */
export const REGENERATE_RUNTIME_UNSUPPORTED = "REGENERATE_RUNTIME_UNSUPPORTED";
/** The resolution's refusal prefix. */
export const REGENERATE_SEGMENT_REFUSED = "REGENERATE_SEGMENT_REFUSED";
/**
 * The verified receipt of a segment run is kept in the run's own snapshot
 * table (cascades with the run) under this node id. A segment run is a
 * lifecycle repair run, which never records step snapshots (slice B1a), so no
 * node of its own can sit under this id.
 */
export const SEGMENT_RECEIPT_NODE_ID = "cinatra:segment-receipt";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RECEIPT_ATTESTATION = /^g1:([0-9a-f]{64})$/;
const LIFECYCLE_REPAIR_SOURCE_TYPE = "lifecycle_repair";
/** The id prefix of a repair run; equal to REPAIR_RUN_PREFIX of
 *  ./lifecycle-repair-dispatch-store (pinned by the tests), kept here so that
 *  a run that is not a repair run is answered without loading the store. */
export const SEGMENT_REPAIR_RUN_PREFIX = "lifecycle-repair-run:";

/** The repair a repair-run id names, or null. */
export function segmentRepairIdFromRunId(runId: string | null | undefined): string | null {
  if (!runId || !runId.startsWith(SEGMENT_REPAIR_RUN_PREFIX)) return null;
  const id = runId.slice(SEGMENT_REPAIR_RUN_PREFIX.length);
  return id.length > 0 ? id : null;
}
const FENCE_TIMEOUT_MS = 10_000;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// The stored declaration.
// ---------------------------------------------------------------------------

export type RegenerateEntry = { artifactNode: string; step: string; noteInput: string };

/**
 * The entry of the template's stored `regenerate` list (its lifecycle_config
 * JSON text, or the parsed object) whose `artifactNode` is `artifactNode`, or
 * null. All or nothing, as the stored shape is written: a list with an entry
 * that is not three non-empty strings, or with one `artifactNode` twice, gives
 * no entry at all.
 */
export function readRegenerateEntry(
  lifecycleConfig: unknown,
  artifactNode: string,
): { step: string; noteInput: string } | null {
  let parsed: unknown = lifecycleConfig;
  if (typeof lifecycleConfig === "string") {
    try {
      parsed = JSON.parse(lifecycleConfig);
    } catch {
      return null;
    }
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.regenerate)) return null;
  const seen = new Set<string>();
  let found: { step: string; noteInput: string } | null = null;
  for (const entry of parsed.regenerate) {
    if (!plainObject(entry)) return null;
    const { artifactNode: node, step, noteInput } = entry;
    if (!nonEmptyString(node) || !nonEmptyString(step) || !nonEmptyString(noteInput)) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (node === artifactNode) found = { step, noteInput };
  }
  return found;
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export type RegenerateRepairIntent = {
  id: string;
  orgId: string;
  regenerateNodeId: string | null;
  baseArtifactId: string;
  baseRepresentationRevisionId: string;
};

export type StoredStepSnapshot = {
  nodeId: string;
  inputsJson: string;
  inputsSha256: string;
  flowSha256: string;
  ambiguous: boolean;
};

export type SegmentSnapshot = { node: string; inputs_json: string; sha256: string };

export type RegenerateSegmentPlan = {
  repairId: string;
  provenanceRunId: string;
  step: string;
  artifactNode: string;
  noteInput: string;
  flowSha256: string;
  snapshots: SegmentSnapshot[];
};

export type RegenerateSegmentResolution =
  | { kind: "ordinary" }
  | { kind: "segment"; plan: RegenerateSegmentPlan }
  | { kind: "refused"; reason: string };

export type RegenerateSegmentDeps = {
  /** The repair a repair-run id belongs to (null: not a repair run, or no row). */
  readRepairForRun: (runId: string) => Promise<RegenerateRepairIntent | null>;
  readVerifiedFilingNode: (input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    templateId: string;
  }) => Promise<{ runId: string; nodeId: string } | null>;
  readStepSnapshots: (input: {
    orgId: string;
    runId: string;
    nodeIds: string[];
  }) => Promise<StoredStepSnapshot[]>;
};

async function defaultRegenerateSegmentDeps(): Promise<RegenerateSegmentDeps> {
  const [{ readRepair }, { readVerifiedFilingNode }, { db }, schema, orm] =
    await Promise.all([
      import("./lifecycle-repair-store"),
      import("@/lib/artifacts/regenerate-provenance"),
      import("./db"),
      import("./schema"),
      import("drizzle-orm"),
    ]);
  const t = schema.agentRunStepSnapshots;
  return {
    readRepairForRun: async (runId) => {
      const repairId = segmentRepairIdFromRunId(runId);
      if (!repairId) return null;
      const repair = await readRepair(repairId);
      if (!repair) return null;
      return {
        id: repair.id,
        orgId: repair.orgId,
        regenerateNodeId: repair.regenerateNodeId ?? null,
        baseArtifactId: repair.baseArtifactId,
        baseRepresentationRevisionId: repair.baseRepresentationRevisionId,
      };
    },
    readVerifiedFilingNode: (input) => readVerifiedFilingNode(input),
    readStepSnapshots: async ({ orgId, runId, nodeIds }) =>
      db
        .select({
          nodeId: t.nodeId,
          inputsJson: t.inputsJson,
          inputsSha256: t.inputsSha256,
          flowSha256: t.flowSha256,
          ambiguous: t.ambiguous,
        })
        .from(t)
        .where(orm.and(orm.eq(t.orgId, orgId), orm.eq(t.runId, runId), orm.inArray(t.nodeId, nodeIds))),
  };
}

function refused(reason: string): RegenerateSegmentResolution {
  return { kind: "refused", reason: `${REGENERATE_SEGMENT_REFUSED}: ${reason}` };
}

/**
 * Whether `run` is a Regenerate segment run, and its plan. `ordinary` for a
 * run that is not a lifecycle repair run, a repair run whose id names no
 * repair, and a repair whose `regenerate_node_id` is NULL (both run as before).
 * `refused` for every disagreement of the re-derivation and for a read fault
 * (fail closed: the run is failed before anything is sent).
 */
export async function resolveRegenerateSegment(
  input: {
    run: { id: string; orgId: string | null; sourceType?: string | null; templateId: string };
    lifecycleConfig: unknown;
  },
  deps?: RegenerateSegmentDeps,
): Promise<RegenerateSegmentResolution> {
  const { run } = input;
  if (run.sourceType !== LIFECYCLE_REPAIR_SOURCE_TYPE) return { kind: "ordinary" };
  if (!deps && segmentRepairIdFromRunId(run.id) === null) return { kind: "ordinary" };
  try {
    const d = deps ?? (await defaultRegenerateSegmentDeps());
    const repair = await d.readRepairForRun(run.id);
    if (!repair || repair.regenerateNodeId === null || repair.regenerateNodeId === undefined) {
      return { kind: "ordinary" };
    }
    const nodeId = repair.regenerateNodeId;
    if (!nonEmptyString(nodeId)) return refused("the Regenerate intent names no node");
    if (!nonEmptyString(run.orgId) || repair.orgId !== run.orgId) {
      return refused("the repair belongs to another organization than its run");
    }
    const provenance = await d.readVerifiedFilingNode({
      orgId: repair.orgId,
      artifactId: repair.baseArtifactId,
      representationRevisionId: repair.baseRepresentationRevisionId,
      templateId: run.templateId,
    });
    if (!provenance) {
      return refused("the reviewed revision has no verified filing step of this agent");
    }
    if (provenance.nodeId !== nodeId) {
      return refused("the reviewed revision was filed by another step than the one Regenerate names");
    }
    const entry = readRegenerateEntry(input.lifecycleConfig, nodeId);
    if (!entry) return refused("the agent declares no Regenerate entry for the step that filed the revision");
    const nodes = [...new Set([entry.step, nodeId])].sort();
    const rows = await d.readStepSnapshots({ orgId: repair.orgId, runId: provenance.runId, nodeIds: nodes });
    const snapshots: SegmentSnapshot[] = [];
    let flowSha256: string | null = null;
    for (const node of nodes) {
      const matching = rows.filter((row) => row.nodeId === node);
      if (matching.length !== 1) return refused("the producing run holds no single snapshot of a segment node");
      const row = matching[0]!;
      if (row.ambiguous) return refused("the producing run recorded two different inputs of a segment node");
      if (!SHA256_HEX.test(row.inputsSha256) || !SHA256_HEX.test(row.flowSha256)) {
        return refused("a stored snapshot is malformed");
      }
      if (sha256Utf8(row.inputsJson) !== row.inputsSha256) return refused("a stored snapshot does not match its sha256");
      if (flowSha256 !== null && flowSha256 !== row.flowSha256) {
        return refused("the segment nodes were recorded under two flow versions");
      }
      flowSha256 = row.flowSha256;
      snapshots.push({ node, inputs_json: row.inputsJson, sha256: row.inputsSha256 });
    }
    return {
      kind: "segment",
      plan: {
        repairId: repair.id,
        provenanceRunId: provenance.runId,
        step: entry.step,
        artifactNode: nodeId,
        noteInput: entry.noteInput,
        flowSha256: flowSha256!,
        snapshots,
      },
    };
  } catch (err) {
    console.error(
      `[regenerate-segment] run=${run.id} resolution failed: ${err instanceof Error ? err.name : "error"}`,
    );
    return refused("the Regenerate segment could not be resolved");
  }
}

/**
 * Whether `run` is a lifecycle repair run whose repair names a Regenerate
 * intent: the task handler skips the end-node binding materialization for it.
 * A read fault answers false: the materializer then runs and, finding none of
 * the template's end outputs on a segment, fails the run (fail closed).
 */
export async function isRegenerateSegmentRun(
  run: { id: string; sourceType?: string | null },
  deps?: Pick<RegenerateSegmentDeps, "readRepairForRun">,
): Promise<boolean> {
  if (run.sourceType !== LIFECYCLE_REPAIR_SOURCE_TYPE) return false;
  if (!deps && segmentRepairIdFromRunId(run.id) === null) return false;
  try {
    const read = deps?.readRepairForRun ?? (await defaultRegenerateSegmentDeps()).readRepairForRun;
    const repair = await read(run.id);
    return nonEmptyString(repair?.regenerateNodeId);
  } catch {
    return false;
  }
}

/** The first-message metadata of a segment run. */
export function regenerateSegmentMetadata(plan: RegenerateSegmentPlan): Record<string, unknown> {
  return {
    [REGENERATE_SEGMENT_METADATA_KEY]: {
      step: plan.step,
      artifactNode: plan.artifactNode,
      noteInput: plan.noteInput,
      flowSha256: plan.flowSha256,
      snapshots: plan.snapshots.map((s) => ({ node: s.node, inputs_json: s.inputs_json, sha256: s.sha256 })),
    },
  };
}

// ---------------------------------------------------------------------------
// The dispatch drain's half: the run's parent and its input params.
// ---------------------------------------------------------------------------

export type SegmentDispatchPlan =
  | { kind: "segment"; parentRunId: string; inputParams: Record<string, unknown> }
  | { kind: "refused"; reason: string };

/**
 * What the dispatch drain writes for a repair whose `regenerate_node_id` is
 * set: the run's `parent_run_id` is the PROVENANCE run (the run that filed the
 * reviewed revision, so the context inheritance reads that run's answers), and
 * its input params hold the note, under the entry's `noteInput`, and the typed
 * request only. A provenance that cannot be proven, or another filing node,
 * refuses (the drain escalates the repair; nothing is dispatched).
 */
export async function planSegmentDispatch(
  input: {
    repair: RegenerateRepairIntent;
    templateId: string;
    lifecycleConfig: unknown;
    note: string;
    request: Record<string, unknown>;
  },
  deps?: Pick<RegenerateSegmentDeps, "readVerifiedFilingNode">,
): Promise<SegmentDispatchPlan> {
  const { repair } = input;
  const nodeId = repair.regenerateNodeId;
  if (!nonEmptyString(nodeId)) return { kind: "refused", reason: "the Regenerate intent names no node" };
  const read =
    deps?.readVerifiedFilingNode ??
    (await import("@/lib/artifacts/regenerate-provenance")).readVerifiedFilingNode;
  const provenance = await read({
    orgId: repair.orgId,
    artifactId: repair.baseArtifactId,
    representationRevisionId: repair.baseRepresentationRevisionId,
    templateId: input.templateId,
  });
  if (!provenance || provenance.nodeId !== nodeId) {
    return { kind: "refused", reason: "Regenerate refused: the reviewed revision has no verified filing step it names" };
  }
  const entry = readRegenerateEntry(input.lifecycleConfig, nodeId);
  if (!entry) {
    return { kind: "refused", reason: "Regenerate refused: the agent declares no Regenerate entry for that step" };
  }
  return {
    kind: "segment",
    parentRunId: provenance.runId,
    inputParams: { [entry.noteInput]: input.note, lifecycleRepairRequest: input.request },
  };
}

// ---------------------------------------------------------------------------
// The fence.
// ---------------------------------------------------------------------------

/**
 * True only when the runtime's `/.health` answers with a `capabilities` list
 * that names `regenerate_segment/1`. Any other answer, a fault, or no
 * `WAYFLOW_BASE_URL` is false: the caller then fails the run before anything is
 * sent.
 */
export async function fenceRegenerateRuntime(opts?: {
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const base = (opts?.baseUrl ?? process.env.WAYFLOW_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return false;
  try {
    const response = await (opts?.fetchImpl ?? fetch)(`${base}/.health`, {
      method: "GET",
      signal: AbortSignal.timeout(FENCE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (!plainObject(body) || !Array.isArray(body.capabilities)) return false;
    return body.capabilities.includes(REGENERATE_SEGMENT_CAPABILITY);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The receipt.
// ---------------------------------------------------------------------------

export type SegmentReceipt = { step: string; artifactNode: string; flowSha256: string; attestation: string };

export function segmentReceiptAttestation(
  key: string,
  runId: string,
  step: string,
  artifactNode: string,
  flowSha256: string,
): string {
  const material = `g1\n${runId}\n${step}\n${artifactNode}\n${flowSha256}`;
  return `g1:${createHmac("sha256", key).update(material, "utf8").digest("hex")}`;
}

/** The receipt for `runId` (the handler's own run), or null when the key is
 *  blank or the claim has another shape or does not verify. */
export function verifySegmentReceiptClaim(input: {
  key: string | null | undefined;
  runId: string;
  claim: unknown;
}): SegmentReceipt | null {
  const { key, runId, claim } = input;
  if (!nonEmptyString(key) || key.trim() === "" || !nonEmptyString(runId)) return null;
  if (!plainObject(claim)) return null;
  const { step, artifactNode, flowSha256, attestation } = claim;
  if (!nonEmptyString(step) || !nonEmptyString(artifactNode)) return null;
  if (!nonEmptyString(flowSha256) || !SHA256_HEX.test(flowSha256)) return null;
  if (!nonEmptyString(attestation)) return null;
  const match = RECEIPT_ATTESTATION.exec(attestation);
  if (!match) return null;
  const expected = segmentReceiptAttestation(key, runId, step, artifactNode, flowSha256).slice(3);
  if (!equalHex(match[1]!, expected)) return null;
  return { step, artifactNode, flowSha256, attestation };
}

type HistoryLike = { role?: unknown; metadata?: unknown };

export function extractSegmentReceiptClaims(history: ReadonlyArray<HistoryLike> | undefined): unknown[] {
  const out: unknown[] = [];
  for (const message of history ?? []) {
    if (message?.role !== "agent" && message?.role !== "assistant") continue;
    if (!plainObject(message.metadata)) continue;
    if (SEGMENT_RECEIPT_METADATA_KEY in message.metadata) out.push(message.metadata[SEGMENT_RECEIPT_METADATA_KEY]);
  }
  return out;
}

/** `history` without the receipt (removed from every message's metadata). */
export function stripSegmentReceipts<T extends HistoryLike>(
  history: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined {
  if (!history) return history;
  return history.map((message) => {
    const metadata = message?.metadata;
    if (!plainObject(metadata) || !(SEGMENT_RECEIPT_METADATA_KEY in metadata)) return message;
    const rest = { ...metadata };
    delete rest[SEGMENT_RECEIPT_METADATA_KEY];
    const copy = { ...message } as T & { metadata?: unknown };
    if (Object.keys(rest).length > 0) copy.metadata = rest;
    else delete copy.metadata;
    return copy;
  });
}

/** The stored form of a verified receipt: sorted keys, one serialization. */
function receiptJson(receipt: SegmentReceipt): string {
  return JSON.stringify({
    artifactNode: receipt.artifactNode,
    attestation: receipt.attestation,
    flowSha256: receipt.flowSha256,
    step: receipt.step,
  });
}

/**
 * Verify and store the receipt a leg's response carries, for `runId` (the
 * handler's own argument), BEFORE the resync. Never throws. Only exactly one
 * verified receipt is stored; none, an unverified one, or two are dropped
 * (logged), and the completer then refiles nothing.
 */
export async function persistSegmentReceipt(input: {
  runId: string;
  orgId: string | null | undefined;
  history: ReadonlyArray<HistoryLike> | undefined;
  key?: string | null;
  write?: StepSnapshotWriter;
}): Promise<"stored" | "none" | "dropped"> {
  const claims = extractSegmentReceiptClaims(input.history);
  if (claims.length === 0) return "none";
  const key = input.key === undefined ? process.env.CINATRA_CONTEXT_ATTEST_KEY : input.key;
  const verified = claims.length === 1 ? verifySegmentReceiptClaim({ key, runId: input.runId, claim: claims[0] }) : null;
  if (!verified || !nonEmptyString(input.orgId)) {
    console.warn(`[regenerate-segment] run=${input.runId} dropped an unverified segment receipt`);
    return "dropped";
  }
  const inputsJson = receiptJson(verified);
  try {
    const outcome = await (input.write ?? writeStepSnapshotRow)({
      orgId: input.orgId,
      runId: input.runId,
      nodeId: SEGMENT_RECEIPT_NODE_ID,
      inputsJson,
      inputsSha256: sha256Utf8(inputsJson),
      flowSha256: verified.flowSha256,
    });
    return outcome === "ambiguous" ? "dropped" : "stored";
  } catch (err) {
    console.warn(
      `[regenerate-segment] run=${input.runId} receipt store failed: ${err instanceof Error ? err.name : "error"}`,
    );
    return "dropped";
  }
}

/** A stored receipt row, re-verified against `runId` (null when absent,
 *  ambiguous, or not valid under the key). */
export function readStoredSegmentReceipt(input: {
  runId: string;
  row: StoredStepSnapshot | null | undefined;
  key?: string | null;
}): SegmentReceipt | null {
  const { row } = input;
  if (!row || row.ambiguous || row.nodeId !== SEGMENT_RECEIPT_NODE_ID) return null;
  if (sha256Utf8(row.inputsJson) !== row.inputsSha256) return null;
  let claim: unknown;
  try {
    claim = JSON.parse(row.inputsJson);
  } catch {
    return null;
  }
  const key = input.key === undefined ? process.env.CINATRA_CONTEXT_ATTEST_KEY : input.key;
  const receipt = verifySegmentReceiptClaim({ key, runId: input.runId, claim });
  return receipt && receipt.flowSha256 === row.flowSha256 ? receipt : null;
}

// ---------------------------------------------------------------------------
// The completer's claim.
// ---------------------------------------------------------------------------

export type SegmentClaimDeps = {
  /** Every non-CMS produced-event row of the run (artifact, revision). */
  listProductions: (orgId: string, runId: string) => Promise<Array<{ artifactId: string; representationRevisionId: string }>>;
  /** The `verified_step_id` of each finalized `materialize_tool` ledger row
   *  of this run for (artifact, revision). */
  readVerifiedSteps: (input: {
    orgId: string;
    runId: string;
    artifactId: string;
    representationRevisionId: string;
  }) => Promise<Array<string | null>>;
  /** The stored receipt row of the run, if any. */
  readReceiptRow: (orgId: string, runId: string) => Promise<StoredStepSnapshot | null>;
};

/**
 * The production a segment run answered with, or null (the repair stays
 * open): exactly one non-CMS production; exactly one finalized ledger row of
 * that revision in this run, whose verified step is `regenerateNodeId`; and a
 * valid persisted receipt naming that node.
 */
export async function claimSegmentProduction(
  input: { orgId: string; runId: string; regenerateNodeId: string; key?: string | null },
  deps: SegmentClaimDeps,
): Promise<{ artifactId: string; representationRevisionId: string } | null> {
  const productions = await deps.listProductions(input.orgId, input.runId);
  if (productions.length !== 1) return null;
  const production = productions[0]!;
  const steps = await deps.readVerifiedSteps({
    orgId: input.orgId,
    runId: input.runId,
    artifactId: production.artifactId,
    representationRevisionId: production.representationRevisionId,
  });
  if (steps.length !== 1 || steps[0] !== input.regenerateNodeId) return null;
  const receipt = readStoredSegmentReceipt({
    runId: input.runId,
    row: await deps.readReceiptRow(input.orgId, input.runId),
    key: input.key,
  });
  if (!receipt || receipt.artifactNode !== input.regenerateNodeId) return null;
  return { artifactId: production.artifactId, representationRevisionId: production.representationRevisionId };
}
