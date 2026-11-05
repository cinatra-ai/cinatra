// The cookie-less actor resolution `resolveUserContextForUserId` must build the
// SAME actor as the cookie session lineage (`getActorContext` /
// `requireActorContext`) for the same person in the same organization, the
// `teamIds` axis included.
//
// Why it matters (cinatra#3487 item 7): the run page's prompt window resolves
// its actor through `resolveUserContextForUserId`
// (src/lib/lifecycle/run-window-turn.ts), while the chat composer resolves it
// through `requireActorContext` (src/app/api/assistants/chat/route.ts). Both
// hand that actor to the one assistant runtime, which feeds it into the
// person's connector inventory. Two different actors for one person give two
// different tool exposures.
//
// Drives the REAL resolvers of src/lib/auth-session.ts. Only the I/O
// boundaries are mocked (the pattern of auth-session-team-roles.test.ts): the
// auth session, the better-auth select chain, the single team read, the
// project-grant read and the default-org bootstrap.

import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  // Rows the better-auth select chain answers, per table.
  userRows: [] as Array<{ id: string; role: string | null }>,
  sessionRows: [] as Array<{ activeOrganizationId: string | null }>,
  memberRows: [] as Array<Record<string, unknown>>,
  // EVERY team membership of the person, across organizations. The fake team
  // read answers like the real `readTeamsForUser`: only the rows of the
  // organization it is asked about.
  memberships: [] as Array<{
    id: string;
    name: string;
    orgId: string;
    role?: "admin" | "member" | null;
  }>,
  grants: [] as unknown[],
  readTeamsForUser: vi.fn(),
  readProjectGrantsForUser: vi.fn(),
  ensureDefaultOrganizationMembership: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

// Break the heavy better-auth boot graph and hand back a controllable session.
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => io.session } },
  ensureGoogleAvatarSync: async () => undefined,
  ensureInitialAdminBootstrap: async () => undefined,
  ensureDefaultOrganizationMembership: (userId: string) =>
    io.ensureDefaultOrganizationMembership(userId),
  ensureAssistantBootstrap: async () => undefined,
}));

// Keep the real module surface (tables included); stub only the reads. A
// select on a table this file does not expect REFUSES, so a new read cannot
// pass silently.
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/better-auth-db")>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === actual.betterAuthUsers) return io.userRows;
    if (table === actual.betterAuthSessions) return io.sessionRows;
    if (table === actual.betterAuthMembers) return io.memberRows;
    throw new Error("unexpected table in the better-auth select chain");
  };
  return {
    ...actual,
    betterAuthDb: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => rowsFor(table) }),
        }),
      }),
    },
    readTeamsForUser: (userId: string, orgId: string) =>
      io.readTeamsForUser(userId, orgId),
    readProjectGrantsForUser: (userId: string, orgId: string, hints: unknown) =>
      io.readProjectGrantsForUser(userId, orgId, hints),
  };
});

import {
  getActorContext,
  requireActorContext,
  resolveUserContextForUserId,
} from "@/lib/auth-session";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TEAM_A1 = "aaaaaaaa-1111-4111-8111-000000000011";
const TEAM_A2 = "aaaaaaaa-2222-4222-8222-000000000012";
const TEAM_B1 = "bbbbbbbb-1111-4111-8111-000000000021";

function chatSession(orgId: string) {
  return {
    user: { id: USER, image: "https://example.test/a.png", role: "member" },
    session: { activeOrganizationId: orgId },
  } as Record<string, unknown>;
}

beforeEach(() => {
  io.session = null;
  io.userRows = [{ id: USER, role: "member" }];
  io.sessionRows = [];
  io.memberRows = [];
  io.memberships = [];
  io.grants = [];
  io.readTeamsForUser.mockReset();
  io.readTeamsForUser.mockImplementation(async (_userId: string, orgId: string) =>
    io.memberships
      .filter((m) => m.orgId === orgId)
      .map(({ id, name, role }) => (role === undefined ? { id, name } : { id, name, role })),
  );
  io.readProjectGrantsForUser.mockReset();
  io.readProjectGrantsForUser.mockImplementation(async () => io.grants);
  io.ensureDefaultOrganizationMembership.mockReset();
  io.ensureDefaultOrganizationMembership.mockResolvedValue(undefined);
});

