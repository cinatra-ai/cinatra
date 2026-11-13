/**
 * cinatra#4264 slice B1a: the application's half of the step snapshots.
 *
 * T3 persist: a valid claim is stored; a wrong key, another runId, altered
 * bytes or an altered flow_sha256 drop it; an equal second claim is a no-op; a
 * different second claim marks the row ambiguous; a response carrying R2's
 * valid claim, handled for R1, is dropped.
 * T4 vectors (TS side): the shared fixture's bytes, sha256 and attestation are
 * reproduced from the stored string alone, never re-serialized.
 * T6 node list: the union of step and artifactNode, deduped and sorted, only
 * when the stored lifecycle declares `regenerate` and never for a repair run;
 * the resume carrier adds it and is otherwise the token alone.
 *
 * Red at main: step-snapshots.ts and the fixture do not exist; the carrier
 * returns the token only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CINATRA_SNAPSHOT_NODES_METADATA_KEY,
  CINATRA_SNAPSHOT_RUN_METADATA_KEY,
  CINATRA_STEP_SNAPSHOTS_METADATA_KEY,
  extractStepSnapshotClaims,
  persistStepSnapshots,
  readSnapshotNodesMetadataForRun,
  snapshotNodesFromLifecycleConfig,
  snapshotNodesMetadata,
  stepSnapshotAttestation,
  stepSnapshotSha256,
  stripStepSnapshotClaims,
  verifyStepSnapshotClaim,
  type StepSnapshotRow,
  type StepSnapshotWriteOutcome,
} from "../step-snapshots";

const FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../../docker/wayflow/tests/fixtures/step-snapshot-vectors.json"),
    "utf8",
  ),
) as {
  key: string;
  run_id: string;
  node: string;
  flow_sha256: string;
  vectors: Array<{ name: string; inputs_json: string; bytes_hex: string; sha256: string; attestation: string }>;
};

const KEY = FIXTURE.key;
const FLOW = FIXTURE.flow_sha256;

function claim(runId: string, node: string, inputsJson: string, flow = FLOW, key = KEY) {
  const sha256 = stepSnapshotSha256(inputsJson);
  return { node, inputs_json: inputsJson, sha256, flow_sha256: flow, attestation: stepSnapshotAttestation(key, runId, node, sha256, flow) };
}

function leg(...claims: unknown[]) {
  return [
    { role: "user", parts: [{ kind: "text", text: "go" }] },
    { role: "agent", parts: [{ kind: "text", text: "done" }], metadata: { [CINATRA_STEP_SNAPSHOTS_METADATA_KEY]: claims } },
  ];
}

/** An in-memory stand-in of the store write with its conflict rule. */
function memoryWriter() {
  const rows = new Map<string, StepSnapshotRow & { ambiguous: boolean }>();
  const write = vi.fn(async (row: StepSnapshotRow): Promise<StepSnapshotWriteOutcome> => {
    const id = `${row.runId}\n${row.nodeId}`;
    const existing = rows.get(id);
    if (!existing) {
      rows.set(id, { ...row, ambiguous: false });
      return "inserted";
    }
    if (existing.inputsSha256 === row.inputsSha256 && existing.flowSha256 === row.flowSha256) return "equal";
    existing.ambiguous = true;
    return "ambiguous";
  });
  return { rows, write };
}

describe("T4: the shared vectors, TS side", () => {
  it.each(FIXTURE.vectors.map((v) => [v.name, v] as const))("%s: same bytes, sha256 and attestation", (_n, v) => {
    expect(Buffer.from(v.inputs_json, "utf8").toString("hex")).toBe(v.bytes_hex);
    expect(stepSnapshotSha256(v.inputs_json)).toBe(v.sha256);
    expect(stepSnapshotAttestation(KEY, FIXTURE.run_id, FIXTURE.node, v.sha256, FLOW)).toBe(v.attestation);
    const verified = verifyStepSnapshotClaim({
      key: KEY,
      runId: FIXTURE.run_id,
      claim: { node: FIXTURE.node, inputs_json: v.inputs_json, sha256: v.sha256, flow_sha256: FLOW, attestation: v.attestation },
    });
    // Stored verbatim: the string is never re-serialized (1.0, -0.0, 1e+300, a big int survive).
    expect(verified?.inputsJson).toBe(v.inputs_json);
  });
});

