// The one stated exception to the recommendation rule of cinatra#3408.
//
// Acceptance item 1 of the issue: on a recommending connector, a connection
// panel whose seed is untouched draws the recommendation line and opens the
// picker on the recommended scope. The panel model makes ONE exception: a
// connection of no organization (a legacy row stored before cinatra#3397
// stamped the organization, or the row of a person of no organization) gets
// no line and no pre-selection, although its seed is untouched.
//
// The reason is the save path. The connection kind's write gate refuses a
// workspace or organization grant on a connection of no organization
// ("invalid_locus"), so a pre-selected recommended scope there would be a Save
// that always fails. This suite pins both halves on the SAME row: the real
// panel model states nothing and keeps the owner scope, and the real write
// gate refuses the recommended scope and accepts the owner scope the picker
// shows. The paired case on a connection of an organization shows that the
// exception follows the gate exactly.

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

// connection-use-gate imports the permissions-store and audit surfaces at
// module scope; stub them so the REAL model and the REAL write gate stay
// hermetic.
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
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUser: (...a: unknown[]) => readOrgsWithTeamsForUser(...a),
  readProjectsForUser: (...a: unknown[]) => readProjectsForUser(...a),
  readTeamForOrg: vi.fn(async () => null),
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(async () => null),
}));

import { getExtensionKindHooks } from "@cinatra-ai/extensions/permissions-kind-hooks";
import { decideConnectionShareSurface } from "@/lib/connection-share-ui";
import { EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } from "@/lib/connection-use-gate";
import type { AvailableScopes } from "@/components/access-scope";

const ORG = "org-1";
const OWNER = "user-owner";

/**
 * The recommendation line as section II of the connectors drawing gives it,
 * word for word. The dash is U+2014, written as an escape here.
 */
const RECOMMENDATION_LINE =
  "This connector recommends sharing with your organization \u2014 nothing is shared until you save. Currently: only you.";

/** A server registered on the MCP Servers Setup tab, with its organization. */
const orgRow: NangoConnectionIdentity = {
  id: "conn-external-mcp",
  organizationId: ORG,
  connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
  connectorKey: "externalMcp",
  connectionId: "external-mcp-9a4f3c2e-1b7d-4e60-8c55-2f0a6d9b7e14",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

/** The same row as a legacy row stores it: no organization. */
const legacyRow: NangoConnectionIdentity = { ...orgRow, organizationId: null };

/** The owner still belongs to an organization: the row, not the person, decides. */
const scopes: AvailableScopes = {
  orgs: [{ id: ORG, name: "Acme", teams: [] }],
  projects: [],
  canGrantWorkspace: true,
};

/** Exactly what `registerSavedConnectionIdentity` writes at registration. */
const CONNECT_SEED = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
  seededDefault: true,
} as unknown as AgentAuthPolicy;

function decl(scope: "workspace" | "organization") {
  return { formatVersion: 1 as const, mode: "default", scope, source: "declared" as const } as never;
}

/** What Save changes writes for one picker value. */
function policyOf(visibility: string): AgentAuthPolicy {
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  } as unknown as AgentAuthPolicy;
}

function surfaceFor(row: NangoConnectionIdentity, scope: "workspace" | "organization") {
  return decideConnectionShareSurface({
    identity: row,
    declaration: decl(scope),
    storedPolicy: CONNECT_SEED,
    scopes,
  });
}

/** The save path's own veto for the connection kind, run for the owner. */
async function saveVeto(row: NangoConnectionIdentity, policy: AgentAuthPolicy) {
  readNangoConnectionById.mockResolvedValue(row);
  const hooks = await getExtensionKindHooks("connection");
  return hooks.validatePolicyWrite!(row.id, policy, { userId: OWNER });
}

beforeEach(() => {
  vi.clearAllMocks();
  readInstalledExtensionsByPackageName.mockResolvedValue([
    { organizationId: null, accessDeclaration: decl("workspace") },
  ]);
  readOrgsWithTeamsForUser.mockResolvedValue([{ id: ORG, name: "Acme", teams: [] }]);
  readProjectsForUser.mockResolvedValue([]);
});

describe("the stated exception: an untouched seed on a connection of no organization", () => {
  it("draws no line and no pre-selection, because the save path refuses the workspace grant on that row", async () => {
    const s = surfaceFor(legacyRow, "workspace");
    expect(s).toEqual({ surface: "editable", value: "owner" });

    // The reason, on the same row: the recommended workspace scope could never
    // be saved there, while the owner scope the picker shows can.
    expect(await saveVeto(legacyRow, policyOf("workspace"))).toBe("invalid_locus");
    expect(await saveVeto(legacyRow, policyOf("owner"))).toBeNull();
  });

  it("regression guard (passes without the #3408 fix too): draws no line and no pre-selection for an organization recommendation either, for the same reason", async () => {
    const s = surfaceFor(legacyRow, "organization");
    expect(s).toEqual({ surface: "editable", value: "owner" });

    expect(await saveVeto(legacyRow, policyOf(`org:${ORG}`))).toBe("invalid_locus");
  });

  it("the same seed on a connection of an organization draws the line and the pre-selection, a scope the save path accepts", async () => {
    const s = surfaceFor(orgRow, "workspace");
    expect(s).toEqual({
      surface: "editable",
      value: "workspace",
      recommendationNote: RECOMMENDATION_LINE,
    });

    expect(await saveVeto(orgRow, policyOf("workspace"))).toBeNull();
  });
});