describe("resolveUserContextForUserId carries the person's team ids (window lineage)", () => {
  it("a: with an active org and two teams, actorContext.teamIds equals the two team ids of the one team read", async () => {
    io.memberships = [
      { id: TEAM_A1, name: "Team one", orgId: ORG_A, role: "admin" },
      { id: TEAM_A2, name: "Team two", orgId: ORG_A, role: "member" },
    ];

    const { actorContext } = await resolveUserContextForUserId(USER, {
      activeOrganizationId: ORG_A,
    });

    expect(actorContext.teamIds).toEqual([TEAM_A1, TEAM_A2]);
    // The ids the project-grant read was given are the ids the actor carries.
    const hints = io.readProjectGrantsForUser.mock.calls[0]?.[2] as
      | { teamIds?: string[] }
      | undefined;
    expect(hints?.teamIds).toEqual([TEAM_A1, TEAM_A2]);
    expect(actorContext.teamIds).toEqual(hints?.teamIds);
  });

  it("b: the chat composer's lineage and the window lineage build the same actor for the same person and org", async () => {
    io.memberships = [
      { id: TEAM_A1, name: "Team one", orgId: ORG_A, role: "admin" },
      { id: TEAM_A2, name: "Team two", orgId: ORG_A, role: "member" },
      { id: TEAM_B1, name: "Other org team", orgId: ORG_B, role: "admin" },
    ];
    io.grants = [{ projectId: "project-1", effectiveRole: "read", accessSource: "team" }];
    io.session = chatSession(ORG_A);

    const chatRequired = await requireActorContext();
    const chatOptional = await getActorContext();
    const { actorContext: windowActor } = await resolveUserContextForUserId(USER, {
      activeOrganizationId: ORG_A,
    });

    expect(chatRequired.teamIds).toEqual([TEAM_A1, TEAM_A2]);
    expect(windowActor.teamIds).toEqual(chatRequired.teamIds);
    expect(windowActor.teamIds).toEqual(chatOptional?.teamIds);
    expect(Array.isArray(windowActor.teamIds)).toBe(true);
    // The whole actor, not only the axis this case is about: the window and
    // the chat composer must hand the runtime the same exposure-driving actor.
    expect(windowActor).toStrictEqual(chatRequired);
    expect(windowActor).toStrictEqual(chatOptional);
  });

  it("c: the team read is made for the supplied org only; a membership in another org never enters teamIds", async () => {
    io.memberships = [
      { id: TEAM_A1, name: "Team one", orgId: ORG_A, role: "member" },
      { id: TEAM_B1, name: "Other org team", orgId: ORG_B, role: "admin" },
    ];

    const { actorContext, sessionOrgId } = await resolveUserContextForUserId(USER, {
      activeOrganizationId: ORG_A,
    });

    expect(sessionOrgId).toBe(ORG_A);
    expect(io.readTeamsForUser.mock.calls).toEqual([[USER, ORG_A]]);
    expect(actorContext.teamIds).toEqual([TEAM_A1]);
    expect(actorContext.teamIds).not.toContain(TEAM_B1);
    expect(Object.keys(actorContext.teamRoles ?? {})).not.toContain(TEAM_B1);
  });

  it("c: with no org supplied, the team read is made for the session row's org only", async () => {
    io.memberships = [
      { id: TEAM_A1, name: "Team one", orgId: ORG_A, role: "member" },
      { id: TEAM_B1, name: "Other org team", orgId: ORG_B, role: "admin" },
    ];
    io.sessionRows = [{ activeOrganizationId: ORG_A }];

    const { actorContext, sessionOrgId } = await resolveUserContextForUserId(USER);

    expect(sessionOrgId).toBe(ORG_A);
    expect(io.readTeamsForUser.mock.calls).toEqual([[USER, ORG_A]]);
    expect(actorContext.teamIds).toEqual([TEAM_A1]);
    expect(actorContext.teamIds).not.toContain(TEAM_B1);
  });

  it("d: with no active org, teamIds is [] (resolved-empty, not undefined) and no team read is made", async () => {
    io.memberships = [{ id: TEAM_B1, name: "Other org team", orgId: ORG_B, role: "admin" }];
    io.sessionRows = [];
    io.memberRows = [];

    const { actorContext, sessionOrgId } = await resolveUserContextForUserId(USER);

    expect(sessionOrgId).toBeNull();
    expect(io.ensureDefaultOrganizationMembership).toHaveBeenCalledWith(USER);
    expect(io.readTeamsForUser).not.toHaveBeenCalled();
    expect(actorContext.teamIds).toStrictEqual([]);
    expect(actorContext.teamRoles).toBeUndefined();
    // The fail-closed no-org road is unchanged: only Source 1, asked with an
    // empty org and no hints.
    expect(io.readProjectGrantsForUser.mock.calls).toEqual([[USER, "", {}]]);
  });

  it("e: one resolution makes exactly ONE team read (org supplied, and org from the session row)", async () => {
    io.memberships = [
      { id: TEAM_A1, name: "Team one", orgId: ORG_A, role: "admin" },
      { id: TEAM_A2, name: "Team two", orgId: ORG_A, role: "member" },
    ];

    await resolveUserContextForUserId(USER, { activeOrganizationId: ORG_A });
    expect(io.readTeamsForUser).toHaveBeenCalledTimes(1);

    io.readTeamsForUser.mockClear();
    io.sessionRows = [{ activeOrganizationId: ORG_A }];
    await resolveUserContextForUserId(USER);
    expect(io.readTeamsForUser).toHaveBeenCalledTimes(1);
  });
});
