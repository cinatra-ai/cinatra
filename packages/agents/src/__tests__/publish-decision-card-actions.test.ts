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
  decidePublishDecisionCardForActor: vi.fn(),
}));
vi.mock("../publish-decision-card-core", () => core);

import * as actions from "../publish-decision-card-actions";
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

// cinatra#4758: the card's ANSWER for a cookie host. The same session person as the read, handed to the core's answer;
// no session is no actor, and nothing is decided.
describe("decidePublishDecisionCardAction", () => {
  type Decide = (input: Record<string, unknown>) => Promise<string>;
  const decide = (input: Record<string, unknown>) => {
    const fn = (actions as unknown as Record<string, unknown>).decidePublishDecisionCardAction;
    expect(typeof fn, "the session decide door is exported").toBe("function");
    return (fn as Decide)(input);
  };

  beforeEach(() => {
    core.decidePublishDecisionCardForActor.mockResolvedValue("decided");
  });

  it("hands the core the answer and the session's person as a human UI actor, with the viewer's standing", async () => {
    expect(await decide({ runId: "run-1", answer: "decline", note: "Not ready yet." })).toBe("decided");
    expect(core.decidePublishDecisionCardForActor).toHaveBeenCalledWith(
      { runId: "run-1", answer: "decline", note: "Not ready yet." },
      {
        actor: { actorType: "human", source: "ui", userId: "user-a" },
        roleHints: { orgRole: "member", teamIds: ["t1"], actorOrganizationId: "org-1" },
      },
    );
  });

  it("answers what the core answers: a second answer is no longer open", async () => {
    core.decidePublishDecisionCardForActor.mockResolvedValue("not_open");
    expect(await decide({ runId: "run-1", answer: "approve", note: "" })).toBe("not_open");
  });

  it("an actor smuggled into the input is not the decider", async () => {
    await decide({ runId: "run-1", answer: "approve", note: "", who: { actor: { userId: "user-z" } } });
    const who = core.decidePublishDecisionCardForActor.mock.calls[0]![1] as { actor: { userId: string } };
    expect(who.actor.userId).toBe("user-a");
  });

  it.each([
    ["no session", () => session.requireAuthSession.mockRejectedValue(new Error("Unauthorized"))],
    ["no actor context", () => session.requireActorContext.mockRejectedValue(new Error("no org"))],
  ])("%s is failed, and nothing is decided", async (_name, arrange) => {
    arrange();
    expect(await decide({ runId: "run-1", answer: "approve", note: "" })).toBe("failed");
    expect(core.decidePublishDecisionCardForActor).not.toHaveBeenCalled();
  });
});
