// cinatra#4150 part 7a-3b: WHO MAY DECIDE A PUBLISH FROM THE SITE WIDGET. Security class.
//
// The site widget's person is built as a human actor of source "a2a" (the shape the MCP frame entry builds too), so the
// actor alone never admits a decider. A widget decider needs a widget publish grant minted for THIS run, THIS person
// and the actor's org, from claims that carry the existing `lifecycle.decide` scope, and its run must be its own run in
// that org. Every other token-scoped or a2a actor stays refused. The allowed case then meets the same run access checks
// (run.execute, run.approveHitl) and the same record as a person on the app.
//
// Red at the base: mintWidgetPublishDecideGrant does not exist, and the allowed case is refused ("Only a person").
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  readLatestDecisionForRun: vi.fn(async () => null as unknown),
  readOpenDecisionForRun: vi.fn(async () => null as unknown),
  listDueParked: vi.fn(async () => [] as unknown[]),
  listSettledWithWaitingRun: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../publish-decision-store", () => decisions);

const enforceRunAccess = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../auth-policy", () => ({ enforceRunAccess, resolveEffectivePolicy: () => "owner-only" }));

const resolveOrgRoleForUser = vi.hoisted(() => vi.fn(async () => "member" as string | undefined));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser }));

vi.mock("../lifecycle-coordinator", () => ({
  onPublishGate: vi.fn(async () => undefined),
  clearPublishMoment: vi.fn(async () => undefined),
}));

import * as actions from "../publish-decision-actions";

type Grant = Readonly<{ runId: string; userId: string; orgId: string }>;
type Claims = { userId: string; orgId: string; grantedScopes: readonly string[] };
const mint = (claims: Claims, runId: string): Grant | null =>
  (actions as unknown as { mintWidgetPublishDecideGrant: (c: Claims, r: string) => Grant | null })
    .mintWidgetPublishDecideGrant(claims, runId);

/** The widget door's actor: the live-standing leaf builds exactly this (widget-lifecycle-frame-actor.ts). */
const WIDGET = { actorType: "human" as const, source: "a2a" as const, userId: "user-a", orgId: "org-1" };
const DECIDE_CLAIMS: Claims = { userId: "user-a", orgId: "org-1", grantedScopes: ["lifecycle.read", "lifecycle.decide"] };
const OWN_RUN = { id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a", authPolicy: null, status: "pending_approval" };

const decline = (actorContext: unknown, widgetGrant?: unknown) =>
  actions.declinePublishDecision({ runId: "run-1", actorContext, widgetGrant } as never);

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentRunById.mockReset();
  storeMock.readAgentRunById.mockResolvedValue(OWN_RUN);
  decisions.readOpenDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "parked" });
  decisions.decide.mockReset();
  decisions.decide.mockImplementation(async (id: string, change: { to: string }) => ({
    outcome: "won",
    decision: { id, status: change.to },
  }));
  enforceRunAccess.mockResolvedValue(undefined);
  resolveOrgRoleForUser.mockResolvedValue("member");
});

function expectNothingRead() {
  expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
  expect(enforceRunAccess).not.toHaveBeenCalled();
  expect(decisions.decide).not.toHaveBeenCalled();
}

describe("the allowed case: a widget person with the decide grant, on their own run", () => {
  it("decides like a person on the app: the same two run access checks, the same membership, the same record", async () => {
    const grant = mint(DECIDE_CLAIMS, "run-1");
    expect(grant).not.toBeNull();
    expect(await decline(WIDGET, grant)).toEqual({ ok: true, runStopped: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["execute", "approveHitl"]);
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[1])).toEqual([WIDGET, WIDGET]);
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-1", "user-a");
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-a", note: null });
  });

  it("the run access checks still decide: a widget person the run policy refuses is refused", async () => {
    enforceRunAccess.mockRejectedValueOnce(Object.assign(new Error("Run access denied."), { statusCode: 403 }));
    await expect(decline(WIDGET, mint(DECIDE_CLAIMS, "run-1"))).rejects.toBeTruthy();
    expect(decisions.decide).not.toHaveBeenCalled();
  });
});

