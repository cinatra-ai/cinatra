// cinatra#3089: a tool whose owning package declares that the passthrough road serves it only as a declared publishing
// step's call is served when, and only when, the verified calling step is a listed publishing step of the run's compiled
// flow AND that step's newest decision reads `released`. Unlike publishCallAllowed, a step that is not listed is refused
// whatever its decision rows say, and every read failure refuses.
// red-first-expect: publishingStepCallReleased is not a function
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  readDecisionForRunNode: vi.fn(),
  readLatestDecisionForRun: vi.fn(),
  readOpenDecisionForRun: vi.fn(),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

const bound = vi.hoisted(() => ({ readCurrentRunStepToolPolicy: vi.fn() }));
vi.mock("../agent-run-serde", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCurrentRunStepToolPolicy: bound.readCurrentRunStepToolPolicy,
}));

import * as actions from "../publish-decision-actions";

const publishingStepCallReleased = (run: { id: string; templateId: string; orgId?: string }, step: string | undefined,
  proof?: Record<string, unknown>) =>
  (actions as unknown as {
    publishingStepCallReleased: (r: typeof run, s: string | undefined, p?: Record<string, unknown>) => Promise<boolean>;
  }).publishingStepCallReleased(run, step, proof);

const RUN = { id: "run-1", templateId: "tmpl-1", orgId: "org-1" };
const template = (publishingSteps: string[] | null | undefined) => ({ id: "tmpl-1", publishingSteps });
const row = (status: string) => ({ id: "d1", runId: "run-1", nodeId: "send", status });

beforeEach(() => {
  storeMock.readAgentTemplateById.mockReset().mockResolvedValue(template(["send"]));
  decisions.readDecisionForRunNode.mockReset().mockResolvedValue(null);
  bound.readCurrentRunStepToolPolicy.mockReset().mockRejectedValue(new Error("no bound source in this case"));
});

describe("a listed publishing step", () => {
  it("is served when its newest decision is released", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "send");
  });

  it.each(["parked", "declined", "expired", "run_ended"])("is refused while its newest decision is %s", async (status) => {
    decisions.readDecisionForRunNode.mockResolvedValue(row(status));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });

  it("is refused when it has no decision", async () => {
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });
});

describe("a step that is not a listed publishing step", () => {
  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
    ["carries no list", undefined],
  ])("on a template that %s is refused, also with a released decision", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });

  it("a call with no verified step is refused without reading a decision", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, undefined)).toBe(false);
    expect(decisions.readDecisionForRunNode).not.toHaveBeenCalled();
  });
});

describe("a read that cannot prove the step", () => {
  it("a template that is not found refuses", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });

  it("a template read error refuses", async () => {
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down"));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });

  it("a decision read error refuses", async () => {
    decisions.readDecisionForRunNode.mockRejectedValue(new Error("db down"));
    expect(await publishingStepCallReleased(RUN, "send")).toBe(false);
  });
});

// A call that carries the verified executed-source proof is checked against the flow its run executes: the source bound
// to the run's current attempt, which a recompile of the template cannot change.
describe("a call that carries the verified executed-source proof", () => {
  const PROOF = { contextId: "ctx", stepId: "send", executionAttemptId: "attempt-1" };
  const flow = (publishes: boolean) => JSON.stringify({
    component_type: "Flow", id: "f", nodes: [{ $component_ref: "send" }],
    $referenced_components: { send: { component_type: "ApiNode", id: "send", metadata: { cinatra: { publishes } } } },
  });

  it("is served for a step its run's bound source declares as publishing, after a recompile dropped it from the template", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(template([]));
    bound.readCurrentRunStepToolPolicy.mockResolvedValue({ source: flow(true) });
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send", PROOF)).toBe(true);
    expect(bound.readCurrentRunStepToolPolicy).toHaveBeenCalledWith("run-1", "org-1", PROOF);
  });

  it("is refused for a step its run's bound source does not declare as publishing, after a recompile listed it", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(["send"]));
    bound.readCurrentRunStepToolPolicy.mockResolvedValue({ source: flow(false) });
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send", PROOF)).toBe(false);
    expect(decisions.readDecisionForRunNode).not.toHaveBeenCalled();
  });

  it("is refused when the bound source cannot be read", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased(RUN, "send", PROOF)).toBe(false);
  });

  it("is refused when the run carries no organization to read its bound source with", async () => {
    bound.readCurrentRunStepToolPolicy.mockResolvedValue({ source: flow(true) });
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishingStepCallReleased({ id: "run-1", templateId: "tmpl-1" }, "send", PROOF)).toBe(false);
  });
});
