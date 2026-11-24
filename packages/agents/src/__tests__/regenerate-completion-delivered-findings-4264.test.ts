import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// cinatra#4264: the completer of a Regenerate reports applied only the
// findings whose words the segment run was given. A picture's Regenerate
// records two review fields, the Note and the picture's prompt (the review
// store records the prompt only for a picture with a recorded prompt), and
// only the prompt's words reach the run, whatever its input is called. A note
// with other words reached no input of the run and is reported skipped, never
// applied. An ordinary repair run is handed every finding and keeps every
// finding applied.
//
// The database is a small fake that answers by TABLE (no database, no run, no
// queue), as in lifecycle-repair-producer-completion-fix1-3862.test.ts. The
// segment claim is a spy, and both claims answer the run's one write on the
// reviewed artifact itself (no re-file).

const dialect = new PgDialect();
type Row = Record<string, unknown>;
let tables: { lifecycleRepair: unknown; agentRuns: unknown; agentTemplates: unknown; artifactProducedOutbox: unknown };

const ports = {
  readRepair: vi.fn(),
  submitRepairResponse: vi.fn(),
  readDeliveredRepairRequest: vi.fn(),
  resolveOrgRoleForUser: vi.fn(),
  claimSegmentProduction: vi.fn(),
  escalateRegenerateRepairOfUndeclaredRun: vi.fn(),
};

const MOCKED = [
  "server-only",
  "../db",
  "../lifecycle-repair-store",
  "../lifecycle-repair-dispatch-store",
  "../regenerate-segment",
  "@/lib/auth-session",
  "@/lib/artifacts/artifact-revision-append",
  "../installed-oas-path",
] as const;

const RUN = "lifecycle-repair-run-repair-1";
const NOTE = "Make the sky brighter";
const PROMPT = "A lighthouse at dusk, wide angle";

// The template's Regenerate entries and its installed flow: the picture step
// declares its prompt (fed by the start output `imagePrompt`), the draft step
// its note (fed by `draftNote`). The run's stored inputs are read against them.
const LIFECYCLE = JSON.stringify({ regenerate: [
  { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
  { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" },
] });
const OAS = {
  component_type: "Flow",
  start_node: { $component_ref: "start" },
  data_flow_connections: [
    { source_node: { $component_ref: "start" }, source_output: "imagePrompt",
      destination_node: { $component_ref: "image_flow" }, destination_input: "prompt" },
    { source_node: { $component_ref: "start" }, source_output: "draftNote",
      destination_node: { $component_ref: "draft_flow" }, destination_input: "note" },
  ],
};
let oasDir: string;
/** Whether the agent's flow is mounted now; a case unmounts it. */
let oasMounted: boolean;
/** The template the run was made from, as it reads now; a case changes it. */
let templateRow: Row;
/** The repair run's status and stored inputs (the declared-input form unless a case sets another). */
let runRow: Row;
/** The declared input the dispatch recorded in the run's request when it made the run. */
const PICTURE_RECORD = { artifactNode: "file_image", step: "image_flow", noteInput: "prompt", startOutput: "imagePrompt" };
const declaredForm = (words: string) =>
  JSON.stringify({
    imagePrompt: words,
    lifecycleRepairRequest: { repairId: "repair-1", findings: [], regenerateInput: PICTURE_RECORD },
  });

function answer(table: unknown, where: unknown): Row[] {
  const params = where ? dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]).params : [];
  if (table === tables.lifecycleRepair) {
    return params.includes("repair-1") ? [] : [{ id: "repair-1", createdAt: "2026-11-01 10:00:00+00" }];
  }
  if (table === tables.agentRuns) return [runRow];
  if (table === tables.agentTemplates) return [templateRow];
  // an ordinary repair run's latest write, on the reviewed artifact itself
  if (table === tables.artifactProducedOutbox) return [{ artifactId: "art-base", representationRevisionId: "rev-run" }];
  // the base artifact's liveness and pointer
  return [{ deletedAt: null, pointer: "rev-base" }];
}

function repairRow(findings: Row[], regenerateNodeId: string | null) {
  return {
    id: "repair-1", orgId: "org-1", gateId: "gate-1", lineageId: "lineage-1", attempt: 1,
    route: "producer_repair", status: "dispatched", regenerateNodeId,
    baseArtifactId: "art-base", baseRepresentationRevisionId: "rev-base", expectedBaseRevisionId: "rev-base",
    findings,
    successorGateId: null, successorArtifactId: null, successorRepresentationRevisionId: null,
    findingOutcomes: null, changeSummary: null,
  };
}

