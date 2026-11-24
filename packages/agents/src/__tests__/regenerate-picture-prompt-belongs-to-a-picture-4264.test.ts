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
// one), captures the request the canonical operation is given, and plans the
// dispatch from that request's findings with the real planner.

const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
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
}));
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
 * filing node of the reviewed revision, and the finalized ledger rows of that
 * revision that record a prompt.
 */
async function arrange(entry: typeof PICTURE_ENTRY, recordedPrompts: unknown[]) {
  ports.reads = [
    [{ templateId: "tmpl-4264-picture" }],
    [{ lifecycleConfig: await compiledLifecycleText({ regenerate: [entry] }) }],
    [],
    [{ verifiedStepId: entry.artifactNode }],
    recordedPrompts.map((imagePrompt) => ({ imagePrompt })),
  ];
}

beforeEach(() => {
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
    ports.reads.pop(); // a request with no prompt reads no ledger prompt
    const withoutPrompt = await press();
    expect(withPrompt.request.idempotencyKey).toBe(withoutPrompt.request.idempotencyKey);
    expect(ports.reads).toHaveLength(0);
  });

  it("a prompt read that faults refuses the Regenerate before anything is recorded, and never drops the prompt", async () => {
    await arrange(PICTURE_ENTRY, []);
    ports.reads.pop(); // the ledger prompt read faults (no queued result: the stubbed read throws)
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
