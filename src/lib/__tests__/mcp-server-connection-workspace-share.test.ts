// cinatra#3397 — a server registered on the MCP Servers connector's Setup tab
// and the WORKSPACE share of its connection on the Sharing tab (cinatra#3374).
//
// The two halves, end to end, over the REAL production seam: the write handler
// (`createServerHandler`) mints the credential identity through the sanctioned
// path, the REAL `registerSavedConnectionIdentity` stores that identity row,
// and the REAL connection kind-hook `validatePolicyWrite` then rules on a
// `workspace` grant against THAT row. Only the leaves are stubbed — the Nango
// credential write (covered by `external-mcp-apikey-connection.test.ts`) and
// the identity/policy stores.
//
// The RATIFIED rule is untouched and re-pinned here from the other side: a
// person of NO organization still creates the connection, and the workspace
// locus on that null-org row stays `invalid_locus`
// (`connection-grant-write-gate.test.ts`, "rejects a workspace grant on a
// NULL-org identity row").

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

// --- mocks ----------------------------------------------------------------
let sessionUserId = "u1";
let sessionActiveOrganizationId: string | null = null;

// The identity rows the REAL seam writes (the store is the leaf that is stubbed).
const identities = new Map<string, NangoConnectionIdentity>();
let identitySeq = 0;
// The external-MCP server rows the write handler persists.
const servers = new Map<string, { id: string; scope: string; userId: string | null; nangoConnectionId?: string | null }>();

class ExternalMcpServerWriteConflictError extends Error {}
class ExternalMcpServerManagedEndpointError extends Error {}

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({
    user: { id: sessionUserId },
    session: { activeOrganizationId: sessionActiveOrganizationId },
  }),
  isPlatformAdmin: () => false,
  // The sanctioned save action authenticates through the ACTOR context.
  getActorContext: async () => ({
    principalType: "HumanUser",
    principalId: sessionUserId,
    platformRole: "member",
  }),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  ExternalMcpServerWriteConflictError,
  ExternalMcpServerManagedEndpointError,
  normalizeExternalMcpTransport: (value: unknown) =>
    value === "streamable-http" || value === "sse" ? value : "unknown",
  getExternalMcpServerByIdFresh: (id: string) => servers.get(id) ?? null,
  insertExternalMcpServerStrict: (input: { id: string; scope: string; userId: string | null }) => {
    servers.set(input.id, input);
  },
  updateExternalMcpServerGuarded: (input: { id: string; scope: string; userId: string | null }) => {
    servers.set(input.id, input);
  },
  deleteExternalMcpServerGuarded: (id: string) => {
    servers.delete(id);
  },
  // The credential write is the leaf. Everything AFTER it — the identity the
  // handler derived and the row the seam stores from it — is the real code.
  importExternalMcpApiKeyConnection: async (
    connectionId: string,
    _apiKey: string,
    identity: { ownerUserId: string; organizationId: string | null; seed: "owner" | "workspace" },
  ) => {
    const { registerSavedConnectionIdentity } = await import("@/lib/connection-identity-seam");
    await registerSavedConnectionIdentity({
      connectorKey: "externalMcp",
      connectionId,
      ownerUserId: identity.ownerUserId,
      organizationId: identity.organizationId,
      seed: identity.seed,
    });
  },
  revokeExternalMcpApiKeyConnection: async () => {},
}));

vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  insertNangoConnection: async (input: {
    organizationId: string | null;
    connectorPackageId: string;
    connectorKey: string;
    connectionId: string;
    ownerUserId: string;
  }) => {
    const row = {
      id: `identity-${++identitySeq}`,
      ...input,
      createdAt: new Date(),
      deletedAt: null,
    } as NangoConnectionIdentity;
    identities.set(row.id, row);
    return row;
  },
  readNangoConnectionById: async (id: string) => identities.get(id) ?? null,
  readNangoConnectionByNaturalKey: async () => null,
  softDeleteNangoConnection: async () => {},
}));

