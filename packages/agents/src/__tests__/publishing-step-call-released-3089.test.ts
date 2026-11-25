// cinatra#3089: a tool whose owning package declares that the passthrough road serves it only as a declared publishing
// step's call is served when, and only when, the verified calling step is a listed publishing step of the run's compiled
// flow AND that step's newest decision reads `released`. Unlike publishCallAllowed, a step that is not listed is refused
// whatever its decision rows say, and every read failure refuses.
// red-first-expect: publishingStepCallReleased is not a function
// red-first-expect: releasedPublishingStepDecisionId is not a function
// red-first-expect: claimPublishingStepCall is not a function
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
  claimPublishDecisionConsumption: vi.fn(),
}));
vi.mock("../publish-decision-store", () => decisions);

import * as actions from "../publish-decision-actions";

const publishingStepCallReleased = (run: { id: string; templateId: string }, step: string | undefined) =>
  (actions as unknown as {
    publishingStepCallReleased: (r: typeof run, s: string | undefined) => Promise<boolean>;
  }).publishingStepCallReleased(run, step);

const RUN = { id: "run-1", templateId: "tmpl-1" };
const template = (publishingSteps: string[] | null | undefined) => ({ id: "tmpl-1", publishingSteps });
const row = (status: string) => ({ id: "d1", runId: "run-1", nodeId: "send", status });

beforeEach(() => {
  storeMock.readAgentTemplateById.mockReset().mockResolvedValue(template(["send"]));
  decisions.readDecisionForRunNode.mockReset().mockResolvedValue(null);
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

const releasedPublishingStepDecisionId = (run: { id: string; templateId: string }, step: string | undefined) =>
  (actions as unknown as {
    releasedPublishingStepDecisionId: (r: typeof run, s: string | undefined) => Promise<string | null>;
  }).releasedPublishingStepDecisionId(run, step);

const claimPublishingStepCall = (input: Record<string, unknown>) =>
  (actions as unknown as { claimPublishingStepCall: (i: Record<string, unknown>) => Promise<boolean> }).claimPublishingStepCall(input);

describe("the released decision a call is performed under", () => {
  it("is the id of the listed step's newest decision when it reads released", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await releasedPublishingStepDecisionId(RUN, "send")).toBe("d1");
  });

  it("is none for a step the call may not take, and for a read error", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("parked"));
    expect(await releasedPublishingStepDecisionId(RUN, "send")).toBeNull();
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await releasedPublishingStepDecisionId(RUN, "other")).toBeNull();
    expect(await releasedPublishingStepDecisionId(RUN, undefined)).toBeNull();
    decisions.readDecisionForRunNode.mockRejectedValue(new Error("db down"));
    expect(await releasedPublishingStepDecisionId(RUN, "send")).toBeNull();
  });
});

describe("claimPublishingStepCall", () => {
  beforeEach(() => {
    decisions.claimPublishDecisionConsumption.mockReset().mockResolvedValue(true);
  });

  it("claims the decision in the run's organisation, naming the road and the tool", async () => {
    expect(
      await claimPublishingStepCall({
        decisionId: "d1",
        run: { id: "run-1", orgId: "org-1" },
        stepId: "send",
        tool: "email_outreach_send_initial_start",
        executedSourceSha256: null,
      }),
    ).toBe(true);
    expect(decisions.claimPublishDecisionConsumption).toHaveBeenCalledWith({
      decisionId: "d1",
      orgId: "org-1",
      runId: "run-1",
      stepId: "send",
      toolIdentity: { road: "passthrough_publishing_step", tool: "email_outreach_send_initial_start" },
      executedSourceSha256: null,
    });
  });

  it("answers what the ledger answers, and a ledger error propagates", async () => {
    decisions.claimPublishDecisionConsumption.mockResolvedValue(false);
    const input = { decisionId: "d1", run: { id: "run-1", orgId: "org-1" }, stepId: "send", tool: "t", executedSourceSha256: "s" };
    expect(await claimPublishingStepCall(input)).toBe(false);
    decisions.claimPublishDecisionConsumption.mockRejectedValue(new Error("db down"));
    await expect(claimPublishingStepCall(input)).rejects.toThrow("db down");
  });
});
