/**
 * THE PER-SCOPE LIST FIXTURES, AT THE LOADER (cinatra#3529, the S2 leftovers of
 * cinatra#2808).
 *
 * #2808 names the fixture set: "five scopes; multi-org workspace union;
 * admin-only visibility both ways; hidden bindings absent; exact-project
 * installs present; viewed-org != active-org correct". The pure core's own suite
 * (`scope-surface-eligibility.test.ts`) drives `resolveScopeSurfaceEligibility`
 * with a hand-written actor arm and an anchor it builds itself. This suite
 * asserts what the SERVER LOADER returns instead: the rows
 * `readScopeSurfaceAgentRows` hands a scope's Agents tab, with the anchor
 * resolved from the session and the membership reads, the policy snapshot read
 * from the permissions store, and BOTH arms the platform's own:
 * `evaluateExtensionAccess` for the actor and `policyFieldAdmitsScopeVantage`
 * for the scope.
 *
 * Only the reads are fixtures: the session, the membership and project readers,
 * the template and install stores, the permissions store and the assistants
 * directory. Every decision below is taken by production code.
 *
 * THE FIXTURE WORLD. One reader is a member of two organizations, A and B, with
 * a team and projects in each; the session's active organization is A. Each
 * install exists to be present on some scopes and absent on others, so every
 * scope is told apart from the rest by at least one row:
 *
 *   org-a-wide        A, organization row, no stored policy (the default).
 *   org-b-wide        B, organization row, no stored policy.
 *   team-a-only       A, team row, audience `team:<team-a>`.
 *   project-a1-only   A, organization row, audience `project:<proj-a1>`: the
 *                     policy the install-target contract persists for a
 *                     project install (`accessTargetToInstallPolicy`).
 *   platform-wide     org-NULL workspace row, audience `workspace`.
 *   project-b-platform  org-NULL workspace row, audience `project:<proj-b>`.
 *   admin-only        org-NULL workspace row, audience `admin`: the anchor and
 *                     policy the install-target contract writes for "admin".
 *   org-a-admin       A, organization row, audience `admin`.
 *   bound-platform    org-NULL workspace row, audience `workspace`, bound to
 *                     proj-a1 by a VISIBLE project binding.
 *   hidden-platform   org-NULL workspace row, audience `workspace`, bound to
 *                     proj-a1 by a HIDDEN project binding.
 *   archived-a        A, archived: never listed anywhere.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  resolveActorGrantsForUserInOrg: vi.fn(),
  readOrgsWithTeamsForUserActiveOnly: vi.fn(),
  readProjectsForUser: vi.fn(),
  readProjectOrganizationFacts: vi.fn(),
  readProjectAgentTemplateBindings: vi.fn(),
  readInstalledAgentTemplates: vi.fn(),
  listInstalledExtensions: vi.fn(),
  readExtensionAccessPolicies: vi.fn(),
  readExtensionCoOwners: vi.fn(),
  readExtensionInstalledBy: vi.fn(),
  buildAssistantsDirectoryForCurrentActor: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  requireActorContext: mocks.requireActorContext,
  resolveActorGrantsForUserInOrg: mocks.resolveActorGrantsForUserInOrg,
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: mocks.readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser: mocks.readProjectsForUser,
  readProjectOrganizationFacts: mocks.readProjectOrganizationFacts,
  readProjectAgentTemplateBindings: mocks.readProjectAgentTemplateBindings,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: mocks.readInstalledAgentTemplates,
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: mocks.listInstalledExtensions,
}));
// The permissions STORE is a read; the evaluator that consumes it
// (`@cinatra-ai/extensions/enforce-extension-access`) is NOT mocked.
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicies: mocks.readExtensionAccessPolicies,
  readExtensionCoOwners: mocks.readExtensionCoOwners,
  readExtensionInstalledBy: mocks.readExtensionInstalledBy,
  readExtensionAccessPolicy: vi.fn(async () => null),
}));
vi.mock("@/lib/assistants-directory.server", () => ({
  buildAssistantsDirectoryForCurrentActor: mocks.buildAssistantsDirectoryForCurrentActor,
}));

import {
  readScopeSurfaceAgentRows,
  readScopeSurfaceEligibility,
} from "@/lib/scope-surface-eligibility.server";
import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

// ---------------------------------------------------------------------------
// THE WORLD
// ---------------------------------------------------------------------------

const MEMBER = "user-member";
const ORG_ADMIN = "user-org-a-admin";
const PLATFORM_ADMIN = "user-platform-admin";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TEAM_A = "team-a";
const TEAM_B = "team-b";
const PROJECT_A1 = "proj-a1";
const PROJECT_A2 = "proj-a2";
const PROJECT_B = "proj-b";
/** A legacy personal project that carries no organization of its own. */
const PROJECT_LEGACY = "proj-legacy";

