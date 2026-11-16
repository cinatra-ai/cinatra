// cinatra#4150 part 7a-1a: the publish card's SESSION entry. Identity comes from the session only: the action takes no
// actor argument, hands the core a human UI actor with the viewer's live standing, and answers "none" for no session.
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => session);

const core = vi.hoisted(() => ({
  PUBLISH_DECISION_CARD_NONE: Object.freeze({ state: "none" }),
  resolvePublishDecisionCardStateForActor: vi.fn(),
  decidePublishDecisionForActor: vi.fn(),
}));
vi.mock("../publish-decision-card-core", () => core);

import { decidePublishDecisionAction, getPublishDecisionCardStateAction } from "../publish-decision-card-actions";

beforeEach(() => {
  vi.resetAllMocks();
  session.requireAuthSession.mockResolvedValue({ user: { id: "user-a" } });
  session.requireActorContext.mockResolvedValue({ orgRole: "member", organizationId: "org-1", teamIds: ["t1"] });
  core.resolvePublishDecisionCardStateForActor.mockResolvedValue({ state: "expired" });
  core.decidePublishDecisionForActor.mockResolvedValue("decided");
});

describe("getPublishDecisionCardStateAction", () => {
  it("hands the core the session's person as a human UI actor, with the viewer's standing", async () => {
    expect(await getPublishDecisionCardStateAction({ runId: "run-1" })).toEqual({ state: "expired" });
    expect(core.resolvePublishDecisionCardStateForActor).toHaveBeenCalledWith({
      runId: "run-1",
      who: {
        actor: { actorType: "human", source: "ui", userId: "user-a" },
        roleHints: { orgRole: "member", teamIds: ["t1"], actorOrganizationId: "org-1" },
      },
    });
  });

  it("an actor smuggled into the input is ignored", async () => {
    await getPublishDecisionCardStateAction({ runId: "run-1", who: { actor: { userId: "user-z" } } } as never);
    const call = core.resolvePublishDecisionCardStateForActor.mock.calls[0]![0] as { who: { actor: { userId: string } } };
    expect(call.who.actor.userId).toBe("user-a");
  });

  it.each([
    ["no session", () => session.requireAuthSession.mockRejectedValue(new Error("Unauthorized"))],
    ["a session with no user", () => session.requireAuthSession.mockResolvedValue({ user: null })],
    ["no actor context", () => session.requireActorContext.mockRejectedValue(new Error("no org"))],
  ])("%s answers none and reads nothing", async (_name, arrange) => {
    arrange();
    expect(await getPublishDecisionCardStateAction({ runId: "run-1" })).toEqual({ state: "none" });
    expect(core.resolvePublishDecisionCardStateForActor).not.toHaveBeenCalled();
  });
});

// cinatra#4150 part 7a-3a: the SESSION decide door. Red at the base: the action does not exist.
describe("decidePublishDecisionAction", () => {
  it("hands the ONE decide answer the session's person as a human UI actor, with the answer and the note", async () => {
    expect(await decidePublishDecisionAction({ runId: "run-1", answer: "decline", note: "Not yet." })).toBe("decided");
    expect(core.decidePublishDecisionForActor).toHaveBeenCalledWith({
      runId: "run-1",
      answer: "decline",
      note: "Not yet.",
      who: {
        actor: { actorType: "human", source: "ui", userId: "user-a" },
        roleHints: { orgRole: "member", teamIds: ["t1"], actorOrganizationId: "org-1" },
      },
    });
  });

  it("passes the core's answer through: not_open and failed", async () => {
    core.decidePublishDecisionForActor.mockResolvedValueOnce("not_open").mockResolvedValueOnce("failed");
    expect(await decidePublishDecisionAction({ runId: "run-1", answer: "approve", note: "" })).toBe("not_open");
    expect(await decidePublishDecisionAction({ runId: "run-1", answer: "approve", note: "" })).toBe("failed");
  });

  it("an actor smuggled into the input is ignored", async () => {
    await decidePublishDecisionAction({ runId: "run-1", answer: "approve", note: "", who: { actor: { userId: "user-z" } } } as never);
    const call = core.decidePublishDecisionForActor.mock.calls[0]![0] as { who: { actor: { userId: string } } };
    expect(call.who.actor.userId).toBe("user-a");
  });

  it.each([
    ["no session", () => session.requireAuthSession.mockRejectedValue(new Error("Unauthorized"))],
    ["a session with no user", () => session.requireAuthSession.mockResolvedValue({ user: null })],
    ["no actor context", () => session.requireActorContext.mockRejectedValue(new Error("no org"))],
  ])("%s decides nothing and answers failed", async (_name, arrange) => {
    arrange();
    expect(await decidePublishDecisionAction({ runId: "run-1", answer: "approve", note: "" })).toBe("failed");
    expect(core.decidePublishDecisionForActor).not.toHaveBeenCalled();
  });
});
