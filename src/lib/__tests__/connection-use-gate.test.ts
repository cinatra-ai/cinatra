// Per-connection use-gate contract tests (cinatra#952 W2). Mirrors the
// enforce-extension-access suite style: the REAL evaluator + REAL gate logic
// run over mocked stores (permissions-store / canonical-store) and a mocked
// audit sink, so every codex-converged binding requirement is pinned:
//   • explicit OWNER_DEFAULT fallback (the WORKSPACE module default must
//     NEVER engage for connections),
//   • non-human subject own-match (runAsUserId),
//   • the only-clamp ceiling over ALL grant material (visibility, co-owner /
//     installer person-grants, the platform_admin bypass),
//   • deny audited (durable + cooldown-aware) BEFORE the throw,
//   • no tokens in audit metadata.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const readExtensionAccessPolicy = vi.fn();
const readExtensionCoOwners = vi.fn();
const readExtensionInstalledBy = vi.fn();
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicy: (...a: unknown[]) => readExtensionAccessPolicy(...a),
  readExtensionCoOwners: (...a: unknown[]) => readExtensionCoOwners(...a),
  readExtensionInstalledBy: (...a: unknown[]) => readExtensionInstalledBy(...a),
}));

const readInstalledExtensionsByPackageName = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...a),
}));

const logAuditEvent = vi.fn(async (_input: Record<string, unknown>) => {});
const logDeniedAuditEventStrictWithCooldown = vi.fn(async (_input: Record<string, unknown>) => ({ id: "audit-1" }));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: (input: Record<string, unknown>) => logAuditEvent(input),
  logDeniedAuditEventStrictWithCooldown: (input: Record<string, unknown>) =>
    logDeniedAuditEventStrictWithCooldown(input),
}));

import {
  decideConnectionUse,
  enforceConnectionUse,
  connectionSubjectUserId,
  ConnectionUseDeniedError,
  EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
} from "@/lib/connection-use-gate";

const ORG = "org-1";
const OWNER = "user-owner";
const MEMBER = "user-member";

const identity: NangoConnectionIdentity = {
  id: "conn-uuid-1",
  organizationId: ORG,
  connectorPackageId: "@cinatra-ai/github-connector",
  connectorKey: "github",
  connectionId: "github-conn-1",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

function human(userId: string, over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: userId,
    organizationId: ORG,
    teamIds: [],
    projectIds: [],
    projectGrants: [],
    authSource: "ui",
    policyVersion: "v2",
    ...over,
  } as ActorContext;
}

function declaration(mode: "default" | "only", scope: string) {
  return {
    accessDeclaration: { formatVersion: 1, mode, scope, source: "declared" },
    organizationId: ORG,
  };
}

const policy = (vis: string) => ({
  runListVisibility: vis,
  runDataVisibility: vis,
  runExecuteVisibility: vis,
  allowRunSharing: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  readExtensionAccessPolicy.mockResolvedValue(null);
  readExtensionCoOwners.mockResolvedValue([]);
  readExtensionInstalledBy.mockResolvedValue(null);
  readInstalledExtensionsByPackageName.mockResolvedValue([declaration("default", "admin")]);
});

describe("subject resolution", () => {
  it("human principal is its own subject; worker resolves runAsUserId", () => {
    expect(connectionSubjectUserId(human(MEMBER))).toBe(MEMBER);
    expect(
      connectionSubjectUserId({
        principalType: "InternalWorker",
        principalId: "run:1",
        runAsUserId: OWNER,
        authSource: "worker",
        policyVersion: "v2",
      } as ActorContext),
    ).toBe(OWNER);
  });
});

describe("own short-circuit (round-2 finding 1)", () => {
  it("allows the owner's agent run via runAsUserId without any store read", async () => {
    const worker = {
      principalType: "InternalWorker",
      principalId: "run:42",
      organizationId: ORG,
      runAsUserId: OWNER,
      authSource: "agent",
      policyVersion: "v2",
    } as ActorContext;
    const d = await decideConnectionUse({
      identity,
      actor: worker,
      subjectUserId: connectionSubjectUserId(worker),
    });
    expect(d).toEqual({ allowed: true, asOwner: true });
    expect(readExtensionAccessPolicy).not.toHaveBeenCalled();
  });
});

