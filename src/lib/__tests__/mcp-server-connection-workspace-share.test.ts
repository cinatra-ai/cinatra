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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

// --- mocks ----------------------------------------------------------------
let sessionUserId = "u1";
let sessionActiveOrganizationId: string | null = null;
// cinatra#3485: the org/owner derivation has an ADMIN branch (an admin editing
// another person's user row) and a GLOBAL branch, so the actor's standing is a
// per-case flag rather than a constant.
let sessionIsPlatformAdmin = false;

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
  // The Sharing tab reads the actor through `getAuthSession` (cinatra#3485).
  getAuthSession: async () => ({
    user: {
      id: sessionUserId,
      name: "Lane person",
      email: "lane@example.test",
      image: null,
    },
    session: { activeOrganizationId: sessionActiveOrganizationId },
  }),
  isPlatformAdmin: () => sessionIsPlatformAdmin,
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
  // cinatra#3485, the KEYLESS road: the identity registration with no
  // credential half at all. Everything after it — the identity the handler
  // derived and the row the REAL seam stores from it — is the real code.
  externalMcpKeylessConnectionId: (serverId: string) => `external-mcp-keyless-${serverId}`,
  registerExternalMcpKeylessConnectionIdentity: async (
    connectionId: string,
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
  // Mirrors the real helper's IDENTITY-FIRST ordering (its credential leaf is
  // covered by `external-mcp-apikey-connection.test.ts`): soft-delete the live
  // `externalMcp` identity addressed by this connection id, never throw, no-op
  // on an empty id.
  revokeExternalMcpApiKeyConnection: async (connectionId?: string | null) => {
    if (!connectionId) return;
    for (const row of identities.values()) {
      if (
        row.connectorKey === "externalMcp" &&
        row.connectionId === connectionId &&
        row.deletedAt === null
      ) {
        row.deletedAt = new Date();
      }
    }
  },
  // cinatra#3485 (codex convergence finding 4): the KEYLESS identity is retired
  // identity-ONLY — the same soft delete with no credential leaf behind it.
  revokeExternalMcpKeylessConnectionIdentity: async (connectionId?: string | null) => {
    if (!connectionId) return;
    for (const row of identities.values()) {
      if (
        row.connectorKey === "externalMcp" &&
        row.connectionId === connectionId &&
        row.deletedAt === null
      ) {
        row.deletedAt = new Date();
      }
    }
  },
}));

vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  insertNangoConnection: async (input: {
    organizationId: string | null;
    connectorPackageId: string;
    connectorKey: string;
    connectionId: string;
    ownerUserId: string;
  }) => {
    // The store's live-unique (connector_key, connection_id) upsert: an existing
    // LIVE row is RETURNED, never duplicated.
    const existing = [...identities.values()].find(
      (r) =>
        r.connectorKey === input.connectorKey &&
        r.connectionId === input.connectionId &&
        r.deletedAt === null,
    );
    if (existing) return existing;
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
  readNangoConnectionByNaturalKey: async (connectorKey: string, connectionId: string) =>
    [...identities.values()].find(
      (r) =>
        r.connectorKey === connectorKey &&
        r.connectionId === connectionId &&
        r.deletedAt === null,
    ) ?? null,
  // What the Sharing tab reads (cinatra#3485).
  listNangoConnectionsByOwner: async (ownerUserId: string) =>
    [...identities.values()].filter(
      (r) => r.ownerUserId === ownerUserId && r.deletedAt === null,
    ),
  softDeleteNangoConnection: async (id: string) => {
    const row = identities.get(id);
    if (row) row.deletedAt = new Date();
  },
}));

