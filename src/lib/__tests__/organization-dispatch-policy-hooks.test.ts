/**
 * Dual-transport hook-CONTRACT test (cinatra#1942 archive V2, Decision 5;
 * codex r0 finding #14: "a mis-shaped matcher/mutation could silently
 * no-op"). Proves the top-level `hooks:` layer (built in
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

function makeAuth(
  db: Record<string, unknown[]>,
  beforeHookDeps?: Parameters<typeof buildOrganizationDispatchPolicyBeforeHook>[0],
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
    hooks: {
      before: [buildOrganizationDispatchPolicyBeforeHook(beforeHookDeps)],
      after: [buildOrganizationListAfterHook()],
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
  return { userId: body.user.id, cookie };
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
      body: { name: "Team Alpha", organizationId: orgId },
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
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: "invitee@example.test",
    });
    const invitee = await seedUserWithSession(auth, "invitee");
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId },
        headers: new Headers({ cookie: invitee.cookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("raw HTTP POST /organization/accept-invitation refuses on the archived org", async () => {
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: "invitee2@example.test",
    });
    const invitee = await seedUserWithSession(auth, "invitee2");
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
    const invitationId = seedInvitation(db, {
      organizationId: orgId,
      inviterId: ownerUserId,
      email: "reject-me@example.test",
    });
    const invitee = await seedUserWithSession(auth, "reject-me");
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

describe("dispatch-hook endpoint policy — end-to-end SPLIT read-error polarity (codex r0 #6), through a REAL betterAuth() instance", () => {
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
