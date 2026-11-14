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

const access = vi.hoisted(() => ({ enforcePublishDecisionAccess: vi.fn() }));
vi.mock("../publish-decision-actions", () => access);

const names = vi.hoisted(() => ({ readDeciderName: vi.fn() }));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => names);

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