// The policy STORE is the leaf. `writeExtensionAccessPolicy` is the exact row
// write the sanctioned save action performs, so a call on it IS "the policy row
// changes"; a rejected save must never reach it.
const writtenPolicies: Array<{ kind: string; resourceId: string; policy: AgentAuthPolicy }> = [];
// The one-time grant seed the REAL seam writes (cinatra#3485 reads it to prove
// the keyless identity is seeded exactly as the keyed one is).
const seededPolicies = new Map<string, Record<string, unknown>>();
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  seedExtensionAccessPolicyIfAbsent: vi.fn(
    async (kind: string, resourceId: string, policy: Record<string, unknown>) => {
      const key = `${kind}:${resourceId}`;
      if (seededPolicies.has(key)) return false;
      seededPolicies.set(key, policy);
      return true;
    },
  ),
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
  // The MCP Servers connector's OWN registration cache row — the declaration
  // that governs a panel is the declaration of the connector whose page draws
  // it, and a page with no resolvable row hides every panel (cinatra#3485).
  readInstalledExtensionsByPackageName: vi.fn(async (packageName: string) => {
    const { connectionSharingPagePackageId, EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } =
      await import("@/lib/connection-use-gate");
    const page = connectionSharingPagePackageId({
      connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
    } as NangoConnectionIdentity);
    return packageName === page
      ? [
          {
            organizationId: "org-1",
            accessDeclaration: {
              formatVersion: 1,
              mode: "default",
              scope: "workspace",
              source: "declared",
            },
          },
        ]
      : [];
  }),
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
  betterAuthDb: {},
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: "org-1", name: "Lane workspace", teams: [] },
  ]),
  readOrgsWithTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readTeamForOrg: vi.fn(async () => null),
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(async () => null),
}));

// Leaf UI: identity-carrying stand-ins so the panel list is countable. The tab
// body (`ConnectorSharingPanels`) that composes them stays REAL — the same
// posture `ceiling-connector-save-sharing-panel.test.ts` takes.
const stubs = vi.hoisted(() => ({
  ConnectionRowStub: () => null,
  ConnectionsListStub: ({ children }: { children?: unknown }) => children as never,
  ConnectionsStatusCardStub: () => null,
  ExtensionPermissionsClientStub: () => null,
}));
vi.mock("@cinatra-ai/sdk-ui/connections-list", () => ({
  ConnectionsList: stubs.ConnectionsListStub,
  ConnectionRow: stubs.ConnectionRowStub,
}));
vi.mock("@cinatra-ai/sdk-ui/connection-status-card", () => ({
  ConnectionsStatusCard: stubs.ConnectionsStatusCardStub,
}));
vi.mock("@/components/extension-permissions-client", () => ({
  ExtensionPermissionsClient: stubs.ExtensionPermissionsClientStub,
}));

// Import AFTER the mocks are registered.
const { createServerHandler, deleteServerHandler } = await import(
  "@/lib/mcp-server-write-actions"
);
const { connectionSharingPagePackageId, EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } = await import(
  "@/lib/connection-use-gate"
);
const { ConnectionSharingSection } = await import(
  "@/components/extensions/connection-sharing-section"
);
const { ConnectorSharingPanels } = await import(
  "@/components/extensions/connector-sharing-panels"
);
type ConnectorSharingPanelsProps = Parameters<typeof ConnectorSharingPanels>[0];
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
  sessionIsPlatformAdmin = false;
  identities.clear();
  servers.clear();
  writtenPolicies.length = 0;
  seededPolicies.clear();
  identitySeq = 0;
});