describe("T3: verify and persist, against the handler's own runId", () => {
  it("stores a valid claim", async () => {
    const { rows, write } = memoryWriter();
    const out = await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(claim("R1", "produce", '{"a":1}')), key: KEY, write });
    expect(out).toEqual({ stored: ["inserted"], dropped: 0 });
    expect(rows.get("R1\nproduce")).toMatchObject({ orgId: "org-1", inputsJson: '{"a":1}', flowSha256: FLOW, ambiguous: false });
  });

  it("drops a claim under a wrong key, for another run, with altered bytes or an altered flow", async () => {
    const { rows, write } = memoryWriter();
    const good = claim("R1", "produce", '{"a":1}');
    const cases = [
      claim("R1", "produce", '{"a":1}', FLOW, "another-key"),
      claim("R2", "produce", '{"a":1}'),
      { ...good, inputs_json: '{"a":2}' },
      { ...good, flow_sha256: "e".repeat(64) },
      { ...good, inputs_json: "[1]", sha256: stepSnapshotSha256("[1]") },
      "not an object",
    ];
    const out = await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(...cases), key: KEY, write });
    expect(out).toEqual({ stored: [], dropped: cases.length });
    expect(rows.size).toBe(0);
    // A blank key verifies nothing.
    expect(verifyStepSnapshotClaim({ key: "  ", runId: "R1", claim: good })).toBeNull();
  });

  it("an equal second claim is a no-op; a different one marks the row ambiguous", async () => {
    const { rows, write } = memoryWriter();
    const first = claim("R1", "produce", '{"a":1}');
    await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(first), key: KEY, write });
    expect((await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(first), key: KEY, write })).stored).toEqual(["equal"]);
    expect(rows.get("R1\nproduce")?.ambiguous).toBe(false);
    const other = claim("R1", "produce", '{"a":2}');
    expect((await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(other), key: KEY, write })).stored).toEqual(["ambiguous"]);
    expect(rows.get("R1\nproduce")?.ambiguous).toBe(true);
  });

  it("a response carrying R2's task, context and valid claim, handled for R1, stores nothing", async () => {
    const { rows, write } = memoryWriter();
    const r2Response = { id: "task-R2", contextId: "ctx-R2", history: leg(claim("R2", "file_image", '{"p":"x"}')) };
    const out = await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: r2Response.history, key: KEY, write });
    expect(out.dropped).toBe(1);
    expect(rows.size).toBe(0);
  });

  it("a run without an org stores nothing; a store fault never throws", async () => {
    const write = vi.fn(async () => {
      throw new Error("db down");
    });
    const c = claim("R1", "produce", '{"a":1}');
    expect(await persistStepSnapshots({ runId: "R1", orgId: null, history: leg(c), key: KEY, write })).toEqual({ stored: [], dropped: 1 });
    expect(await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(c), key: KEY, write })).toEqual({ stored: [], dropped: 1 });
  });

  it("the stored history keeps its messages and drops the claims and the carrier", () => {
    const history = [
      ...leg(claim("R1", "produce", "{}")),
      { role: "agent", message_id: "cinatra-step-snapshots-task-1", parts: [], metadata: {} },
    ];
    const stripped = stripStepSnapshotClaims(history)!;
    expect(stripped).toHaveLength(2);
    expect(JSON.stringify(stripped)).not.toContain(CINATRA_STEP_SNAPSHOTS_METADATA_KEY);
  });
});

