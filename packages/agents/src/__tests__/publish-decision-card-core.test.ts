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
  releasedPublishAwaitsResume: vi.fn(),
  widgetReaderMayDecidePublish: vi.fn(),
  approvePublishDecision: vi.fn(),
  declinePublishDecision: vi.fn(),
  approvePublishDecisionAsWidgetReader: vi.fn(),
  declinePublishDecisionAsWidgetReader: vi.fn(),
}));
vi.mock("../publish-decision-actions", () => access);

const names = vi.hoisted(() => ({ readDeciderName: vi.fn() }));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => names);

import * as core from "../publish-decision-card-core";
import {
  publishDecisionCardStateForRun,
  publishDecisionCardStateForWidgetRun,
  resolvePublishDecisionCardStateForActor,
} from "../publish-decision-card-core";

const WHO = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "user-a" },
  roleHints: { orgRole: "member" as const, actorOrganizationId: "org-1" },
};
const RUN = { id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a", status: "pending_approval" };

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
  access.releasedPublishAwaitsResume.mockResolvedValue(false);
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
      decisionId: "d1",
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

  // Before the fix the widget read does not exist yet, so this test fails on the missing export.
  // red-first-expect: publishDecisionCardStateForWidgetRun is not a function
  it("the site widget's card asks the widget reader's rights, never the decide check", async () => {
    const widget = { ...WHO, actor: { actorType: "human" as const, source: "a2a" as const, userId: "user-a" } };
    for (const answer of [true, false]) {
      access.widgetReaderMayDecidePublish.mockResolvedValueOnce(answer);
      const state = await publishDecisionCardStateForWidgetRun(RUN as unknown as Run, widget);
      expect(state).toMatchObject({ state: "pending", mayDecide: answer });
    }
    expect(access.widgetReaderMayDecidePublish).toHaveBeenCalledWith({
      runId: "run-1",
      actorContext: widget.actor,
      roleHints: widget.roleHints,
    });
    expect(access.enforcePublishDecisionAccess).not.toHaveBeenCalled();
  });

  it("a released decision is APPROVED and names the person who decided", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-b" }));
    expect(await read()).toMatchObject({ state: "approved", deciderName: "Dana Okafor" });
    expect(names.readDeciderName).toHaveBeenCalledWith("user-b");
    expect(access.enforcePublishDecisionAccess).not.toHaveBeenCalled();
  });

  // An Allow whose resume did not complete leaves a released decision on a run that still waits at its gate. That run is
  // not approved and going on: the card keeps Allow (and only Allow), so the run is never left with no way forward.
  it("a released decision whose run still waits at its gate keeps Allow open on that decision, and draws no Approved", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-b", gateTaskId: "task-1" }));
    access.releasedPublishAwaitsResume.mockResolvedValue(true);
    // red-first-expect: expected { state: 'approved', …(4) } to match object { state: 'pending', …(3) }
    expect(await read()).toMatchObject({ state: "pending", decisionId: "d1", mayDecide: true, resumeOnly: true });
    expect(access.releasedPublishAwaitsResume).toHaveBeenCalledWith(RUN, expect.objectContaining({ id: "d1", status: "released" }));
    access.releasedPublishAwaitsResume.mockResolvedValue(false);
    expect(await read()).toMatchObject({ state: "approved", deciderName: "Dana Okafor" });
    access.releasedPublishAwaitsResume.mockRejectedValue(new Error("redis down"));
    expect(await read()).toMatchObject({ state: "approved", deciderName: "Dana Okafor" });
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

  it("a parked decision of a run that has ENDED is no open card: the run is parked at no gate", async () => {
    for (const status of ["stopped", "completed", "failed"]) {
      const ended = { ...RUN, status } as unknown as Run;
      expect(await publishDecisionCardStateForRun(ended, WHO), status).toEqual({ state: "none" });
      expect(await publishDecisionCardStateForWidgetRun(ended, WHO), status).toEqual({ state: "none" });
    }
    // A held or working run keeps its open card.
    for (const status of ["pending_approval", "running"]) {
      const held = { ...RUN, status } as unknown as Run;
      expect((await publishDecisionCardStateForRun(held, WHO)).state, status).toBe("pending");
    }
    // A settled decision still shows its outcome on an ended run.
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "expired" }));
    expect((await publishDecisionCardStateForRun({ ...RUN, status: "stopped" } as unknown as Run, WHO)).state).toBe("expired");
  });

  it("a parked decision of a run NOT held at its gate (a retry back in pending_input or queued) is no open card", async () => {
    // A failed attempt's row left parked must not read as the open stop of the run's next attempt.
    for (const status of ["pending_input", "queued", "some_future_status", undefined]) {
      const notHeld = { ...RUN, status } as unknown as Run;
      expect(await publishDecisionCardStateForRun(notHeld, WHO), String(status)).toEqual({ state: "none" });
      expect(await publishDecisionCardStateForWidgetRun(notHeld, WHO), String(status)).toEqual({ state: "none" });
    }
    expect(access.enforcePublishDecisionAccess).not.toHaveBeenCalled();
    expect(access.widgetReaderMayDecidePublish).not.toHaveBeenCalled();
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

describe("a decision's rows are the ones its template declared at the park (review finding 2)", () => {
  const AT_PARK = [{ label: "Title", input: "title" }, { label: "Where", input: "channel" }];
  // A recompile after the park: new labels, an input renamed, a row added that names an identifier.
  const RECOMPILED = {
    ...TEMPLATE,
    publishRows: { post: [{ label: "Headline", input: "headline" }, { label: "Record", input: "secretId" }] },
  };
  const STORED_ROWS = [{ label: "Title", value: "Autumn launch" }, { label: "Where", value: "Blog" }];

  it("a parked decision keeps its stored labels and inputs after the template is recompiled", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(RECOMPILED);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ declaredRows: AT_PARK }));
    const card = await read();
    expect(card.state).toBe("pending");
    expect((card as { rows: unknown }).rows).toEqual(STORED_ROWS);
  });

  it("a settled decision keeps its stored labels and inputs after the template is recompiled", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(RECOMPILED);
    for (const settled of [
      decision({ status: "released", decidedBy: "user-b", declaredRows: AT_PARK }),
      decision({ status: "declined", decidedBy: "user-b", decisionNote: "No.", declaredRows: AT_PARK }),
      decision({ status: "expired", declaredRows: AT_PARK }),
    ]) {
      decisions.readLatestDecisionForRun.mockResolvedValue(settled);
      const card = await read();
      expect((card as { rows: unknown }).rows, settled.status as string).toEqual(STORED_ROWS);
    }
  });

  it("a stored empty declaration draws no rows, even when the template now declares some", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ declaredRows: [] }));
    expect((await read() as { rows: unknown }).rows).toEqual([]);
  });

  it("an older decision with no stored declaration (null) falls back to the template's current rows", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ declaredRows: null }));
    expect((await read() as { rows: unknown }).rows).toEqual(STORED_ROWS);
    storeMock.readAgentTemplateById.mockResolvedValue(RECOMPILED);
    expect((await read() as { rows: unknown }).rows).toEqual([{ label: "Record", value: "row-77" }]);
  });
});