// This file's stores are module-level, and `vi.spyOn` is used below — leave the
// process exactly as it was found so the package's FULL run stays green.
afterEach(() => {
  sessionIsPlatformAdmin = false;
  identities.clear();
  servers.clear();
  writtenPolicies.length = 0;
  seededPolicies.clear();
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// cinatra#3485 — the SAME Setup form, with the optional API-key field left
// BLANK. The write road (`createServerHandler` / `deleteServerHandler`), the
// identity seam and the Sharing tab's own listing, filtering and panel
// composition (`ConnectorSharingPanels`) are REAL; only the leaves — the
// credential write, the stores and the leaf UI primitives — are stubbed.
//
// RED at c53ef20642cc6b3562a7ce11af8502dde4136ce6: the whole identity road sits
// inside `if (apiKey)` (src/lib/mcp-server-write-actions.ts:259), so a blank key
// writes NO identity row, `ownRows` is empty and the section returns null
// (src/components/extensions/connection-sharing-section.tsx:157) — zero panels.
// ---------------------------------------------------------------------------

type ElementLike = { type?: unknown; props?: Record<string, unknown> };

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null;
}

/** Walk a rendered element tree and count elements of one component type. */
function countElementsOfType(node: unknown, type: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((n, child) => n + countElementsOfType(child, type), 0);
  }
  if (!isElementLike(node)) return 0;
  const self = node.type === type ? 1 : 0;
  return self + countElementsOfType(node.props?.children, type);
}

/** Collect the props of every element of one component type, in tree order. */
function collectPropsOfType(node: unknown, type: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (!isElementLike(current)) return;
    if (current.type === type && current.props) found.push(current.props);
    walk(current.props?.children);
  };
  walk(node);
  return found;
}

/** The identity rows the seam wrote that are still live. */
function liveIdentities(): NangoConnectionIdentity[] {
  return [...identities.values()].filter((r) => r.deletedAt === null);
}

/** The one-time grant seed written for an identity row. */
function seededPolicyFor(identityId: string): Record<string, unknown> | undefined {
  return seededPolicies.get(`connection:${identityId}`);
}

/** Register a server through the connector's own Setup form with NO API key. */
async function registerKeyless(input: Record<string, unknown> = {}) {
  return createServerHandler({
    label: "Keyless server",
    serverUrl: "https://mcp.example",
    scope: "user",
    ...input,
  });
}

/** The MCP Servers connector's own page — where a sentinel-homed row is listed. */
function mcpServersPagePackageId(): string {
  return connectionSharingPagePackageId({
    connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
  } as NangoConnectionIdentity);
}

/**
 * That page's Sharing tab as a person reaches it: the section renders, and the
 * tab's BODY is the real `ConnectorSharingPanels` the section hands its panel
 * views to.
 */
async function renderMcpServersSharingTab(): Promise<{
  section: unknown;
  panelViews: ConnectorSharingPanelsProps["panels"] | null;
  body: unknown;
}> {
  const section = await ConnectionSharingSection({
    packageId: mcpServersPagePackageId(),
    variant: "tab",
  });
  const [bodyProps] = collectPropsOfType(section, ConnectorSharingPanels);
  if (!bodyProps) return { section, panelViews: null, body: null };
  const props = bodyProps as unknown as ConnectorSharingPanelsProps;
  return { section, panelViews: props.panels, body: ConnectorSharingPanels(props) };
}

