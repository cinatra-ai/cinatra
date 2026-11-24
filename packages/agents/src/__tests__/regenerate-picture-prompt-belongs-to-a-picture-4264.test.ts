import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4264: whether a Regenerate sends the picture's prompt is a fact of
// the reviewed work, never of the name of the step's declared input. A
// manifest may call a picture step's prompt input anything it admits, and a
// text step may call its note input `prompt`.
//
// The review store keeps a submitted picture's prompt only when the reviewed
// revision records the prompt it was made from (its finalized ledger row, read
// on the server). The dispatch then gives the declared input the picture's
// prompt when the request carries one, and the Note otherwise. This file
// drives the real composer with its ports replaced (the database is a queue of
// read results: each `db.select()` chain ending in `.limit()` takes the next
// one, and so does each pool query of the ledger's prompt read, unless a test
// sets its own pool), captures the request the canonical operation is given,
// and plans the dispatch from that request's findings with the real planner.

const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
  pool: null as null | ((text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>),
  readReviewGate: vi.fn(),
  recordChangesRequested: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  db: {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          const result = ports.reads.shift();
          if (!result) throw new Error("Unexpected database read");
          return result;
        },
      };
      return query;
    },
    transaction: vi.fn(async () => {
      throw new Error("the transaction was opened");
    }),
  },
  agentBuilderPool: {
    query: async (text: string, values: unknown[]) => {
      if (ports.pool) return ports.pool(text, values);
      const result = ports.reads.shift();
      if (!result) throw new Error("Unexpected database read");
      return { rows: result };
    },
  },
}));
// The review surface's prefill read goes through the ledger's own pool.
vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({
    query: async (text: string, values: unknown[]) => {
      if (!ports.pool) throw new Error("Unexpected ledger pool read");
      return ports.pool(text, values);
    },
  }),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("../artifact-review-gate-store", () => ({
  readReviewGate: ports.readReviewGate,
  listReviewGatesForRun: vi.fn(async () => []),
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  readProducedEvent: vi.fn(async () => null),
}));
vi.mock("../lifecycle-repair-store", () => ({
  recordChangesRequested: ports.recordChangesRequested,
}));

import { planSegmentDispatch } from "../regenerate-segment";

const RUN = "run-4264-picture";
const BASE = { artifactId: "art-4264-picture", representationRevisionId: "rev-4264-picture" };
const TASK = "lifecycle-review:4264-picture";
const NOTE = "make the sky bluer";
const PROMPT = "a lighthouse at dusk, wide angle";

/** A picture step whose prompt input is not called `prompt`. */
const PICTURE_ENTRY = { artifactNode: "file_picture", step: "picture_flow", noteInput: "imagePrompt" };
/** A text step whose note input is called `prompt`. */
const TEXT_ENTRY = { artifactNode: "write_draft", step: "draft_flow", noteInput: "prompt" };

/** The `lifecycle_config` text an install writes for this block, after the strict manifest parse. */
async function compiledLifecycleText(block: unknown): Promise<string | null> {
  const { agentLifecycleDeclarationSchema } = await import("../verdaccio/package-contract");
  const { readManifestLifecycle, serializeLifecycleConfig } = await import("@/lib/lifecycle/lifecycle-policy");
  const lifecycle = agentLifecycleDeclarationSchema.parse(block);
  return serializeLifecycleConfig(readManifestLifecycle({ cinatra: { lifecycle } }));
}

/**
 * The reads in order: the producing run's template, its compiled lifecycle
 * (one regenerate entry), the artifact's object type (none), the verified
 * filing node of the reviewed revision, then the prompt read: the finalized
 * ledger rows of that revision that record a prompt and, when there are none,
 * the rows the refile link reaches (none here: the revision is no refile).
 */
async function arrange(entry: typeof PICTURE_ENTRY, recordedPrompts: unknown[]) {
  ports.reads = [
    [{ templateId: "tmpl-4264-picture" }],
    [{ lifecycleConfig: await compiledLifecycleText({ regenerate: [entry] }) }],
    [],
    [{ verifiedStepId: entry.artifactNode }],
    recordedPrompts.map((image_prompt) => ({ image_prompt })),
    ...(recordedPrompts.length === 0 ? [[]] : []),
  ];
}

