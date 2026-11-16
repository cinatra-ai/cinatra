// cinatra#4150 part 7a-1a: the publish card's ONE authorized read.
//
// What is pinned here is what the card may draw for one reader, and nothing the card decides itself:
//   - the run access door runs first, and every refusal is the same silence ("none");
//   - the state comes from the run's NEWEST decision: parked = pending, released = approved, declined, expired;
//     a decision the run left another way (run_ended) and a run with no decision draw nothing;
//   - the rows are the pack's declared rows (7-0) over the values the stop surfaced, label over value, in the
//     declared order; a row whose value is missing or not a plain value is dropped, never shown as an identifier;
//   - "may decide" is the SAME access check Publish and Do not publish run, asked without deciding;
//   - a settled card names the person who decided (approved, declined) and an expired one names no one; a settled row
//     with no recorded decider, or a decider name that cannot be read, draws nothing rather than an anonymous card.
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({ readLatestDecisionForRun: vi.fn() }));
vi.mock("../publish-decision-store", () => decisions);

const access = vi.hoisted(() => ({
  enforcePublishDecisionAccess: vi.fn(),
  approvePublishDecision: vi.fn(),
  declinePublishDecision: vi.fn(),
}));
vi.mock("../publish-decision-actions", () => access);

const names = vi.hoisted(() => ({ readDeciderName: vi.fn() }));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => names);

import * as cardCore from "../publish-decision-card-core";
import {
  publishDecisionCardStateForRun,
  resolvePublishDecisionCardStateForActor,
} from "../publish-decision-card-core";

const WHO = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "user-a" },
  roleHints: { orgRole: "member" as const, actorOrganizationId: "org-1" },
};
const RUN = { id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a" };

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    runId: "run-1",
    nodeId: "post",
    status: "parked",
    surfacedValues: { title: "Autumn launch", channel: "Blog", secretId: "row-77" },
    decidedBy: null,
    decisionNote: null,
    ...overrides,
  };
}

const TEMPLATE = {
  id: "tmpl-1",
  name: "Launch writer",
  publishRows: { post: [{ label: "Title", input: "title" }, { label: "Where", input: "channel" }] },
};

type Run = Parameters<typeof publishDecisionCardStateForRun>[0];
const read = () => publishDecisionCardStateForRun(RUN as unknown as Run, WHO);

beforeEach(() => {
  vi.resetAllMocks();
  storeMock.readAgentRunById.mockResolvedValue(RUN);
  storeMock.readAgentTemplateById.mockResolvedValue(TEMPLATE);
  decisions.readLatestDecisionForRun.mockResolvedValue(decision());
  access.enforcePublishDecisionAccess.mockResolvedValue({ run: RUN, deciderId: "user-a", authority: {} });
  names.readDeciderName.mockResolvedValue("Dana Okafor");
});

describe("which card a run shows", () => {
  it("a parked decision is PENDING, with the agent's name and its declared rows in order", async () => {
    expect(await read()).toEqual({
      state: "pending",
      runId: "run-1",
      agentName: "Launch writer",
      rows: [
        { label: "Title", value: "Autumn launch" },
        { label: "Where", value: "Blog" },
      ],
      mayDecide: true,
    });
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
  });

  it("may decide is the decide access check, asked for this reader without deciding", async () => {
    access.enforcePublishDecisionAccess.mockRejectedValue(new Error("Forbidden"));
    const state = await read();
    expect(state).toMatchObject({ state: "pending", mayDecide: false });
    expect(access.enforcePublishDecisionAccess).toHaveBeenCalledWith({
      runId: "run-1",
      actorContext: WHO.actor,
      roleHints: WHO.roleHints,
    });
  });

  it("a released decision is APPROVED and names the person who decided", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-b" }));
    expect(await read()).toMatchObject({ state: "approved", deciderName: "Dana Okafor" });
    expect(names.readDeciderName).toHaveBeenCalledWith("user-b");
    expect(access.enforcePublishDecisionAccess).not.toHaveBeenCalled();
  });

  it("a declined decision names the person and carries the reason that was written", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(
      decision({ status: "declined", decidedBy: "user-b", decisionNote: "Not ready yet." }),
    );
    expect(await read()).toMatchObject({ state: "declined", deciderName: "Dana Okafor", reason: "Not ready yet." });
  });

  it("a declined decision with no note carries no reason, and an unnamed person is null", async () => {
    names.readDeciderName.mockResolvedValue(undefined);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "declined", decidedBy: "user-b" }));
    expect(await read()).toMatchObject({ state: "declined", deciderName: null, reason: null });
  });

  it("a settled decision with no recorded decider draws nothing, never an anonymous card", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: null }));
    expect(await read()).toEqual({ state: "none" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "declined", decidedBy: "", decisionNote: "No." }));
    expect(await read()).toEqual({ state: "none" });
    expect(names.readDeciderName).not.toHaveBeenCalled();
  });

  it("a decider name that cannot be read draws nothing, not a card with its reason", async () => {
    names.readDeciderName.mockRejectedValue(new Error("db down"));
    decisions.readLatestDecisionForRun.mockResolvedValue(
      decision({ status: "declined", decidedBy: "user-b", decisionNote: "Not ready yet." }),
    );
    expect(await read()).toEqual({ state: "none" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-b" }));
    expect(await read()).toEqual({ state: "none" });
  });

  it("an expired decision names no one", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "expired" }));
    const state = await read();
    expect(state.state).toBe("expired");
    expect(state).not.toHaveProperty("deciderName");
    expect(names.readDeciderName).not.toHaveBeenCalled();
  });

  it("a decision the run left another way (run_ended), and a run with no decision, draw nothing", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "run_ended" }));
    expect(await read()).toEqual({ state: "none" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
    expect(await read()).toEqual({ state: "none" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "some_future_status" }));
    expect(await read()).toEqual({ state: "none" });
  });

  it("an unreadable decision or template draws nothing rather than half a card", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("malformed"));
    expect(await read()).toEqual({ state: "none" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision());
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down"));
    expect(await read()).toEqual({ state: "none" });
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    expect(await read()).toEqual({ state: "none" });
  });
});