beforeEach(async () => {
  tables = await import("../schema");
  oasDir = mkdtempSync(path.join(tmpdir(), "regen-completion-4264-"));
  writeFileSync(path.join(oasDir, "agent.oas.json"), JSON.stringify(OAS));
  runRow = { status: "completed", templateId: "tmpl-1", inputParams: declaredForm(PROMPT) };
  oasMounted = true;
  templateRow = { lifecycleConfig: LIFECYCLE, packageName: "@vendor/blog" };
  vi.doMock("../installed-oas-path", () => ({
    resolveInstalledOasPathForRead: () => (oasMounted ? path.join(oasDir, "agent.oas.json") : null),
  }));
  vi.doMock("server-only", () => ({}));
  vi.doMock("../db", () => ({
    db: {
      select: () => {
        let table: unknown;
        let where: unknown;
        const query = {
          from: (t: unknown) => { table = t; return query; },
          where: (w: unknown) => { where = w; return query; },
          orderBy: () => query,
          limit: async () => answer(table, where),
        };
        return query;
      },
    },
  }));
  vi.doMock("../lifecycle-repair-store", () => ({
    readRepair: ports.readRepair,
    submitRepairResponse: ports.submitRepairResponse,
  }));
  vi.doMock("../lifecycle-repair-dispatch-store", () => ({
    repairRunId: () => RUN,
    readDeliveredRepairRequest: ports.readDeliveredRepairRequest,
    escalateRegenerateRepairOfUndeclaredRun: ports.escalateRegenerateRepairOfUndeclaredRun,
  }));
  vi.doMock("../regenerate-segment", async () => ({
    ...(await vi.importActual<typeof import("../regenerate-segment")>("../regenerate-segment")),
    claimSegmentProduction: ports.claimSegmentProduction,
  }));
  vi.doMock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: ports.resolveOrgRoleForUser }));
  vi.doMock("@/lib/artifacts/artifact-revision-append", () => ({
    refileRevisionOntoArtifact: vi.fn(() => { throw new Error("Unexpected re-file"); }),
    advanceArtifactPointerOntoRevision: vi.fn(),
    SemanticArtifactRevisionAppendRefusal: class extends Error {},
  }));
  ports.readDeliveredRepairRequest.mockResolvedValue({ originatingRunBy: "user-1" });
  ports.resolveOrgRoleForUser.mockResolvedValue("member");
  ports.claimSegmentProduction.mockResolvedValue({ artifactId: "art-base", representationRevisionId: "rev-run" });
  ports.submitRepairResponse.mockResolvedValue({ ok: true, successorGateId: "gate-next", successorTaskId: "task-next" });
});

afterEach(() => {
  rmSync(oasDir, { recursive: true, force: true });
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

async function completeOne() {
  const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
  const summary = await completeDispatchedProducerRepairs();
  expect(summary.completed).toBe(1);
  const call = ports.submitRepairResponse.mock.calls[0][0] as {
    response: { findingOutcomes: Array<{ findingId: string; applied: boolean; skipReason?: string }>; changeSummary: string };
  };
  return call.response;
}

describe("the completer reports applied only the findings a Regenerate delivered", () => {
  // red-first-expect: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(3) }, { …(2) } ]
  it("a picture's Regenerate whose note differs from its prompt: the prompt is applied, the note is skipped", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }], "file_image"),
    );
    const response = await completeOne();
    expect(response.findingOutcomes).toEqual([
      { findingId: "prompt-window", applied: false, skipReason: expect.any(String) },
      { findingId: "picture-prompt", applied: true },
    ]);
    expect(response.changeSummary).toContain("answered 1 requested change(s)");
  });

  it("a picture's Regenerate whose note is the prompt's words: both are applied", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "prompt-window", message: PROMPT }, { id: "picture-prompt", message: PROMPT }], "file_image"),
    );
    const response = await completeOne();
    expect(response.findingOutcomes).toEqual([
      { findingId: "prompt-window", applied: true },
      { findingId: "picture-prompt", applied: true },
    ]);
  });

  it("an ordinary repair run is handed every finding, so every finding stays applied", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "finding-1", message: NOTE }, { id: "finding-2", message: PROMPT }], null),
    );
    const response = await completeOne();
    expect(ports.claimSegmentProduction).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual([
      { findingId: "finding-1", applied: true },
      { findingId: "finding-2", applied: true },
    ]);
    expect(response.changeSummary).toContain("answered 2 requested change(s)");
  });
});

