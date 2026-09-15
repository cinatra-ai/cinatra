/**
 * THE TAB DRAWS THEM (cinatra#3408, acceptance item 2).
 *
 * The sibling suite `connection-sharing-section-external-mcp.test.ts` pins the
 * section-to-picker WIRING with the policy reader mocked, so it cannot tell an
 * untouched connect seed from a saved grant: it hands the section a policy
 * object that already carries the seed marker, and therefore passes unchanged
 * at the pre-fix head. This suite closes that gap. It runs the REAL
 * `readExtensionAccessPolicy` over a mocked postgres leaf, so the whole road
 * the live tab walks — the stored jsonb row, the canonical parse, the pure
 * fold, the panel the tab renders — is exercised end to end.
 *
 * §II of the ratified drawing: "Where the connector only recommends a scope,
 * the line reads instead This connector recommends sharing with your
 * organization — nothing is shared until you save. Currently: only you."
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const getAuthSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));

const listNangoConnectionsByOwner = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsByOwner: (...a: unknown[]) => listNangoConnectionsByOwner(...a),
}));

// The postgres LEAF — the only thing standing in for the database. Everything
// above it (the policy reader and its canonical parse) is the real module.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));

// Only the two OTHER readers of the permissions store are stubbed; the policy
// reader this fix changes stays REAL so the suite discriminates it.
const readExtensionCoOwners = vi.fn();
const readExtensionInstalledBy = vi.fn();
vi.mock("@cinatra-ai/extensions/permissions-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cinatra-ai/extensions/permissions-store")>();
  return {
    ...actual,
    readExtensionCoOwners: (...a: unknown[]) => readExtensionCoOwners(...a),
    readExtensionInstalledBy: (...a: unknown[]) => readExtensionInstalledBy(...a),
  };
});

const readInstalledExtensionsByPackageName = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...a),
}));

vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: async () => {},
  logDeniedAuditEventStrictWithCooldown: async () => ({ id: "audit-1" }),
}));

const readOrgsWithTeamsForUserActiveOnly = vi.fn();
const readProjectsForUser = vi.fn();
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {},
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: (...a: unknown[]) =>
    readOrgsWithTeamsForUserActiveOnly(...a),
  readProjectsForUser: (...a: unknown[]) => readProjectsForUser(...a),
}));

vi.mock("@/components/extension-permissions-client", () => ({
  ExtensionPermissionsClient: () => null,
}));

vi.mock("@cinatra-ai/sdk-ui/connector-sharing-panels", () => ({
  CONNECTOR_SHARING_INTRO: "Choose who can use each of your saved connections.",
  ConnectorSharingPanels: () => null,
}));

import { ConnectionSharingSection } from "@/components/extensions/connection-sharing-section";
import { ConnectorSharingPanels } from "@cinatra-ai/sdk-ui/connector-sharing-panels";
import { EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } from "@/lib/connection-use-gate";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

/** Derived through the sanctioned catalog registry — no package literal here. */
const MCP_SERVERS_PACKAGE =
  getConnectorDescriptorBySlug("mcp-server-connector")?.packageId ?? "";

const OWNER = "user-owner";
const ORG = "org-1";

const registeredRow: NangoConnectionIdentity = {
  id: "conn-external-mcp-seeded",
  organizationId: ORG,
  connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
  connectorKey: "externalMcp",
  connectionId: "external-mcp-4d1c0f8e-2b7a-4a19-9f30-6c51d0a7be22",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

/** The MCP Servers connector's own declaration (mode default, scope workspace). */
const recommendWorkspace = {
  formatVersion: 1,
  mode: "default",
  scope: "workspace",
  source: "declared",
};

/** Exactly what `registerSavedConnectionIdentity` writes at registration. */
const CONNECT_SEED = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
  seededDefault: true,
};

/** Exactly what the first explicit Save changes writes (no marker). */
const SAVED_WORKSPACE = {
  runListVisibility: ["workspace"],
  runDataVisibility: ["workspace"],
  runExecuteVisibility: ["workspace"],
  allowRunSharing: false,
};

/** One stored `extension_access_policy` row, as the column holds it. */
function storedPolicyRow(policy: Record<string, unknown>) {
  runPostgresQueriesSync.mockReturnValue([
    { rows: [{ resource_id: registeredRow.id, policy }] },
  ]);
}

type PanelView = {
  key: string;
  name: string;
  url: string;
  scopeConstraint: string | null;
  permissions: ReactElement;
};

function findElement(node: unknown, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: unknown }).children, type);
}

function panelsOf(rendered: unknown): PanelView[] | null {
  const el = findElement(rendered, ConnectorSharingPanels);
  if (!el) return null;
  return (el.props as { panels: PanelView[] }).panels;
}

async function drawTab() {
  return ConnectionSharingSection({
    packageId: MCP_SERVERS_PACKAGE,
    variant: "tab",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({
    user: { id: OWNER, name: "Owner", email: "owner@example.com", image: null },
    session: { activeOrganizationId: ORG },
  });
  readOrgsWithTeamsForUserActiveOnly.mockResolvedValue([
    { id: ORG, name: "Acme", teams: [] },
  ]);
  readProjectsForUser.mockResolvedValue([]);
  readExtensionCoOwners.mockResolvedValue([]);
  readExtensionInstalledBy.mockResolvedValue(null);
  readInstalledExtensionsByPackageName.mockResolvedValue([
    { organizationId: null, accessDeclaration: recommendWorkspace },
  ]);
  listNangoConnectionsByOwner.mockResolvedValue([registeredRow]);
});

// Every mock this file installs is released again, so the package's full run
// stays green with the file present (the module registry is reset too: the
// partial `permissions-store` factory must not leak into a sibling file).
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the Sharing tab draws a recommending connector's line, read from the stored seed", () => {
  it("draws the recommendation line word for word on an UNTOUCHED registration seed", async () => {
    storedPolicyRow(CONNECT_SEED);

    const panel = panelsOf(await drawTab())?.[0];
    expect(panel).toBeDefined();
    expect(panel?.scopeConstraint).toBe("recommended");
    expect(
      (panel?.permissions.props as { accessScopeNote?: string }).accessScopeNote,
    ).toBe(
      "This connector recommends sharing with the whole workspace — nothing is shared until you save. Currently: only you.",
    );
  });

  it("keeps the picker on the stored owner scope on that same seed, so the recommendation can be taken OR declined", async () => {
    storedPolicyRow(CONNECT_SEED);

    const panel = panelsOf(await drawTab())?.[0];
    // The line reads "Currently: only you."; a picker pre-selected to the
    // recommended scope contradicted it AND left the owner no enabled
    // alternative to the value already selected, so Save could never write
    // (cinatra#3408).
    expect(
      (panel?.permissions.props as { accessValueOverride?: string }).accessValueOverride,
    ).toBe("owner");
  });

  it("draws the SAVED scope and no recommendation line once the owner has saved", async () => {
    storedPolicyRow(SAVED_WORKSPACE);

    const panel = panelsOf(await drawTab())?.[0];
    expect(panel).toBeDefined();
    expect(panel?.scopeConstraint).toBeNull();
    expect(
      (panel?.permissions.props as { accessScopeNote?: string }).accessScopeNote,
    ).toBeUndefined();
    expect(
      (panel?.permissions.props as { accessValueOverride?: string }).accessValueOverride,
    ).toBe("workspace");
  });
});