describe("a KEYLESS MCP Servers registration writes its connection identity (cinatra#3485)", () => {
  it("writes the `externalMcp` identity row for a server registered with the API-key field left blank, and that connector's Sharing tab draws exactly ONE panel for it", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless();
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorKey: "externalMcp",
      connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
      ownerUserId: "u1",
    });
    const { section, panelViews } = await renderMcpServersSharingTab();
    expect(section).not.toBeNull();
    expect(panelViews).toHaveLength(1);
    expect(panelViews?.[0]).toMatchObject({ name: rows[0].connectionId, url: "externalMcp" });
  });

  it("the tab lists the person's OWN saved connection for this connector — and a person who has saved none sees nothing on it yet", async () => {
    sessionActiveOrganizationId = ORG;
    // Nothing saved here yet: the tab draws nothing at all.
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    await registerKeyless();
    const { section, panelViews } = await renderMcpServersSharingTab();
    expect(section).not.toBeNull();
    expect(panelViews).toHaveLength(1);
    // A connection saved by SOMEONE ELSE is never listed here.
    sessionUserId = "u2";
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("the listed connection is a connection ROW with the access picker and the ownership panel beneath it, and no roll-up above a single connection", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless();
    const { body } = await renderMcpServersSharingTab();
    expect(countElementsOfType(body, stubs.ConnectionRowStub)).toBe(1);
    expect(countElementsOfType(body, stubs.ExtensionPermissionsClientStub)).toBe(1);
    expect(countElementsOfType(body, stubs.ConnectionsStatusCardStub)).toBe(0);
    const [picker] = collectPropsOfType(body, stubs.ExtensionPermissionsClientStub);
    expect(picker.kind).toBe("connection");
    expect(picker.accessHelperText).toBe("Choose who can use this connection.");
    expect(picker.ownershipHelperText).toBe(
      "Owners can change this connection's sharing and disconnect it.",
    );
  });

  it("a self-registered user row carries the acting person's own organization and the never-auto-share OWNER seed", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless();
    const [row] = liveIdentities();
    expect(row.ownerUserId).toBe("u1");
    expect(row.organizationId).toBe(ORG);
    const policy = seededPolicyFor(row.id);
    expect(policy).toBeDefined();
    expect(policy?.runListVisibility).not.toContain("workspace");
  });

  it("an ADMIN editing another person's user row keeps THAT person as the owner and keeps the identity org-less", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    servers.set("srv-of-u2", {
      id: "srv-of-u2",
      scope: "user",
      userId: "u2",
      nangoConnectionId: null,
    });
    await registerKeyless({ id: "srv-of-u2" });
    const [row] = liveIdentities();
    expect(row.ownerUserId).toBe("u2");
    expect(row.organizationId).toBeNull();
    expect(seededPolicyFor(row.id)?.runListVisibility).not.toContain("workspace");
  });

  it("a GLOBAL keyless row takes the session organization and is seeded WORKSPACE, exactly as the keyed road seeds it", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ scope: "global" });
    const [row] = liveIdentities();
    expect(row.ownerUserId).toBe("u1");
    expect(row.organizationId).toBe(ORG);
    expect(seededPolicyFor(row.id)?.runListVisibility).toEqual(["workspace"]);
  });

  it("the stored row still reports NO API key — the identity is addressed by its own derived id, never by a credential pointer", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-no-key" });
    const stored = servers.get("srv-no-key");
    // `apiKeyConfigured` is derived connector-side as `nangoConnectionId != null`.
    expect(stored?.nangoConnectionId).toBeNull();
    expect(liveIdentities()[0].connectionId).toBe("external-mcp-keyless-srv-no-key");
  });

  it("deleting a keyless server soft-deletes the identity it created — no orphan is left on the Sharing tab", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-to-delete" });
    expect(liveIdentities()).toHaveLength(1);
    await deleteServerHandler({ id: "srv-to-delete" });
    expect(liveIdentities()).toHaveLength(0);
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("saving a key onto a keyless server retires its keyless identity — one server, still exactly ONE panel", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-upgraded" });
    await registerKeyless({ id: "srv-upgraded", apiKey: "sk-now-keyed" });
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].connectionId).not.toBe("external-mcp-keyless-srv-upgraded");
    const { panelViews } = await renderMcpServersSharingTab();
    expect(panelViews).toHaveLength(1);
  });

  it("a registration whose identity cannot be written truthfully still SAVES the server", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionActiveOrganizationId = ORG;
    // A FOREIGN live identity already holds this row's derived connection id:
    // the seam hard-fails rather than taking it away from its owner.
    identities.set("identity-foreign", {
      id: "identity-foreign",
      organizationId: ORG,
      connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
      connectorKey: "externalMcp",
      connectionId: "external-mcp-keyless-srv-foreign",
      ownerUserId: "somebody-else",
      createdAt: new Date(),
      deletedAt: null,
    } as NangoConnectionIdentity);
    await expect(registerKeyless({ id: "srv-foreign" })).resolves.toEqual({ banner: "saved" });
    expect(servers.get("srv-foreign")).toBeTruthy();
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].ownerUserId).toBe("somebody-else");
    expect(error).toHaveBeenCalled();
  });
});