// cinatra#4758: THE CARD'S ANSWER. Allow and Do not allow take the existing decision roads (approvePublishDecision and
// declinePublishDecision, which check run.execute then run.approveHitl and write the one guarded decision); the site
// widget's answer takes their widget-reader twins. The card is told only: decided, no longer open, or failed.
describe("the card's answer (cinatra#4758)", () => {
  type Decide = (input: { runId: string; decisionId: string; answer: "approve" | "decline"; note?: string | null }, who: typeof WHO) => Promise<string>;
  const decideFor = (name: string): Decide => {
    const fn = (core as unknown as Record<string, unknown>)[name];
    expect(typeof fn, `${name} is exported`).toBe("function");
    return fn as Decide;
  };

  beforeEach(() => {
    access.approvePublishDecision.mockResolvedValue({ ok: true, resumed: true });
    access.declinePublishDecision.mockResolvedValue({ ok: true, runStopped: true });
    access.approvePublishDecisionAsWidgetReader.mockResolvedValue({ ok: true, resumed: true });
    access.declinePublishDecisionAsWidgetReader.mockResolvedValue({ ok: true, runStopped: true });
  });

  it("Allow releases the run through the approve road, as this person, and is decided", async () => {
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "approve", note: "" }, WHO)).toBe("decided");
    expect(access.approvePublishDecision).toHaveBeenCalledWith({ runId: "run-1", decisionId: "d1", actorContext: WHO.actor, roleHints: WHO.roleHints });
    expect(access.declinePublishDecision).not.toHaveBeenCalled();
  });

  it("Do not allow stops the run through the decline road, with the note recorded, and is decided", async () => {
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "decline", note: "Not ready yet." }, WHO)).toBe("decided");
    expect(access.declinePublishDecision).toHaveBeenCalledWith({
      runId: "run-1", decisionId: "d1", actorContext: WHO.actor, roleHints: WHO.roleHints, note: "Not ready yet.",
    });
    expect(access.approvePublishDecision).not.toHaveBeenCalled();
  });

  it("a blank note is no note, and Allow never carries one", async () => {
    await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "decline", note: "   " }, WHO);
    expect((access.declinePublishDecision.mock.calls[0]![0] as { note: unknown }).note).toBeNull();
    await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "approve", note: "a note" }, WHO);
    expect(access.approvePublishDecision.mock.calls[0]![0]).not.toHaveProperty("note");
  });

  it("a second answer after the request was decided is no longer open", async () => {
    access.declinePublishDecision.mockResolvedValue({ ok: false, code: "publish_decision_not_open", currentStatus: "released" });
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "decline", note: "" }, WHO)).toBe("not_open");
    access.approvePublishDecision.mockResolvedValue({ ok: false, code: "publish_decision_not_open", currentStatus: "declined" });
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "approve", note: "" }, WHO)).toBe("not_open");
    // An Allow that met a run no longer waiting at this decision (another Allow released it) resumed nothing.
    access.approvePublishDecision.mockResolvedValue({ ok: true, resumed: false });
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "approve", note: "" }, WHO)).toBe("not_open");
  });

  it("a reader who may view but not decide is refused by the road's own access check: failed, nothing else told", async () => {
    access.declinePublishDecision.mockRejectedValue(Object.assign(new Error("Run access denied."), { statusCode: 403 }));
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "decline", note: "x" }, WHO)).toBe("failed");
    access.approvePublishDecision.mockRejectedValue(Object.assign(new Error("Run access denied."), { statusCode: 403 }));
    expect(await decideFor("decidePublishDecisionCardForActor")({ runId: "run-1", decisionId: "d1", answer: "approve", note: "" }, WHO)).toBe("failed");
  });

  it.each([
    ["no run id", { runId: "", answer: "approve" }],
    ["an unknown answer", { runId: "run-1", decisionId: "d1", answer: "publish" }],
    ["a note that is not text", { runId: "run-1", decisionId: "d1", answer: "decline", note: 7 }],
    ["no decision (an answer must name the decision the card shows)", { runId: "run-1", answer: "approve" }],
    ["an empty decision", { runId: "run-1", decisionId: "", answer: "decline" }],
  ])("%s is failed, and no road is taken", async (_label, input) => {
    expect(await decideFor("decidePublishDecisionCardForActor")(input as never, WHO)).toBe("failed");
    expect(access.approvePublishDecision).not.toHaveBeenCalled();
    expect(access.declinePublishDecision).not.toHaveBeenCalled();
  });

  // both doors hand the roads the decision the card showed, so the roads' guarded write lands
  // only on that decision.
  it.each([
    ["the session door", "decidePublishDecisionCardForActor", "approvePublishDecision", "declinePublishDecision"],
    ["the widget door", "decidePublishDecisionCardForWidgetReader", "approvePublishDecisionAsWidgetReader", "declinePublishDecisionAsWidgetReader"],
  ] as const)("%s hands both roads the decision the card showed", async (_label, door, approve, decline) => {
    await decideFor(door)({ runId: "run-1", decisionId: "d-shown", answer: "approve", note: "" }, WHO);
    await decideFor(door)({ runId: "run-1", decisionId: "d-shown", answer: "decline", note: "" }, WHO);
    expect(access[approve].mock.calls[0]![0]).toMatchObject({ runId: "run-1", decisionId: "d-shown" });
    expect(access[decline].mock.calls[0]![0]).toMatchObject({ runId: "run-1", decisionId: "d-shown" });
  });

  it("the site widget's answer takes the widget-reader roads, never the session ones", async () => {
    const decide = decideFor("decidePublishDecisionCardForWidgetReader");
    expect(await decide({ runId: "run-1", decisionId: "d1", answer: "approve", note: "" }, WHO)).toBe("decided");
    expect(await decide({ runId: "run-1", decisionId: "d1", answer: "decline", note: "Not ready yet." }, WHO)).toBe("decided");
    expect(access.approvePublishDecisionAsWidgetReader).toHaveBeenCalledTimes(1);
    expect((access.declinePublishDecisionAsWidgetReader.mock.calls[0]![0] as { note: unknown }).note).toBe("Not ready yet.");
    expect(access.approvePublishDecision).not.toHaveBeenCalled();
    expect(access.declinePublishDecision).not.toHaveBeenCalled();
  });
});
