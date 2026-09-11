/**
 * The Sharing tab lists a server registered on the MCP Servers connector's OWN
 * Setup tab (cinatra#3374, the sentinel-home defect).
 *
 * §II of the ratified drawing, the Sharing tab: "The tab lists your own saved
 * connections for this connector". A server registered on that connector's
 * form-configured Setup tab IS one of its saved connections — but the identity
 * row it writes is homed to the external-MCP SENTINEL package (external MCP
 * servers are host rows, not marketplace connector packages), so the strict
 * `connectorPackageId === packageId` row filter dropped it and the tab drew
 * nothing at all.
 *
 * These tests run the REAL section over mocked stores (the same shape as the
 * use-gate contract suite) and pin BOTH halves of the one named mapping:
 *   • the sentinel-homed row is listed on the MCP Servers connector's page,
 *     governed there by THAT connector's own access declaration (so the
 *     picker draws the recommendation line), and
 *   • it appears on NO other connector's page, while every ordinary row keeps
 *     being listed by its own package exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

// The picker itself is a client component — stubbed so the section's element
// tree stays inspectable in the node test env (no DOM render in this suite).
vi.mock("@/components/extension-permissions-client", () => ({
  ExtensionPermissionsClient: () => null,
}));

vi.mock("@/components/extensions/connector-sharing-panels", () => ({
  CONNECTOR_SHARING_INTRO: "Choose who can use each of your saved connections.",
  ConnectorSharingPanels: () => null,
}));

import { ConnectionSharingSection } from "@/components/extensions/connection-sharing-section";
import { ConnectorSharingPanels } from "@/components/extensions/connector-sharing-panels";
import { ExtensionPermissionsClient } from "@/components/extension-permissions-client";
import { EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } from "@/lib/connection-use-gate";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

/** Derived through the sanctioned catalog registry — no package literal here. */
const MCP_SERVERS_PACKAGE = getConnectorDescriptorBySlug("mcp-server-connector")?.packageId ?? "";
const OTHER_CONNECTOR_PACKAGE =
  getConnectorDescriptorBySlug("github-connector")?.packageId ?? "";

const OWNER = "user-owner";
const ORG = "org-1";

/**
 * A LEGACY (or organization-less) registration: its identity carries no
 * organization. Rows like this exist from before cinatra#3397 and are still
 * created by a person who belongs to no organization; the tab must keep
 * listing them.
 */
const externalMcpRow: NangoConnectionIdentity = {
  id: "conn-external-mcp-1",
  organizationId: null,
  connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
  connectorKey: "externalMcp",
  connectionId: "external-mcp-9b6ed3c5-11fe-4829-ba38-fb113a6711d3",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

/**
 * The row shape a registration WRITES since cinatra#3397: the creating person's
 * own organization is stamped on the identity (which is what lets the Sharing
 * tab's workspace share pass the ratified write-time veto). It must be listed
 * on the same tab, under the same one mapping.
 */
const externalMcpOrgRow: NangoConnectionIdentity = {
  id: "conn-external-mcp-2",
  organizationId: ORG,
  connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
  connectorKey: "externalMcp",
  connectionId: "external-mcp-343b9466-2a4e-4f52-9d2e-7c4a1f0b55aa",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

const ordinaryRow: NangoConnectionIdentity = {
  id: "conn-github-1",
  organizationId: ORG,
  connectorPackageId: OTHER_CONNECTOR_PACKAGE,
  connectorKey: "github",
  connectionId: "github-conn-1",
  ownerUserId: OWNER,
  createdAt: new Date(),
  deletedAt: null,
};

/** The connect-time grant seed: owner-only and UNTOUCHED. */
const seededOwnerPolicy = {
  seededDefault: true,
  allowRunSharing: false,
  runDataVisibility: ["owner"],
  runListVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
};

/** The MCP Servers connector's OWN declaration (mode default, scope workspace). */
const recommendWorkspace = {
  formatVersion: 1,
  mode: "default",
  scope: "workspace",
  source: "declared",
};

type PanelView = {
  key: string;
  name: string;
  url: string;
  scopeConstraint: string | null;
  permissions: ReactElement;
};

/** Depth-first search of a server component's returned element tree. */
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
  readExtensionAccessPolicy.mockResolvedValue(seededOwnerPolicy);
  readExtensionCoOwners.mockResolvedValue([]);
  readExtensionInstalledBy.mockResolvedValue(null);
  readInstalledExtensionsByPackageName.mockImplementation(async (pkg: string) =>
    pkg === MCP_SERVERS_PACKAGE
      ? [{ organizationId: null, accessDeclaration: recommendWorkspace }]
      : [{ organizationId: ORG, accessDeclaration: null }],
  );
});

