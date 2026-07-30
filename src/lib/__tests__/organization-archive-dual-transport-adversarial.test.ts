/**
 * cinatra#1943 A5 (manifest row 13) — "Dual-transport coverage": an
 * adversarial EXTENSION of cinatra#1942 archive V2's own dual-transport
 * contract, not a re-derivation of it.
 *
 * V2 already proves, each in its OWN file, in isolation:
 *  - organization-dispatch-policy-hooks.test.ts — the Better-Auth dispatch
 *    hook fires on BOTH of ITS OWN transports (raw HTTP + in-process
 *    `auth.api.*`), using test-injected store-backed deps (there is no real
 *    DB in this unit-test tier).
 *  - team-member-actions.test.ts — the APP-NATIVE writer
 *    (`member-actions.ts`) calls the archive guard before mutating, with the
 *    guard module MOCKED WHOLESALE (`vi.mock("@/lib/organization-archive-guard")`).
 *  - organization-archive-guard.test.ts — the guard's own pure decision
 *    (active / archived / read-error) against an injected fake reader.
 *
 * None of the three proves the actual #1943-shaped claim: that the TWO
 * STRUCTURALLY DIFFERENT transports for mutating Better-Auth-owned
 * membership state actually agree, from ONE shared real archived-state
 * source, with no drift window and no split-brain gap where a caller
 * refused on one transport could slip through the other. The two
 * transports are:
 *   1. Better Auth's own endpoint dispatch pipeline
 *      (`@/lib/organization-dispatch-policy`, wired at the root
 *      `hooks.before`/`hooks.after` on the `betterAuth()` call) — reachable
 *      via raw HTTP or in-process `auth.api.*`.
 *   2. The APP-NATIVE writer path that bypasses that pipeline ENTIRELY —
 *      `@/lib/organization-archive-guard`'s `assertTargetOrgNotArchived`,
 *      called directly by `member-actions.ts` (see that guard's own module
 *      doc: "Better Auth's dispatch-hook endpoint policy... can only see
 *      writes that flow through a Better Auth endpoint... every APP-NATIVE
 *      writer... sits entirely outside that hook").
 *
 * Every case below drives the REAL production functions from both modules
 * (`buildOrganizationDispatchPolicyBeforeHook` / `buildOrganizationListAfterHook`
 * and `assertTargetOrgNotArchived`) against a SINGLE shared fake org store —
 * never two independently-seeded fakes, which would hide exactly the drift
 * this row exists to rule out.
 *
 * No real DB — same `memoryAdapter` harness as
 * organization-dispatch-policy-hooks.test.ts. Rides the wholesale root
 * Vitest suite (`pnpm test:root`, the `perpetual-loops-invariants` CI job),
 * the same tier that file already runs under.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";
import {
  buildOrganizationDispatchPolicyBeforeHook,
  buildOrganizationListAfterHook,
} from "../organization-dispatch-policy";
import {
  assertTargetOrgNotArchived,
  OrganizationArchivedError,
} from "../organization-archive-guard";

type OrgRow = { id?: string; name?: string; slug?: string; archivedAt?: Date | null };
type TeamRow = { id?: string; organizationId?: string; name?: string };

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
 * The ONE shared read — both transports resolve archived state through this
 * exact function, reading the exact same in-memory store row the Better-Auth
 * `memoryAdapter` endpoints mutate. This is the anti-drift property this
 * whole file pins: no transport gets its own independently-faked view of
 * "is this org archived" (production wiring achieves the same thing by
 * having `organization-dispatch-policy.ts` import
 * `readOrganizationArchivedAt` from `organization-archive-guard.ts` — one
 * real function, not two).
 */
function sharedReadArchivedAt(db: Record<string, unknown[]>) {
  return async (organizationId: string) =>
    (db.organization as OrgRow[]).find((o) => o.id === organizationId)?.archivedAt ?? null;
}

function makeAuth(
  db: Record<string, unknown[]>,
  readArchivedAt: (organizationId: string) => Promise<Date | string | null>,
) {
  return betterAuth({
    appName: "Cinatra",
    secret: "test-secret-cinatra-1943-a5-abcdefghijklmnop",
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    plugins: [buildCinatraOrganizationPlugin({})],
    // The EXACT root-hooks shape src/lib/auth.ts uses: ONE middleware per
    // phase (see organization-dispatch-policy-hooks.test.ts's own comment on
    // why the {matcher, handler} array form must never be used here).
    hooks: {
      before: buildOrganizationDispatchPolicyBeforeHook({
        readArchivedAt,
        readTeamOrganizationId: async (teamId: string) =>
          (db.team as TeamRow[]).find((t) => t.id === teamId)?.organizationId ?? null,
        readInvitationOrganizationId: async () => null,
        readOrganizationIdBySlug: async () => null,
      }),
      after: buildOrganizationListAfterHook(),
    },
  });
}