describe("the rows are the pack's words over the surfaced values", () => {
  it("drops a row whose value is missing or not a plain value, and shows no undeclared value", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...TEMPLATE,
      publishRows: {
        post: [
          { label: "Title", input: "title" },
          { label: "Missing", input: "absent" },
          { label: "Nested", input: "nested" },
        ],
      },
    });
    decisions.readLatestDecisionForRun.mockResolvedValue(
      decision({ surfacedValues: { title: "Autumn launch", nested: { id: "x" }, secretId: "row-77" } }),
    );
    const state = await read();
    expect(state).toMatchObject({ rows: [{ label: "Title", value: "Autumn launch" }] });
    expect(JSON.stringify(state)).not.toContain("row-77");
  });

  it("numbers and booleans read as text; an empty string is dropped", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...TEMPLATE,
      publishRows: { post: [{ label: "Count", input: "n" }, { label: "Live", input: "live" }, { label: "Blank", input: "b" }] },
    });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ surfacedValues: { n: 3, live: true, b: "  " } }));
    expect(await read()).toMatchObject({
      rows: [
        { label: "Count", value: "3" },
        { label: "Live", value: "true" },
      ],
    });
  });

  it("a number that is not finite is dropped", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...TEMPLATE,
      publishRows: { post: [{ label: "A", input: "a" }, { label: "B", input: "b" }, { label: "C", input: "c" }] },
    });
    decisions.readLatestDecisionForRun.mockResolvedValue(
      decision({ surfacedValues: { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 0 } }),
    );
    expect(await read()).toMatchObject({ rows: [{ label: "C", value: "0" }] });
  });

  it("a step that declares no rows, or a template with no declaration, shows the card with no rows", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, publishRows: null });
    expect(await read()).toMatchObject({ state: "pending", rows: [] });
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, publishRows: { other: TEMPLATE.publishRows.post } });
    expect(await read()).toMatchObject({ state: "pending", rows: [] });
  });

  it("a node id that names an Object.prototype member reads as no declaration", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ nodeId: "constructor" }));
    expect(await read()).toMatchObject({ state: "pending", rows: [] });
  });
});

describe("the access door runs first", () => {
  it("reads the run through the door with the reader's own actor and role hints", async () => {
    const state = await resolvePublishDecisionCardStateForActor({ runId: "run-1", who: WHO });
    expect(state.state).toBe("pending");
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1", WHO.actor, WHO.roleHints);
  });

  it("a run the reader may not read, a refused read and an empty id are the same silence", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);
    expect(await resolvePublishDecisionCardStateForActor({ runId: "run-1", who: WHO })).toEqual({ state: "none" });
    storeMock.readAgentRunById.mockRejectedValue(new Error("Forbidden"));
    expect(await resolvePublishDecisionCardStateForActor({ runId: "run-1", who: WHO })).toEqual({ state: "none" });
    expect(await resolvePublishDecisionCardStateForActor({ runId: "", who: WHO })).toEqual({ state: "none" });
    expect(decisions.readLatestDecisionForRun).not.toHaveBeenCalled();
    expect(storeMock.readAgentTemplateById).not.toHaveBeenCalled();
    expect(names.readDeciderName).not.toHaveBeenCalled();
    expect(access.enforcePublishDecisionAccess).not.toHaveBeenCalled();
  });

  it("the run read comes before every other read", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-b" }));
    await resolvePublishDecisionCardStateForActor({ runId: "run-1", who: WHO });
    const door = storeMock.readAgentRunById.mock.invocationCallOrder[0];
    for (const later of [decisions.readLatestDecisionForRun, storeMock.readAgentTemplateById, names.readDeciderName]) {
      expect(later.mock.invocationCallOrder[0]).toBeGreaterThan(door);
    }
  });
});