/** The `projects` rows the fixture world holds, as the project reader sees them. */
const PROJECT_ROWS = [
  { id: PROJECT_A1, name: "Alpha one", organizationId: ORG_A, ownerLevel: "organization", ownerId: ORG_A },
  // organization_id is nullable on older rows: this one is resolved through
  // its owning team, which belongs to organization A.
  { id: PROJECT_A2, name: "Alpha two", organizationId: null, ownerLevel: "team", ownerId: TEAM_A },
  { id: PROJECT_B, name: "Bravo", organizationId: ORG_B, ownerLevel: "organization", ownerId: ORG_B },
  { id: PROJECT_LEGACY, name: "Legacy", organizationId: null, ownerLevel: "user", ownerId: MEMBER },
] as const;

type Policy = {
  runListVisibility: string[];
  runDataVisibility: string[];
  runExecuteVisibility: string[];
  allowRunSharing: boolean;
};
const audience = (token: string): Policy => ({
  runListVisibility: [token],
  runDataVisibility: [token],
  runExecuteVisibility: [token],
  allowRunSharing: false,
});

type Fixture = {
  readonly slug: string;
  readonly organizationId: string | null;
  readonly ownerLevel: "organization" | "team" | "workspace";
  readonly ownerId: string;
  readonly status?: "active" | "locked" | "archived";
  /** `undefined` = no stored policy row (the platform default applies). */
  readonly policy?: Policy;
  readonly binding?: { projectId: string; visibility: "visible" | "hidden" | "project-private" };
};

const WORKSPACE_OWNER = "__platform__";

const FIXTURES: readonly Fixture[] = [
  { slug: "org-a-wide", organizationId: ORG_A, ownerLevel: "organization", ownerId: ORG_A },
  { slug: "org-b-wide", organizationId: ORG_B, ownerLevel: "organization", ownerId: ORG_B },
  { slug: "team-a-only", organizationId: ORG_A, ownerLevel: "team", ownerId: TEAM_A, policy: audience(`team:${TEAM_A}`) },
  {
    slug: "project-a1-only",
    organizationId: ORG_A,
    ownerLevel: "organization",
    ownerId: ORG_A,
    policy: audience(`project:${PROJECT_A1}`),
  },
  { slug: "platform-wide", organizationId: null, ownerLevel: "workspace", ownerId: WORKSPACE_OWNER, policy: audience("workspace") },
  {
    slug: "project-b-platform",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: WORKSPACE_OWNER,
    policy: audience(`project:${PROJECT_B}`),
  },
  { slug: "admin-only", organizationId: null, ownerLevel: "workspace", ownerId: WORKSPACE_OWNER, policy: audience("admin") },
  { slug: "org-a-admin", organizationId: ORG_A, ownerLevel: "organization", ownerId: ORG_A, policy: audience("admin") },
  {
    slug: "bound-platform",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: WORKSPACE_OWNER,
    policy: audience("workspace"),
    binding: { projectId: PROJECT_A1, visibility: "visible" },
  },
  {
    slug: "hidden-platform",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: WORKSPACE_OWNER,
    policy: audience("workspace"),
    binding: { projectId: PROJECT_A1, visibility: "hidden" },
  },
  { slug: "archived-a", organizationId: ORG_A, ownerLevel: "organization", ownerId: ORG_A, status: "archived" },
];