describe("the completer's outcomes follow the reviewed work, never the declared input's name", () => {
  /** A run in the declared-input form for a record, with `words` under its start output. */
  const formFor = (record: Row, words: string) =>
    JSON.stringify({
      [record.startOutput as string]: words,
      lifecycleRepairRequest: { repairId: "repair-1", findings: [], regenerateInput: record },
    });

  // red-first-expect: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(3) }, { …(2) } ]
  it("a picture step whose declared input is not named prompt: the prompt is applied, the note is skipped", async () => {
    const record = { artifactNode: "file_picture", step: "picture_flow", noteInput: "imagePrompt", startOutput: "pictureWords" };
    runRow = { status: "completed", templateId: "tmpl-1", inputParams: formFor(record, PROMPT) };
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }], "file_picture"),
    );
    const response = await completeOne();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual([
      { findingId: "prompt-window", applied: false, skipReason: expect.any(String) },
      { findingId: "picture-prompt", applied: true },
    ]);
  });

  it("a text step whose declared input is named prompt: its Note, the one finding its review records, is applied", async () => {
    const record = { artifactNode: "write_draft", step: "draft_flow", noteInput: "prompt", startOutput: "draftPrompt" };
    runRow = { status: "completed", templateId: "tmpl-1", inputParams: formFor(record, NOTE) };
    ports.readRepair.mockResolvedValue(repairRow([{ id: "prompt-window", message: NOTE }], "write_draft"));
    const response = await completeOne();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual([{ findingId: "prompt-window", applied: true }]);
  });
});

describe("the completer reads a Regenerate run against what its dispatch recorded, not the agent as it is now", () => {
  // The agent can be updated, or its flow briefly not mounted, between the
  // run's end and the maintenance pass. The run's own stored inputs and the
  // declared input its dispatch recorded in them decide; the template and the
  // installed flow as they read now never discard a valid run's work.
  const FINDINGS = [{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }];
  const EXPECTED = [
    { findingId: "prompt-window", applied: false, skipReason: expect.any(String) },
    { findingId: "picture-prompt", applied: true },
  ];

  // red-first-expect: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(3) }, { …(2) } ]
  it("accepts a valid run after the template's declaration and the flow's start output changed", async () => {
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "file_image"));
    templateRow = {
      lifecycleConfig: JSON.stringify({ regenerate: [{ artifactNode: "file_image", step: "image_flow", noteInput: "caption" }] }),
      packageName: "@vendor/blog",
    };
    writeFileSync(path.join(oasDir, "agent.oas.json"), JSON.stringify({ ...OAS, data_flow_connections: [] }));
    const response = await completeOne();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual(EXPECTED);
  });

  it("accepts a valid run while the agent's flow is not mounted and its template is gone", async () => {
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "file_image"));
    oasMounted = false;
    templateRow = { lifecycleConfig: null, packageName: null };
    const response = await completeOne();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual(EXPECTED);
  });

  it("escalates a run whose recorded declared input names another node than the repair", async () => {
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "write_draft"));
    ports.escalateRegenerateRepairOfUndeclaredRun.mockResolvedValueOnce(true);
    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await completeDispatchedProducerRepairs()).toMatchObject({ completed: 0, escalated: 1 });
    } finally {
      error.mockRestore();
    }
    expect(ports.submitRepairResponse).not.toHaveBeenCalled();
  });
});

