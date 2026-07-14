// Exhaustive matrix tests for the pure structured-store thread authorization
// decision (cinatra#1037 P5.5) — the G2 generalization of
// evaluateChatThreadAccess re-targeted at assistant_threads. Pure (no DB).

import { describe, expect, it } from "vitest";

import { evaluateAssistantThreadAccess } from "../assistant-thread-access";

const base = {
  threadAssistantUserId: "assistant-1" as string | null,
  threadOwnerUserId: "owner-1" as string | null,
  threadOrgId: "org-1" as string | null,
  actorUserId: "owner-1",
  actorOrgId: "org-1",
  isPlatformAdmin: false,
};

describe("evaluateAssistantThreadAccess", () => {
  it("allows a platform admin regardless of every other axis", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        actorUserId: "stranger",
        actorOrgId: "other-org",
        threadOwnerUserId: null,
        threadOrgId: null,
        isPlatformAdmin: true,
      }),
    ).toBe(true);
  });

  it("allows the personal owner in the same org", () => {
    expect(evaluateAssistantThreadAccess(base)).toBe(true);
  });

  it("denies a cross-user caller (owner set, not the actor)", () => {
    expect(evaluateAssistantThreadAccess({ ...base, actorUserId: "stranger" })).toBe(false);
  });

  it("denies across orgs even for the owner (cross-org seal)", () => {
    expect(evaluateAssistantThreadAccess({ ...base, actorOrgId: "org-2" })).toBe(false);
  });

  it("denies an org-less thread to a non-admin (team mirror rows fail closed)", () => {
    expect(evaluateAssistantThreadAccess({ ...base, threadOrgId: null })).toBe(false);
  });

  it("allows the BOUND ASSISTANT PRINCIPAL as a participant on a thread another user owns", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        actorUserId: "assistant-1",
      }),
    ).toBe(true);
  });

  it("does not let the participant axis cross the org seal", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        actorUserId: "assistant-1",
        actorOrgId: "org-2",
      }),
    ).toBe(false);
  });

  it("denies a legacy ownerless (and unbound) row to a non-admin", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        threadOwnerUserId: null,
        threadAssistantUserId: null,
      }),
    ).toBe(false);
  });

  it("denies an ownerless row bound to a DIFFERENT assistant to a non-admin non-participant", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        threadOwnerUserId: null,
        actorUserId: "someone-else",
      }),
    ).toBe(false);
  });

  it("never allows an empty actorUserId through the participant axis", () => {
    expect(
      evaluateAssistantThreadAccess({
        ...base,
        threadAssistantUserId: "",
        threadOwnerUserId: null,
        actorUserId: "",
      }),
    ).toBe(false);
  });
});
