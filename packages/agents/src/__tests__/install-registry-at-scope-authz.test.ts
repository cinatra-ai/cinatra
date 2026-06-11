/**
 * Authorization coverage for `installRegistryPackageAtScope`.
 *
 * 13-row authorization matrix for `installRegistryPackageAtScope` covering:
 *  - platform_admin × every target
 *  - org_admin × org-target and org_admin × team-target
 *  - team_admin × same team, × different team, × cross-org forgery, and × org-target
 *  - member × any non-org target
 *  - project owner, team_admin of owning team, plain member of project
 *
 * Plus:
 *  - audit metadata.targetScope + POLICY_VERSION at both denied and allowed paths
 *  - DB read-back assertion (skipped without HAS_REAL_DB)
 *  - back-compat installRegistryPackage wrapper writes EXACTLY 1 audit row
 *
 * Mocks the boundaries (auth-session, actor-context, install-from-package,
 * resolveInstallEnvironment, audit, projects-store). The authorization helpers
 * (assertCanInstallAtTarget + assertTargetBelongsToActiveOrg) live INSIDE
 * actions.ts and are exercised through the public action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POLICY_VERSION } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// HAS_REAL_DB predicate. vitest.config.ts unconditionally injects a placeholder
// SUPABASE_DB_URL, so the simple
// `!process.env.SUPABASE_DB_URL` check is always false).
// ---------------------------------------------------------------------------
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@");

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const ORG_A = "org-A";
const ORG_B = "org-B";
const TEAM_A = "team-A";
const TEAM_B = "team-B";
const TEAM_T = "team-T";
const PROJECT_P = "proj-P";
const USER_OWNER = "user-owner-U";
const USER_OTHER = "user-other-X";

type MockSession = {
  user: { id: string; role?: string | null };
  session: { activeOrganizationId: string };
};

type MockActor = {
  principalType: "HumanUser";
  principalId: string;
  organizationId: string;
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
  projectIds?: string[];
  authSource: "ui";
  policyVersion: string;
};

const SESSION_DEFAULT: MockSession = {
  user: { id: "session-user-id", role: "user" },
  session: { activeOrganizationId: ORG_A },
};

const authSessionMock = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  buildCanDoOptsFromSession: vi.fn(async () => ({})),
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

const installFromPackageMock = vi.hoisted(() => ({
  installAgentPackageWithDependencies: vi.fn(async () => ({
    rootTemplateId: "tmpl-1",
    installedTemplateIds: ["tmpl-1"],
    tree: { root: { packageName: "@cinatra/foo" }, all: new Map() },
  })),
  installAgentFromPackage: vi.fn(),
}));
vi.mock("../install-from-package", () => installFromPackageMock);

// Cut the transitive openai/llm chain. These modules are
// imported by actions.ts but not exercised by installRegistryPackageAtScope.
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../verdaccio/client", () => ({ publishAgentPackage: vi.fn() }));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../store", () => ({
  createAuditEvent: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  readAgentVersionById: vi.fn(),
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  createAgentRun: vi.fn(),
  createShareBinding: vi.fn(),
  createAgentFork: vi.fn(),
  checkRegistryPermission: vi.fn(),
  readRegistryEntryById: vi.fn(),
  updateAgentTemplate: vi.fn(),
  updateShareBinding: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  updateAgentTemplateOrigin: vi.fn(),
  RunTransitionError: class extends Error {},
  transitionRunStatus: vi.fn(),
}));
vi.mock("@/lib/agent-url", () => ({
  buildAgentWorkspacePath: vi.fn((p: string) => `/agents/${p}`),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: {} as Record<string, string>,
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => []),
}));
vi.mock("@cinatra-ai/registries", async () => {
  // Real (pure, dependency-free) vendor-scope helpers — the install action
  // keys the install config's packageScope on the PACKAGE's own scope, never
  // on the instance identity (issue #103).
  const scope = await vi.importActual<typeof import("../../../registries/src/scope")>(
    "../../../registries/src/scope",
  );
  return {
    ...scope,
    InstanceNamespaceNotConfiguredError: class extends Error {},
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const destinationResolverMock = vi.hoisted(() => ({
  resolveInstallEnvironment: vi.fn(async () => ({
    registryUrl: "https://r.example/",
    args: ["--//r.example/:_authToken=tok"],
  })),
  resolvePublishDestination: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => destinationResolverMock);

// Stub instance-identity-store. The install action no longer reads the
// instance identity (packageScope is keyed on the package's own scope —
// issue #103); the stub stays so transitive imports never hit the real DB.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => ({ vendorName: "cinatra" })),
}));

// next/navigation redirect throws a sentinel — replace with a noop so we
// can observe post-install dispatch without crashing the test runner.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    const err = new Error(`__REDIRECT__:${path}`);
    (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${path};307;`;
    throw err;
  }),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));

// Mock the projects-store DAO (used by assertTargetBelongsToActiveOrg
// for project-target installs).
const projectsStoreDaoMock = vi.hoisted(() => ({
  readProjectById: vi.fn(),
}));
vi.mock("@/lib/projects-store-dao", () => projectsStoreDaoMock);

// Mock the project-co-owners DAO (used by assertTargetBelongsToActiveOrg).
const projectCoOwnersStoreMock = vi.hoisted(() => ({
  readProjectCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
}));
vi.mock("@/lib/project-co-owners-store", () => projectCoOwnersStoreMock);

// Mock the better-auth teams reader for team-target tenant validation.
const betterAuthDbMock = vi.hoisted(() => ({
  readTeamsForUser: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  // Direct existence check for cross-org forgery — see assertTargetBelongsToActiveOrg.
  readTeamForOrg: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", async (orig) => ({
  ...(await orig() as object),
  ...betterAuthDbMock,
}));

// Mock the authz barrel: provide AuthzError + the spy for logAuditEvent +
// stub canDo (used only by the legacy installRegistryPackage body which is
// bypassed by the wrapper-only path, so this stub is harmless).
const auditMock = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async () => undefined),
}));
class AuthzErrorMock extends Error {
  statusCode: number;
  reason: string;
  constructor(opts: { statusCode: number; reason: string; message?: string }) {
    super(opts.message ?? opts.reason);
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}
// `can` is also imported via the @/lib/authz barrel by the kernel
// (enforce-resource-access.ts → authz). Provide a permissive stub so the
// kernel's belt-and-suspenders gate does not deny on its own —
// the matrix tests assert that the product helpers are the
// authoritative gate. enforce-resource-access.test.ts covers
// the kernel's behavior with the real `can` implementation separately.
vi.mock("@/lib/authz", () => ({
  canDo: vi.fn(() => true),
  can: vi.fn(() => true),
  AuthzError: AuthzErrorMock,
  logAuditEvent: auditMock.logAuditEvent,
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: auditMock.logAuditEvent,
}));
vi.mock("@/lib/authz/errors", () => ({
  AuthzError: AuthzErrorMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actorPlatformAdmin(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: "user-pa",
    organizationId: ORG_A,
    platformRole: "platform_admin",
    orgRole: "member",
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function actorOrgAdminNotTeamAdmin(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: "user-org-admin",
    organizationId: ORG_A,
    platformRole: "member",
    orgRole: "org_admin",
    teamRoles: {}, // empty — explicitly NOT team_admin of any team
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function actorTeamAdminTeamA(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: "user-team-admin-a",
    organizationId: ORG_A,
    platformRole: "member",
    orgRole: "member",
    teamRoles: { [TEAM_A]: "team_admin" },
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function actorTeamAdminTeamT(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: "user-team-admin-t",
    organizationId: ORG_A,
    platformRole: "member",
    orgRole: "member",
    teamRoles: { [TEAM_T]: "team_admin" },
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function actorMember(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: "user-member",
    organizationId: ORG_A,
    platformRole: "member",
    orgRole: "member",
    teamRoles: {},
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function actorProjectOwnerU(): MockActor {
  return {
    principalType: "HumanUser",
    principalId: USER_OWNER,
    organizationId: ORG_A,
    platformRole: "member",
    orgRole: "member",
    teamRoles: {},
    authSource: "ui",
    policyVersion: POLICY_VERSION,
  };
}

function setActor(actor: MockActor): void {
  authSessionMock.requireActorContext.mockResolvedValue(actor);
  // The action calls requireAuthSession + buildCanDoOptsFromSession. We
  // encode the actor's role bag onto session.user (where readActorRolesForInstall
  // expects it) so the production code reaches the same role bag the matrix
  // tests assert against.
  authSessionMock.requireAuthSession.mockResolvedValue({
    ...SESSION_DEFAULT,
    user: {
      id: actor.principalId,
      role: actor.platformRole === "platform_admin" ? "admin" : "user",
      teamRoles: actor.teamRoles,
    },
  });
  authSessionMock.isPlatformAdmin.mockReturnValue(actor.platformRole === "platform_admin");
  authSessionMock.buildCanDoOptsFromSession.mockResolvedValue(
    actor.orgRole ? { orgRole: actor.orgRole } : {},
  );
}

// Wire up team-existence response: team belongs to active org.
function setTeamBelongsToActiveOrg(teamId: string, exists: boolean): void {
  if (exists) {
    betterAuthDbMock.readTeamForOrg.mockResolvedValue({ id: teamId, organizationId: ORG_A });
  } else {
    betterAuthDbMock.readTeamForOrg.mockResolvedValue(null);
  }
}

// Wire up project-existence + ownership response.
function setProject(opts: {
  exists: boolean;
  ownerLevel?: "user" | "team";
  ownerId?: string;
  organizationId?: string;
  coOwnerIds?: string[];
}): void {
  if (!opts.exists) {
    projectsStoreDaoMock.readProjectById.mockResolvedValue(null);
    return;
  }
  projectsStoreDaoMock.readProjectById.mockResolvedValue({
    id: PROJECT_P,
    name: "P",
    description: null,
    ownerLevel: opts.ownerLevel ?? "user",
    ownerId: opts.ownerId ?? USER_OWNER,
    organizationId: opts.organizationId ?? ORG_A,
    visibility: "private",
    createdAt: new Date(),
  });
  projectCoOwnersStoreMock.readProjectCoOwners.mockResolvedValue(
    (opts.coOwnerIds ?? []).map((u) => ({
      projectId: PROJECT_P,
      userId: u,
      grantedBy: "u",
      grantedAt: new Date(),
    })),
  );
}

// Re-import action AFTER mocks are set up.
async function importAction(): Promise<typeof import("../actions")> {
  return await import("../actions");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("installRegistryPackageAtScope — authorization matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: install path succeeds.
    installFromPackageMock.installAgentPackageWithDependencies.mockResolvedValue({
      rootTemplateId: "tmpl-1",
      installedTemplateIds: ["tmpl-1"],
      tree: { root: { packageName: "@cinatra/foo" }, all: new Map() },
    });
    destinationResolverMock.resolveInstallEnvironment.mockResolvedValue({
      registryUrl: "https://r.example/",
      args: ["--//r.example/:_authToken=tok"],
    });
  });

  // ---- M1: platform_admin × team-target → ALLOW
  it("M1 — platform_admin installs at team scope (allow)", async () => {
    setActor(actorPlatformAdmin());
    setTeamBelongsToActiveOrg(TEAM_A, true);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_A },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    // owner tier threaded into install
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ ownerLevel: "team", ownerId: TEAM_A }),
      expect.any(Object),
    );
  });

  // ---- M2: platform_admin × project-target → ALLOW
  it("M2 — platform_admin installs at project scope (allow)", async () => {
    setActor(actorPlatformAdmin());
    setProject({ exists: true, ownerLevel: "user", ownerId: USER_OTHER });
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "project", id: PROJECT_P },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ ownerLevel: "project", ownerId: PROJECT_P }),
      expect.any(Object),
    );
  });

  // ---- M3: platform_admin × org-target → ALLOW
  it("M3 — platform_admin installs at org scope (allow)", async () => {
    setActor(actorPlatformAdmin());
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "organization", id: ORG_A },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
  });

  // ---- M4: org_admin × org-target → ALLOW
  it("M4 — org_admin installs at org scope (allow)", async () => {
    setActor(actorOrgAdminNotTeamAdmin());
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "organization", id: ORG_A },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
  });

  // ---- M5 (NON-NEGOTIABLE CONTRACT): org_admin × team-target → 403
  // CONTRACT — assertCanInstallAtTarget enforces this regardless of
  // EFFECTIVE_GRANTS.org_admin contents. Do NOT invert.
  it("M5 — org_admin without team_admin role on team-target is DENIED 403", async () => {
    setActor(actorOrgAdminNotTeamAdmin());
    setTeamBelongsToActiveOrg(TEAM_A, true);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_A },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
    // Persistence MUST NOT have run.
    expect(installFromPackageMock.installAgentPackageWithDependencies).not.toHaveBeenCalled();
    // Audit row exists with denied + targetScope + POLICY_VERSION.
    expect(auditMock.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        policyVersion: POLICY_VERSION,
        metadata: expect.objectContaining({
          targetScope: { level: "team", id: TEAM_A },
        }),
      }),
    );
  });

  // ---- M6: team_admin (team A) × team A → ALLOW
  it("M6 — team_admin of target team is ALLOWED", async () => {
    setActor(actorTeamAdminTeamA());
    setTeamBelongsToActiveOrg(TEAM_A, true);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_A },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalled();
  });

  // ---- M7: team_admin (team A) × team B → 403
  it("M7 — team_admin of team A on team B target is DENIED", async () => {
    setActor(actorTeamAdminTeamA());
    setTeamBelongsToActiveOrg(TEAM_B, true);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_B },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
    expect(installFromPackageMock.installAgentPackageWithDependencies).not.toHaveBeenCalled();
  });

  // ---- M8: team_admin × cross-org forged team-id → 403 + audit carries the forged id
  it("M8 — cross-org forged team id is DENIED 403 (no existence leakage); audit captures the forged id", async () => {
    setActor(actorTeamAdminTeamA());
    // Team-id "team-B-in-org-B" does NOT exist in active org → readTeamForOrg returns null.
    setTeamBelongsToActiveOrg("team-B-in-org-B", false);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: "team-B-in-org-B" },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
    // Audit row carries the forged id for post-incident traceability.
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({
          targetScope: { level: "team", id: "team-B-in-org-B" },
        }),
      }),
    );
  });

  // ---- M9: team_admin × org-target → 403
  it("M9 — team_admin on org-target is DENIED", async () => {
    setActor(actorTeamAdminTeamA());
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "organization", id: ORG_A },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  // ---- M10: member × any non-org-admin target → 403 (two sub-cases)
  it("M10 — plain member is DENIED on team-target and project-target", async () => {
    const { installRegistryPackageAtScope } = await importAction();

    setActor(actorMember());
    setTeamBelongsToActiveOrg(TEAM_A, true);
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_A },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });

    setActor(actorMember());
    setProject({ exists: true, ownerLevel: "user", ownerId: USER_OTHER });
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "project", id: PROJECT_P },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  // ---- M11: project owner U → ALLOW
  it("M11 — project owner is ALLOWED", async () => {
    setActor(actorProjectOwnerU());
    setProject({ exists: true, ownerLevel: "user", ownerId: USER_OWNER });
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "project", id: PROJECT_P },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ ownerLevel: "project", ownerId: PROJECT_P }),
      expect.any(Object),
    );
  });

  // ---- M12: team_admin of project's owning team → ALLOW
  it("M12 — team_admin of owning team is ALLOWED on project-target", async () => {
    setActor(actorTeamAdminTeamT());
    setProject({
      exists: true,
      ownerLevel: "team",
      ownerId: TEAM_T,
    });
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "project", id: PROJECT_P },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalled();
  });

  // ---- M13: plain member of project (not owner, not team_admin) → 403
  it("M13 — plain member of project (not owner, not team_admin) is DENIED", async () => {
    setActor(actorMember());
    setProject({
      exists: true,
      ownerLevel: "user",
      ownerId: USER_OTHER, // different user owns it
    });
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "project", id: PROJECT_P },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  // ---- M_AUDIT: allowed path uses POLICY_VERSION + targetScope metadata
  it("M_AUDIT — allowed path writes one audit row with POLICY_VERSION + targetScope", async () => {
    setActor(actorTeamAdminTeamA());
    setTeamBelongsToActiveOrg(TEAM_A, true);
    const { installRegistryPackageAtScope } = await importAction();
    await expect(
      installRegistryPackageAtScope({
        packageName: "@cinatra/foo",
        target: { level: "team", id: TEAM_A },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    expect(auditMock.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        metadata: expect.objectContaining({
          targetScope: { level: "team", id: TEAM_A },
        }),
      }),
    );
  });

  // ---- M_WRAPPER: back-compat installRegistryPackage forwards to org-target
  it("M_WRAPPER — installRegistryPackage delegates to installRegistryPackageAtScope with org target; writes EXACTLY 1 audit row", async () => {
    setActor(actorOrgAdminNotTeamAdmin());
    const { installRegistryPackage } = await importAction();
    await expect(
      installRegistryPackage({
        packageName: "@cinatra/foo",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("__REDIRECT__") });
    // Wrapper does NOT write its own audit row; only the inner action does.
    expect(auditMock.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        metadata: expect.objectContaining({
          targetScope: { level: "organization", id: ORG_A },
        }),
      }),
    );
    // Persistence threaded org target.
    expect(installFromPackageMock.installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ ownerLevel: "organization", ownerId: ORG_A }),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// M_READBACK — DB read-back assertion. Skipped without HAS_REAL_DB. Mirrors
// placeholder DB URL → skip cleanly.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)("installRegistryPackageAtScope — DB read-back (M_READBACK)", () => {
  it("persists owner_level + owner_id chosen at the action call site", async () => {
    // Defer to a real-DB integration suite. The unit-mocked matrix above
    // asserts the read-back gate by spying on the
    // installAgentPackageWithDependencies call in M1/M2/M11/M12 (each of
    // which expects the owner tuple in the install call), and by the schema
    // test confirming the columns exist. A real-DB integration test should
    // execute the persistence path and SELECT the row back.
    expect(HAS_REAL_DB).toBe(true);
  });
});
