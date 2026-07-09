// Connection GRANT WRITE-gate contract tests (cinatra#953 W3). Mirrors the
// connection-use-gate suite style: the REAL kind-hook logic (validatePolicyWrite
// + allowSharing) and the REAL declaration resolution + ceiling predicate run
// over mocked stores, pinning the enforcement half of the `only` lock:
//   • mode:"only" REJECTS any out-of-ceiling grant with the TYPED
//     "scope_locked_by_connector" (the UI disable is an affordance — THIS is
//     the enforcement),
//   • only:"user" rejects every non-owner grant; owner-only always passes,
//   • an unreadable declaration (package_unresolved) fails CLOSED,
//   • REAL-LOCI validation: org must be the identity's own org + an actor
//     membership; team/project must be the actor's real memberships contained
//     in the identity's org; bare legacy "org" and workspace-on-null-org are
//     refused ("invalid_locus"),
//   • allowSharing refuses person-grants under only:user/team/project.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const readNangoConnectionById = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  readNangoConnectionById: (...a: unknown[]) => readNangoConnectionById(...a),
}));

const readInstalledExtensionsByPackageName = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...a),
}));

// connection-use-gate imports the permissions-store + audit surfaces at module
// scope; stub them so importing the REAL resolution/ceiling stays hermetic.
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicy: vi.fn(),
  readExtensionCoOwners: vi.fn(async () => []),
  readExtensionInstalledBy: vi.fn(async () => null),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: vi.fn(async () => ({})),
  logDeniedAuditEventStrictWithCooldown: vi.fn(async () => ({})),
}));

const readOrgsWithTeamsForUser = vi.fn();
const readProjectsForUser = vi.fn();
const readProjectById = vi.fn();
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUser: (...a: unknown[]) => readOrgsWithTeamsForUser(...a),
  readProjectsForUser: (...a: unknown[]) => readProjectsForUser(...a),
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: (...a: unknown[]) => readProjectById(...a),
}));

import { getExtensionKindHooks } from "@cinatra-ai/extensions/permissions-kind-hooks";

const ORG = "org-1";
const OWNER = "user-owner";

const identity: NangoConnectionIdentity = {
  id: "conn-uuid-1",
  organizationId: ORG,
  connectorPackageId: "@cinatra-ai/openai-connector",
  connectorKey: "openai",
  connectionId: "openai-conn-1",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

function policyOf(visibility: string): AgentAuthPolicy {
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  } as unknown as AgentAuthPolicy;
}

function declarationRow(declaration: unknown, organizationId: string | null = ORG) {
  return [{ organizationId, accessDeclaration: declaration }];
}

function decl(mode: "default" | "only", scope: string) {
  return { formatVersion: 1, mode, scope, source: "declared" };
}

beforeEach(() => {
  vi.clearAllMocks();
  readNangoConnectionById.mockResolvedValue(identity);
  readOrgsWithTeamsForUser.mockResolvedValue([
    { id: ORG, name: "Org One", teams: [{ id: "team-1", name: "Team One" }] },
  ]);
  readProjectsForUser.mockResolvedValue([{ id: "proj-1", name: "Project One" }]);
  readProjectById.mockResolvedValue({ id: "proj-1", organizationId: ORG });
});

async function validate(policy: AgentAuthPolicy, userId = OWNER) {
  const hooks = await getExtensionKindHooks("connection");
  expect(hooks.validatePolicyWrite).toBeTypeOf("function");
  return hooks.validatePolicyWrite!(identity.id, policy, { userId });
}

describe("connection validatePolicyWrite — the only-ceiling write rejection", () => {
  it("rejects widening past only:admin with the TYPED scope_locked_by_connector", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("only", "admin")),
    );
    for (const v of ["workspace", `org:${ORG}`, "team:team-1", "project:proj-1", "org"]) {
      expect(await validate(policyOf(v)), v).toBe("scope_locked_by_connector");
    }
  });

  it("allows the only-value itself and owner-only under only:admin", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("only", "admin")),
    );
    expect(await validate(policyOf("admin"))).toBeNull();
    expect(await validate(policyOf("owner"))).toBeNull();
  });

  it("only:user rejects EVERY non-owner grant; owner-only passes", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("only", "user")),
    );
    for (const v of ["workspace", "admin", `org:${ORG}`, "team:team-1", "project:proj-1"]) {
      expect(await validate(policyOf(v)), v).toBe("scope_locked_by_connector");
    }
    expect(await validate(policyOf("owner"))).toBeNull();
  });

  it("only:team admits team grants (real membership) and rejects the rest", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("only", "team")),
    );
    expect(await validate(policyOf("team:team-1"))).toBeNull();
    expect(await validate(policyOf("workspace"))).toBe("scope_locked_by_connector");
    expect(await validate(policyOf(`org:${ORG}`))).toBe("scope_locked_by_connector");
  });

  it("a MIXED policy is rejected when ANY visibility field exceeds the ceiling", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("only", "admin")),
    );
    const mixed = {
      ...policyOf("admin"),
      runExecuteVisibility: ["workspace"],
    } as AgentAuthPolicy;
    expect(await validate(mixed)).toBe("scope_locked_by_connector");
  });

  it("an unreadable declaration (package_unresolved) fails CLOSED: owner-only passes, everything else is refused", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    expect(await validate(policyOf("owner"))).toBeNull();
    expect(await validate(policyOf("workspace"))).toBe("scope_locked_by_connector");
  });

  it("a missing identity row returns not_found", async () => {
    readNangoConnectionById.mockResolvedValue(null);
    expect(await validate(policyOf("owner"))).toBe("not_found");
  });
});

