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
}));
vi.mock("../publish-decision-card-core", () => core);

import { getPublishDecisionCardStateAction } from "../publish-decision-card-actions";

beforeEach(() => {
  vi.resetAllMocks();
  session.requireAuthSession.mockResolvedValue({ user: { id: "user-a" } });
  session.requireActorContext.mockResolvedValue({ orgRole: "member", organizationId: "org-1", teamIds: ["t1"] });
  core.resolvePublishDecisionCardStateForActor.mockResolvedValue({ state: "expired" });
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
