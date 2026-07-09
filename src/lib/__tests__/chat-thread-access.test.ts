import { describe, expect, it } from "vitest";

import { evaluateChatThreadAccess } from "@/lib/chat-thread-access";

// ---------------------------------------------------------------------------
// Pure read-authorization matrix for chat_threads (no org_id column; authz
// derived from the thread payload's ownerUserId / teamId). These cases pin the
// tenant-isolation contract without a database. The DENY cases use a non-admin
// actor from a DIFFERENT owner/team so a platform-admin bypass cannot mask them.
// ---------------------------------------------------------------------------

const ACTOR = "user-self";
const OTHER = "user-other";

describe("evaluateChatThreadAccess", () => {
  it("allows a thread the actor personally owns", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: ACTOR,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
      }),
    ).toBe(true);
  });

  it("DENIES a personal thread owned by a different user (core read IDOR)", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: OTHER,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
      }),
    ).toBe(false);
  });

  it("allows another user's thread only for a platform admin", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: OTHER,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: true,
        isActorTeamMember: false,
      }),
    ).toBe(true);
  });

  it("allows a team thread only when the actor is a direct team member", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: "team-1",
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: true,
      }),
    ).toBe(true);
  });

  it("DENIES a team thread when the actor is NOT a member of the team", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: "team-1",
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
      }),
    ).toBe(false);
  });

  it("prefers the owner check over the team check when both are present", () => {
    // A personally-owned thread that also carries a teamId is gated by owner
    // identity, not team membership — a non-owner team member is still denied.
    expect(
      evaluateChatThreadAccess({
        ownerUserId: OTHER,
        teamId: "team-1",
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: true,
      }),
    ).toBe(false);
  });

  it("treats a legacy row (no owner, no team) as public", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
      }),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // MCP-surface knobs: the tagged-assistant participant axis and the
  // deny-legacy-ownerless-to-non-admin posture. The HTTP route passes neither
  // (covered by the cases above); these pin the hardened MCP contract.
  // -------------------------------------------------------------------------

  it("allows a tagged participant even when another user owns the thread", () => {
    // Mirrors chat_thread_list / chat_thread_update visibility: a user tagged
    // into the thread is a participant and retains access.
    expect(
      evaluateChatThreadAccess({
        ownerUserId: OTHER,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
        taggedAssistantUserIds: [ACTOR],
      }),
    ).toBe(true);
  });

  it("DENIES a non-owner who is NOT in the tagged list", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: OTHER,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
        taggedAssistantUserIds: [OTHER, "someone-else"],
      }),
    ).toBe(false);
  });

  it("DENIES a legacy ownerless thread to a non-admin under deny-non-admin", () => {
    // The MCP get/pause/resume/send paths pass legacyOwnerlessPolicy:
    // "deny-non-admin" so an unowned thread's full content is not readable by
    // an arbitrary caller.
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
        legacyOwnerlessPolicy: "deny-non-admin",
      }),
    ).toBe(false);
  });

  it("still allows a legacy ownerless thread to a platform admin under deny-non-admin", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: true,
        isActorTeamMember: false,
        legacyOwnerlessPolicy: "deny-non-admin",
      }),
    ).toBe(true);
  });

  it("allows a tagged participant on a legacy thread even under deny-non-admin", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
        taggedAssistantUserIds: [ACTOR],
        legacyOwnerlessPolicy: "deny-non-admin",
      }),
    ).toBe(true);
  });

  it("default (no legacyOwnerlessPolicy) keeps legacy rows public — HTTP route unchanged", () => {
    expect(
      evaluateChatThreadAccess({
        ownerUserId: null,
        teamId: null,
        actorUserId: ACTOR,
        isPlatformAdmin: false,
        isActorTeamMember: false,
        taggedAssistantUserIds: null,
      }),
    ).toBe(true);
  });
});