// The policy STORE is the leaf. `writeExtensionAccessPolicy` is the exact row
// write the sanctioned save action performs, so a call on it IS "the policy row
// changes"; a rejected save must never reach it.
const writtenPolicies: Array<{ kind: string; resourceId: string; policy: AgentAuthPolicy }> = [];
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  seedExtensionAccessPolicyIfAbsent: vi.fn(async () => true),
  readExtensionAccessPolicy: vi.fn(async () => null),
  readExtensionCoOwners: vi.fn(async () => []),
  readExtensionInstalledBy: vi.fn(async () => null),
  writeExtensionAccessPolicy: vi.fn(
    async (kind: string, resourceId: string, policy: AgentAuthPolicy) => {
      writtenPolicies.push({ kind, resourceId, policy });
    },
  ),
  addExtensionCoOwner: vi.fn(async () => {}),
  removeExtensionCoOwner: vi.fn(async () => {}),
}));
// The generic edit gate's evaluator is NOT what this test measures: the
// connection hooks' own `extraEditors` (the row's owner) opens the gate, and the
// actor holds NO admin standing, so the veto takes its non-admin branch — the
// branch the ratified NULL-org rule lives on.
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  canExtensionAccess: vi.fn(async () => ({ allowed: false, reason: "not-evaluated" })),
  hasAdminStandingOverExtension: () => false,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => []),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: vi.fn(async () => ({})),
  logDeniedAuditEventStrictWithCooldown: vi.fn(async () => ({})),
}));
vi.mock("@/lib/nango-system", () => ({
  deleteNangoConnection: vi.fn(async () => {}),
  removeNangoConnectionRecord: vi.fn(async () => {}),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readTeamForOrg: vi.fn(async () => null),
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(async () => null),
}));

// Import AFTER the mocks are registered.
const { createServerHandler } = await import("@/lib/mcp-server-write-actions");
const { getExtensionKindHooks } = await import("@cinatra-ai/extensions/permissions-kind-hooks");
const { saveExtensionAccessPolicy } = await import(
  "@cinatra-ai/extensions/permissions-actions"
);

const ORG = "org-1";

function policyOf(visibility: string): AgentAuthPolicy {
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  } as unknown as AgentAuthPolicy;
}

async function registerAServer() {
  await createServerHandler({
    label: "My server",
    serverUrl: "https://mcp.example",
    scope: "user",
    apiKey: "sk-registered",
  });
  const row = [...identities.values()][0];
  expect(row).toBeTruthy();
  return row;
}

async function validateWorkspaceGrant(identityId: string) {
  const hooks = await getExtensionKindHooks("connection");
  expect(hooks.validatePolicyWrite).toBeTypeOf("function");
  return hooks.validatePolicyWrite!(identityId, policyOf("workspace"), { userId: sessionUserId });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUserId = "u1";
  sessionActiveOrganizationId = null;
  identities.clear();
  servers.clear();
  writtenPolicies.length = 0;
  identitySeq = 0;
});

describe("MCP Servers registration → the Sharing tab's workspace share (cinatra#3397)", () => {
  it("stores the creating person's organization on the identity and the veto ACCEPTS the workspace share", async () => {
    sessionActiveOrganizationId = ORG;
    const row = await registerAServer();
    // Acceptance 1: the identity carries the signed-in actor's own organization.
    expect(row.organizationId).toBe(ORG);
    expect(row.ownerUserId).toBe("u1");
    // Acceptance 2: on such a row the workspace share is accepted (no veto).
    expect(await validateWorkspaceGrant(row.id)).toBeNull();
  });

  it("a person of NO organization still creates the connection, without one — and the RATIFIED null-org rule still refuses the workspace share", async () => {
    sessionActiveOrganizationId = null;
    const row = await registerAServer();
    expect(row.organizationId).toBeNull();
    expect(row.ownerUserId).toBe("u1");
    expect(await validateWorkspaceGrant(row.id)).toBe("invalid_locus");
  });

  // Acceptance 2, the WRITE side: the veto is not the end of the sentence — the
  // sanctioned save action is what the Sharing tab's Save changes calls, so the
  // proof that "the policy row changes" is the store write it performs. (No
  // audit entry is asserted: this write path emits none on this head — the same
  // at origin/main — see the record's note.)
  it("the SANCTIONED save action writes the workspace policy row for an org-stamped registration", async () => {
    sessionActiveOrganizationId = ORG;
    const row = await registerAServer();
    const result = await saveExtensionAccessPolicy("connection", row.id, policyOf("workspace"));
    expect(result).toEqual({ ok: true });
    expect(writtenPolicies).toHaveLength(1);
    expect(writtenPolicies[0].kind).toBe("connection");
    expect(writtenPolicies[0].resourceId).toBe(row.id);
    expect(writtenPolicies[0].policy.runListVisibility).toEqual(["workspace"]);
  });

  it("the SANCTIONED save action still REFUSES the workspace policy on a null-org registration and writes NOTHING", async () => {
    sessionActiveOrganizationId = null;
    const row = await registerAServer();
    const result = await saveExtensionAccessPolicy("connection", row.id, policyOf("workspace"));
    expect(result).toEqual({ ok: false, error: "invalid_locus" });
    expect(writtenPolicies).toHaveLength(0);
  });
});
