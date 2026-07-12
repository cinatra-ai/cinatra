import { describe, it, expect, vi, beforeEach } from "vitest";

// The transition wrapper's ONLY DB dependency is the atomic CAS primitive;
// mock it so this suite proves the fail-closed POLICY GATING (authorization +
// acyclicity + concurrent-move handling) with no database.
const applySkillLifecycleTransitionInDatabase = vi.fn<
  (input: unknown) => { changed: boolean }
>();
vi.mock("@/lib/database", () => ({
  applySkillLifecycleTransitionInDatabase: (input: unknown) =>
    applySkillLifecycleTransitionInDatabase(input),
}));

import { transitionSkillLifecycle } from "./lifecycle-store";

beforeEach(() => {
  applySkillLifecycleTransitionInDatabase.mockReset();
  applySkillLifecycleTransitionInDatabase.mockReturnValue({ changed: true });
});

describe("transitionSkillLifecycle — policy gates before the DB write", () => {
  it("applies a legal, authorized transition and passes the CAS args through", () => {
    const r = transitionSkillLifecycle({
      skillId: "s1",
      from: "active",
      to: "deprecated",
      actor: { type: "user", isOwner: true, userId: "u1" },
      reason: "superseded",
    });
    expect(r).toEqual({ ok: true });
    expect(applySkillLifecycleTransitionInDatabase).toHaveBeenCalledTimes(1);
    const arg = applySkillLifecycleTransitionInDatabase.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.skillId).toBe("s1");
    expect(arg.expectedFrom).toBe("active");
    expect(arg.to).toBe("deprecated");
    expect(arg.actorType).toBe("user");
    expect(typeof arg.auditId).toBe("string");
  });

  it("rejects an illegal transition WITHOUT touching the DB", () => {
    const r = transitionSkillLifecycle({
      skillId: "s1",
      from: "archived",
      to: "active",
      actor: { type: "platform_admin", isOwner: true },
    });
    expect(r.ok).toBe(false);
    expect(applySkillLifecycleTransitionInDatabase).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized actor WITHOUT touching the DB", () => {
    const r = transitionSkillLifecycle({
      skillId: "s1",
      from: "active",
      to: "archived",
      actor: { type: "user", isOwner: false },
    });
    expect(r.ok).toBe(false);
    expect(applySkillLifecycleTransitionInDatabase).not.toHaveBeenCalled();
  });

  it("rejects a supersede that would create a cycle WITHOUT touching the DB", () => {
    const r = transitionSkillLifecycle({
      skillId: "a",
      from: "active",
      to: "deprecated",
      actor: { type: "user", isOwner: true },
      supersededBy: "b",
      resolveSupersededBy: (id) => (id === "b" ? "a" : null), // b -> a loops back
    });
    expect(r.ok).toBe(false);
    expect(applySkillLifecycleTransitionInDatabase).not.toHaveBeenCalled();
  });

  it("applies a supersede when the chain is acyclic", () => {
    const r = transitionSkillLifecycle({
      skillId: "a",
      from: "active",
      to: "deprecated",
      actor: { type: "user", isOwner: true },
      supersededBy: "b",
      resolveSupersededBy: () => null,
    });
    expect(r).toEqual({ ok: true });
    const arg = applySkillLifecycleTransitionInDatabase.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.supersededBy).toBe("b");
  });

  it("reports a fail-closed no-op when the state moved concurrently (CAS missed)", () => {
    applySkillLifecycleTransitionInDatabase.mockReturnValue({ changed: false });
    const r = transitionSkillLifecycle({
      skillId: "s1",
      from: "active",
      to: "archived",
      actor: { type: "system", isOwner: false },
    });
    expect(r.ok).toBe(false);
    expect(applySkillLifecycleTransitionInDatabase).toHaveBeenCalledTimes(1);
  });
});