describe("a Regenerate run that is not in the declared-input form is escalated, never applied", () => {
  // During a rolling deployment an older dispatcher makes the run in the
  // earlier form (the findings text in the declared input, the request with
  // all its findings) and marks its repair `dispatched`. Whether an older
  // worker completed it or the run start failed it, the completer reads the
  // run's stored inputs as the run start does and escalates the repair: its
  // work is never applied and the review is never left with no successor and
  // no escalation. The next pass finds the repair escalated and writes nothing.
  const FINDINGS = [{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }];
  const EARLIER_FORM = JSON.stringify({
    imagePrompt: `A reviewer requested changes to the work you produced. Apply the following requested changes:\n\n1. ${NOTE}\n2. ${PROMPT}`,
    lifecycleRepairRequest: { kind: "lifecycle_repair_request", repairId: "repair-1", findings: FINDINGS },
  });

  async function completeTwice() {
    ports.escalateRegenerateRepairOfUndeclaredRun.mockResolvedValueOnce(true);
    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await completeDispatchedProducerRepairs();
      // The next pass reads the repair as the escalation left it.
      ports.readRepair.mockResolvedValue({ ...repairRow(FINDINGS, "file_image"), status: "escalated" });
      const second = await completeDispatchedProducerRepairs();
      return { first, second };
    } finally {
      error.mockRestore();
    }
  }

  // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 1 times
  it("an earlier-form run's completion is escalated, not applied", async () => {
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "file_image"));
    runRow = { status: "completed", templateId: "tmpl-1", inputParams: EARLIER_FORM };
    const { first, second } = await completeTwice();
    expect(ports.submitRepairResponse).not.toHaveBeenCalled();
    expect(ports.claimSegmentProduction).not.toHaveBeenCalled();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).toHaveBeenCalledTimes(1);
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).toHaveBeenCalledWith("repair-1");
    expect(first).toMatchObject({ completed: 0, escalated: 1, unresolved: 0 });
    expect(second).toMatchObject({ completed: 0, escalated: 0, unresolved: 0 });
  });

  // red-first-expect: expected "vi.fn()" to be called 1 times, but got 0 times
  it("a dispatched earlier-form repair whose run the run start failed ends escalated, not unresolved", async () => {
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "file_image"));
    runRow = { status: "failed", templateId: "tmpl-1", inputParams: EARLIER_FORM };
    ports.claimSegmentProduction.mockResolvedValue(null);
    const { first } = await completeTwice();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).toHaveBeenCalledTimes(1);
    expect(ports.submitRepairResponse).not.toHaveBeenCalled();
    expect(first).toMatchObject({ completed: 0, escalated: 1, unresolved: 0 });
  });

  it("an ordinary repair run's inputs are not read against a declared input", async () => {
    ports.readRepair.mockResolvedValue(repairRow([{ id: "finding-1", message: NOTE }], null));
    runRow = { status: "completed", templateId: "tmpl-1", inputParams: EARLIER_FORM };
    await completeOne();
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
  });
});

describe("the completer binds the run's signed receipt to the step its dispatch recorded", () => {
  // During a rolling deployment an older worker can run the step an updated
  // template names now (step B) for a run whose dispatch recorded step A. Its
  // receipt is validly signed for the run, but names B. The REAL segment claim
  // reads the receipt against the record the completer hands it: a receipt
  // for another step escalates the repair and its work is never applied.
  const KEY = "receipt-key-4264";
  const FLOW = "a".repeat(64);
  const FINDINGS = [{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }];

  async function completeWithReceipt(step: string) {
    const actual = await vi.importActual<typeof import("../regenerate-segment")>("../regenerate-segment");
    const { createHash } = await import("node:crypto");
    const json = JSON.stringify({
      artifactNode: "file_image",
      attestation: actual.segmentReceiptAttestation(KEY, RUN, step, "file_image", FLOW),
      flowSha256: FLOW,
      step,
    });
    const row = {
      nodeId: actual.SEGMENT_RECEIPT_NODE_ID,
      inputsJson: json,
      inputsSha256: createHash("sha256").update(json, "utf8").digest("hex"),
      flowSha256: FLOW,
      ambiguous: false,
    };
    ports.claimSegmentProduction.mockImplementation((input: Parameters<typeof actual.claimSegmentProduction>[0]) =>
      actual.claimSegmentProduction({ ...input, key: KEY }, {
        listProductions: async () => [{ artifactId: "art-base", representationRevisionId: "rev-run" }],
        readVerifiedSteps: async () => ["file_image"],
        readReceiptRow: async () => row,
      }),
    );
    ports.readRepair.mockResolvedValue(repairRow(FINDINGS, "file_image"));
    ports.escalateRegenerateRepairOfUndeclaredRun.mockResolvedValueOnce(true);
    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return await completeDispatchedProducerRepairs();
    } finally {
      error.mockRestore();
    }
  }

  // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 1 times
  it("a valid receipt for another step than the recorded one is escalated, not applied", async () => {
    const summary = await completeWithReceipt("draft_flow");
    expect(ports.submitRepairResponse).not.toHaveBeenCalled();
    expect(ports.claimSegmentProduction).toHaveBeenCalledWith(
      expect.objectContaining({ record: PICTURE_RECORD }),
      expect.anything(),
    );
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).toHaveBeenCalledWith(
      "repair-1",
      "the Regenerate's repair run finished a segment other than the step its dispatch recorded, so its work is not applied",
    );
    expect(summary).toMatchObject({ completed: 0, escalated: 1, unresolved: 0 });
  });

  it("a valid receipt for the recorded step is applied", async () => {
    const summary = await completeWithReceipt("image_flow");
    expect(ports.escalateRegenerateRepairOfUndeclaredRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ completed: 1, escalated: 0 });
  });
});