describe("no grant: every a2a or token-scoped actor stays refused", () => {
  it("an a2a frame actor WITHOUT the grant is refused before anything is read (decline and Publish)", async () => {
    await expect(decline(WIDGET)).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.approvePublishDecision({ runId: "run-1", actorContext: WIDGET } as never)).rejects.toMatchObject({
      statusCode: 403,
    });
    expectNothingRead();
  });

  it("claims without the lifecycle.decide scope mint no grant", () => {
    expect(mint({ ...DECIDE_CLAIMS, grantedScopes: ["lifecycle.read"] }, "run-1")).toBeNull();
    expect(mint({ ...DECIDE_CLAIMS, grantedScopes: [] }, "run-1")).toBeNull();
    expect(mint({ ...DECIDE_CLAIMS, grantedScopes: undefined as never }, "run-1")).toBeNull();
    expect(mint({ ...DECIDE_CLAIMS, userId: "" }, "run-1")).toBeNull();
    expect(mint({ ...DECIDE_CLAIMS, orgId: "" }, "run-1")).toBeNull();
    expect(mint(DECIDE_CLAIMS, "")).toBeNull();
  });

  it("a grant-shaped object that was not minted is no grant", async () => {
    await expect(decline(WIDGET, { runId: "run-1", userId: "user-a", orgId: "org-1" })).rejects.toMatchObject({ statusCode: 403 });
    expectNothingRead();
  });

  it.each([
    ["another run's grant", () => mint(DECIDE_CLAIMS, "run-2")],
    ["another person's grant", () => mint({ ...DECIDE_CLAIMS, userId: "user-b" }, "run-1")],
    ["another org's grant", () => mint({ ...DECIDE_CLAIMS, orgId: "org-2" }, "run-1")],
  ])("%s does not admit this actor for this run", async (_label, grant) => {
    await expect(decline(WIDGET, grant())).rejects.toMatchObject({ statusCode: 403 });
    expectNothingRead();
  });

  it.each([
    ["a token-scoped actor", { ...WIDGET, tokenScopes: ["run.execute", "run.approveHitl"] }],
    ["an actor with an empty token scope list", { ...WIDGET, tokenScopes: [] }],
    ["an agent acting for the person", { ...WIDGET, oboCeiling: [{ tier: "organization", id: "org-1" }] }],
    ["an MCP source", { ...WIDGET, source: "mcp" }],
    ["an agent source", { ...WIDGET, source: "agent" }],
    ["an A2A peer", { ...WIDGET, actorType: "a2a" }],
    ["a frame actor with no org", { ...WIDGET, orgId: undefined }],
  ])("%s is refused even WITH a minted grant", async (_label, actor) => {
    await expect(decline(actor, mint(DECIDE_CLAIMS, "run-1"))).rejects.toMatchObject({ statusCode: 403 });
    expectNothingRead();
  });
});

describe("the run's own audience: a widget decider reaches only its own run in its token's org", () => {
  it.each([
    ["another person's run", { ...OWN_RUN, runBy: "user-b" }],
    ["a run with no initiator", { ...OWN_RUN, runBy: null }],
    ["a run in another org", { ...OWN_RUN, orgId: "org-2" }],
    ["a run that is not found", null],
  ])("%s answers Not found, and nothing is decided", async (_label, run) => {
    storeMock.readAgentRunById.mockResolvedValue(run);
    await expect(decline(WIDGET, mint(DECIDE_CLAIMS, "run-1"))).rejects.toMatchObject({ statusCode: 404 });
    expect(enforceRunAccess).not.toHaveBeenCalled();
    expect(decisions.decide).not.toHaveBeenCalled();
  });
});

describe("the person on the app is unchanged", () => {
  it("a UI actor decides with no grant, as before", async () => {
    const ui = { actorType: "human" as const, source: "ui" as const, userId: "user-a" };
    expect(await decline(ui)).toEqual({ ok: true, runStopped: true });
  });
});
