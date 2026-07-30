/**
 * Dual-transport hook-CONTRACT test (cinatra#1942 archive V2, Decision 5;
 * the design review's warning that "a mis-shaped matcher/mutation could
 * silently no-op"). Proves the top-level `hooks:` layer (built in
 * `@/lib/organization-dispatch-policy`, wired in `src/lib/auth.ts`) actually
 * FIRES against a REAL `betterAuth()` instance on BOTH transports:
 *   - raw HTTP  (`auth.handler(new Request(...))`, mirrors
 *     `organization-native-delete-disabled.test.ts`'s harness)
 *   - in-process (`auth.api.*`)
 *
 * This is NOT a unit test of the decision logic (see
 * `organization-dispatch-policy.test.ts` for the exhaustive pure-function
 * coverage of the allow/prohibit map and the SPLIT read-error polarity) — it
 * is the CONTRACT that the wiring itself is live: a correctly-shaped
 * `decideDispatchPolicy` behind a matcher that never matches, or an
 * after-hook mutation that never reaches the response, would pass every
 * unit test and still ship a no-op in production. Only driving the REAL
 * `betterAuth()` config catches that class of bug.
 *
 * Setup mirrors `organization-native-delete-disabled.test.ts` (same
 * `memoryAdapter` harness, same real `betterAuth()` + the real cinatra
 * organization plugin). An org is "planted archived" by directly mutating
 * its row in the in-memory store after creation — the same "plant
 * `archivedAt`" technique the design doc uses throughout, since CI-testable
 * behavior here never needs the (still gate-off) real archive transaction.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";
import {
  buildOrganizationDispatchPolicyBeforeHook,
  buildOrganizationListAfterHook,
} from "../organization-dispatch-policy";

type OrgRow = { id?: string; name?: string; slug?: string; archivedAt?: Date | null };
type TeamRow = { id?: string; organizationId?: string; name?: string };
type InvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  inviterId: string;
  teamId: string | null;
  expiresAt: Date;
};

function makeDb(): Record<string, unknown[]> {
  return {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    team: [],
    teamMember: [],
  };
}

/**
 * Hook deps that read the SAME in-memory store the `memoryAdapter` endpoints
 * mutate. The hook's DEFAULT deps run raw SQL against the app's Drizzle
 * `betterAuthDb` — a database that does not exist in this unit-test
 * environment, so leaving the defaults in place would make every archived
 * check throw and the prohibited tests would "pass" via the fail-closed
 * error polarity (green for the wrong reason) while the CONTROL/unarchive
 * tests failed outright. Injecting store-backed readers keeps the ENTIRE
 * hook pipeline real (matcher -> class-aware resolution -> split-polarity
 * decision -> APIError) while the I/O seam — which is exactly the seam
 * production swaps the other way — reads the harness's own store. The
 * default readers' SQL text is trivial single-row lookups covered by the CI
 * typecheck.
 */
function storeBackedDeps(
  db: Record<string, unknown[]>,
): Parameters<typeof buildOrganizationDispatchPolicyBeforeHook>[0] {
  return {
    readArchivedAt: async (organizationId: string) =>
      ((db.organization as OrgRow[]).find((o) => o.id === organizationId)?.archivedAt ?? null),
    readTeamOrganizationId: async (teamId: string) =>
      ((db.team as TeamRow[]).find((t) => t.id === teamId)?.organizationId ?? null),
    readInvitationOrganizationId: async (invitationId: string) =>
      ((db.invitation as InvitationRow[]).find((i) => i.id === invitationId)?.organizationId ??
        null),
    readOrganizationIdBySlug: async (slug: string) =>
      ((db.organization as OrgRow[]).find((o) => o.slug === slug)?.id ?? null),
  };
}