const pkg = (slug: string) => `@acme/${slug}`;
const templateId = (slug: string) => `tpl-${slug}`;

/** The actor axes each reader holds in each organization, as
 *  `resolveActorGrantsForUserInOrg` returns them. The implicit-ownership source
 *  of the real project-grant reader is a multi-organization union, so every
 *  organization's grants carry every project the reader can see (read). */
const ALL_PROJECT_GRANTS = [PROJECT_A1, PROJECT_A2, PROJECT_B].map((projectId) => ({
  projectId,
  effectiveRole: "read" as const,
  accessSource: "organization" as const,
}));
const GRANTS: Record<string, Record<string, { teamIds: string[]; orgRole?: string }>> = {
  [MEMBER]: {
    [ORG_A]: { teamIds: [TEAM_A], orgRole: "member" },
    [ORG_B]: { teamIds: [TEAM_B], orgRole: "member" },
  },
  [ORG_ADMIN]: {
    [ORG_A]: { teamIds: [TEAM_A], orgRole: "org_admin" },
    [ORG_B]: { teamIds: [TEAM_B], orgRole: "member" },
  },
  [PLATFORM_ADMIN]: {
    [ORG_A]: { teamIds: [TEAM_A], orgRole: "member" },
    [ORG_B]: { teamIds: [TEAM_B], orgRole: "member" },
  },
};

