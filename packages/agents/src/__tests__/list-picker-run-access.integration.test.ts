/**
 * The list picker's loader, authorized by the RUN's access (cinatra#3050).
 *
 * Against a REAL Postgres, with the REAL authorization kernel and the REAL
 * `enforceRunAccess` policy path — only the session seam and the CRM capability
 * are stubbed, so what these tests exercise is the actual access decision, not
 * a mock of it.
 *
 * The defect: `fetchAvailableLists()` opened with `requireAdminSession()`, which
 * REDIRECTS a caller without the `admin` role to `/not-authorized`. The
 * ordinary, non-administrator owner of a run was therefore thrown off their own
 * run the moment it reached the step this loader feeds. The run is the
 * authority now.
 *
 * Pinned here:
 *   - the run's NON-ADMINISTRATOR owner reaches the lists for their own run;
 *   - a member of ANOTHER organisation is refused with the hidden reading, and
 *     no CRM capability is resolved or called on the way out;
 *   - a member of the run's OWN organisation who is not its owner is refused
 *     with the forbidden reading, and no CRM capability either;
 *   - a platform administrator is unchanged — still admitted;
 *   - an unknown run id is refused with the hidden-run absence.
 *
 * Each refusal is pinned to ONE exact (statusCode, reason) pair, never to a set
 * of acceptable pairs, because the two pairs mean different things and are
 * produced by different tiers: a caller outside the run's organisation is
 * denied the run.read permission by the kernel, and enforceResourceAccess
 * downgrades every *.read denial to 404/hidden so run ids cannot be enumerated;
 * a caller inside the run's organisation passes the kernel and is refused one
 * tier later by the run's own effective policy — owner-only by default — with
 * 403/forbidden. A test that accepted either pair could not tell a leak of
 * existence from a policy denial.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// The session seam. `caller` is swapped per test; `requireAdminSession` throws
// so a regression back to the platform-admin gate fails loudly here.
// ---------------------------------------------------------------------------
type Caller = { userId: string; orgId: string; role: string };

const { callerRef, requireAdminSessionMock } = vi.hoisted(() => ({
  callerRef: { current: { userId: "u", orgId: "o", role: "user" } as Caller },
  requireAdminSessionMock: vi.fn(async () => {
    throw new Error(
      "requireAdminSession must not gate the list picker's loader (cinatra#3050)",
    );
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: requireAdminSessionMock,
  requireAuthSession: async () => ({
    user: {
      id: callerRef.current.userId,
      email: `${callerRef.current.userId}@example.com`,
      role: callerRef.current.role,
    },
    session: { activeOrganizationId: callerRef.current.orgId },
  }),
  requireActorContext: async () => ({
    principalId: callerRef.current.userId,
    organizationId: callerRef.current.orgId,
    orgRole: "member" as const,
    platformRole:
      callerRef.current.role === "admin"
        ? ("platform_admin" as const)
        : ("member" as const),
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
  }),
  // Consumed by auth-policy itself.
  getAuthSession: async () => null,
  isPlatformAdmin: () => callerRef.current.role === "admin",
  resolveOrgRoleForUser: async () => "member" as const,
}));

const { searchListsMock, resolveCrmListReaderMock } = vi.hoisted(() => ({
  searchListsMock: vi.fn(async () => [
    { id: "v1", slug: "leaders", name: "Leaders", objectType: "contact" as const },
  ]),
  resolveCrmListReaderMock: vi.fn(),
}));
vi.mock("@/lib/crm-integration-providers", () => ({
  resolveCrmListReader: resolveCrmListReaderMock,
}));

const RUN_ORG_ID = "org-3050-run";
const OTHER_ORG_ID = "org-3050-other";

// The DB-less skip guard: vitest injects a well-known placeholder connection
// string when no real database is configured, and it is recognised by its
// "unused:unused" credential pair.
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" && dbUrl.length > 0 && !dbUrl.includes("unused:unused");

// The run-creation guard reads the org's lifecycle from `public."organization"`.
const AUTH = { orgId: RUN_ORG_ID, can: () => true };

// Real principals, because the run-creation scope guard RE-RESOLVES every human
// principal live from the membership rows rather than believing the caller.
const OWNER_ID = "u-3050-owner";       // non-administrator, member of the run's org
const ADMIN_ID = "u-3050-admin";       // platform administrator
const OUTSIDER_ID = "u-3050-outsider"; // member of a DIFFERENT organisation
const MEMBER_ID = "u-3050-member";     // member of the run's OWN org, not the owner

beforeAll(async () => {
  if (!hasDb) return;
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  for (const [id, name] of [
    [RUN_ORG_ID, "Run Org"],
    [OTHER_ORG_ID, "Other Org"],
  ]) {
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [id, name, id],
    );
  }
  for (const [id, role] of [
    [OWNER_ID, null],
    [ADMIN_ID, "admin"],
    [OUTSIDER_ID, null],
    [MEMBER_ID, null],
  ] as Array<[string, string | null]>) {
    await c.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", role) VALUES ($1, $1, $2, true, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@example.com`, role],
    );
  }
  for (const [userId, orgId] of [
    [OWNER_ID, RUN_ORG_ID],
    [ADMIN_ID, RUN_ORG_ID],
    [OUTSIDER_ID, OTHER_ORG_ID],
    [MEMBER_ID, RUN_ORG_ID],
  ]) {
    await c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
      [`m-${userId}-${orgId}`, orgId, userId],
    );
  }
  await c.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveCrmListReaderMock.mockImplementation(() => ({ searchLists: searchListsMock }));
  searchListsMock.mockResolvedValue([
    { id: "v1", slug: "leaders", name: "Leaders", objectType: "contact" as const },
  ]);
});

/**
 * Create an organisation-scoped template and a run OWNED by `ownerUserId`
 * inside the run's org — the shape the email outreach agent's runs actually
 * take. `orgId` alone stamps the determinate organisation install scope.
 */