describe("T6: the node list", () => {
  const LIFECYCLE = JSON.stringify({
    regenerate: [
      { artifactNode: "file_image", step: "produce", noteInput: "imageNote" },
      { artifactNode: "file_draft", step: "produce", noteInput: "textNote" },
    ],
  });

  it("is the sorted, deduped union of step and artifactNode", () => {
    expect(snapshotNodesFromLifecycleConfig(LIFECYCLE)).toEqual(["file_draft", "file_image", "produce"]);
    expect(snapshotNodesMetadata({ runId: "R1", sourceType: "agent_builder", lifecycleConfig: LIFECYCLE })).toEqual({
      [CINATRA_SNAPSHOT_NODES_METADATA_KEY]: ["file_draft", "file_image", "produce"],
      [CINATRA_SNAPSHOT_RUN_METADATA_KEY]: "R1",
    });
  });

  it("is absent without a declaration and never on a repair run", () => {
    for (const lifecycleConfig of [null, "", "not json", JSON.stringify({ review: {} }), JSON.stringify({ regenerate: [] })]) {
      expect(snapshotNodesMetadata({ runId: "R1", sourceType: "agent_builder", lifecycleConfig })).toEqual({});
    }
    expect(snapshotNodesMetadata({ runId: "R1", sourceType: "lifecycle_repair", lifecycleConfig: LIFECYCLE })).toEqual({});
  });

  it("is read for a resume from the run's template; a read fault gives none", async () => {
    const deps = {
      readRun: vi.fn(async () => ({ templateId: "tmpl-1", sourceType: "agent_builder" })),
      readTemplate: vi.fn(async () => ({ lifecycleConfig: LIFECYCLE })),
    };
    expect(await readSnapshotNodesMetadataForRun("R1", deps)).toMatchObject({
      [CINATRA_SNAPSHOT_NODES_METADATA_KEY]: ["file_draft", "file_image", "produce"],
    });
    deps.readRun.mockResolvedValueOnce({ templateId: "tmpl-1", sourceType: "lifecycle_repair" });
    expect(await readSnapshotNodesMetadataForRun("R1", deps)).toEqual({});
    deps.readRun.mockRejectedValueOnce(new Error("db down"));
    expect(await readSnapshotNodesMetadataForRun("R1", deps)).toEqual({});
  });
});

describe("Codex pre-1 MF1 and MF2", () => {
  // 33 Regenerate entries with distinct steps s00..s32 and artifact nodes z00..z32: 66 nodes.
  const pad = (i: number) => String(i).padStart(2, "0");
  const ENTRIES = Array.from({ length: 33 }, (_, i) => ({ step: `s${pad(i)}`, artifactNode: `z${pad(i)}`, noteInput: "note" }));
  const NODES = [...ENTRIES.map((e) => e.step), ...ENTRIES.map((e) => e.artifactNode)].sort();

  it("MF1: every declared node is listed, and every claim of a leg is read and stored, none truncated", async () => {
    expect(snapshotNodesFromLifecycleConfig(JSON.stringify({ regenerate: ENTRIES }))).toEqual(NODES);
    const claims = NODES.map((n) => claim("R1", n, `{"n":"${n}"}`));
    expect(extractStepSnapshotClaims(leg(...claims))).toHaveLength(66);
    const { rows, write } = memoryWriter();
    const out = await persistStepSnapshots({ runId: "R1", orgId: "org-1", history: leg(...claims), key: KEY, write });
    expect(out).toEqual({ stored: NODES.map(() => "inserted"), dropped: 0 });
    expect(rows.has("R1\nz31")).toBe(true);
    expect(rows.has("R1\nz32")).toBe(true);
  });

  it("MF2: a correctly signed claim whose flow_sha256 is not 64 lowercase hex is refused", () => {
    for (const flow of ["x", "E".repeat(64), "e".repeat(63), `${"e".repeat(64)}0`]) {
      expect(verifyStepSnapshotClaim({ key: KEY, runId: "R1", claim: claim("R1", "produce", '{"a":1}', flow) })).toBeNull();
    }
    expect(verifyStepSnapshotClaim({ key: KEY, runId: "R1", claim: claim("R1", "produce", '{"a":1}') })).not.toBeNull();
  });
});