beforeEach(() => {
  ports.pool = null;
  ports.readReviewGate.mockReset();
  ports.readReviewGate.mockResolvedValue({
    id: "gate-4264-picture",
    runId: RUN,
    orgId: "org-4264-picture",
    reviewTaskId: TASK,
    status: "pending",
    pinnedTargets: [BASE],
  });
  ports.recordChangesRequested.mockReset();
  ports.recordChangesRequested.mockResolvedValue({ ok: true });
});

/** Press Regenerate and return the request the canonical operation was given. */
async function press(prompt?: string) {
  const { recordReviewSurfaceChangesRequested } = await import("../lifecycle-review-changes-requested-store");
  await recordReviewSurfaceChangesRequested({
    runId: RUN,
    reviewTaskId: TASK,
    baseTarget: BASE,
    currentBaseRevisionId: BASE.representationRevisionId,
    feedback: NOTE,
    ...(prompt === undefined ? {} : { prompt }),
    decidedBy: "user-4264-picture",
    origin: "regenerate",
  });
  expect(ports.recordChangesRequested).toHaveBeenCalledTimes(1);
  const call = ports.recordChangesRequested.mock.calls[0][0] as {
    request: { findings: Array<{ id: string; message: string }>; idempotencyKey: string };
    regenerateEntry: unknown;
  };
  ports.recordChangesRequested.mockClear();
  return call;
}

/** The dispatch the drain plans for the recorded findings, under `entry`. */
async function dispatchFor(entry: typeof PICTURE_ENTRY, findings: unknown, startOutput: string) {
  const planned = await planSegmentDispatch(
    {
      repair: {
        id: "repair-4264-picture",
        orgId: "org-4264-picture",
        regenerateNodeId: entry.artifactNode,
        baseArtifactId: BASE.artifactId,
        baseRepresentationRevisionId: BASE.representationRevisionId,
      },
      templateId: "tmpl-4264-picture",
      packageName: "@any-vendor/pipeline",
      lifecycleConfig: JSON.stringify({ regenerate: [entry] }),
      findings,
      request: { kind: "lifecycle_repair_request", repairId: "repair-4264-picture", findings },
    },
    {
      readVerifiedFilingNode: vi.fn(async () => ({ runId: RUN, nodeId: entry.artifactNode })),
      readNoteStartOutput: vi.fn(async () => startOutput),
    },
  );
  expect(planned.kind).toBe("segment");
  if (planned.kind !== "segment") throw new Error("unreachable");
  return planned.inputParams;
}

describe("the picture's prompt reaches a Regenerate only when the reviewed work is a picture with a recorded prompt", () => {
  // red-first-expect: expected undefined to be 'a lighthouse at dusk, wide angle' // Object.is equality
  it("a picture step whose declared input is not named prompt is sent the picture's prompt", async () => {
    await arrange(PICTURE_ENTRY, ["the prompt the picture was made from"]);
    const { request, regenerateEntry } = await press(PROMPT);
    expect(regenerateEntry).toEqual(PICTURE_ENTRY);
    expect(request.findings).toEqual([
      { id: "prompt-window", message: NOTE },
      { id: "picture-prompt", message: PROMPT },
    ]);
    const inputs = await dispatchFor(PICTURE_ENTRY, request.findings, "pictureWords");
    expect(inputs.pictureWords).toBe(PROMPT);
    expect(JSON.stringify(inputs)).not.toContain(NOTE);
    expect(ports.reads).toHaveLength(0);
  });

  // red-first-expect: expected [ { id: 'prompt-window', …(1) }, …(1) ] to deeply equal [ { id: 'prompt-window', …(1) } ]
  it("a text step whose declared input is named prompt is sent the Note; a submitted prompt is never recorded or sent", async () => {
    await arrange(TEXT_ENTRY, []);
    const withPrompt = await press(PROMPT);
    expect(withPrompt.request.findings).toEqual([{ id: "prompt-window", message: NOTE }]);
    const inputs = await dispatchFor(TEXT_ENTRY, withPrompt.request.findings, "draftPrompt");
    expect(inputs.draftPrompt).toBe(NOTE);
    expect(JSON.stringify(inputs)).not.toContain(PROMPT);
    expect(ports.reads).toHaveLength(0);

    // The dropped prompt is not part of the request at all: the request is the
    // one a Regenerate with no prompt makes, its key included.
    await arrange(TEXT_ENTRY, []);
    ports.reads.splice(-2); // a request with no prompt reads no ledger prompt
    const withoutPrompt = await press();
    expect(withPrompt.request.idempotencyKey).toBe(withoutPrompt.request.idempotencyKey);
    expect(ports.reads).toHaveLength(0);
  });

  it("a prompt read that faults refuses the Regenerate before anything is recorded, and never drops the prompt", async () => {
    await arrange(PICTURE_ENTRY, []);
    ports.reads.splice(-2); // the ledger prompt read faults (no queued result: the stubbed read throws)
    const { recordReviewSurfaceChangesRequested } = await import("../lifecycle-review-changes-requested-store");
    const result = await recordReviewSurfaceChangesRequested({
      runId: RUN,
      reviewTaskId: TASK,
      baseTarget: BASE,
      currentBaseRevisionId: BASE.representationRevisionId,
      feedback: NOTE,
      prompt: PROMPT,
      decidedBy: "user-4264-picture",
      origin: "regenerate",
    });
    expect(ports.recordChangesRequested).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "regenerate-unavailable" });
  });

  it("a recorded prompt that is blank, or recorded twice, keeps no submitted prompt", async () => {
    for (const recorded of [["   "], ["one", "two"]]) {
      await arrange(PICTURE_ENTRY, recorded);
      const { request } = await press(PROMPT);
      expect(request.findings, JSON.stringify(recorded)).toEqual([{ id: "prompt-window", message: NOTE }]);
      expect((await dispatchFor(PICTURE_ENTRY, request.findings, "pictureWords")).pictureWords).toBe(NOTE);
    }
  });
});

