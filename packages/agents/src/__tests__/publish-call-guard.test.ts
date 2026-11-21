// cinatra#4150 part 5a (A6): no publish without a released decision, enforced at the call. The model bridge and the
// passthrough road ask publishCallAllowed for every call of a run; their own suites pin that they refuse when it says
// no. Here: verified and unverified step x parked / declined / expired / run_ended / released / no row / read error.
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

import { publishCallAllowed } from "../publish-decision-actions";

const RUN = { id: "run-1", templateId: "tmpl-1" };
const template = (publishingSteps: string[] | null | undefined) => ({ id: "tmpl-1", publishingSteps });
const row = (status: string) => ({ id: "d1", runId: "run-1", nodeId: "publish", status });

beforeEach(() => {
  storeMock.readAgentTemplateById.mockReset().mockResolvedValue(template(["publish"]));
  decisions.readDecisionForRunNode.mockReset().mockResolvedValue(null);
});

describe("a verified step the template lists as publishing", () => {
  it.each(["parked", "declined", "expired", "run_ended"])("is refused while its newest decision is %s", async (status) => {
    decisions.readDecisionForRunNode.mockResolvedValue(row(status));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish");
  });

  it("is served once its newest decision is released", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it("is refused when it has no decision row", async () => {
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
  });
});

describe("a verified step the template does not list", () => {
  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
  ])("on a template that %s is held by its decision row", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    decisions.readDecisionForRunNode.mockResolvedValue(row("parked"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
  ])("on a template that %s is served when it has no decision row", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it("a step of a publishing template that is not its publishing step is served", async () => {
    expect(await publishCallAllowed(RUN, "draft")).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "draft");
  });
});

describe("a call with no verified step", () => {
  it("is refused on a run whose template lists a publishing step, whatever the decision rows say", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, undefined)).toBe(false);
  });

  it.each([
    ["lists none", []],
    ["was compiled before the list existed", null],
    ["has no list field", undefined],
  ])("is served on a run whose template %s", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    expect(await publishCallAllowed(RUN, undefined)).toBe(true);
    expect(decisions.readDecisionForRunNode).not.toHaveBeenCalled();
  });
});

describe("what cannot be read is a refusal", () => {
  it("a template that is not found cannot prove that it publishes nothing", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, undefined)).toBe(false);
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it.each([
    ["the template read", () => storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down: tmpl-1"))],
    ["the decision read", () => decisions.readDecisionForRunNode.mockRejectedValue(new Error("db down: run-1"))],
  ])("a fault of %s refuses the call and logs no id or store error", async (_label, fail) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template([]));
    fail();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "send_post")).toBe(false);
      const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toMatch(/db down|run-1|tmpl-1|send_post/);
    } finally {
      warn.mockRestore();
    }
  });
});
