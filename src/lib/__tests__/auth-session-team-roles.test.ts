// cinatra#1566 — session actors carry `teamRoles` resolved from the app-owned
// `teamMember.role` column, so the kernel's team_admin tier finally has a
// role SOURCE in the session lineage.
//
// Drives the REAL `getActorContext()` builder (src/lib/auth-session.ts) with
// only the I/O boundaries mocked (auth session, the single team read, the
// org-role/project-grant reads) — the session-actor-teamids pattern — and
// asserts:
//   1. rows with roles → actor.teamRoles in KERNEL vocabulary
//      ('admin' → 'team_admin'), and the kernel lights up: `can()` grants
//      `team.update` on the administered team and denies it on the other.
//   2. the SAME roles are threaded into `readProjectGrantsForUser` hints, so
//      `deriveImplicitOwnedRole` yields {admin, team} for team admins.
//   3. roleless rows (the un-provisioned-column degrade) → teamRoles stays
//      undefined — exactly the pre-#1566 behavior, never over-granting.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  teams: [] as Array<{ id: string; name: string; role?: "admin" | "member" | null }>,
  grantHints: [] as unknown[],
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
  auth: { api: { getSession: async () => state.session } },
  ensureGoogleAvatarSync: async () => undefined,
  ensureInitialAdminBootstrap: async () => undefined,
  ensureDefaultOrganizationMembership: async () => undefined,
  ensureAssistantBootstrap: async () => undefined,
}));

// Keep the real module surface, stub the reads the actor resolution performs:
//   - `betterAuthDb` select-chain → no membership row → orgRole undefined;
//   - `readTeamsForUser` → controllable membership rows (with/without roles);
//   - `readProjectGrantsForUser` → records its hints for assertion 2.
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/better-auth-db")>();
  return {
    ...actual,
    betterAuthDb: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] as unknown[] }) }),
      }),
    },
    readTeamsForUser: async () => state.teams,
    readProjectGrantsForUser: async (
      _userId: string,
      _orgId: string,
      hints: unknown,
    ) => {
      state.grantHints.push(hints);
      return [];
    },
  };
});

import { getActorContext } from "@/lib/auth-session";
import { can } from "@/lib/authz/enforce";
import type { ResourceRef } from "@/lib/authz/resource-ref";

const USER = "user-1";
const ORG = "org-11111111-1111-1111-1111-111111111111";
const ADMIN_TEAM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEMBER_TEAM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function teamRef(teamId: string): ResourceRef {
  return {
    resourceType: "project",
    resourceId: "res-1",
    organizationId: ORG,
    ownerType: "team",
    ownerId: teamId,
  };
}

function session() {
  return {
    user: { id: USER, image: "https://example.test/a.png", role: "member" },
    session: { activeOrganizationId: ORG },
  } as Record<string, unknown>;
}

beforeEach(() => {
  state.session = null;
  state.teams = [];
  state.grantHints = [];
});

describe("#1566 session builder → actor.teamRoles", () => {
  it("maps DB 'admin'/'member' rows to kernel teamRoles and the kernel resolves team_admin", async () => {
    state.session = session();
    state.teams = [
      { id: ADMIN_TEAM, name: "Administered team", role: "admin" },
      { id: MEMBER_TEAM, name: "Plain-membership team", role: "member" },
    ];

    const actor = await getActorContext();

    expect(actor).toBeDefined();
    expect(actor!.teamRoles).toEqual({
      [ADMIN_TEAM]: "team_admin",
      [MEMBER_TEAM]: "member",
    });
    // Kernel light-up: `team.update` is a team_admin grant — allowed on the
    // administered team, denied on the plain-membership team.
    expect(can(actor!, "team.update", teamRef(ADMIN_TEAM))).toBe(true);
    expect(can(actor!, "team.update", teamRef(MEMBER_TEAM))).toBe(false);
  });

  it("threads the same teamRoles into readProjectGrantsForUser hints", async () => {
    state.session = session();
    state.teams = [{ id: ADMIN_TEAM, name: "Administered team", role: "admin" }];

    await getActorContext();

    expect(state.grantHints).toHaveLength(1);
    expect(state.grantHints[0]).toMatchObject({
      teamIds: [ADMIN_TEAM],
      teamRoles: { [ADMIN_TEAM]: "team_admin" },
    });
  });

  it("degrades to teamRoles undefined when rows carry no role (un-provisioned column)", async () => {
    state.session = session();
    state.teams = [
      { id: ADMIN_TEAM, name: "Team A" },
      { id: MEMBER_TEAM, name: "Team B" },
    ];

    const actor = await getActorContext();

    expect(actor!.teamIds).toEqual([ADMIN_TEAM, MEMBER_TEAM]);
    expect(actor!.teamRoles).toBeUndefined();
    expect(can(actor!, "team.update", teamRef(ADMIN_TEAM))).toBe(false);
    // The hints must NOT carry a teamRoles key in the degrade (undefined
    // means "not resolved", never an empty object).
    expect(state.grantHints[0]).not.toHaveProperty("teamRoles");
  });

  it("coerces an out-of-vocabulary role (null) to plain member — never over-grants", async () => {
    state.session = session();
    state.teams = [{ id: ADMIN_TEAM, name: "Weird-role team", role: null }];

    const actor = await getActorContext();

    expect(actor!.teamRoles).toEqual({ [ADMIN_TEAM]: "member" });
    expect(can(actor!, "team.update", teamRef(ADMIN_TEAM))).toBe(false);
  });
});