// cinatra#4150 part 7a-3a: the ONE decide answer behind every door. Red at the base: decidePublishDecisionForActor
// does not exist (cardCore.decidePublishDecisionForActor is not a function).
describe("the decide answer (part 7a-3a)", () => {
  const decideFor = (input: Record<string, unknown>) =>
    (cardCore as unknown as { decidePublishDecisionForActor: (i: unknown) => Promise<string> }).decidePublishDecisionForActor({
      runId: "run-1",
      note: "",
      who: WHO,
      ...input,
    });

  it("Publish is approvePublishDecision for the verified actor, with no note", async () => {
    access.approvePublishDecision.mockResolvedValue({ ok: true, resumed: true });
    expect(await decideFor({ answer: "approve", note: "ignored" })).toBe("decided");
    expect(access.approvePublishDecision).toHaveBeenCalledWith({
      runId: "run-1",
      actorContext: WHO.actor,
      roleHints: WHO.roleHints,
    });
    expect(access.declinePublishDecision).not.toHaveBeenCalled();
  });

  it("Do not publish is declinePublishDecision with the note", async () => {
    access.declinePublishDecision.mockResolvedValue({ ok: true, runStopped: true });
    expect(await decideFor({ answer: "decline", note: "Not ready." })).toBe("decided");
    expect(access.declinePublishDecision).toHaveBeenCalledWith({
      runId: "run-1",
      actorContext: WHO.actor,
      roleHints: WHO.roleHints,
      note: "Not ready.",
    });
  });

  it("a Publish another road already released is decided too", async () => {
    access.approvePublishDecision.mockResolvedValue({ ok: true, resumed: false });
    expect(await decideFor({ answer: "approve" })).toBe("decided");
  });

  it("a late answer is not_open, on both roads", async () => {
    const late = { ok: false, code: "publish_decision_not_open", currentStatus: "expired" };
    access.approvePublishDecision.mockResolvedValue(late);
    access.declinePublishDecision.mockResolvedValue(late);
    expect(await decideFor({ answer: "approve" })).toBe("not_open");
    expect(await decideFor({ answer: "decline" })).toBe("not_open");
  });

  it("a refusal or a fault is failed, and its log line carries no id, note or error text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    access.approvePublishDecision.mockRejectedValue(new Error("run-1 secret store detail"));
    access.declinePublishDecision.mockRejectedValue(Object.assign(new Error("Only a person can decide a publish."), { statusCode: 403 }));
    expect(await decideFor({ answer: "approve" })).toBe("failed");
    expect(await decideFor({ answer: "decline", note: "private words" })).toBe("failed");
    // One fixed line per failure, and nothing else: a removed or reworded warn fails here.
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toEqual(["[publish-decision] a decide door could not record the answer"]);
      expect(call.map(String).join(" ")).not.toMatch(/run-1|secret|private words|Only a person/);
    }
    warn.mockRestore();
  });

  it.each([
    ["an unknown answer", { answer: "publish" }],
    ["an empty run id", { answer: "approve", runId: "" }],
    ["an oversized run id", { answer: "approve", runId: "r".repeat(257) }],
  ])("%s decides nothing", async (_name, input) => {
    expect(await decideFor(input)).toBe("failed");
    expect(access.approvePublishDecision).not.toHaveBeenCalled();
    expect(access.declinePublishDecision).not.toHaveBeenCalled();
  });
});

// cinatra#4150 part 7a-3b: the widget publish grant travels with the widget reader, to the decision and to "may decide".
// Red at the 7a-3a tip: the grant is dropped, so neither call carries it.
describe("the widget publish grant (part 7a-3b)", () => {
  const GRANT = Object.freeze({ runId: "run-1", userId: "user-a", orgId: "org-1" });
  const WIDGET_WHO = { ...WHO, actor: { ...WHO.actor, source: "a2a" as const }, widgetGrant: GRANT };

  it("is handed to Publish and to Do not publish", async () => {
    access.approvePublishDecision.mockResolvedValue({ ok: true, resumed: true });
    access.declinePublishDecision.mockResolvedValue({ ok: true, runStopped: true });
    const core = cardCore as unknown as { decidePublishDecisionForActor: (i: unknown) => Promise<string> };
    await core.decidePublishDecisionForActor({ runId: "run-1", answer: "approve", note: "", who: WIDGET_WHO });
    await core.decidePublishDecisionForActor({ runId: "run-1", answer: "decline", note: "n", who: WIDGET_WHO });
    expect(access.approvePublishDecision.mock.calls[0]![0]).toMatchObject({ widgetGrant: GRANT });
    expect(access.declinePublishDecision.mock.calls[0]![0]).toMatchObject({ widgetGrant: GRANT, note: "n" });
  });

  it("is handed to the may-decide check of a pending card", async () => {
    await publishDecisionCardStateForRun(RUN as unknown as Run, WIDGET_WHO as never);
    expect(access.enforcePublishDecisionAccess.mock.calls[0]![0]).toMatchObject({ widgetGrant: GRANT });
  });
});