function makeAuth(
  db: Record<string, unknown[]>,
  beforeHookDepOverrides?: Parameters<typeof buildOrganizationDispatchPolicyBeforeHook>[0],
) {
  return betterAuth({
    appName: "Cinatra",
    secret: "test-secret-cinatra-1942-v2-abcdefghijklmnop",
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    plugins: [
      buildCinatraOrganizationPlugin({
        // teams.enabled comes from cinatraOrganizationOptions inside the
        // factory — no override needed here.
      }),
    ],
    // The EXACT root-hooks shape src/lib/auth.ts uses: ONE middleware per
    // phase, never the plugin-style {matcher, handler} array (that shape
    // crashes the handler chain at runtime — the wiring class this contract
    // test exists to catch).
    hooks: {
      before: buildOrganizationDispatchPolicyBeforeHook({
        ...storeBackedDeps(db),
        ...beforeHookDepOverrides,
      }),
      after: buildOrganizationListAfterHook(),
    },
  });
}

async function seedUserWithSession(auth: ReturnType<typeof makeAuth>, label: string) {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const password = "correct-horse-battery-staple";
  const res = await auth.api.signUpEmail({
    body: { email, password, name: label },
    asResponse: true,
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).not.toBe("");
  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie, email };
}

async function seedOrg(auth: ReturnType<typeof makeAuth>, ownerUserId: string): Promise<string> {
  const org = await auth.api.createOrganization({
    body: { name: "Acme Corp", slug: `acme-${crypto.randomUUID()}`, userId: ownerUserId },
  });
  expect(org).toBeTruthy();
  return org!.id;
}

function plantArchived(db: Record<string, unknown[]>, organizationId: string) {
  const orgs = (db.organization ?? []) as OrgRow[];
  const row = orgs.find((o) => o.id === organizationId);
  expect(row).toBeTruthy();
  row!.archivedAt = new Date("2026-07-01T00:00:00Z");
}

function unplantArchived(db: Record<string, unknown[]>, organizationId: string) {
  const orgs = (db.organization ?? []) as OrgRow[];
  const row = orgs.find((o) => o.id === organizationId);
  expect(row).toBeTruthy();
  row!.archivedAt = null;
}