async function seedUserWithSession(auth: ReturnType<typeof makeAuth>, label: string) {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery-staple", name: label },
    asResponse: true,
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
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

async function seedOrgWithTeam(
  auth: ReturnType<typeof makeAuth>,
  ownerUserId: string,
  ownerCookie: string,
): Promise<{ orgId: string; teamId: string }> {
  const orgId = await seedOrg(auth, ownerUserId);
  // `/organization/create-team` is itself a POLICED endpoint (part of the
  // adversarial-review extension to the prohibit set) — callers that need an
  // UNPOLICED seed (e.g. the read-error suite below, where every policed
  // endpoint refuses regardless of real archived state) must use `seedOrg`
  // alone and never call this helper.
  const team = await auth.api.createTeam({
    body: { name: "Team Alpha", slug: `team-alpha-${crypto.randomUUID()}`, organizationId: orgId },
    headers: new Headers({ cookie: ownerCookie }),
  });
  expect(team).toBeTruthy();
  return { orgId, teamId: (team as TeamRow).id! };
}

function plantArchived(db: Record<string, unknown[]>, organizationId: string) {
  const row = (db.organization as OrgRow[]).find((o) => o.id === organizationId);
  expect(row).toBeTruthy();
  row!.archivedAt = new Date("2026-07-01T00:00:00Z");
}

function unplantArchived(db: Record<string, unknown[]>, organizationId: string) {
  const row = (db.organization as OrgRow[]).find((o) => o.id === organizationId);
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

describe("dual-transport coverage (cinatra#1943 A5, row 13) — one shared archived-state source, both transports attacked together", () => {
  let db: Record<string, unknown[]>;
  let auth: ReturnType<typeof makeAuth>;
  let ownerUserId: string;
  let ownerCookie: string;
  let orgId: string;
  let teamId: string;

  beforeEach(async () => {
    db = makeDb();
    auth = makeAuth(db, sharedReadArchivedAt(db));
    const owner = await seedUserWithSession(auth, "owner");
    ownerUserId = owner.userId;
    ownerCookie = owner.cookie;
    const seeded = await seedOrgWithTeam(auth, ownerUserId, ownerCookie);
    orgId = seeded.orgId;
    teamId = seeded.teamId;
  });

  it("ONE shared archive flip refuses ALL THREE surfaces for the identical org — in-process BA, raw-HTTP BA, and the app-native guard", async () => {
    plantArchived(db, orgId);

    // Transport 1a — Better Auth's own endpoint dispatch pipeline, in-process.
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });

    // Transport 1b — the SAME pipeline, raw HTTP.
    const res = await rawPost(auth, "/organization/set-active", { organizationId: orgId }, ownerCookie);
    expect(res.status).toBe(403);

    // Transport 2 — the APP-NATIVE writer path member-actions.ts calls
    // directly, entirely outside Better Auth's dispatch pipeline. Same org,
    // read through the SAME shared store row the two BA-transport calls
    // above just observed as archived.
    await expect(
      assertTargetOrgNotArchived(orgId, sharedReadArchivedAt(db)),
    ).rejects.toBeInstanceOf(OrganizationArchivedError);
  });

  it("positive control: an ACTIVE org allows all three surfaces — neither transport is hard-coded to always-refuse", async () => {
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).resolves.toBeTruthy();

    const res = await rawPost(auth, "/organization/set-active", { organizationId: orgId }, ownerCookie);
    expect(res.status).toBe(200);

    await expect(
      assertTargetOrgNotArchived(orgId, sharedReadArchivedAt(db)),
    ).resolves.toBeUndefined();
  });

  it("round trip: archive then unarchive the SAME store row keeps all three surfaces in lockstep — no transport-local cache lags behind", async () => {
    plantArchived(db, orgId);
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    const archivedRes = await rawPost(auth, "/organization/set-active", { organizationId: orgId }, ownerCookie);
    expect(archivedRes.status).toBe(403);
    await expect(
      assertTargetOrgNotArchived(orgId, sharedReadArchivedAt(db)),
    ).rejects.toBeInstanceOf(OrganizationArchivedError);

    // ONE write to the shared store — not a per-transport re-seed.
    unplantArchived(db, orgId);

    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: ownerCookie }),
      }),
    ).resolves.toBeTruthy();
    const activeRes = await rawPost(auth, "/organization/set-active", { organizationId: orgId }, ownerCookie);
    expect(activeRes.status).toBe(200);
    await expect(
      assertTargetOrgNotArchived(orgId, sharedReadArchivedAt(db)),
    ).resolves.toBeUndefined();
  });

  it("SPOOF PIN carries across the seam: add-team-member with a planted ACTIVE organizationId still refuses on the BA transport (target = the team's org), and the app-native guard checked against the TEAM's real org agrees", async () => {
    plantArchived(db, orgId);
    // A second, ACTIVE org an attacker points the checker at.
    const activeOwner = await seedUserWithSession(auth, "active-owner");
    const activeOrg = await auth.api.createOrganization({
      body: { name: "Active Co", slug: `active-${crypto.randomUUID()}`, userId: activeOwner.userId },
    });
    const res = await rawPost(
      auth,
      "/organization/add-team-member",
      // teamId belongs to the ARCHIVED org; organizationId names the ACTIVE
      // one. The dispatch policy must resolve via the team, not the
      // caller-supplied organizationId, and refuse.
      { teamId, userId: "user-that-need-not-exist", organizationId: activeOrg!.id },
      ownerCookie,
    );
    expect(res.status).toBe(403);

    // The app-native guard has no target-resolution logic of its own (see
    // module doc) — its anti-spoof property rests entirely on the CALLER
    // resolving the org id server-side from the team row, never from client
    // input (exactly what `assertTeamMemberAuthority` in member-actions.ts
    // does: `team.organizationId` from its own `SELECT ... FROM team WHERE
    // id = teamId`, never a client-supplied organizationId parameter). This
    // pins that the team's REAL org — not the spoofed active one — is what
    // must be checked, and that checking it agrees with the BA transport's
    // own (structurally different) resolution above.
    await expect(
      assertTargetOrgNotArchived(orgId, sharedReadArchivedAt(db)),
    ).rejects.toBeInstanceOf(OrganizationArchivedError);
    await expect(
      assertTargetOrgNotArchived(activeOrg!.id, sharedReadArchivedAt(db)),
    ).resolves.toBeUndefined();
  });
});