describe("OWNER_DEFAULT fallback (the workspace default must never engage)", () => {
  it("denies a same-org member on a NO-policy-row connection (default mode)", async () => {
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
  });

  it("allows a same-org member once a workspace grant row exists", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("denies cross-org even with a workspace grant (404-hidden at the gate)", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { organizationId: "org-2" }),
      subjectUserId: MEMBER,
    });
    expect(d).toMatchObject({ allowed: false, reason: "cross_org" });
  });
});

describe("only-clamp ceiling (round-2 finding 2 + convergence amendments)", () => {
  it("workspace grant on an only:team connector evaluates owner-only", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("visibility");
  });

  it("team grant within an only:team ceiling admits a team member", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "team")]);
    readExtensionAccessPolicy.mockResolvedValue(policy("team:team-9"));
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { teamIds: ["team-9"] }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("co-owner grantee is clamped out under only:user (amendment 2)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("coOwner");
  });

  it("co-owner grantee survives an only:workspace ceiling (same-org individual)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "workspace")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("non-admin co-owner is clamped out under only:admin; org-admin passes", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "admin")]);
    readExtensionCoOwners.mockResolvedValue([{ userId: MEMBER }]);
    const denied = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(denied.allowed).toBe(false);
    readExtensionAccessPolicy.mockResolvedValue(policy("admin"));
    const allowed = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { orgRole: "org_admin" }),
      subjectUserId: MEMBER,
    });
    expect(allowed.allowed).toBe(true);
  });

  it("platform_admin bypass is neutralized under a non-admin only ceiling (amendment 3)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { platformRole: "platform_admin" }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
    expect((d as { clampApplied?: string[] }).clampApplied).toContain("platformAdminBypass");
  });

  it("platform_admin OWNER still allowed under only:user (own short-circuit first)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("only", "user")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(OWNER, { platformRole: "platform_admin" }),
      subjectUserId: OWNER,
    });
    expect(d).toEqual({ allowed: true, asOwner: true });
  });

  it("platform_admin keeps kernel parity on default-mode connections", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([declaration("default", "admin")]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER, { platformRole: "platform_admin" }),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
  });

  it("fails closed for non-owner use when the package row cannot be resolved", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    const d = await decideConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(false);
  });

  it("external-MCP sentinel rows skip declaration resolution (default semantics)", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    const d = await decideConnectionUse({
      identity: {
        ...identity,
        connectorKey: "externalMcp",
        connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
      },
      actor: human(MEMBER),
      subjectUserId: MEMBER,
    });
    expect(d.allowed).toBe(true);
    expect(readInstalledExtensionsByPackageName).not.toHaveBeenCalled();
  });
});

describe("enforceConnectionUse — audit ordering + mapping", () => {
  it("ALLOW audits delegatedBy = owner for a granted non-owner", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    await enforceConnectionUse({
      identity,
      actor: human(MEMBER),
      subjectUserId: MEMBER,
      runId: "run-7",
      source: "test",
    });
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const row = logAuditEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      decision: "allowed",
      delegatedBy: OWNER,
      resourceType: "connection",
      resourceId: identity.id,
      operation: "use",
      runId: "run-7",
    });
  });

  it("DENY writes the durable cooldown-aware audit row BEFORE the throw, never tokens", async () => {
    let auditedBeforeThrow = false;
    logDeniedAuditEventStrictWithCooldown.mockImplementation(async () => {
      auditedBeforeThrow = true;
      return { id: "a" };
    });
    await expect(
      enforceConnectionUse({
        identity,
        actor: human(MEMBER),
        subjectUserId: MEMBER,
      }),
    ).rejects.toBeInstanceOf(ConnectionUseDeniedError);
    expect(auditedBeforeThrow).toBe(true);
    const row = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(row.metadata ?? {})).not.toMatch(/token|secret|credential/i);
  });

  it("maps cross-org to a 404-hidden error", async () => {
    readExtensionAccessPolicy.mockResolvedValue(policy("workspace"));
    await expect(
      enforceConnectionUse({
        identity,
        actor: human(MEMBER, { organizationId: "org-2" }),
        subjectUserId: MEMBER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("maps a missing actor to 401", async () => {
    await expect(
      enforceConnectionUse({ identity, actor: null, subjectUserId: undefined }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