// A REGENERATED PICTURE IS REGENERATED AGAIN. The first Regenerate's run wrote
// its picture on an artifact of its own, with a finalized ledger row recording
// the prompt it was made from; completion refiled that revision onto the
// reviewed artifact as the successor: a representation row binding the same
// resource, made by the repair run, and no ledger row. The tables below are
// those rows; the ledger's prompt read runs against them through the real
// `readRevisionImagePrompt`, and the drizzle reads stay the queue.
describe("a refiled successor keeps its picture's prompt on the next Regenerate", () => {
  const ORG = "org-4264-picture";
  const REPAIR_RUN = "run-4264-picture-repair";
  const FIRST_PROMPT = "a lighthouse at noon";
  const REGENERATED_PROMPT = "a lighthouse at dusk, wide angle";
  const NEXT_PROMPT = "a lighthouse at night, long exposure";
  const WRITE = { artifactId: "art-4264-segment-write", representationRevisionId: "rev-4264-segment-write" };
  const SUCCESSOR = { artifactId: BASE.artifactId, representationRevisionId: "rev-4264-refiled" };
  const SUCCESSOR_TASK = "lifecycle-review:repair:repair-4264-picture:1";

  type Representation = { id: string; orgId: string; artifactId: string; resourceId: string; createdByRunId: string | null };
  type LedgerRow = { orgId: string; runId: string; artifactId: string; revisionId: string; phase: string; imagePrompt: string | null };
  const representations: Representation[] = [
    { id: BASE.representationRevisionId, orgId: ORG, artifactId: BASE.artifactId, resourceId: "res-first", createdByRunId: RUN },
    { id: WRITE.representationRevisionId, orgId: ORG, artifactId: WRITE.artifactId, resourceId: "res-regenerated", createdByRunId: REPAIR_RUN },
    // The refile: the same resource on the reviewed artifact, made by the repair run.
    { id: SUCCESSOR.representationRevisionId, orgId: ORG, artifactId: SUCCESSOR.artifactId, resourceId: "res-regenerated", createdByRunId: REPAIR_RUN },
  ];
  const ledger: LedgerRow[] = [
    { orgId: ORG, runId: RUN, artifactId: BASE.artifactId, revisionId: BASE.representationRevisionId, phase: "finalized", imagePrompt: FIRST_PROMPT },
    { orgId: ORG, runId: REPAIR_RUN, artifactId: WRITE.artifactId, revisionId: WRITE.representationRevisionId, phase: "finalized", imagePrompt: REGENERATED_PROMPT },
  ];

  /** The two queries of the prompt read, answered from the tables above. */
  async function tables(text: string, values: unknown[]) {
    const [orgId, artifactId, revisionId] = values as string[];
    const prompts = (rows: LedgerRow[]) =>
      rows.filter((m) => m.phase === "finalized" && m.imagePrompt !== null).slice(0, 2).map((m) => ({ image_prompt: m.imagePrompt }));
    if (!text.includes('"representation" r')) {
      return { rows: prompts(ledger.filter((m) => m.orgId === orgId && m.artifactId === artifactId && m.revisionId === revisionId)) };
    }
    const r = representations.find((x) => x.orgId === orgId && x.artifactId === artifactId && x.id === revisionId && x.createdByRunId);
    if (!r) return { rows: [] };
    const sources = representations.filter((p) => p.orgId === r.orgId && p.resourceId === r.resourceId && p.artifactId !== r.artifactId);
    return {
      rows: prompts(
        ledger.filter((m) =>
          sources.some((p) => m.orgId === p.orgId && m.artifactId === p.artifactId && m.revisionId === p.id && m.runId === r.createdByRunId),
        ),
      ),
    };
  }

  // red-first-expect: expected null to deeply equal { artifactNode: 'file_picture', …(2) }
  it("a second Regenerate with a prompt against the refiled successor records, keys and sends that prompt", async () => {
    ports.pool = tables;
    ports.readReviewGate.mockResolvedValue({
      id: "gate-4264-successor",
      runId: RUN,
      orgId: ORG,
      reviewTaskId: SUCCESSOR_TASK,
      status: "pending",
      pinnedTargets: [SUCCESSOR],
    });
    ports.reads = [
      [{ templateId: "tmpl-4264-picture" }],
      [{ lifecycleConfig: await compiledLifecycleText({ regenerate: [PICTURE_ENTRY] }) }],
      [],
      // The successor has no filing row of its own; the one repaired repair
      // naming it leads to the reviewed revision, which the picture node filed.
      [],
      [{ baseArtifactId: BASE.artifactId, baseRepresentationRevisionId: BASE.representationRevisionId }],
      [{ verifiedStepId: PICTURE_ENTRY.artifactNode }],
    ];

    const { recordReviewSurfaceChangesRequested } = await import("../lifecycle-review-changes-requested-store");
    await recordReviewSurfaceChangesRequested({
      runId: RUN,
      reviewTaskId: SUCCESSOR_TASK,
      baseTarget: SUCCESSOR,
      currentBaseRevisionId: SUCCESSOR.representationRevisionId,
      feedback: NOTE,
      prompt: NEXT_PROMPT,
      decidedBy: "user-4264-picture",
      origin: "regenerate",
    });
    expect(ports.recordChangesRequested).toHaveBeenCalledTimes(1);
    const call = ports.recordChangesRequested.mock.calls[0][0] as {
      request: { findings: Array<{ id: string; message: string }> };
      regenerateEntry: unknown;
    };
    expect(call.regenerateEntry).toEqual(PICTURE_ENTRY);
    expect(call.request.findings).toEqual([
      { id: "prompt-window", message: NOTE },
      { id: "picture-prompt", message: NEXT_PROMPT },
    ]);
    const inputs = await dispatchFor(PICTURE_ENTRY, call.request.findings, "pictureWords");
    expect(inputs.pictureWords).toBe(NEXT_PROMPT);
    expect(JSON.stringify(inputs)).not.toContain(NOTE);
    expect(ports.reads).toHaveLength(0);
  });

  // red-first-expect: expected null to be 'a lighthouse at dusk, wide angle'
  it("the review surface offers the refiled successor the prompt its picture was made from", async () => {
    ports.pool = tables;
    const { readRevisionImagePrompt } = await import("@/lib/artifacts/materialization-ledger");
    expect(await readRevisionImagePrompt({ orgId: ORG, ...SUCCESSOR })).toBe(REGENERATED_PROMPT);
    expect(await readRevisionImagePrompt({ orgId: ORG, ...BASE })).toBe(FIRST_PROMPT);
    // Another org never reaches the run's write.
    expect(await readRevisionImagePrompt({ orgId: "org-other", ...SUCCESSOR })).toBeNull();
  });
});