describe("dual-transport coverage (cinatra#1943 A5, row 13) — the asymmetric read-error polarity is an INTENTIONAL divergence, not a gap", () => {
  // A forced `readArchivedAt` failure shared by both transports — this is
  // the case the two modules' own docs claim they handle DIFFERENTLY:
  // organization-dispatch-policy.ts's dispatch hook uses a per-endpoint
  // SPLIT polarity (prohibited endpoints fail CLOSED, cleanup endpoints fail
  // OPEN), while organization-archive-guard.ts's assertTargetOrgNotArchived
  // is UNCONDITIONALLY fail-CLOSED — "these are raw app-native writes with
  // NO kernel/DB backstop at all... so 'can't verify archived state' must
  // mean REFUSE, not proceed" (module doc). This suite proves that
  // divergence is real and lands exactly where each module's own doc claims
  // it does, from the SAME failing reader — not an accidental split nobody
  // meant to introduce.
  const throwingReadArchivedAt = async (_organizationId: string): Promise<never> => {
    throw new Error("simulated archivedAt read failure");
  };

  it("a shared read failure fails the PROHIBITED-class action closed on BOTH transports", async () => {
    const db = makeDb();
    const auth = makeAuth(db, throwingReadArchivedAt);
    const owner = await seedUserWithSession(auth, "owner");
    const orgId = await seedOrg(auth, owner.userId);
    // Org is NOT planted archived — the read itself fails regardless of the
    // underlying row, exactly the scenario the SPLIT polarity exists for.
    await expect(
      auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: owner.cookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });

    await expect(
      assertTargetOrgNotArchived(orgId, throwingReadArchivedAt),
    ).rejects.toThrow(/could not verify archived state/i);
  });

  it("the SAME shared read failure fails OPEN on the BA transport's CLEANUP class, but the app-native guard has no cleanup carve-out and always refuses — the intentional asymmetry, pinned", async () => {
    const db = makeDb();
    const auth = makeAuth(db, throwingReadArchivedAt);
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

    // BA transport, CLEANUP class: a user must never be trapped in an
    // archived org by a transient read failure — fails OPEN.
    await expect(
      auth.api.leaveOrganization({
        body: { organizationId: orgId },
        headers: new Headers({ cookie: member.cookie }),
      }),
    ).resolves.toBeTruthy();

    // The APP-NATIVE guard has NO cleanup/exit concept at all — every call
    // site is a management mutation (add/remove/update-role), so a read
    // failure through the identical broken reader always refuses. This is
    // not a bug the BA transport happens to paper over: it is why the guard
    // module doc calls its posture "fail-closed on read error" with no split,
    // unlike the dispatch hook. A future app-native call site must not
    // assume this guard grants the same fail-open escape hatch BA's cleanup
    // class does.
    await expect(
      assertTargetOrgNotArchived(orgId, throwingReadArchivedAt),
    ).rejects.toThrow(/could not verify archived state/i);
  });
});