async function seedRun(ownerUserId: string): Promise<string> {
  const { createAgentTemplate, createAgentRun } = await import("../store");
  const templateId = `t_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: "list-picker-run-access",
    sourceNl: "x",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    orgId: RUN_ORG_ID,
    creatorId: ownerUserId,
  });
  const runId = `r_${randomUUID()}`;
  await createAgentRun(
    { id: runId, templateId, inputParams: {}, runBy: ownerUserId, orgId: RUN_ORG_ID },
    AUTH,
  );
  return runId;
}

describe.skipIf(!hasDb)("fetchAvailableLists — authorized by the run's access", () => {
  it("the run's NON-ADMINISTRATOR owner reaches the lists for their own run", async () => {
    const runId = await seedRun(OWNER_ID);
    callerRef.current = { userId: OWNER_ID, orgId: RUN_ORG_ID, role: "user" };

    const { fetchAvailableLists } = await import("../list-picker-actions");
    const lists = await fetchAvailableLists(runId);

    expect(lists).toEqual([
      {
        id: "v1",
        name: "Leaders",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    expect(requireAdminSessionMock).not.toHaveBeenCalled();
    // LIST SCOPE UNCHANGED — the same single call the admin-gated loader made.
    expect(searchListsMock).toHaveBeenCalledTimes(1);
    expect(searchListsMock).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });

  it("a member of ANOTHER organisation is refused with the hidden-run absence — no CRM capability resolved", async () => {
    const runId = await seedRun(OWNER_ID);
    callerRef.current = { userId: OUTSIDER_ID, orgId: OTHER_ORG_ID, role: "user" };

    const { fetchAvailableLists } = await import("../list-picker-actions");
    // EXACTLY the hidden reading, not \"one of the refusal shapes\": the caller
    // is outside the run's organisation, so the kernel cross-organisation guard
    // denies the run.read permission, and enforceResourceAccess downgrades every
    // *.read denial to 404/hidden so a probing caller cannot learn which run ids
    // exist. Pinning the pair is what makes this test able to catch a regression
    // that leaked existence as a 403.
    await expect(fetchAvailableLists(runId)).rejects.toMatchObject({
      statusCode: 404,
      reason: "hidden",
    });
    expect(resolveCrmListReaderMock).not.toHaveBeenCalled();
    expect(searchListsMock).not.toHaveBeenCalled();
  });

  it("a member of the run's OWN organisation who is not its owner is refused with the forbidden reading — no CRM capability resolved", async () => {
    const runId = await seedRun(OWNER_ID);
    callerRef.current = { userId: MEMBER_ID, orgId: RUN_ORG_ID, role: "user" };

    const { fetchAvailableLists } = await import("../list-picker-actions");
    // The OTHER exact reading, and the one that distinguishes the two: this
    // caller shares the run's organisation, so the kernel allows run.read and
    // the run's own effective policy — the owner-only default — is what
    // refuses, at the policy tier, with 403/forbidden. Hidden and forbidden are
    // therefore both real on this road and each is pinned to the case that
    // produces it.
    await expect(fetchAvailableLists(runId)).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
    expect(resolveCrmListReaderMock).not.toHaveBeenCalled();
    expect(searchListsMock).not.toHaveBeenCalled();
  });

  it("a platform administrator is unchanged — still admitted", async () => {
    const runId = await seedRun(OWNER_ID);
    callerRef.current = { userId: ADMIN_ID, orgId: RUN_ORG_ID, role: "admin" };

    const { fetchAvailableLists } = await import("../list-picker-actions");
    const lists = await fetchAvailableLists(runId);

    expect(lists).toHaveLength(1);
    expect(searchListsMock).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });

  it("an unknown run id is refused with the hidden-run absence — no CRM capability resolved", async () => {
    callerRef.current = { userId: OWNER_ID, orgId: RUN_ORG_ID, role: "user" };

    const { fetchAvailableLists } = await import("../list-picker-actions");
    await expect(fetchAvailableLists(`r_${randomUUID()}`)).rejects.toMatchObject({
      statusCode: 404,
      reason: "hidden",
    });
    expect(resolveCrmListReaderMock).not.toHaveBeenCalled();
    expect(searchListsMock).not.toHaveBeenCalled();
  });
});
