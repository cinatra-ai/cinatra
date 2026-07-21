// #1486 — session actors must carry `teamIds` so a #1069 `team:<id>`
// visibility token can match in `requireResourceAccess`.
//
// AC2 requires the coverage to exercise the session BUILDER, not a fabricated
// actor: it drives the REAL `getActorContext()` / `requireActorContext()`
// (src/lib/auth-session.ts) — with only the I/O boundaries mocked (auth
// session, the team read, the org-role/project-grant reads) — and then feeds
// the produced ActorContext straight into `requireResourceAccess` to prove a
// granted team member is admitted and a non-member / cross-org team is denied.
// The pure `requireResourceAccess` positive/negative coverage on hand-built
// actors already lives in `require-resource-access-multi-scope.test.ts`; this
// file is the missing builder→gate proof.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable control surface, hoisted above the `vi.mock` factories so they can
// close over it.
const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  // What `readTeamsForUser(userId, activeOrg)` returns — i.e. the caller's
  // ACTIVE-ORG team memberships only (the real reader filters on
  // team.organizationId = activeOrg, so a foreign-org membership never enters).
  teams: [] as Array<{ id: string; name: string }>,
  readTeamsCalls: [] as Array<{ userId: string; orgId: string }>,
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

// Keep the real module (auth-policy + auth-session both import many of its
// exports) but stub the three reads the actor resolution performs so no live
// Postgres is required:
//   - `betterAuthDb` select-chain → no membership row → orgRole undefined
//     (buildActorContext then defaults orgRole to "member").
//   - `readTeamsForUser` → the caller's ACTIVE-ORG teams (records its args so
//     the test can assert exactly ONE call, scoped to the active org).
//   - `readProjectGrantsForUser` → none (this test isolates the team axis).
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/better-auth-db")>();
  return {
    ...actual,
    betterAuthDb: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] as unknown[] }) }),
      }),
    },
    readTeamsForUser: async (userId: string, orgId: string) => {
      state.readTeamsCalls.push({ userId, orgId });
      return state.teams;
    },
    readProjectGrantsForUser: async () => [],
  };
});

// Imports MUST follow the mocks (vi.mock is hoisted, but the module graph is
// evaluated with the mocks in place).
import { getActorContext, requireActorContext } from "@/lib/auth-session";
import { requireResourceAccess, buildSkillResourceRef } from "../auth-policy";
import type { AgentAuthPolicy } from "../auth-policy";

const MEMBER = "member-user-1";
const ORG = "org-11111111-1111-1111-1111-111111111111";
// The team the member belongs to IN THE ACTIVE ORG.
const MEMBER_TEAM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
// A team the member does NOT belong to in the active org (used as both the
// "different team" and the "cross-org team" negative — the active-org team read
// never returns it).
const OTHER_TEAM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function policy(tokens: AgentAuthPolicy["runListVisibility"]): AgentAuthPolicy {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}

// A team-scoped skill whose effective policy is exactly `["team:<member-team>"]`
// — the #1416 shape (effPolicy correct, member 404s because actor.teamIds was
// empty).
const memberTeamRef = buildSkillResourceRef({
  id: "@pkg/team-skill",
  level: "team",
  scope: MEMBER_TEAM,
  accessPolicy: policy([`team:${MEMBER_TEAM}`]),
});

// Same shape, but scoped to a team the member is NOT in (in the active org).
const otherTeamRef = buildSkillResourceRef({
  id: "@pkg/other-team-skill",
  level: "team",
  scope: OTHER_TEAM,
  accessPolicy: policy([`team:${OTHER_TEAM}`]),
});

function memberSession() {
  // Fast-path shape for getAuthSession (avatar + non-"user" role +
  // activeOrganizationId) so no enrichment / re-getSession runs. role="member"
  // is non-empty and !== "user" (fast path) yet does NOT include "admin"
  // (platformRole stays "member", so the policy union — not the admin bypass —
  // decides).
  return {
    user: { id: MEMBER, image: "https://example.test/a.png", role: "member" },
    session: { activeOrganizationId: ORG },
  } as Record<string, unknown>;
}

beforeEach(() => {
  state.session = null;
  state.teams = [];
  state.readTeamsCalls = [];
});

describe("#1486 session builder → requireResourceAccess (team:<id> token)", () => {
  it("getActorContext(): a member of the granted team is ADMITTED (was 404 before the fix)", async () => {
    state.session = memberSession();
    state.teams = [{ id: MEMBER_TEAM, name: "Active-org team" }];

    const actor = await getActorContext();

    expect(actor).toBeDefined();
    // The builder threaded the active-org membership onto the actor.
    expect(actor!.teamIds).toEqual([MEMBER_TEAM]);
    expect(() => requireResourceAccess(actor!, memberTeamRef)).not.toThrow();
  });

  it("getActorContext(): a NON-member of the team is DENIED (different-team policy → 403)", async () => {
    state.session = memberSession();
    state.teams = [{ id: MEMBER_TEAM, name: "Active-org team" }];

    const actor = await getActorContext();

    // actor.teamIds = [MEMBER_TEAM] does not include OTHER_TEAM.
    expect(() => requireResourceAccess(actor!, otherTeamRef)).toThrow(
      expect.objectContaining({ statusCode: 403, reason: "forbidden" }),
    );
  });

  it("requireActorContext(): admits the granted-team member and denies the other-team policy", async () => {
    state.session = memberSession();
    state.teams = [{ id: MEMBER_TEAM, name: "Active-org team" }];

    const actor = await requireActorContext();

    expect(actor.teamIds).toEqual([MEMBER_TEAM]);
    expect(() => requireResourceAccess(actor, memberTeamRef)).not.toThrow();
    expect(() => requireResourceAccess(actor, otherTeamRef)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("no memberships → teamIds is [] (never undefined) and every team policy is denied", async () => {
    state.session = memberSession();
    state.teams = [];

    const actor = await getActorContext();

    expect(actor!.teamIds).toEqual([]);
    expect(actor!.teamIds).not.toBeUndefined();
    expect(() => requireResourceAccess(actor!, memberTeamRef)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("cross-org isolation: the team read is scoped to the ACTIVE org and runs exactly ONCE per actor resolution", async () => {
    // The member also belongs to teams in OTHER orgs, but the active-org-scoped
    // reader returns only the active-org team — the builder can never place a
    // foreign-org membership onto teamIds. We assert the read is anchored to the
    // active org (so a stale/foreign org can't leak) and is not duplicated
    // (#1486 AC1: reuse the single project-grant team read).
    state.session = memberSession();
    state.teams = [{ id: MEMBER_TEAM, name: "Active-org team" }];

    const actor = await getActorContext();

    expect(actor!.teamIds).toEqual([MEMBER_TEAM]);
    expect(state.readTeamsCalls).toHaveLength(1);
    expect(state.readTeamsCalls[0]).toEqual({ userId: MEMBER, orgId: ORG });
    // A policy for a team the member holds only in a DIFFERENT org (never
    // returned by the active-org read) is denied.
    expect(() => requireResourceAccess(actor!, otherTeamRef)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("getActorContext(): returns undefined when there is no session (no team inference)", async () => {
    state.session = null;
    const actor = await getActorContext();
    expect(actor).toBeUndefined();
    expect(state.readTeamsCalls).toHaveLength(0);
  });
});
