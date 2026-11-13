/**
 * cinatra#4264 slice B1b: the application's half of the Regenerate segment run.
 *
 * Entry: the stored `regenerate` list is read all or nothing.
 * T11 resolution: a NULL `regenerate_node_id` is an ordinary repair; a set one
 * is re-derived from the verified provenance and the stored snapshots, and
 * every disagreement (another filing node, no provenance, no entry, a missing,
 * ambiguous or altered snapshot, two flow versions, another organization, a
 * read fault) refuses the run with a plain reason.
 * T12 fence: only a `/.health` whose `capabilities` lists
 * `regenerate_segment/1` lets a segment run be sent.
 * Receipt: the shared vectors reproduce on the TS side; a receipt is verified
 * against the handler's own runId, stored once, and stripped from history.
 * Claim: the completer claims exactly one write by the named node, with a
 * valid stored receipt; anything else leaves the repair open.
 * Dispatch: the run's parent is the provenance run; its inputs are the note
 * and the typed request only.
 * Note start output (App1 ruling on B1b): the note travels under the flow's
 * ORIGINAL start output that feeds (step, noteInput), read from the agent's
 * flow document; the segment metadata carries that name as
 * `noteStartOutput`, and a flow where no single start output feeds the note
 * refuses.
 *
 * Red at the B1a head: regenerate-segment.ts and the vectors do not exist.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  REGENERATE_SEGMENT_CAPABILITY,
  REGENERATE_SEGMENT_METADATA_KEY,
  REGENERATE_SEGMENT_REFUSED,
  SEGMENT_RECEIPT_METADATA_KEY,
  SEGMENT_RECEIPT_NODE_ID,
  SEGMENT_REPAIR_RUN_PREFIX,
  claimSegmentProduction,
  fenceRegenerateRuntime,
  noteStartOutputFromOas,
  isRegenerateSegmentRun,
  persistSegmentReceipt,
  planSegmentDispatch,
  readRegenerateEntry,
  readStoredSegmentReceipt,
  regenerateSegmentMetadata,
  resolveRegenerateSegment,
  segmentReceiptAttestation,
  segmentRepairIdFromRunId,
  stripSegmentReceipts,
  verifySegmentReceiptClaim,
  type RegenerateRepairIntent,
  type RegenerateSegmentDeps,
  type StoredStepSnapshot,
} from "../regenerate-segment";

const VECTORS = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../../docker/wayflow/tests/fixtures/regenerate-segment-receipt-vectors.json"),
    "utf8",
  ),
) as {
  key: string;
  vectors: Array<{ name: string; run_id: string; step: string; artifactNode: string; flowSha256: string; attestation: string }>;
};

const KEY = VECTORS.key;
const FLOW = "a".repeat(64);
const OTHER_FLOW = "b".repeat(64);
const RUN = "lifecycle-repair-run:repair-1";
const PROVENANCE_RUN = "run-producer-1";

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const LIFECYCLE = JSON.stringify({
  regenerate: [
    { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
    { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" },
  ],
});

function snapshot(nodeId: string, inputsJson: string, over: Partial<StoredStepSnapshot> = {}): StoredStepSnapshot {
  return { nodeId, inputsJson, inputsSha256: sha(inputsJson), flowSha256: FLOW, ambiguous: false, ...over };
}

function intent(over: Partial<RegenerateRepairIntent> = {}): RegenerateRepairIntent {
  return {
    id: "repair-1",
    orgId: "org-1",
    regenerateNodeId: "file_image",
    baseArtifactId: "artifact-1",
    baseRepresentationRevisionId: "rev-1",
    ...over,
  };
}

function deps(over: Partial<RegenerateSegmentDeps> = {}): RegenerateSegmentDeps {
  return {
    readRepairForRun: vi.fn(async () => intent()),
    readVerifiedFilingNode: vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "file_image" })),
    readNoteStartOutput: vi.fn(async () => "imagePrompt"),
    readStepSnapshots: vi.fn(async () => [
      snapshot("image_flow", '{"prompt":"a cat","post":"kept"}'),
      snapshot("file_image", '{"title":"t"}'),
    ]),
    ...over,
  };
}

const RUN_ROW = { id: RUN, orgId: "org-1", sourceType: "lifecycle_repair", templateId: "tpl-1" };
const PACKAGE = "@cinatra-ai/blog-pipeline-agent";

async function resolve(d: RegenerateSegmentDeps, run = RUN_ROW, lifecycleConfig: unknown = LIFECYCLE) {
  return resolveRegenerateSegment({ run, lifecycleConfig, packageName: PACKAGE }, d);
}

function expectRefused(result: Awaited<ReturnType<typeof resolve>>) {
  expect(result.kind).toBe("refused");
  if (result.kind === "refused") expect(result.reason.startsWith(`${REGENERATE_SEGMENT_REFUSED}: `)).toBe(true);
}

describe("readRegenerateEntry", () => {
  it("reads the entry of the named filing node, from text or object", () => {
    expect(readRegenerateEntry(LIFECYCLE, "file_image")).toEqual({ step: "image_flow", noteInput: "prompt" });
    expect(readRegenerateEntry(JSON.parse(LIFECYCLE), "write_draft")).toEqual({ step: "draft_flow", noteInput: "note" });
    expect(readRegenerateEntry(LIFECYCLE, "other")).toBeNull();
  });

  it("is all or nothing", () => {
    const bad = (regenerate: unknown) => readRegenerateEntry({ regenerate }, "file_image");
    expect(bad([{ artifactNode: "file_image", step: "image_flow", noteInput: "" }])).toBeNull();
    expect(
      bad([
        { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
        { artifactNode: "x", step: 3, noteInput: "n" },
      ]),
    ).toBeNull();
    expect(
      bad([
        { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
        { artifactNode: "file_image", step: "other", noteInput: "prompt" },
      ]),
    ).toBeNull();
    expect(bad("nope")).toBeNull();
    expect(readRegenerateEntry("{not json", "file_image")).toBeNull();
    expect(readRegenerateEntry(null, "file_image")).toBeNull();
  });
});

describe("resolveRegenerateSegment (T11)", () => {
  it("a run that is not a repair run is ordinary and reads nothing", async () => {
    const d = deps();
    expect(await resolve(d, { ...RUN_ROW, sourceType: "manual" })).toEqual({ kind: "ordinary" });
    expect(d.readRepairForRun).not.toHaveBeenCalled();
    // Without deps a non-repair id is answered without loading the store.
    expect(
      await resolveRegenerateSegment({
        run: { ...RUN_ROW, id: "run-plain" },
        lifecycleConfig: LIFECYCLE,
        packageName: PACKAGE,
      }),
    ).toEqual({ kind: "ordinary" });
  });

  it("a repair whose regenerate_node_id is NULL (or no repair) runs as before", async () => {
    expect(await resolve(deps({ readRepairForRun: vi.fn(async () => intent({ regenerateNodeId: null })) }))).toEqual({
      kind: "ordinary",
    });
    expect(await resolve(deps({ readRepairForRun: vi.fn(async () => null) }))).toEqual({ kind: "ordinary" });
  });

  it("an agreeing re-derivation gives the segment plan from the provenance run", async () => {
    const d = deps();
    const result = await resolve(d);
    expect(result).toEqual({
      kind: "segment",
      plan: {
        repairId: "repair-1",
        provenanceRunId: PROVENANCE_RUN,
        step: "image_flow",
        artifactNode: "file_image",
        noteInput: "prompt",
        noteStartOutput: "imagePrompt",
        flowSha256: FLOW,
        snapshots: [
          { node: "file_image", inputs_json: '{"title":"t"}', sha256: sha('{"title":"t"}') },
          {
            node: "image_flow",
            inputs_json: '{"prompt":"a cat","post":"kept"}',
            sha256: sha('{"prompt":"a cat","post":"kept"}'),
          },
        ],
      },
    });
    expect(d.readVerifiedFilingNode).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "artifact-1",
      representationRevisionId: "rev-1",
      templateId: "tpl-1",
    });
    expect(d.readStepSnapshots).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: PROVENANCE_RUN,
      nodeIds: ["file_image", "image_flow"],
    });
    expect(d.readNoteStartOutput).toHaveBeenCalledWith({ packageName: PACKAGE, step: "image_flow", noteInput: "prompt" });
  });

  it("refuses when no single start output of the agent's flow feeds the note, or it cannot be read", async () => {
    expectRefused(await resolve(deps({ readNoteStartOutput: vi.fn(async () => null) })));
    expectRefused(await resolve(deps({ readNoteStartOutput: vi.fn(async () => "") })));
    expectRefused(
      await resolve(
        deps({
          readNoteStartOutput: vi.fn(async () => {
            throw new Error("unreadable");
          }),
        }),
      ),
    );
  });

  it("the run's own input params never make a segment run", async () => {
    // The resolution reads only the repair row, the provenance and the
    // snapshots: no input-params argument exists.
    const result = await resolve(deps({ readRepairForRun: vi.fn(async () => intent({ regenerateNodeId: null })) }));
    expect(result.kind).toBe("ordinary");
  });

  it("refuses a provenance that is missing or names another node", async () => {
    expectRefused(await resolve(deps({ readVerifiedFilingNode: vi.fn(async () => null) })));
    expectRefused(
      await resolve(deps({ readVerifiedFilingNode: vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "write_draft" })) })),
    );
  });

  it("refuses a node the template does not declare", async () => {
    expectRefused(await resolve(deps(), RUN_ROW, JSON.stringify({ regenerate: [] })));
    expectRefused(await resolve(deps(), RUN_ROW, null));
  });

  it("refuses a missing, duplicated, ambiguous, altered or malformed snapshot", async () => {
    const rows = (r: StoredStepSnapshot[]) => deps({ readStepSnapshots: vi.fn(async () => r) });
    const step = snapshot("image_flow", '{"prompt":"x"}');
    const file = snapshot("file_image", "{}");
    expectRefused(await resolve(rows([step])));
    expectRefused(await resolve(rows([step, file, snapshot("file_image", "{}")])));
    expectRefused(await resolve(rows([{ ...step, ambiguous: true }, file])));
    expectRefused(await resolve(rows([{ ...step, inputsJson: '{"prompt":"y"}' }, file])));
    expectRefused(await resolve(rows([{ ...step, flowSha256: "short" }, file])));
  });

  it("refuses segment nodes recorded under two flow versions", async () => {
    expectRefused(
      await resolve(
        deps({
          readStepSnapshots: vi.fn(async () => [
            snapshot("image_flow", "{}"),
            snapshot("file_image", "{}", { flowSha256: OTHER_FLOW }),
          ]),
        }),
      ),
    );
  });

  it("refuses a repair of another organization and a blank node", async () => {
    expectRefused(await resolve(deps({ readRepairForRun: vi.fn(async () => intent({ orgId: "org-2" })) })));
    expectRefused(await resolve(deps(), { ...RUN_ROW, orgId: null as unknown as string }));
    expectRefused(await resolve(deps({ readRepairForRun: vi.fn(async () => intent({ regenerateNodeId: "" })) })));
  });

  it("a read fault refuses (fail closed)", async () => {
    expectRefused(
      await resolve(
        deps({
          readStepSnapshots: vi.fn(async () => {
            throw new Error("db down");
          }),
        }),
      ),
    );
    expectRefused(
      await resolve(
        deps({
          readRepairForRun: vi.fn(async () => {
            throw new Error("db down");
          }),
        }),
      ),
    );
  });

  it("a step equal to the filing node takes one snapshot", async () => {
    const d = deps({
      readStepSnapshots: vi.fn(async () => [snapshot("file_image", "{}")]),
    });
    const result = await resolve(d, RUN_ROW, { regenerate: [{ artifactNode: "file_image", step: "file_image", noteInput: "prompt" }] });
    expect(result.kind).toBe("segment");
    expect(d.readStepSnapshots).toHaveBeenCalledWith(expect.objectContaining({ nodeIds: ["file_image"] }));
  });
});

describe("isRegenerateSegmentRun", () => {
  it("is true only for a repair run whose repair names a node; a fault is false", async () => {
    const read = (r: RegenerateRepairIntent | null) => ({ readRepairForRun: vi.fn(async () => r) });
    expect(await isRegenerateSegmentRun({ id: RUN, sourceType: "lifecycle_repair" }, read(intent()))).toBe(true);
    expect(
      await isRegenerateSegmentRun({ id: RUN, sourceType: "lifecycle_repair" }, read(intent({ regenerateNodeId: null }))),
    ).toBe(false);
    expect(await isRegenerateSegmentRun({ id: RUN, sourceType: "manual" }, read(intent()))).toBe(false);
    expect(
      await isRegenerateSegmentRun(
        { id: RUN, sourceType: "lifecycle_repair" },
        {
          readRepairForRun: vi.fn(async () => {
            throw new Error("x");
          }),
        },
      ),
    ).toBe(false);
  });
});

describe("the repair-run id prefix", () => {
  it("equals the dispatch store's REPAIR_RUN_PREFIX", () => {
    const source = readFileSync(path.resolve(__dirname, "../lifecycle-repair-dispatch-store.ts"), "utf8");
    expect(source).toContain(`export const REPAIR_RUN_PREFIX = "${SEGMENT_REPAIR_RUN_PREFIX}";`);
    expect(segmentRepairIdFromRunId(RUN)).toBe("repair-1");
    expect(segmentRepairIdFromRunId(SEGMENT_REPAIR_RUN_PREFIX)).toBeNull();
    expect(segmentRepairIdFromRunId("run-x")).toBeNull();
  });
});

describe("regenerateSegmentMetadata", () => {
  it("carries the segment with the snapshot strings as stored", () => {
    const inputs = '{ "b":1,  "a":"\\u00e9" }';
    const meta = regenerateSegmentMetadata({
      repairId: "repair-1",
      provenanceRunId: PROVENANCE_RUN,
      step: "image_flow",
      artifactNode: "file_image",
      noteInput: "prompt",
      noteStartOutput: "imagePrompt",
      flowSha256: FLOW,
      snapshots: [{ node: "image_flow", inputs_json: inputs, sha256: sha(inputs) }],
    });
    expect(meta).toEqual({
      [REGENERATE_SEGMENT_METADATA_KEY]: {
        step: "image_flow",
        artifactNode: "file_image",
        noteInput: "prompt",
        noteStartOutput: "imagePrompt",
        flowSha256: FLOW,
        snapshots: [{ node: "image_flow", inputs_json: inputs, sha256: sha(inputs) }],
      },
    });
  });
});

describe("fenceRegenerateRuntime (T12)", () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("is true only when /.health lists the capability", async () => {
    const fetchImpl = answer(200, { status: "ok", capabilities: [REGENERATE_SEGMENT_CAPABILITY] });
    expect(await fenceRegenerateRuntime({ baseUrl: "http://runtime/", fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledWith("http://runtime/.health", expect.objectContaining({ method: "GET" }));
  });

  it("is false for an older runtime, an error status, bad JSON, a fault or no base url", async () => {
    const f = (impl: unknown) => fenceRegenerateRuntime({ baseUrl: "http://runtime", fetchImpl: impl as typeof fetch });
    expect(await f(answer(200, { status: "ok" }))).toBe(false);
    expect(await f(answer(200, { capabilities: ["regenerate_segment/2"] }))).toBe(false);
    expect(await f(answer(503, { capabilities: [REGENERATE_SEGMENT_CAPABILITY] }))).toBe(false);
    expect(await f(vi.fn(async () => new Response("not json", { status: 200 })))).toBe(false);
    expect(
      await f(
        vi.fn(async () => {
          throw new Error("refused");
        }),
      ),
    ).toBe(false);
    expect(await fenceRegenerateRuntime({ baseUrl: "", fetchImpl: answer(200, {}) as unknown as typeof fetch })).toBe(false);
  });
});

describe("the receipt", () => {
  it("reproduces the shared vectors (same bytes as the runtime)", () => {
    expect(VECTORS.vectors.length).toBeGreaterThanOrEqual(4);
    for (const v of VECTORS.vectors) {
      expect(segmentReceiptAttestation(KEY, v.run_id, v.step, v.artifactNode, v.flowSha256)).toBe(v.attestation);
      expect(verifySegmentReceiptClaim({ key: KEY, runId: v.run_id, claim: v })).toEqual({
        step: v.step,
        artifactNode: v.artifactNode,
        flowSha256: v.flowSha256,
        attestation: v.attestation,
      });
    }
  });

  it("does not verify under another run, key, node or flow", () => {
    const v = VECTORS.vectors[0]!;
    const claim = { step: v.step, artifactNode: v.artifactNode, flowSha256: v.flowSha256, attestation: v.attestation };
    expect(verifySegmentReceiptClaim({ key: KEY, runId: "lifecycle-repair-run:other", claim })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: "other-key", runId: v.run_id, claim })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: "", runId: v.run_id, claim })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: "   ", runId: v.run_id, claim })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: KEY, runId: v.run_id, claim: { ...claim, artifactNode: "x" } })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: KEY, runId: v.run_id, claim: { ...claim, flowSha256: OTHER_FLOW } })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: KEY, runId: v.run_id, claim: { ...claim, attestation: "g2:00" } })).toBeNull();
    expect(verifySegmentReceiptClaim({ key: KEY, runId: v.run_id, claim: "nope" })).toBeNull();
  });

  function receiptFor(runId: string, node = "file_image") {
    return {
      step: "image_flow",
      artifactNode: node,
      flowSha256: FLOW,
      attestation: segmentReceiptAttestation(KEY, runId, "image_flow", node, FLOW),
    };
  }

  it("stores one verified receipt for the handler's own run", async () => {
    const write = vi.fn(async () => "inserted" as const);
    const history = [
      { role: "user", metadata: {} },
      { role: "agent", metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: receiptFor(RUN) } },
    ];
    expect(await persistSegmentReceipt({ runId: RUN, orgId: "org-1", history, key: KEY, write })).toBe("stored");
    expect(write).toHaveBeenCalledTimes(1);
    const row = (write.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(row).toMatchObject({ orgId: "org-1", runId: RUN, nodeId: SEGMENT_RECEIPT_NODE_ID, flowSha256: FLOW });
    expect(row.inputsSha256).toBe(sha(row.inputsJson));
    expect(
      readStoredSegmentReceipt({
        runId: RUN,
        key: KEY,
        row: { nodeId: row.nodeId, inputsJson: row.inputsJson, inputsSha256: row.inputsSha256, flowSha256: FLOW, ambiguous: false },
      }),
    ).toEqual(receiptFor(RUN));
  });

  it("drops another run's receipt, two receipts, a user-role receipt and a missing org", async () => {
    const write = vi.fn(async () => "inserted" as const);
    const agent = (r: unknown) => ({ role: "agent", metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: r } });
    const p = (history: unknown[], orgId: string | null = "org-1") =>
      persistSegmentReceipt({ runId: RUN, orgId, history: history as never, key: KEY, write });
    expect(await p([agent(receiptFor("lifecycle-repair-run:other"))])).toBe("dropped");
    expect(await p([agent(receiptFor(RUN)), agent(receiptFor(RUN))])).toBe("dropped");
    expect(await p([agent(receiptFor(RUN))], null)).toBe("dropped");
    expect(await p([{ role: "user", metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: receiptFor(RUN) } }])).toBe("none");
    expect(await p([])).toBe("none");
    expect(write).not.toHaveBeenCalled();
    expect(await persistSegmentReceipt({ runId: RUN, orgId: "org-1", history: [agent(receiptFor(RUN))], key: "", write })).toBe(
      "dropped",
    );
  });

  it("a store fault or an ambiguous row is dropped, never thrown", async () => {
    const agent = { role: "agent", metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: receiptFor(RUN) } };
    const throwing = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(
      persistSegmentReceipt({ runId: RUN, orgId: "org-1", history: [agent], key: KEY, write: throwing }),
    ).resolves.toBe("dropped");
    await expect(
      persistSegmentReceipt({ runId: RUN, orgId: "org-1", history: [agent], key: KEY, write: vi.fn(async () => "ambiguous" as const) }),
    ).resolves.toBe("dropped");
  });

  it("is stripped from the stored history", () => {
    const history = [
      { role: "agent", parts: [], metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: receiptFor(RUN), other: 1 } },
      { role: "agent", parts: [], metadata: { [SEGMENT_RECEIPT_METADATA_KEY]: receiptFor(RUN) } },
      { role: "user", parts: [] },
    ];
    expect(stripSegmentReceipts(history)).toEqual([
      { role: "agent", parts: [], metadata: { other: 1 } },
      { role: "agent", parts: [] },
      { role: "user", parts: [] },
    ]);
    expect(stripSegmentReceipts(undefined)).toBeUndefined();
  });

  it("a stored row that is ambiguous, altered or of another node does not verify", () => {
    const json = JSON.stringify(receiptFor(RUN));
    const row: StoredStepSnapshot = {
      nodeId: SEGMENT_RECEIPT_NODE_ID,
      inputsJson: json,
      inputsSha256: sha(json),
      flowSha256: FLOW,
      ambiguous: false,
    };
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row })).not.toBeNull();
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row: { ...row, ambiguous: true } })).toBeNull();
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row: { ...row, inputsSha256: sha("x") } })).toBeNull();
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row: { ...row, nodeId: "file_image" } })).toBeNull();
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row: { ...row, flowSha256: OTHER_FLOW } })).toBeNull();
    expect(readStoredSegmentReceipt({ runId: "lifecycle-repair-run:other", key: KEY, row })).toBeNull();
    expect(readStoredSegmentReceipt({ runId: RUN, key: KEY, row: null })).toBeNull();
  });
});

describe("claimSegmentProduction", () => {
  const PRODUCTION = { artifactId: "artifact-1", representationRevisionId: "rev-2" };
  function receiptRow(node = "file_image"): StoredStepSnapshot {
    const json = JSON.stringify({
      artifactNode: node,
      attestation: segmentReceiptAttestation(KEY, RUN, "image_flow", node, FLOW),
      flowSha256: FLOW,
      step: "image_flow",
    });
    return { nodeId: SEGMENT_RECEIPT_NODE_ID, inputsJson: json, inputsSha256: sha(json), flowSha256: FLOW, ambiguous: false };
  }
  const claim = (over: Partial<Parameters<typeof claimSegmentProduction>[1]> = {}) =>
    claimSegmentProduction(
      { orgId: "org-1", runId: RUN, regenerateNodeId: "file_image", key: KEY },
      {
        listProductions: vi.fn(async () => [PRODUCTION]),
        readVerifiedSteps: vi.fn(async () => ["file_image"]),
        readReceiptRow: vi.fn(async () => receiptRow()),
        ...over,
      },
    );

  it("claims the one write of the named node with a valid receipt", async () => {
    expect(await claim()).toEqual(PRODUCTION);
  });

  it("leaves the repair open for two writes, another step, two ledger rows or no receipt", async () => {
    expect(await claim({ listProductions: vi.fn(async () => [PRODUCTION, { ...PRODUCTION, artifactId: "a2" }]) })).toBeNull();
    expect(await claim({ listProductions: vi.fn(async () => []) })).toBeNull();
    expect(await claim({ readVerifiedSteps: vi.fn(async () => ["image_flow"]) })).toBeNull();
    expect(await claim({ readVerifiedSteps: vi.fn(async () => [null]) })).toBeNull();
    expect(await claim({ readVerifiedSteps: vi.fn(async () => ["file_image", "file_image"]) })).toBeNull();
    expect(await claim({ readReceiptRow: vi.fn(async () => null) })).toBeNull();
    expect(await claim({ readReceiptRow: vi.fn(async () => receiptRow("write_draft")) })).toBeNull();
  });
});

describe("planSegmentDispatch", () => {
  const base = {
    repair: intent(),
    templateId: "tpl-1",
    packageName: PACKAGE,
    lifecycleConfig: LIFECYCLE,
    note: "brighter picture",
    request: { kind: "lifecycle_repair" },
  };

  const startOutput = (name: string | null) => vi.fn(async () => name);

  it("parents the run on the provenance run with the note, under its start output, and the request only", async () => {
    const read = vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "file_image" }));
    const readNoteStartOutput = startOutput("imagePrompt");
    expect(await planSegmentDispatch(base, { readVerifiedFilingNode: read, readNoteStartOutput })).toEqual({
      kind: "segment",
      parentRunId: PROVENANCE_RUN,
      inputParams: { imagePrompt: "brighter picture", lifecycleRepairRequest: { kind: "lifecycle_repair" } },
    });
    expect(readNoteStartOutput).toHaveBeenCalledWith({ packageName: PACKAGE, step: "image_flow", noteInput: "prompt" });
  });

  it("refuses when no single start output feeds the note, or it names the request input", async () => {
    const read = vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "file_image" }));
    for (const name of [null, "", "lifecycleRepairRequest"]) {
      expect((await planSegmentDispatch(base, { readVerifiedFilingNode: read, readNoteStartOutput: startOutput(name) })).kind).toBe(
        "refused",
      );
    }
  });

  it("refuses a missing provenance, another node or no entry", async () => {
    expect(
      (await planSegmentDispatch(base, { readVerifiedFilingNode: vi.fn(async () => null), readNoteStartOutput: startOutput("p") }))
        .kind,
    ).toBe("refused");
    expect(
      (
        await planSegmentDispatch(base, {
          readVerifiedFilingNode: vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "write_draft" })),
          readNoteStartOutput: startOutput("p"),
        })
      ).kind,
    ).toBe("refused");
    expect(
      (
        await planSegmentDispatch(
          { ...base, lifecycleConfig: "{}" },
          {
            readVerifiedFilingNode: vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId: "file_image" })),
            readNoteStartOutput: startOutput("p"),
          },
        )
      ).kind,
    ).toBe("refused");
  });
});

describe("where the segment is wired in the task handler (read from source)", () => {
  const source = readFileSync(path.resolve(__dirname, "../execution.ts"), "utf8");

  it("verifies and stores the receipt for its own run after the snapshots and before the resync", () => {
    const snapshots = source.indexOf("await persistStepSnapshots({");
    const receipt = source.indexOf("await persistSegmentReceipt({");
    const resync = source.indexOf("await updateAgentRunA2ATaskId(runId, task.id)");
    expect(snapshots).toBeGreaterThan(0);
    expect(receipt).toBeGreaterThan(snapshots);
    expect(resync).toBeGreaterThan(receipt);
    expect(source.slice(receipt, receipt + 80)).toContain("runId,");
  });

  it("keeps the receipt out of the stored history and skips the end-node materializer for a segment", () => {
    expect(source).toMatch(/const history = stripSegmentReceipts\(/);
    const guard = source.indexOf("if (await isRegenerateSegmentRun({ id: runId, sourceType: run.sourceType }))");
    expect(guard).toBeGreaterThan(0);
    const materialize = source.indexOf("materializeRunArtifacts({", guard);
    const elseBranch = source.indexOf("} else {", guard);
    expect(elseBranch).toBeGreaterThan(guard);
    expect(materialize).toBeGreaterThan(elseBranch);
  });

  it("resolves the segment before the findings binding and fences before queued->running", () => {
    const resolveAt = source.indexOf("await resolveRegenerateSegment({");
    const bindAt = source.indexOf("await bindRepairFindingsInputAtStart(runId");
    expect(resolveAt).toBeGreaterThan(0);
    expect(bindAt).toBeGreaterThan(resolveAt);
    const fenceAt = source.indexOf("if (segmentPlan && !(await fenceRegenerateRuntime()))");
    expect(fenceAt).toBeGreaterThan(bindAt);
    const runningAt = source.indexOf('await transitionRunStatus(runId, "queued", "running", {', fenceAt);
    expect(runningAt).toBeGreaterThan(fenceAt);
    expect(source.slice(fenceAt, runningAt)).not.toContain("sendTask(");
  });
});

describe("noteStartOutputFromOas (the note's original start output)", () => {
  const PIPELINE = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../../../docker/wayflow/tests/fixtures/regenerate-segment-blog-pipeline.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  /** A flow whose start output `userNote` feeds the step's input `note`. */
  function tiny(extraEdges: unknown[] = [], startRef: unknown = { $component_ref: "start" }) {
    const edge = (src: string, out: string, dst: string, port: string) => ({
      component_type: "DataFlowEdge",
      source_node: { $component_ref: src },
      source_output: out,
      destination_node: { $component_ref: dst },
      destination_input: port,
    });
    return {
      component_type: "Flow",
      start_node: startRef,
      data_flow_connections: [edge("start", "userNote", "produce", "note"), edge("produce", "out", "file", "body"), ...extraEdges],
      $referenced_components: { start: { component_type: "StartNode", id: "start" } },
      _edge: edge,
    };
  }

  it("reads the blog pipeline's own names (the runtime fixture)", () => {
    expect(noteStartOutputFromOas(PIPELINE, "image_flow", "prompt")).toBe("prompt");
    expect(noteStartOutputFromOas(PIPELINE, "draft_flow", "note")).toBe("note");
  });

  it("reads a start output whose name differs from the note input", () => {
    expect(noteStartOutputFromOas(tiny(), "produce", "note")).toBe("userNote");
  });

  it("is null without exactly one start-fed edge into the note input", () => {
    const t = tiny();
    expect(noteStartOutputFromOas(t, "produce", "topic")).toBeNull();
    expect(noteStartOutputFromOas(tiny([t._edge("start", "other", "produce", "note")]), "produce", "note")).toBeNull();
    expect(noteStartOutputFromOas(tiny([], { $component_ref: "elsewhere" }), "produce", "note")).toBeNull();
    expect(noteStartOutputFromOas(tiny(), "file", "body")).toBeNull(); // fed by a step, not the start
    expect(noteStartOutputFromOas({ component_type: "Agent" }, "produce", "note")).toBeNull();
    expect(noteStartOutputFromOas(null, "produce", "note")).toBeNull();
  });
});