function rawPost(
  auth: ReturnType<typeof makeAuth>,
  path: string,
  body: Record<string, unknown>,
  cookie: string,
) {
  return auth.handler(
    new Request(`http://localhost/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

function seedInvitation(
  db: Record<string, unknown[]>,
  opts: { organizationId: string; inviterId: string; email: string },
): string {
  const id = crypto.randomUUID();
  const row: InvitationRow = {
    id,
    organizationId: opts.organizationId,
    email: opts.email,
    role: "member",
    status: "pending",
    inviterId: opts.inviterId,
    teamId: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  };
  (db.invitation as InvitationRow[]).push(row);
  return id;
}

describe("/organization/list after-hook — fires on BOTH transports (cinatra#1942 archive V2)", () => {
  let db: Record<string, unknown[]>;
  let auth: ReturnType<typeof makeAuth>;
  let ownerUserId: string;
  let ownerCookie: string;
  let activeOrgId: string;
  let archivedOrgId: string;

  beforeEach(async () => {
    db = makeDb();
    auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    ownerUserId = owner.userId;
    ownerCookie = owner.cookie;
    activeOrgId = await seedOrg(auth, ownerUserId);
    archivedOrgId = await seedOrg(auth, ownerUserId);
    plantArchived(db, archivedOrgId);
  });

  it("auth.api.listOrganizations excludes the archived org, includes the active one", async () => {
    const orgs = await auth.api.listOrganizations({ headers: new Headers({ cookie: ownerCookie }) });
    const ids = (orgs ?? []).map((o: { id: string }) => o.id);
    expect(ids).toContain(activeOrgId);
    expect(ids).not.toContain(archivedOrgId);
  });

  it("raw HTTP GET /organization/list excludes the archived org, includes the active one", async () => {
    const res = await auth.handler(
      new Request("http://localhost/api/auth/organization/list", {
        method: "GET",
        headers: { cookie: ownerCookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((o) => o.id);
    expect(ids).toContain(activeOrgId);
    expect(ids).not.toContain(archivedOrgId);
  });
});

describe("dispatch-hook endpoint policy — PROHIBITED endpoints refuse on an archived org, BOTH transports", () => {
  let db: Record<string, unknown[]>;
  let auth: ReturnType<typeof makeAuth>;
  let ownerUserId: string;
  let ownerCookie: string;
  let orgId: string;
  let teamId: string;

  beforeEach(async () => {
    db = makeDb();
    auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    ownerUserId = owner.userId;
    ownerCookie = owner.cookie;
    orgId = await seedOrg(auth, ownerUserId);
    const team = await auth.api.createTeam({
      // `slug` is REQUIRED by the public create-team endpoint's body schema
      // (the team.slug additionalField is required:true — see
      // better-auth-org-hooks' scope note).
      body: { name: "Team Alpha", slug: `team-alpha-${crypto.randomUUID()}`, organizationId: orgId },
      headers: new Headers({ cookie: ownerCookie }),
    });
    expect(team).toBeTruthy();
    teamId = (team as TeamRow).id!;
    plantArchived(db, orgId);
  });

  it("in-process auth.api.setActiveOrganization refuses (FORBIDDEN) on the archived org", async () => {
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/set-active refuses on the archived org", async () => {
    const res = await rawPost(auth, "/organization/set-active", { organizationId: orgId }, ownerCookie);
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.setActiveTeam refuses on the archived org (org resolved via teamId)", async () => {
    await expect(
      auth.api.setActiveTeam({
        body: { teamId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/set-active-team refuses on the archived org", async () => {
    const res = await rawPost(auth, "/organization/set-active-team", { teamId }, ownerCookie);
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.addTeamMember refuses on the archived org (before the endpoint even validates the target user)", async () => {
    await expect(
      auth.api.addTeamMember({
        body: { teamId, userId: "user-that-need-not-exist" },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/add-team-member refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/add-team-member",
      { teamId, userId: "user-that-need-not-exist" },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.removeTeamMember refuses on the archived org", async () => {
    await expect(
      auth.api.removeTeamMember({
        body: { teamId, userId: ownerUserId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/remove-team-member refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/remove-team-member",
      { teamId, userId: ownerUserId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.acceptInvitation refuses on the archived org (org resolved via invitationId)", async () => {
    // The invitee exists FIRST so the invitation row can carry their real
    // email — better-auth's own recipient check must pass, leaving the
    // dispatch policy as the ONLY refusal source this test can observe.
    const invitee = await seedUserWithSession(auth, "invitee");
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: invitee.email,
    });
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId },
        headers: new Headers({ cookie: invitee.cookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/accept-invitation refuses on the archived org", async () => {
    const invitee = await seedUserWithSession(auth, "invitee2");
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: invitee.email,
    });
    const res = await rawPost(auth, "/organization/accept-invitation", { invitationId }, invitee.cookie);
    expect(res.status).toBe(403);
  });

  it("CONTROL: the same setActiveOrganization call succeeds once the org is unarchived (the hook is not an always-refuse)", async () => {
    unplantArchived(db, orgId);
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).resolves.toBeTruthy();
  });

  // --- V2 review finding 1 — the organizationId-spoof leg is DEAD ---------
  it("SPOOF PIN: add-team-member with a planted ACTIVE organizationId still refuses (target = the team's org)", async () => {
    // A second, ACTIVE org the attacker points the checker at.
    const activeOrgId = await seedOrg(auth, ownerUserId);
    const res = await rawPost(
      auth,
      "/organization/add-team-member",
      // teamId belongs to the ARCHIVED org; organizationId names the ACTIVE
      // one. The policy must resolve via the team and refuse.
      { teamId, userId: "user-that-need-not-exist", organizationId: activeOrgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  // --- V2 review finding 3 — the extended prohibit set fires (raw HTTP; a
  // wrong path name would 404 here, so these also pin the endpoint names) ---
  it("raw HTTP POST /organization/invite-member refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/invite-member",
      { email: "new-invitee@example.test", role: "member", organizationId: orgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("raw HTTP POST /organization/remove-member refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/remove-member",
      { memberIdOrEmail: "someone@example.test", organizationId: orgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.removeMember refuses on the archived org (the extension class fires in-process too)", async () => {
    await expect(
      auth.api.removeMember({
        body: { memberIdOrEmail: "someone@example.test", organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/update-member-role refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/update-member-role",
      { memberId: "member-row-id", role: "member", organizationId: orgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("raw HTTP POST /organization/create-team refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/create-team",
      { name: "New Team", slug: "new-team", organizationId: orgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("raw HTTP POST /organization/update (org settings) refuses on the archived org", async () => {
    const res = await rawPost(
      auth,
      "/organization/update",
      { data: { name: "Renamed While Archived" }, organizationId: orgId },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("raw HTTP POST /organization/update-team refuses on the archived org (team-target resolution)", async () => {
    const res = await rawPost(
      auth,
      "/organization/update-team",
      { teamId, data: { name: "Renamed Team" } },
      ownerCookie,
    );
    expect(res.status).toBe(403);
  });

  it("raw HTTP POST /organization/remove-team refuses on the archived org (team-target resolution)", async () => {
    const res = await rawPost(auth, "/organization/remove-team", { teamId, organizationId: orgId }, ownerCookie);
    expect(res.status).toBe(403);
  });

  // --- the organizationSlug leg (set-active accepts a slug instead of an id)
  it("raw HTTP POST /organization/set-active via organizationSlug refuses on the archived org", async () => {
    const slug = `slug-leg-${crypto.randomUUID()}`;
    const org = await auth.api.createOrganization({
      body: { name: "Slug Leg Org", slug, userId: ownerUserId },
    });
    expect(org).toBeTruthy();
    plantArchived(db, org!.id);
    const res = await rawPost(auth, "/organization/set-active", { organizationSlug: slug }, ownerCookie);
    expect(res.status).toBe(403);
  });
});

describe("dispatch-hook endpoint policy — a bodyless organization-target request falls back to the session's active org", () => {
  // The `resolveDispatchTarget` "organization" class mirrors Better Auth's
  // OWN default: when the body names no `organizationId`/`organizationSlug`,
  // both the policy and the real endpoint (e.g. `/organization/update`)
  // fall back to the caller's session `activeOrganizationId`. The hook must
  // read that from a REAL session lookup (`getSessionFromCtx`), not the
  // `ctx.context.session` cache slot, which is unpopulated this early in the
  // root `hooks.before` pipeline — reading it directly would silently
  // resolve `unresolvable` and stand the policy aside on every such request,
  // even though the real endpoint still acts on the archived org.
  it("raw HTTP POST /organization/update with no organizationId in the body still refuses when the session's active org is archived", async () => {
    const db = makeDb();
    const auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    // Make the org the session's active org WHILE it is still active...
    await auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: new Headers({ cookie: owner.cookie }),
    });
    // ...then archive it out from under the session.
    plantArchived(db, orgId);
    const res = await rawPost(
      auth,
      "/organization/update",
      { data: { name: "Renamed While Archived" } },
      owner.cookie,
    );
    expect(res.status).toBe(403);
  });

  it("in-process auth.api.updateOrganization with no organizationId in the body still refuses when the session's active org is archived", async () => {
    const db = makeDb();
    const auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    await auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: new Headers({ cookie: owner.cookie }),
    });
    plantArchived(db, orgId);
    await expect(
      auth.api.updateOrganization({
        body: { data: { name: "Renamed While Archived" } },
        headers: new Headers({ cookie: owner.cookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});

describe("dispatch-hook endpoint policy — the set-active(null) UNSET escape hatch is never policed", () => {
  it("a user whose session still points at an archived org can always unset it (organizationId: null)", async () => {
    const db = makeDb();
    const auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    // Make the org the session's active org WHILE it is still active...
    await auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: new Headers({ cookie: owner.cookie }),
    });
    // ...then archive it out from under the session.
    plantArchived(db, orgId);
    // The UNSET must succeed — policing it via the active-org fallback would
    // trap the user in the archived org.
    const res = await auth.handler(
      new Request("http://localhost/api/auth/organization/set-active", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ organizationId: null }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("dispatch-hook endpoint policy — CLEANUP endpoints stay ALLOWED on an archived org, BOTH transports", () => {
  let db: Record<string, unknown[]>;
  let auth: ReturnType<typeof makeAuth>;
  let ownerUserId: string;
  let ownerCookie: string;
  let orgId: string;

  beforeEach(async () => {
    db = makeDb();
    auth = makeAuth(db);
    const owner = await seedUserWithSession(auth, "owner");
    ownerUserId = owner.userId;
    ownerCookie = owner.cookie;
    orgId = await seedOrg(auth, ownerUserId);
  });

  it("in-process auth.api.leaveOrganization still succeeds on an archived org (a non-owner member leaving)", async () => {
    const member = await seedUserWithSession(auth, "member");
    // Seed the membership row directly (memory-adapter arrays), avoiding any
    // uncertainty about the invite/accept round-trip for this control.
    (db.member as Array<Record<string, unknown>>).push({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: member.userId,
      role: "member",
      createdAt: new Date(),
    });
    plantArchived(db, orgId);
    await expect(
      auth.api.leaveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: member.cookie }),
      }),
    ).resolves.toBeTruthy();
  });

  it("raw HTTP POST /organization/reject-invitation still succeeds on an archived org", async () => {
    // Invitee first — the invitation must carry their REAL email, or
    // better-auth's own recipient check 403s and masks the cleanup-allow
    // this test exists to prove.
    const invitee = await seedUserWithSession(auth, "reject-me");
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: invitee.email,
    });
    plantArchived(db, orgId);
    const res = await rawPost(auth, "/organization/reject-invitation", { invitationId }, invitee.cookie);
    expect(res.status).toBe(200);
  });

  it("in-process auth.api.cancelInvitation still succeeds on an archived org", async () => {
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: "cancel-me@example.test",
    });
    plantArchived(db, orgId);
    await expect(
      auth.api.cancelInvitation({
        body: { invitationId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("dispatch-hook endpoint policy — end-to-end SPLIT read-error polarity through a REAL betterAuth() instance", () => {
  // A forced `readArchivedAt` failure, injected into the SAME hook wiring
  // `src/lib/auth.ts` uses in production (just with a broken reader) — this
  // closes the loop between the exhaustive PURE decideDispatchPolicy
  // coverage (organization-dispatch-policy.test.ts) and the live request
  // pipeline: a prohibited endpoint must refuse even when the archivedAt
  // read itself throws, and a cleanup endpoint must still proceed.
  const throwingReadArchivedAt = async (_organizationId: string): Promise<never> => {
    throw new Error("simulated archivedAt read failure");
  };

  it("PROHIBITED (set-active) fails CLOSED when the archivedAt read throws", async () => {
    const db = makeDb();
    const auth = makeAuth(db, { readArchivedAt: throwingReadArchivedAt });
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    // Org is NOT planted archived — the read itself fails regardless of the
    // underlying row, which is exactly the scenario the SPLIT polarity
    // exists for.
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: owner.cookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("CLEANUP (leave) fails OPEN when the archivedAt read throws — a user is never trapped by a transient failure", async () => {
    const db = makeDb();
    const auth = makeAuth(db, { readArchivedAt: throwingReadArchivedAt });
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    const member = await seedUserWithSession(auth, "member");
    (db.member as Array<Record<string, unknown>>).push({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: member.userId,
      role: "member",
      createdAt: new Date(),
    });
    await expect(
      auth.api.leaveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: member.cookie }),
      }),
    ).resolves.toBeTruthy();
  });
});