describe("ConnectionSharingSection — a server registered on the MCP Servers Setup tab", () => {
  it("is listed on that connector's OWN Sharing tab as one panel", async () => {
    listNangoConnectionsByOwner.mockResolvedValue([externalMcpRow]);

    const rendered = await ConnectionSharingSection({
      packageId: MCP_SERVERS_PACKAGE,
      variant: "tab",
    });

    const panels = panelsOf(rendered);
    expect(panels).not.toBeNull();
    expect(panels).toHaveLength(1);
    expect(panels?.[0].key).toBe(externalMcpRow.id);
    expect(panels?.[0].name).toBe(externalMcpRow.connectionId);
  });

  it("is governed there by the MCP Servers connector's OWN access declaration", async () => {
    listNangoConnectionsByOwner.mockResolvedValue([externalMcpRow]);

    const rendered = await ConnectionSharingSection({
      packageId: MCP_SERVERS_PACKAGE,
      variant: "tab",
    });

    // The declaration read is the PAGE's connector, never the sentinel.
    expect(readInstalledExtensionsByPackageName).toHaveBeenCalledWith(MCP_SERVERS_PACKAGE);
    const panel = panelsOf(rendered)?.[0];
    expect(panel?.scopeConstraint).toBe("recommended");
    const note = (panel?.permissions.props as { accessScopeNote?: string }).accessScopeNote;
    expect(panel?.permissions.type).toBe(ExtensionPermissionsClient);
    expect(note).toContain("This connector recommends sharing with");
    expect(note).toContain("nothing is shared until you save");
  });

  it("appears on NO other connector's Sharing tab", async () => {
    listNangoConnectionsByOwner.mockResolvedValue([externalMcpRow]);

    const rendered = await ConnectionSharingSection({
      packageId: OTHER_CONNECTOR_PACKAGE,
      variant: "tab",
    });

    expect(rendered).toBeNull();
  });

  it("lists an ORG-STAMPED registration (the row shape cinatra#3397 writes) on the same tab, and on no other", async () => {
    listNangoConnectionsByOwner.mockResolvedValue([externalMcpOrgRow]);

    const mcp = await ConnectionSharingSection({
      packageId: MCP_SERVERS_PACKAGE,
      variant: "tab",
    });
    const panels = panelsOf(mcp);
    expect(panels).toHaveLength(1);
    expect(panels?.[0].key).toBe(externalMcpOrgRow.id);
    expect(panels?.[0].scopeConstraint).toBe("recommended");

    const other = await ConnectionSharingSection({
      packageId: OTHER_CONNECTOR_PACKAGE,
      variant: "tab",
    });
    expect(other).toBeNull();
  });

  it("leaves every ordinary row listed by its own package", async () => {
    listNangoConnectionsByOwner.mockResolvedValue([externalMcpRow, ordinaryRow]);

    const own = await ConnectionSharingSection({
      packageId: OTHER_CONNECTOR_PACKAGE,
      variant: "tab",
    });
    const panels = panelsOf(own);
    expect(panels).toHaveLength(1);
    expect(panels?.[0].key).toBe(ordinaryRow.id);

    const mcp = await ConnectionSharingSection({
      packageId: MCP_SERVERS_PACKAGE,
      variant: "tab",
    });
    expect(panelsOf(mcp)?.map((p) => p.key)).toEqual([externalMcpRow.id]);
  });
});