describe("connection validatePolicyWrite — REAL-loci validation (default mode)", () => {
  beforeEach(() => {
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("default", "workspace")),
    );
  });

  it("admits the identity's own org when the actor is a member", async () => {
    expect(await validate(policyOf(`org:${ORG}`))).toBeNull();
  });

  it("rejects a FOREIGN org id (not the identity's org)", async () => {
    expect(await validate(policyOf("org:org-other"))).toBe("invalid_locus");
  });

  it("rejects an org the actor is not a member of", async () => {
    readOrgsWithTeamsForUser.mockResolvedValue([]);
    expect(await validate(policyOf(`org:${ORG}`))).toBe("invalid_locus");
  });

  it("admits a real team membership; rejects a team the actor does not hold", async () => {
    expect(await validate(policyOf("team:team-1"))).toBeNull();
    expect(await validate(policyOf("team:team-stranger"))).toBe("invalid_locus");
  });

  it("rejects a team that belongs to a DIFFERENT org than the identity's", async () => {
    readOrgsWithTeamsForUser.mockResolvedValue([
      { id: "org-other", name: "Other", teams: [{ id: "team-1", name: "Team One" }] },
    ]);
    expect(await validate(policyOf("team:team-1"))).toBe("invalid_locus");
  });

  it("admits a real project (actor access + org containment); rejects otherwise", async () => {
    expect(await validate(policyOf("project:proj-1"))).toBeNull();
    // Not in the actor's project set:
    expect(await validate(policyOf("project:proj-x"))).toBe("invalid_locus");
    // In the actor's set but owned by ANOTHER org (multi-org union — codex
    // round-0 finding 2):
    readProjectsForUser.mockResolvedValue([{ id: "proj-1", name: "Project One" }]);
    readProjectById.mockResolvedValue({ id: "proj-1", organizationId: "org-other" });
    expect(await validate(policyOf("project:proj-1"))).toBe("invalid_locus");
  });

  it("rejects the legacy bare org token (never a concrete locus)", async () => {
    expect(await validate(policyOf("org"))).toBe("invalid_locus");
  });

  it("rejects a workspace grant on a NULL-org identity row", async () => {
    readNangoConnectionById.mockResolvedValue({ ...identity, organizationId: null });
    readInstalledExtensionsByPackageName.mockResolvedValue(
      declarationRow(decl("default", "workspace"), null),
    );
    expect(await validate(policyOf("workspace"))).toBe("invalid_locus");
  });

  it("admits workspace + admin on an org-bound row (no id to validate)", async () => {
    expect(await validate(policyOf("workspace"))).toBeNull();
    expect(await validate(policyOf("admin"))).toBeNull();
  });
});

describe("connection allowSharing — person-grant writes under the ceiling", () => {
  async function sharing() {
    const hooks = await getExtensionKindHooks("connection");
    expect(hooks.allowSharing).toBeTypeOf("function");
    return hooks.allowSharing!(identity.id);
  }

  it("refuses sharing under only:user / only:team / only:project", async () => {
    for (const scope of ["user", "team", "project"]) {
      readInstalledExtensionsByPackageName.mockResolvedValue(
        declarationRow(decl("only", scope)),
      );
      expect(await sharing(), scope).toBe("sharing_disabled");
    }
  });

  it("allows sharing under only:admin / only:organization / default / null declaration", async () => {
    for (const declaration of [
      decl("only", "admin"),
      decl("only", "organization"),
      decl("default", "user"),
      null,
    ]) {
      readInstalledExtensionsByPackageName.mockResolvedValue(declarationRow(declaration));
      expect(await sharing()).toBeNull();
    }
  });

  it("fails closed when the declaration cannot be read", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    expect(await sharing()).toBe("sharing_disabled");
  });
});
