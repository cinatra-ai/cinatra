// @vitest-environment jsdom
//
// The lock glyph marks the ceiling line only (cinatra#3454).
//
// Section II of the connectors drawing, the Sharing tab: "A connector may
// declare a ceiling on how far its connections travel. The picker then renders
// every option above that ceiling locked, each carrying this one sentence as
// its reason, and the same sentence sits under the picker with a lock. Where
// the connector only recommends a scope, the line reads instead This connector
// recommends sharing with your organization ... Currently: only you."
//
// So the ceiling line carries one lock and the recommendation line carries
// none. This suite draws both lines the way the tab draws them: the REAL
// `ConnectionSharingSection` builds the panels from the stored rows (only the
// database leaves are mocked), and each panel's own permissions node, the real
// `ExtensionPermissionsClient` over the real `PermissionsForm`, is rendered.
// The conformance fixture's two variants are rendered too, so the harness
// keeps drawing the same two lines the page draws.

import "@/components/__tests__/access-picker-jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The four server actions the permissions card binds. Nothing in this suite
// presses a button; the card only has to draw.
vi.mock("@cinatra-ai/extensions/permissions-actions", () => ({
  saveExtensionAccessPolicy: vi.fn(async () => ({ ok: true })),
  searchExtensionCoOwnerCandidates: vi.fn(async () => ({
    ok: true,
    results: [],
    hasMore: false,
  })),
  addExtensionCoOwner: vi.fn(async () => ({ ok: true })),
  removeExtensionCoOwner: vi.fn(async () => ({ ok: true })),
}));

const getAuthSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));

const listNangoConnectionsByOwner = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsByOwner: (...a: unknown[]) => listNangoConnectionsByOwner(...a),
}));

// The postgres LEAF: the policy reader above it is the real module.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));

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

import { ConnectionSharingSection } from "@/components/extensions/connection-sharing-section";
import { PermissionsForm } from "@/components/permissions-form";
import { ConnectorSharingFixture } from "@/app/design-fixtures/conformance/connector-sharing-fixture";
import {
  CONNECTOR_SHARING_LOCK_NOTE,
  CONNECTOR_SHARING_RECOMMENDATION_NOTE,
} from "@/app/design-fixtures/conformance/connector-sharing-seed";
import { EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } from "@/lib/connection-use-gate";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

const OWNER = "user-owner";
const ORG = "org-1";

/** A connector that declares a ceiling: its connections stay in the organization. */
const CEILING_PACKAGE = "@acme/ceiling-connector";

/** Derived through the sanctioned catalog registry, no package literal here. */
const MCP_SERVERS_PACKAGE =
  getConnectorDescriptorBySlug("mcp-server-connector")?.packageId ?? "";

/** The ceiling line as section II of the connectors drawing gives it, word for word. */
const CEILING_LINE =
  'Locked by this connector: access is limited to your organization (only:"organization").';

/** The recommendation line, word for word. The dash is U+2014, written as an escape here. */
const RECOMMENDATION_LINE =
  "This connector recommends sharing with your organization \u2014 nothing is shared until you save. Currently: only you.";

/** Exactly what `registerSavedConnectionIdentity` writes at registration. */
const CONNECT_SEED = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
  seededDefault: true,
};

function row(overrides: Partial<NangoConnectionIdentity>): NangoConnectionIdentity {
  return {
    id: "conn-1",
    organizationId: ORG,
    connectorPackageId: CEILING_PACKAGE,
    connectorKey: "acmeCeiling",
    connectionId: "acme-ceiling-1",
    ownerUserId: OWNER,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

/** Draw the Sharing tab for one stored connection and one connector declaration. */
async function drawTab(options: {
  packageId: string;
  identity: NangoConnectionIdentity;
  declaration: Record<string, unknown>;
}) {
  listNangoConnectionsByOwner.mockResolvedValue([options.identity]);
  readInstalledExtensionsByPackageName.mockResolvedValue([
    { organizationId: null, accessDeclaration: options.declaration },
  ]);
  runPostgresQueriesSync.mockReturnValue([
    { rows: [{ resource_id: options.identity.id, policy: CONNECT_SEED }] },
  ]);
  const section = await ConnectionSharingSection({
    packageId: options.packageId,
    variant: "tab",
  });
  expect(section).not.toBeNull();
  render(section as ReactElement);
}

/** The line under the picker that reads exactly `text`. */
function lineReading(text: string): HTMLElement {
  const line = screen.getByText(text);
  expect(line.tagName).toBe("P");
  return line;
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Sharing tab draws the lock on the ceiling line only", () => {
  it("draws exactly one lock in front of a ceiling connector's line", async () => {
    await drawTab({
      packageId: CEILING_PACKAGE,
      identity: row({}),
      declaration: {
        formatVersion: 1,
        mode: "only",
        scope: "organization",
        source: "declared",
      },
    });

    expect(lineReading(CEILING_LINE).querySelectorAll("svg")).toHaveLength(1);
  });

  it("draws no lock in front of a recommending connector's line", async () => {
    await drawTab({
      packageId: MCP_SERVERS_PACKAGE,
      identity: row({
        id: "conn-external-mcp-seeded",
        connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
        connectorKey: "externalMcp",
        connectionId: "external-mcp-4d1c0f8e-2b7a-4a19-9f30-6c51d0a7be22",
      }),
      declaration: {
        formatVersion: 1,
        mode: "default",
        scope: "workspace",
        source: "declared",
      },
    });

    expect(lineReading(RECOMMENDATION_LINE).querySelectorAll("svg")).toHaveLength(0);
  });
});

describe("the permissions card draws the lock only where a ceiling is stated", () => {
  it("draws no lock in front of a line whose kind is not stated", () => {
    render(
      <PermissionsForm
        resourceKind="connection"
        canEdit
        initialPolicy={CONNECT_SEED as never}
        owner={{ userId: OWNER, name: "Owner", email: "owner@example.com", image: null }}
        coOwners={[]}
        availableScopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
        currentUserId={OWNER}
        allowSharing
        actions={{
          savePolicy: async () => ({ ok: true }),
          searchCandidates: async () => ({ ok: true, results: [], hasMore: false }),
          addCoOwner: async () => ({ ok: true }),
          removeCoOwner: async () => ({ ok: true }),
        }}
        accessScopeNote="A line of no stated kind."
      />,
    );

    expect(lineReading("A line of no stated kind.").querySelectorAll("svg")).toHaveLength(0);
  });
});

describe("the conformance harness draws the same two lines the tab draws", () => {
  it("draws one lock in front of the locked variant's line", () => {
    render(<ConnectorSharingFixture variant="locked" />);

    expect(lineReading(CONNECTOR_SHARING_LOCK_NOTE).querySelectorAll("svg")).toHaveLength(1);
  });

  it("draws no lock in front of the recommended variant's line", () => {
    render(<ConnectorSharingFixture variant="recommended" />);

    expect(
      lineReading(CONNECTOR_SHARING_RECOMMENDATION_NOTE).querySelectorAll("svg"),
    ).toHaveLength(0);
  });
});