function signIn(userId: string, options: { activeOrg?: string; platformAdmin?: boolean } = {}) {
  const activeOrg = options.activeOrg ?? ORG_A;
  mocks.getAuthSession.mockResolvedValue({
    user: { id: userId, role: options.platformAdmin ? "admin" : "user" },
    session: { activeOrganizationId: activeOrg },
  });
  mocks.requireActorContext.mockResolvedValue({
    principalType: "HumanUser",
    principalId: userId,
    authSource: "ui",
    organizationId: activeOrg,
    platformRole: options.platformAdmin ? "platform_admin" : "member",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn(MEMBER);

  mocks.resolveActorGrantsForUserInOrg.mockImplementation(async (userId: string, orgId: string) => {
    const grants = GRANTS[userId]?.[orgId];
    if (!grants) return { teamIds: [], projectGrants: [] };
    return {
      teamIds: grants.teamIds,
      projectGrants: ALL_PROJECT_GRANTS,
      ...(grants.orgRole ? { orgRole: grants.orgRole } : {}),
    };
  });
  mocks.readOrgsWithTeamsForUserActiveOnly.mockResolvedValue([
    { id: ORG_A, name: "Alpha", teams: [{ id: TEAM_A, name: "Alpha team" }] },
    { id: ORG_B, name: "Bravo", teams: [{ id: TEAM_B, name: "Bravo team" }] },
  ]);
  // THE REAL READER'S CONTRACT: `readProjectsForUser(userId, _orgId)` is a
  // multi-organization union (own + team-owned + org-owned across EVERY
  // organization the reader belongs to). It never reads its organization
  // argument, so it answers the same list whichever organization is passed.
  mocks.readProjectsForUser.mockImplementation(async () =>
    PROJECT_ROWS.map(({ id, name }) => ({ id, name })),
  );
  mocks.readProjectOrganizationFacts.mockImplementation(async (ids: readonly string[]) =>
    PROJECT_ROWS.filter((p) => ids.includes(p.id)).map(({ id, organizationId, ownerLevel, ownerId }) => ({
      id,
      organizationId,
      ownerLevel,
      ownerId,
    })),
  );
  mocks.readProjectAgentTemplateBindings.mockImplementation(async (projectId: string) =>
    FIXTURES.filter((f) => f.binding?.projectId === projectId).map((f) => ({
      agentTemplateId: templateId(f.slug),
      visibility: f.binding!.visibility,
    })),
  );

  mocks.readInstalledAgentTemplates.mockResolvedValue(
    FIXTURES.map((f) => ({
      id: templateId(f.slug),
      name: f.slug,
      description: `${f.slug} description`,
      packageName: pkg(f.slug),
    })),
  );
  mocks.listInstalledExtensions.mockResolvedValue(
    FIXTURES.map((f) => ({
      id: `install-${f.slug}`,
      packageName: pkg(f.slug),
      organizationId: f.organizationId,
      ownerLevel: f.ownerLevel,
      ownerId: f.ownerId,
      status: f.status ?? "active",
      version: "1.0.0",
    })),
  );
  mocks.readExtensionAccessPolicies.mockImplementation(async (_kind: string, ids: string[]) => {
    const out = new Map<string, Policy>();
    for (const f of FIXTURES) {
      if (f.policy && ids.includes(templateId(f.slug))) out.set(templateId(f.slug), f.policy);
    }
    return out;
  });
  mocks.readExtensionCoOwners.mockResolvedValue([]);
  mocks.readExtensionInstalledBy.mockResolvedValue(null);
  mocks.buildAssistantsDirectoryForCurrentActor.mockResolvedValue([]);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The package slugs the Agents tab of `scope` lists, sorted. */
async function listed(scope: ScopeSurfaceRef): Promise<string[]> {
  const rows = await readScopeSurfaceAgentRows(scope);
  return rows.map((r) => r.packageName.replace("@acme/", "")).sort();
}

// ---------------------------------------------------------------------------
// THE FIVE SCOPES, FOR A PLAIN MEMBER
// ---------------------------------------------------------------------------

describe("the five scopes, as the loader lists them for a plain member", () => {
  it("PERSONAL: the reader's invocable set under the active organization, plus the app-wide rows", async () => {
    // Every org-NULL row reaches the personal scope; a binding is a PROJECT
    // fact and plays no part here.
    expect(await listed({ kind: "personal" })).toEqual(
      [
        "bound-platform",
        "hidden-platform",
        "org-a-wide",
        "platform-wide",
        "project-a1-only",
        "project-b-platform",
        "team-a-only",
      ].sort(),
    );
  });

  it("ORGANIZATION: exact-org installs a generic member of the organization reaches", async () => {
    // team-a-only and project-a1-only are org-A rows too, but their audience is
    // a team and a project, and no generic member of the ORGANIZATION reaches
    // them; the app-wide rows are the workspace tier's, not the organization's.
    expect(await listed({ kind: "organization", id: ORG_A })).toEqual(["org-a-wide"]);
  });

  it("TEAM: exact-team plus exact-org", async () => {
    expect(await listed({ kind: "team", id: TEAM_A })).toEqual(["org-a-wide", "team-a-only"]);
  });

  it("PROJECT: EXACT-PROJECT INSTALLS PRESENT, plus exact-org and the visibly bound rows", async () => {
    expect(await listed({ kind: "project", id: PROJECT_A1 })).toEqual(
      ["bound-platform", "org-a-wide", "project-a1-only"].sort(),
    );
  });

  it("PROJECT: another project of the same organization does NOT list proj-a1's install", async () => {
    expect(await listed({ kind: "project", id: PROJECT_A2 })).toEqual(["org-a-wide"]);
  });

  it("WORKSPACE: the multi-organization UNION, every row once", async () => {
    expect(await listed({ kind: "workspace" })).toEqual(
      [
        "bound-platform",
        "hidden-platform",
        "org-a-wide",
        "org-b-wide",
        "platform-wide",
        "project-a1-only",
        "project-b-platform",
        "team-a-only",
      ].sort(),
    );
  });

  it("never lists an archived install on any scope", async () => {
    for (const scope of [
      { kind: "personal" },
      { kind: "organization", id: ORG_A },
      { kind: "team", id: TEAM_A },
      { kind: "project", id: PROJECT_A1 },
      { kind: "workspace" },
    ] as const) {
      expect(await listed(scope)).not.toContain("archived-a");
    }
  });
});

// ---------------------------------------------------------------------------
// THE WORKSPACE UNION KEEPS EACH ORGANIZATION'S OWN ROWS
// ---------------------------------------------------------------------------

describe("the multi-organization workspace union", () => {
  async function executionOrgs(slug: string): Promise<readonly string[] | undefined> {
    const rows = await readScopeSurfaceEligibility({ kind: "workspace" });
    return rows.find((r) => r.packageName === pkg(slug))?.executionOrgIds;
  }

  it("keeps each organization's install under that organization alone", async () => {
    expect(await executionOrgs("org-a-wide")).toEqual([ORG_A]);
    expect(await executionOrgs("org-b-wide")).toEqual([ORG_B]);
  });

  it("admits an app-wide row once, executable in every member organization", async () => {
    expect(await executionOrgs("platform-wide")).toEqual([ORG_A, ORG_B]);
  });

  it("reads a project's vantage under the project's OWN organization only", async () => {
    // proj-b belongs to organization B. The project reader returns it for
    // every organization; judging it under A as well would hand this row an
    // execution organization the project does not belong to.
    expect(await executionOrgs("project-b-platform")).toEqual([ORG_B]);
  });

  it("drops an organization from the union once the membership read no longer returns it", async () => {
    mocks.readOrgsWithTeamsForUserActiveOnly.mockResolvedValue([
      { id: ORG_A, name: "Alpha", teams: [{ id: TEAM_A, name: "Alpha team" }] },
    ]);
    const names = await listed({ kind: "workspace" });
    expect(names).not.toContain("org-b-wide");
    expect(names).not.toContain("project-b-platform");
    expect(names).toContain("org-a-wide");
  });
});

// ---------------------------------------------------------------------------
// ADMIN-ONLY VISIBILITY, BOTH WAYS
// ---------------------------------------------------------------------------

describe("admin-only visibility, both ways", () => {
  const SHARED_SCOPES = [
    { kind: "organization", id: ORG_A },
    { kind: "team", id: TEAM_A },
    { kind: "project", id: PROJECT_A1 },
    { kind: "workspace" },
  ] as const;

  it("a MEMBER never sees an admin-only package, on any scope", async () => {
    for (const scope of [{ kind: "personal" } as const, ...SHARED_SCOPES]) {
      const names = await listed(scope);
      expect(names).not.toContain("admin-only");
      expect(names).not.toContain("org-a-admin");
    }
  });

  it("a PLATFORM ADMINISTRATOR sees both on their personal scope", async () => {
    signIn(PLATFORM_ADMIN, { platformAdmin: true });
    const names = await listed({ kind: "personal" });
    expect(names).toContain("admin-only");
    expect(names).toContain("org-a-admin");
  });

  it("the owning organization's ADMIN sees its own admin-only package, never the app-wide one", async () => {
    // The admin tier is owner-aware: an org admin holds admin standing over
    // their organization's rows, and only a platform administrator holds it
    // over an org-NULL row.
    signIn(ORG_ADMIN);
    const names = await listed({ kind: "personal" });
    expect(names).toContain("org-a-admin");
    expect(names).not.toContain("admin-only");
  });

  it("no shared scope lists an admin-only package, not even to an administrator", async () => {
    // A scope tab lists what a GENERIC member of the scope could reach, and a
    // scope holds no admin standing.
    for (const who of [
      () => signIn(PLATFORM_ADMIN, { platformAdmin: true }),
      () => signIn(ORG_ADMIN),
    ]) {
      who();
      for (const scope of SHARED_SCOPES) {
        const names = await listed(scope);
        expect(names).not.toContain("admin-only");
        expect(names).not.toContain("org-a-admin");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// HIDDEN BINDINGS
// ---------------------------------------------------------------------------

describe("project bindings", () => {
  it("a VISIBLE binding surfaces an app-wide package on the bound project's tab", async () => {
    expect(await listed({ kind: "project", id: PROJECT_A1 })).toContain("bound-platform");
    expect(mocks.readProjectAgentTemplateBindings).toHaveBeenCalledWith(PROJECT_A1);
  });

  it("a project-private binding surfaces it too: only a hidden binding is held back", async () => {
    mocks.readProjectAgentTemplateBindings.mockResolvedValue([
      { agentTemplateId: templateId("bound-platform"), visibility: "project-private" },
    ]);
    expect(await listed({ kind: "project", id: PROJECT_A1 })).toContain("bound-platform");
  });

  it("HIDDEN BINDINGS ABSENT: a hidden binding never surfaces its package", async () => {
    expect(await listed({ kind: "project", id: PROJECT_A1 })).not.toContain("hidden-platform");
  });

  it("a binding reaches only the project it names", async () => {
    expect(await listed({ kind: "project", id: PROJECT_A2 })).not.toContain("bound-platform");
    expect(await listed({ kind: "organization", id: ORG_A })).not.toContain("bound-platform");
  });

  it("a FAILED binding read lists the project's own rows and no bound package", async () => {
    // A binding only ever ADDS a row, so reading none is the narrow answer: the
    // tab keeps its exact-org and exact-project rows instead of going blank.
    mocks.readProjectAgentTemplateBindings.mockRejectedValue(new Error("bindings read down"));
    expect(await listed({ kind: "project", id: PROJECT_A1 })).toEqual(
      ["org-a-wide", "project-a1-only"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// THE VIEWED ORGANIZATION, NOT THE ACTIVE ONE
// ---------------------------------------------------------------------------

describe("the viewed organization differs from the active one", () => {
  it("ORGANIZATION: organization B's tab lists B's rows while the session points at A", async () => {
    expect(await listed({ kind: "organization", id: ORG_B })).toEqual(["org-b-wide"]);
  });

  it("TEAM: a team of organization B lists B's rows while the session points at A", async () => {
    expect(await listed({ kind: "team", id: TEAM_B })).toEqual(["org-b-wide"]);
  });

  it("PROJECT: a project of organization B lists B's rows while the session points at A", async () => {
    // Organization A sorts first, so a project resolved to the first member
    // organization that lists it would read this tab under A.
    expect(await listed({ kind: "project", id: PROJECT_B })).toEqual(["org-b-wide"]);
  });

  it("PROJECT: a project of organization A lists A's rows while the session points at B", async () => {
    signIn(MEMBER, { activeOrg: ORG_B });
    const names = await listed({ kind: "project", id: PROJECT_A1 });
    expect(names).toContain("org-a-wide");
    expect(names).toContain("project-a1-only");
    expect(names).not.toContain("org-b-wide");
  });

  it("PROJECT: a project resolved through its owning team is read under that team's organization", async () => {
    signIn(MEMBER, { activeOrg: ORG_B });
    expect(await listed({ kind: "project", id: PROJECT_A2 })).toEqual(["org-a-wide"]);
  });

  it("each row of the viewed project carries that scope's own Run and Settings addresses", async () => {
    const scope = { kind: "project", id: PROJECT_B } as const;
    const rows = await readScopeSurfaceAgentRows(scope);
    const row = rows.find((r) => r.packageName === pkg("org-b-wide"));
    expect(row?.runHref).toBe(scopeSurfaceAgentLaunchHref(scope, pkg("org-b-wide")));
    expect(row?.settingsHref).toBe(scopeSurfaceAgentSettingsHref(scope, pkg("org-b-wide")));
  });

  it("the personal scope follows the ACTIVE organization, the one place it should", async () => {
    signIn(MEMBER, { activeOrg: ORG_B });
    expect(await listed({ kind: "personal" })).toEqual(
      ["bound-platform", "hidden-platform", "org-b-wide", "platform-wide", "project-b-platform"].sort(),
    );
  });

  it("FAIL CLOSED: a project with no organization of its own is read under none", async () => {
    // Nothing tells which organization's installs belong on it, so the tab
    // lists nothing rather than an arbitrary organization's rows.
    expect(await listed({ kind: "project", id: PROJECT_LEGACY })).toEqual([]);
  });
});
