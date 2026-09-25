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
// The external-MCP server rows the write handler persists. `createdAt` and
// `updatedAt` are the stamps a real store keeps (cinatra#3485 fix leg 2): a row
// a case places by hand starts without them, exactly as a legacy row does.
const servers = new Map<
  string,
  {
    id: string;
    scope: string;
    userId: string | null;
    // The configuration a save wrote, so a case can say WHOSE save the row that
    // stands is holding (cinatra#3485 fix leg 4).
    label?: string;
    nangoConnectionId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }
>();

// The store clock. Every write reads it once, so two writes are two instants and
// no case depends on a wall clock.
let storeClock = 0;
function nextStamp(): string {
  storeClock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, storeClock)).toISOString();
}
// A row a case places by hand is a row that was ALREADY THERE when the case
// began. The columns are NOT NULL in the store, so such a row carries stamps
// too, and they are older than anything this case writes.
const PLACED_BEFORE = "2025-12-31T00:00:00.000Z";
function stampsOf(row: { createdAt?: string; updatedAt?: string } | undefined): {
  createdAt: string;
  updatedAt: string;
} {
  return {
    createdAt: row?.createdAt ?? PLACED_BEFORE,
    updatedAt: row?.updatedAt ?? PLACED_BEFORE,
  };
}

// cinatra#3485 fix leg: deterministic stand-ins for the two things a wall
// clock would otherwise have to produce: a CONCURRENT request that lands
// between this save's row write and its identity registration, and a retire
// that fails once. Both fire from inside the mocked road, so the interleaving
// is exact and carries no timing.
let onServerRowWritten: (() => void | Promise<void>) | null = null;
let onKeylessIdentityRegister: (() => void | Promise<void>) | null = null;
let onAfterKeylessRetire: (() => void | Promise<void>) | null = null;
let onAfterKeylessIdentityRead: (() => void | Promise<void>) | null = null;
// The window BEFORE a retire writes (cinatra#3485 fix leg 5). The take-back
// addresses the identity row the registration itself reported, so it takes no
// read of its own any more, and this is where a racing request changes what
// stands while the retire is on its way.
let onBeforeKeylessRetire: (() => void | Promise<void>) | null = null;
// The window BEFORE an identity read resolves, as against the one after it: a
// request that runs here changes WHAT the read returns, and a request that runs
// after it changes what stands once the caller already holds its answer.
let onBeforeKeylessIdentityRead: (() => void | Promise<void>) | null = null;
let keylessRetireFailsOnce = false;
let identitySeedFailsOnce = false;

/**
 * The witnessed keyless retire the registry performs. Best-effort like the real
 * helper: a store failure is logged and swallowed, so the caller sees a retire
 * that retired nothing. `onlyWhile` is the caller's own condition, asked
 * immediately before the write rather than on an earlier read.
 */
async function keylessRetire(
  identityId: string,
  onlyWhile: (() => boolean) | undefined,
): Promise<void> {
  const afterRetire = onAfterKeylessRetire;
  await onBeforeKeylessRetire?.();
  if (keylessRetireFailsOnce) {
    keylessRetireFailsOnce = false;
    return;
  }
  if (onlyWhile !== undefined && !onlyWhile()) return;
  const row = identities.get(identityId);
  if (row && row.deletedAt === null) row.deletedAt = new Date();
  // The window a racing request runs in, named from the retire itself: on the
  // delete road this is the point where the retire has happened and the row
  // delete has not.
  await afterRetire?.();
}

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
  getExternalMcpServerByIdFresh: (id: string) => {
    const row = servers.get(id);
    return row ? { ...row, ...stampsOf(row) } : null;
  },
  // cinatra#3485 fix leg 2: one reading of a stamp, for both sides of a
  // comparison, mirroring the real helper.
  normalizeExternalMcpRowStamp: (value: unknown) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
  // A COPY, as a real store hands back: the handler must never be able to read
  // its own row object back and see itself unchanged. The write also STAMPS the
  // row and hands its stamps back: an INSERT mints a creation instant, an UPDATE
  // leaves it standing and mints a new update instant.
  insertExternalMcpServerStrict: (input: {
    id: string;
    scope: string;
    userId: string | null;
    label?: string;
  }) => {
    const stamp = nextStamp();
    servers.set(input.id, { ...input, createdAt: stamp, updatedAt: stamp });
    void onServerRowWritten?.();
    return { createdAt: stamp, updatedAt: stamp };
  },
  updateExternalMcpServerGuarded: (input: {
    id: string;
    scope: string;
    userId: string | null;
    label?: string;
  }) => {
    const { createdAt } = stampsOf(servers.get(input.id));
    const updatedAt = nextStamp();
    servers.set(input.id, { ...input, createdAt, updatedAt });
    void onServerRowWritten?.();
    return { createdAt, updatedAt };
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
    // cinatra#3485 fix leg 5: what THIS call did with the identity row, which
    // only the store's own insert can answer.
    report?: (written: { identityId: string; created: boolean }) => void,
  ) => {
    await onKeylessIdentityRegister?.();
    const { registerSavedConnectionIdentity } = await import("@/lib/connection-identity-seam");
    const row = await registerSavedConnectionIdentity({
      connectorKey: "externalMcp",
      connectionId,
      ownerUserId: identity.ownerUserId,
      organizationId: identity.organizationId,
      seed: identity.seed,
      onIdentityRow: (written) => report?.({ identityId: written.id, created: written.created }),
    });
    return { created: row.created };
  },
  // The live identity the derived id addresses, the leaf read the handler
  // reconciles its owner and workspace against (cinatra#3485 fix leg). Exactly
  // the store read the real helper performs, no decision of its own.
  readExternalMcpKeylessConnectionIdentity: async (connectionId: string) => {
    // The window BEFORE the read resolves: a racing request that deletes the
    // row and registers the same id again here is a request whose identity this
    // read HANDS BACK, which is how one person's save comes to hold another
    // person's identity row.
    await onBeforeKeylessIdentityRead?.();
    const found =
      [...identities.values()].find(
        (r) =>
          r.connectorKey === "externalMcp" &&
          r.connectionId === connectionId &&
          r.deletedAt === null,
      ) ?? null;
    // The window after the caller has the row it witnessed and before it acts
    // on it: a racing request can replace the identity here.
    await onAfterKeylessIdentityRead?.();
    return found;
  },
  // cinatra#3485: the KEYLESS identity is retired identity-ONLY, and addressed
  // by its own row id, so it retires exactly what was witnessed and passes over
  // a row already retired. Best-effort like the real helper: a store failure is
  // logged and swallowed, so the caller sees a retire that retired nothing.
  // cinatra#3485 fix leg 5: the caller's own condition travels down to the
  // write, so the store asks it once more before it retires anything.
  retireExternalMcpKeylessConnectionIdentityRow: async (
    identityId: string,
    onlyWhile?: () => boolean,
  ) => {
    await keylessRetire(identityId, onlyWhile);
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
    if (existing) return { ...existing, created: false };
    const row = {
      id: `identity-${++identitySeq}`,
      ...input,
      createdAt: new Date(),
      deletedAt: null,
    } as NangoConnectionIdentity;
    identities.set(row.id, row);
    return { ...row, created: true };
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
      // The seam writes the identity row and seeds its grant as two writes: this
      // is a failure of the SECOND, with the first already landed.
      if (identitySeedFailsOnce) {
        identitySeedFailsOnce = false;
        throw new Error("the grant seed could not be written");
      }
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
  onServerRowWritten = null;
  onKeylessIdentityRegister = null;
  onAfterKeylessRetire = null;
  onBeforeKeylessRetire = null;
  onAfterKeylessIdentityRead = null;
  onBeforeKeylessIdentityRead = null;
  keylessRetireFailsOnce = false;
  identitySeedFailsOnce = false;
  storeClock = 0;
});

// This file's stores are module-level, and `vi.spyOn` is used below — leave the
// process exactly as it was found so the package's FULL run stays green.
afterEach(() => {
  sessionIsPlatformAdmin = false;
  identities.clear();
  servers.clear();
  writtenPolicies.length = 0;
  seededPolicies.clear();
  onServerRowWritten = null;
  onKeylessIdentityRegister = null;
  onAfterKeylessRetire = null;
  onBeforeKeylessRetire = null;
  onAfterKeylessIdentityRead = null;
  onBeforeKeylessIdentityRead = null;
  keylessRetireFailsOnce = false;
  identitySeedFailsOnce = false;
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

/** Live keyless identities with no server row behind them (cinatra#3485). */
function orphanKeylessIdentities(): string[] {
  const prefix = "external-mcp-keyless-";
  return [...identities.values()]
    .filter(
      (r) =>
        r.deletedAt === null &&
        r.connectionId.startsWith(prefix) &&
        !servers.has(r.connectionId.slice(prefix.length)),
    )
    .map((r) => r.connectionId);
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

  /** A foreign live identity already holding a row's derived connection id. */
  function placeForeignIdentityFor(serverId: string) {
    identities.set(`identity-foreign-${serverId}`, {
      id: `identity-foreign-${serverId}`,
      organizationId: ORG,
      connectorPackageId: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
      connectorKey: "externalMcp",
      connectionId: `external-mcp-keyless-${serverId}`,
      ownerUserId: "somebody-else",
      createdAt: new Date(),
      deletedAt: null,
    } as NangoConnectionIdentity);
  }

  // cinatra#3485 fix leg 4, the seventh round, finding 2 MOVED this case's
  // outcome. A CREATE that would land a row under an id somebody else's
  // identity holds was reported as saved, and the panel stayed with that
  // person; it is refused before the row is written now.
  it("a registration at an id a FOREIGN identity already holds is refused, and no row lands", async () => {
    sessionActiveOrganizationId = ORG;
    placeForeignIdentityFor("srv-foreign");
    await expect(registerKeyless({ id: "srv-foreign" })).rejects.toThrow(
      /another person's saved connection/i,
    );
    expect(servers.get("srv-foreign")).toBeUndefined();
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].ownerUserId).toBe("somebody-else");
  });

  // The best-effort contract this case was written for STANDS where the
  // refusal can only be met after the row is already there: the row write has
  // landed, and an identity that cannot be written truthfully must never turn a
  // saved server into an error.
  it("an EDIT whose identity cannot be written truthfully still SAVES the server", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionActiveOrganizationId = ORG;
    servers.set("srv-foreign-edit", {
      id: "srv-foreign-edit",
      scope: "user",
      userId: "u1",
      nangoConnectionId: null,
    });
    placeForeignIdentityFor("srv-foreign-edit");
    await expect(registerKeyless({ id: "srv-foreign-edit" })).resolves.toEqual({
      banner: "saved",
    });
    expect(servers.get("srv-foreign-edit")).toBeTruthy();
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].ownerUserId).toBe("somebody-else");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485, the fix leg: the keyless identity under CONCURRENCY, after a
// retire that failed, and across a change of who owns the row.
//
// Three rules, measured here from the outside:
//   • the identity is registered only for a row that STILL exists and is STILL
//     keyless when the registration lands, so a save that lost the race to a
//     key or to a delete leaves nothing behind;
//   • every KEYED save and every delete retires a keyless identity that is
//     still live, so a retire that failed once is reconciled by the next save
//     instead of standing for ever;
//   • a save that moves the row to a new owner or a new workspace moves the
//     identity with it, so the panel and the authority to edit its sharing
//     follow the row.
// ---------------------------------------------------------------------------
describe("the keyless identity never outlives the row it describes (cinatra#3485)", () => {
  it("a repeated keyless save keeps exactly ONE identity and never re-seeds its grant", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-twice" });
    const first = liveIdentities()[0];
    await registerKeyless({ id: "srv-twice", label: "Renamed" });
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].id).toBe(first.id);
    expect(seededPolicies.size).toBe(1);
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });

  it("a row DELETED between its write and its identity registration never gets an identity at all", async () => {
    sessionActiveOrganizationId = ORG;
    // The other request deletes the server the moment this save's row write
    // lands, before this save reaches its registration.
    onServerRowWritten = () => {
      servers.delete("srv-gone");
    };
    await expect(registerKeyless({ id: "srv-gone" })).resolves.toEqual({ banner: "saved" });
    expect(liveIdentities()).toHaveLength(0);
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("a key saved on the row WHILE this registration is in flight leaves ONE panel, not two", async () => {
    sessionActiveOrganizationId = ORG;
    // The other request stores a key and retires the keyless identity while
    // this save is inside its own registration: there is nothing to retire yet,
    // so this save has to take its own insert back.
    onKeylessIdentityRegister = () => {
      const row = servers.get("srv-raced-key");
      if (row) row.nangoConnectionId = "external-mcp-from-the-other-request";
    };
    await registerKeyless({ id: "srv-raced-key" });
    expect(liveIdentities().map((r) => r.connectionId)).not.toContain(
      "external-mcp-keyless-srv-raced-key",
    );
  });

  it("a DELETE while this registration is in flight leaves no orphan panel for a server that is gone", async () => {
    sessionActiveOrganizationId = ORG;
    onKeylessIdentityRegister = () => {
      servers.delete("srv-raced-delete");
    };
    await registerKeyless({ id: "srv-raced-delete" });
    expect(liveIdentities()).toHaveLength(0);
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("a keyed save whose keyless retire FAILED is reconciled by the next save, not left as a second panel for ever", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-upgrade-retry" });
    expect(liveIdentities()).toHaveLength(1);
    // The upgrade stores the key, and its cleanup fails: both are live now.
    keylessRetireFailsOnce = true;
    await registerKeyless({ id: "srv-upgrade-retry", apiKey: "sk-first" });
    expect(liveIdentities()).toHaveLength(2);
    // ANY later save of the same row reconciles it back to one panel.
    await registerKeyless({ id: "srv-upgrade-retry", apiKey: "sk-second" });
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].connectionId).not.toBe("external-mcp-keyless-srv-upgrade-retry");
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });

  it("a keyless row an admin PROMOTES to global moves the identity to its new owner, and the previous owner keeps no panel", async () => {
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-promoted" });
    expect(liveIdentities()[0].ownerUserId).toBe("u2");
    // The same row, promoted: the connection is the platform's now, owned by
    // the registering admin and workspace-seeded.
    sessionUserId = "u1";
    sessionIsPlatformAdmin = true;
    await registerKeyless({ id: "srv-promoted", scope: "global" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u1");
    expect(seededPolicyFor(rows[0].id)?.runListVisibility).toEqual(["workspace"]);
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
    // The previous owner no longer draws a panel for a row that is not theirs.
    sessionUserId = "u2";
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("a keyless row re-saved from a DIFFERENT workspace re-homes its identity to that workspace", async () => {
    sessionActiveOrganizationId = "org-1";
    await registerKeyless({ id: "srv-moved" });
    expect(liveIdentities()[0].organizationId).toBe("org-1");
    sessionActiveOrganizationId = "org-2";
    await registerKeyless({ id: "srv-moved" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe("org-2");
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });

  it("an ADMIN editing another person's keyless row never re-homes it: the owner and their workspace stand", async () => {
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-of-u2-edited" });
    const before = liveIdentities()[0];
    expect(before.organizationId).toBe(ORG);
    sessionUserId = "u1";
    sessionIsPlatformAdmin = true;
    await registerKeyless({ id: "srv-of-u2-edited", label: "Renamed by an admin" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].ownerUserId).toBe("u2");
    expect(rows[0].organizationId).toBe(ORG);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485, the fix leg, second opinion round 1. Four orderings a reviewer
// put to the fix, each of them pinned here by the outcome it must produce.
// ---------------------------------------------------------------------------
describe("the keyless identity road under a lost race (cinatra#3485)", () => {
  it("a save that LOST its row to a promotion never takes the new owner's identity away", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionUserId = "u2";
    sessionActiveOrganizationId = ORG;
    // An admin promotes the same row to global while this save is inside its own
    // registration: the row this save wrote is no longer the row it describes.
    onKeylessIdentityRegister = async () => {
      onKeylessIdentityRegister = null;
      sessionUserId = "u1";
      sessionIsPlatformAdmin = true;
      await createServerHandler({
        id: "srv-lost",
        label: "Promoted",
        serverUrl: "https://mcp.example",
        scope: "global",
      });
      sessionUserId = "u2";
      sessionIsPlatformAdmin = false;
    };
    await registerKeyless({ id: "srv-lost" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u1");
    // The person who lost the race draws no panel for a row that is not theirs.
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("a DELETE never leaves a panel for a server row that is gone, whatever a racing save does in its window", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-del-race" });
    // A racing save runs its WHOLE road in the window this delete's own retire
    // opens: it writes the row, registers the identity and re-reads the row,
    // all of it while this delete has not removed the row yet.
    onAfterKeylessRetire = async () => {
      onAfterKeylessRetire = null;
  onAfterKeylessIdentityRead = null;
      await registerKeyless({ id: "srv-del-race" });
    };
    await deleteServerHandler({ id: "srv-del-race" });
    // The invariant, whichever request won: no live keyless identity stands for
    // a server row that is not there.
    expect(orphanKeylessIdentities()).toEqual([]);
  });

  it("a grant seed that fails AFTER the identity row landed leaves no second panel behind", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionActiveOrganizationId = ORG;
    // The other request stores a key on the row while this save is registering,
    // and this save's grant seed then fails with its identity row already in.
    onKeylessIdentityRegister = () => {
      const row = servers.get("srv-seed-fail");
      if (row) row.nangoConnectionId = "external-mcp-from-the-other-request";
    };
    identitySeedFailsOnce = true;
    await registerKeyless({ id: "srv-seed-fail" });
    expect(liveIdentities().map((r) => r.connectionId)).not.toContain(
      "external-mcp-keyless-srv-seed-fail",
    );
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("a delete whose identity retire FAILED is repaired by deleting the same server again", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-del-retry" });
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-del-retry" });
    // The row is gone and its identity outlived it.
    expect(servers.get("srv-del-retry")).toBeUndefined();
    expect(liveIdentities()).toHaveLength(1);
    // Deleting the server again reconciles the orphan the first delete left.
    await deleteServerHandler({ id: "srv-del-retry" });
    expect(liveIdentities()).toHaveLength(0);
    expect((await renderMcpServersSharingTab()).section).toBeNull();
  });

  it("a stranger's orphan identity is never retired by someone else's delete of a row that is gone", async () => {
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-orphan" });
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-orphan" });
    expect(liveIdentities()).toHaveLength(1);
    // Another person, no admin standing, deleting the same absent id.
    sessionUserId = "u1";
    await deleteServerHandler({ id: "srv-orphan" });
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].ownerUserId).toBe("u2");
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485, the fix leg, second opinion round 2. Three orderings and inputs
// that must not let one person's save take an identity away from another.
// ---------------------------------------------------------------------------
describe("the keyless identity road never retires what it may not (cinatra#3485)", () => {
  it("a save that lost its row BETWEEN its two reads writes nothing at all", async () => {
    sessionUserId = "u2";
    sessionActiveOrganizationId = "org-1";
    await registerKeyless({ id: "srv-late-loss" });
    expect(liveIdentities()[0].ownerUserId).toBe("u2");
    // The same person re-saves from a different workspace, so this save DOES
    // mean to reconcile the identity it is about to read. The admin's promotion
    // completes in the window between that read and acting on it.
    sessionActiveOrganizationId = "org-2";
    onAfterKeylessIdentityRead = async () => {
      onAfterKeylessIdentityRead = null;
      sessionUserId = "u1";
      sessionIsPlatformAdmin = true;
      await createServerHandler({
        id: "srv-late-loss",
        label: "Promoted",
        serverUrl: "https://mcp.example",
        scope: "global",
      });
      sessionUserId = "u2";
      sessionIsPlatformAdmin = false;
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await registerKeyless({ id: "srv-late-loss" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u1");
    expect(seededPolicyFor(rows[0].id)).toBeDefined();
    // The save that lost the row never reached the seam at all, so it wrote
    // nothing and had nothing refused.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("the take-back retires the identity it WITNESSED, never one registered after it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionUserId = "u2";
    sessionActiveOrganizationId = ORG;
    // This save's row is taken over right after its own identity landed, so its
    // take-back runs. In the window of the take-back's read, the admin replaces
    // the identity with one of their own.
    onKeylessIdentityRegister = () => {
      onKeylessIdentityRegister = null;
      const row = servers.get("srv-witness");
      if (row) {
        row.scope = "global";
        row.userId = null;
      }
      onBeforeKeylessRetire = async () => {
        onBeforeKeylessRetire = null;
        sessionUserId = "u1";
        sessionIsPlatformAdmin = true;
        await createServerHandler({
          id: "srv-witness",
          label: "Promoted",
          serverUrl: "https://mcp.example",
          scope: "global",
        });
        sessionUserId = "u2";
        sessionIsPlatformAdmin = false;
      };
    };
    await registerKeyless({ id: "srv-witness" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u1");
    error.mockRestore();
  });

  // cinatra#3485 fix leg 4, the seventh round, finding 2 MOVED this case's
  // outcome. The earlier ruling stands: another person's save never takes the
  // orphan away. What changes is the answer the person gets. Registering a
  // server at an id another person's identity still holds used to be reported
  // as SAVED while the panel stayed with that person, and no later save of the
  // new row could repair it. It is refused instead, before the row is written,
  // and the caller is told what is in the way.
  it("registering a server at an id another person's orphan identity still holds is REFUSED, and their orphan stands", async () => {
    sessionActiveOrganizationId = ORG;
    // The victim's delete leaves an orphan identity behind.
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-reused" });
    const orphan = liveIdentities()[0];
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-reused" });
    expect(liveIdentities()).toHaveLength(1);
    // Another person registers a server under the SAME id: refused, and NO row
    // is written, so nobody owns a configuration whose panel is somebody
    // else's.
    sessionUserId = "u1";
    await expect(registerKeyless({ id: "srv-reused" })).rejects.toThrow(
      /another person's saved connection/i,
    );
    expect(servers.get("srv-reused")).toBeUndefined();
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(rows[0].ownerUserId).toBe("u2");
  });

  it("a platform admin's replacement at that id is refused too, and their delete of the absent id is the repair", async () => {
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-admin-reused" });
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-admin-reused" });
    expect(liveIdentities()).toHaveLength(1);
    // Platform standing does not make somebody else's identity this save's to
    // write over: the admin is refused exactly as anybody else is.
    sessionUserId = "u1";
    sessionIsPlatformAdmin = true;
    await expect(registerKeyless({ id: "srv-admin-reused", scope: "global" })).rejects.toThrow(
      /another person's saved connection/i,
    );
    expect(servers.get("srv-admin-reused")).toBeUndefined();
    // The road the orphan was always repaired on is still open to the admin,
    // and the id is free once they take it.
    await deleteServerHandler({ id: "srv-admin-reused" });
    expect(liveIdentities()).toHaveLength(0);
    await registerKeyless({ id: "srv-admin-reused", scope: "global" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u1");
  });

  it("registering a server at an id the SAME person's orphan holds is not a collision at all", async () => {
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-own-reused" });
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-own-reused" });
    expect(liveIdentities()).toHaveLength(1);
    // Their own orphan is their own to write over, and the row they register
    // keeps exactly one panel.
    await registerKeyless({ id: "srv-own-reused" });
    expect(servers.get("srv-own-reused")).toBeTruthy();
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("u2");
    expect(orphanKeylessIdentities()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485, the fix leg, second opinion round 3. A server registered again
// at the same id, in the window of each reconciling read. Every retire re-reads
// the row between reading the identity and retiring it, so none of them takes
// away an identity that a save which WON legitimately holds.
// ---------------------------------------------------------------------------
describe("no retire takes away the identity of a server registered again (cinatra#3485)", () => {
  it("the DELETE road leaves the identity of a server registered again at the same id in its window", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-recreated" });
    onAfterKeylessIdentityRead = async () => {
      onAfterKeylessIdentityRead = null;
      await registerKeyless({ id: "srv-recreated" });
    };
    await deleteServerHandler({ id: "srv-recreated" });
    expect(servers.get("srv-recreated")).toBeTruthy();
    expect(liveIdentities()).toHaveLength(1);
    expect(orphanKeylessIdentities()).toEqual([]);
  });

  it("a KEYED save leaves the identity of a row that became keyless again in its window", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-flip" });
    onAfterKeylessIdentityRead = () => {
      onAfterKeylessIdentityRead = null;
      servers.set("srv-flip", {
        id: "srv-flip",
        scope: "user",
        userId: "u1",
        nangoConnectionId: null,
      });
    };
    await registerKeyless({ id: "srv-flip", apiKey: "sk-x" });
    expect(liveIdentities().map((r) => r.connectionId)).toContain("external-mcp-keyless-srv-flip");
  });

  // cinatra#3485 fix leg 2 MOVED this case's outcome. A row REGISTERED AGAIN at
  // the same id is a different row, and the second opinion put the reason
  // plainly: reading only the scope, the owner and the missing key leaves this
  // save's identity standing on a server somebody ELSE registered, with the
  // authority to share it. The take-back reads the row's creation instant, so it
  // takes back what it wrote whoever the other person is. The price is here:
  // when the SAME person re-created the row, they lose the panel until their
  // next save. That is the fail-closed direction, and the case below pins the
  // repair. A row merely SAVED again is NOT this case: see the case that keeps
  // the identity, and its sharing, through a concurrent save.
  it("the TAKE-BACK takes back what it wrote even from a row registered again at the same id", async () => {
    sessionActiveOrganizationId = ORG;
    // The row is deleted right after this save's identity landed, so its
    // take-back runs; the row is registered again inside that take-back's read.
    onKeylessIdentityRegister = () => {
      onKeylessIdentityRegister = null;
      servers.delete("srv-back");
      onBeforeKeylessRetire = async () => {
        onBeforeKeylessRetire = null;
        await registerKeyless({ id: "srv-back" });
      };
    };
    await registerKeyless({ id: "srv-back" });
    // The row that came back stands, without the identity of the save that lost
    // it, and with no orphan left anywhere.
    expect(servers.get("srv-back")).toBeTruthy();
    expect(liveIdentities()).toHaveLength(0);
    expect(orphanKeylessIdentities()).toEqual([]);
    // The next save of that row draws its panel again.
    await registerKeyless({ id: "srv-back" });
    expect(liveIdentities()).toHaveLength(1);
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });

  it("the ALREADY-GONE delete branch leaves the identity of a server created in its window", async () => {
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-gone-race" });
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-gone-race" });
    expect(liveIdentities()).toHaveLength(1);
    onAfterKeylessIdentityRead = async () => {
      onAfterKeylessIdentityRead = null;
      await registerKeyless({ id: "srv-gone-race" });
    };
    await deleteServerHandler({ id: "srv-gone-race" });
    expect(servers.get("srv-gone-race")).toBeTruthy();
    expect(liveIdentities()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485, the fix leg's second leg. TWO PEOPLE AND ONE ID. A server id is
// supplied by the caller, so a person who deletes a server may register the same
// id again, and the row that lands then carries the same scope, the same absent
// owner and the same missing key as the row somebody else's save is still on its
// way to. The identity of the ROW is what tells them apart: a row registered
// again was CREATED again, and a save that reads a creation instant it never
// wrote is a save looking at somebody else's server.
// ---------------------------------------------------------------------------
describe("a server registered again at the same id is not the row this save wrote (cinatra#3485)", () => {
  it("a keyless GLOBAL row deleted and registered again by ANOTHER admin keeps ITS identity, and this save writes nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    sessionUserId = "admin-a";
    await registerKeyless({ id: "srv-two-admins", scope: "global" });
    expect(liveIdentities()).toHaveLength(1);
    expect(liveIdentities()[0].ownerUserId).toBe("admin-a");
    // The first admin saves the same server again and pauses before the read of
    // its identity returns. The second admin deletes the server and registers
    // the same id again, keyless and global, so the identity that read hands
    // back is the second admin's.
    onBeforeKeylessIdentityRead = async () => {
      onBeforeKeylessIdentityRead = null;
      sessionUserId = "admin-b";
      await deleteServerHandler({ id: "srv-two-admins" });
      await registerKeyless({ id: "srv-two-admins", scope: "global" });
      sessionUserId = "admin-a";
    };
    await registerKeyless({ id: "srv-two-admins", scope: "global" });
    // The replacement keeps the identity its own registration wrote: the first
    // admin never retires it and never registers over it.
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-b");
    expect(orphanKeylessIdentities()).toEqual([]);
    // Nothing was refused either: the save that lost the row never reached the
    // seam at all.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("the person who lost the row gets their panel back on their NEXT save, and takes no one else's", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    sessionUserId = "admin-a";
    await registerKeyless({ id: "srv-two-admins-again", scope: "global" });
    onBeforeKeylessIdentityRead = async () => {
      onBeforeKeylessIdentityRead = null;
      sessionUserId = "admin-b";
      await deleteServerHandler({ id: "srv-two-admins-again" });
      await registerKeyless({ id: "srv-two-admins-again", scope: "global" });
      sessionUserId = "admin-a";
    };
    await registerKeyless({ id: "srv-two-admins-again", scope: "global" });
    expect(liveIdentities()[0].ownerUserId).toBe("admin-b");
    // The second admin owns the server now, and a save of their own keeps it.
    sessionUserId = "admin-b";
    await registerKeyless({ id: "srv-two-admins-again", scope: "global" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-b");
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485 fix leg 2, second opinion round 1. The same two people and the
// same id, one window later: this save's identity lands on a replacement row
// that another admin created while the save was on its way to the seam. Reading
// the scope, the owner and the missing key says the identity belongs there, and
// it does not: the row is somebody else's server.
// ---------------------------------------------------------------------------
describe("an identity never stays on a replacement row this save never wrote (cinatra#3485)", () => {
  it("a replacement ANOTHER admin created while this save was registering never keeps this save's identity", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    sessionUserId = "admin-a";
    // The first admin's save is inside its own registration when the second
    // admin deletes the server and lands a replacement row at the same id. The
    // replacement's own identity is not written yet, so the identity that lands
    // on it is the first admin's.
    onKeylessIdentityRegister = async () => {
      onKeylessIdentityRegister = null;
      sessionUserId = "admin-b";
      await deleteServerHandler({ id: "srv-replaced" });
      servers.set("srv-replaced", {
        id: "srv-replaced",
        scope: "global",
        userId: null,
        nangoConnectionId: null,
        createdAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      });
      sessionUserId = "admin-a";
    };
    await registerKeyless({ id: "srv-replaced", scope: "global" });
    // The replacement carries no identity of the person who never registered
    // it, so nobody holds sharing authority over somebody else's server.
    expect(liveIdentities()).toHaveLength(0);
    expect(orphanKeylessIdentities()).toEqual([]);
    sessionUserId = "admin-a";
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    // The admin whose server it is gets the panel on their own next save.
    sessionUserId = "admin-b";
    await registerKeyless({ id: "srv-replaced", scope: "global" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-b");
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485 fix leg 2, second opinion round 2. The other half of the same
// question. A row written again is still the row the identity was written for,
// and the identity row is what a sharing policy hangs on: retiring it because
// somebody saved the server again would hand the next registration a FRESH
// identity, seeded at the scope's default, and a policy an owner narrowed by
// hand would silently widen without anybody editing the sharing.
// ---------------------------------------------------------------------------
describe("a row SAVED again keeps its identity, and the sharing set on it (cinatra#3485)", () => {
  it("a concurrent save of the same row by the same person keeps the identity row the policy hangs on", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    await registerKeyless({ id: "srv-resaved", scope: "global" });
    const before = liveIdentities()[0];
    // The admin narrows that connection's sharing by hand, through the same
    // sanctioned save action the Sharing tab calls.
    expect(await saveExtensionAccessPolicy("connection", before.id, policyOf("owner"))).toEqual({
      ok: true,
    });
    expect(writtenPolicies).toHaveLength(1);
    expect(writtenPolicies[0].resourceId).toBe(before.id);
    // A second save of the SAME server lands while this one is inside its
    // registration. Nothing about the row moves except the instant it was
    // written.
    onKeylessIdentityRegister = async () => {
      onKeylessIdentityRegister = null;
      await registerKeyless({ id: "srv-resaved", scope: "global" });
    };
    await registerKeyless({ id: "srv-resaved", scope: "global" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    // The very same identity row, so the narrowed policy written against it
    // still governs, and no second grant seed was written at the default.
    expect(rows[0].id).toBe(before.id);
    expect(seededPolicies.size).toBe(1);
    expect(writtenPolicies).toHaveLength(1);
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485 fix leg 3, the sixth read-only round. TWO PEOPLE saving the SAME
// row, and an orphan identity left at an id somebody else now holds. The first
// is about which save's identity may stand on a row both of them wrote; the
// second about which save may take an identity away at all.
// ---------------------------------------------------------------------------
describe("two admins saving one row: the identity follows the write that stands (cinatra#3485)", () => {
  it("an identity that landed while ANOTHER admin's save was registering never keeps that row's sharing authority", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    sessionUserId = "admin-a";
    // The exact interleaving, with no wall clock in it. The first admin creates
    // the row and pauses inside its registration. The second admin's save of the
    // SAME row lands its write, reads no identity at all, passes its guards and
    // pauses inside its own registration. Only then does the first admin's
    // identity land.
    let secondAdminHasParked = () => {};
    const secondAdminParked = new Promise<void>((resolve) => {
      secondAdminHasParked = resolve;
    });
    let releaseSecondAdmin = () => {};
    const secondAdminMayGo = new Promise<void>((resolve) => {
      releaseSecondAdmin = resolve;
    });
    let secondAdminSave: Promise<unknown> | null = null;
    onKeylessIdentityRegister = async () => {
      // The next registration to reach this hook is the second admin's: it
      // parks there until the first admin's save has finished entirely.
      onKeylessIdentityRegister = async () => {
        onKeylessIdentityRegister = null;
        secondAdminHasParked();
        await secondAdminMayGo;
      };
      sessionUserId = "admin-b";
      secondAdminSave = registerKeyless({ id: "srv-two-admins", scope: "global" });
      await secondAdminParked;
      sessionUserId = "admin-a";
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await registerKeyless({ id: "srv-two-admins", scope: "global" });
    releaseSecondAdmin();
    await secondAdminSave;
    // The row holds the second admin's write, so the identity on it names the
    // second admin: one live identity, one panel, and the first admin holds no
    // sharing authority over a configuration they did not save.
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-b");
    expect(orphanKeylessIdentities()).toEqual([]);
    sessionUserId = "admin-a";
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    sessionUserId = "admin-b";
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
    error.mockRestore();
  });

  // The pin the retrying pass above must not break. It is green on both sides
  // of the fix by design: what it measures is the BOUND, that a save which lost
  // its row to a later write writes nothing at all, however many times it is
  // refused.
  it("the second pass never registers on a row a THIRD write has moved: the losing save writes nothing", async () => {
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    sessionUserId = "admin-a";
    await registerKeyless({ id: "srv-third", scope: "global" });
    // The second admin's save is inside its registration when a third write of
    // the same row lands, with an identity of its own. The second admin's
    // registration is refused, and the row it wrote is no longer the row that
    // stands, so its second pass refuses too.
    sessionUserId = "admin-b";
    onKeylessIdentityRegister = async () => {
      onKeylessIdentityRegister = null;
      sessionUserId = "admin-a";
      await registerKeyless({ id: "srv-third", scope: "global" });
      sessionUserId = "admin-b";
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await registerKeyless({ id: "srv-third", scope: "global" });
    // The person who wrote the row that stands holds the one live identity, and
    // the save that lost the row holds none: no second identity, no take-back of
    // somebody else's.
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-a");
    expect(orphanKeylessIdentities()).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485 fix leg 4, the seventh read-only round, finding 1. THREE SAVES
// AND TWO PEOPLE on one keyless row. The round drove the exact four steps
// below and read back a row holding the second person's configuration with the
// FIRST person's name on its panel, while the second person's save reported
// success. A retry alone cannot settle it: the first person has two saves in
// flight, so each pass of the second person's retry can be undone by the next
// one landing. What settles it is that an identity a save PUT on the row while
// a later write already stood there is taken back by the save that put it
// there.
// ---------------------------------------------------------------------------
describe("three saves, two people, one row (cinatra#3485)", () => {
  it("the first admin's two saves never leave that admin holding the panel over the second admin's configuration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionIsPlatformAdmin = true;
    sessionActiveOrganizationId = ORG;
    // Every save runs until it reaches the seam and PARKS there, so the order
    // the identities land is the order this case releases them, and no wall
    // clock decides anything.
    const release: Array<() => void> = [];
    const announce: Array<() => void> = [];
    const parked = [0, 1, 2].map(
      (i) => new Promise<void>((resolve) => { release[i] = resolve; }),
    );
    const reachedTheSeam = [0, 1, 2].map(
      (i) => new Promise<void>((resolve) => { announce[i] = resolve; }),
    );
    let reached = 0;
    let secondSave: Promise<unknown> | null = null;
    onKeylessIdentityRegister = async () => {
      const n = reached++;
      if (n < 3) {
        announce[n]();
        await parked[n];
        return;
      }
      // A FOURTH registration is the second admin's retry, and the round's step
      // five lands the first admin's second identity inside it: the retry has
      // already taken the first identity away and has not yet put its own
      // there.
      release[1]();
      await secondSave;
    };

    sessionUserId = "admin-a";
    const firstSave = registerKeyless({
      id: "srv-four-step",
      scope: "global",
      label: "A, the first save",
    });
    await reachedTheSeam[0];
    secondSave = registerKeyless({
      id: "srv-four-step",
      scope: "global",
      label: "A, the second save",
    });
    await reachedTheSeam[1];
    sessionUserId = "admin-b";
    const thirdSave = registerKeyless({
      id: "srv-four-step",
      scope: "global",
      label: "B, the configuration that stands",
    });
    await reachedTheSeam[2];

    // Step four: the first admin's FIRST identity lands and that save finishes.
    release[0]();
    await firstSave;
    // Step five and six: the second admin's registration meets whatever stands.
    release[2]();
    await thirdSave;
    // The first admin's second save, if the retry above did not already let it
    // through.
    release[1]();
    await secondSave;

    // The row holds the second admin's configuration, so the panel and the
    // authority to share it belong to the second admin, and to nobody else.
    expect(servers.get("srv-four-step")?.label).toBe("B, the configuration that stands");
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-b");
    expect(orphanKeylessIdentities()).toEqual([]);
    sessionUserId = "admin-a";
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    sessionUserId = "admin-b";
    expect((await renderMcpServersSharingTab()).panelViews).toHaveLength(1);
    error.mockRestore();
  });
});

describe("the orphan of a deleted server belongs to its owner, on every road (cinatra#3485)", () => {
  it("a KEYED save of somebody else's replacement row never retires the orphan identity", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionActiveOrganizationId = ORG;
    // The first person's delete leaves their identity behind: the retire failed.
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-keyed-orphan" });
    const orphan = liveIdentities()[0];
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-keyed-orphan" });
    expect(liveIdentities()).toHaveLength(1);
    // Another person's own server at the SAME id, then a key added to it. The
    // keyed road retires a keyless identity that may not stand on a row
    // carrying a credential, and the identity it finds is not this row's.
    //
    // The row is PLACED here rather than registered: since fix leg 4 the create
    // road refuses an id another person's identity still holds, so the only way
    // such a row can stand at all is one that was already there.
    servers.set("srv-keyed-orphan", {
      id: "srv-keyed-orphan",
      scope: "user",
      userId: "u1",
      nangoConnectionId: null,
    });
    sessionUserId = "u1";
    await createServerHandler({
      id: "srv-keyed-orphan",
      label: "Keyed",
      serverUrl: "https://mcp.example",
      scope: "user",
      apiKey: "sk-not-a-real-key",
    });
    const rows = liveIdentities();
    expect(rows.map((r) => r.id)).toContain(orphan.id);
    expect(rows.find((r) => r.id === orphan.id)?.ownerUserId).toBe("u2");
    error.mockRestore();
  });

  it("a DELETE of somebody else's replacement row never retires the orphan identity, and the owner's own delete still repairs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionActiveOrganizationId = ORG;
    sessionUserId = "u2";
    await registerKeyless({ id: "srv-del-orphan" });
    const orphan = liveIdentities()[0];
    keylessRetireFailsOnce = true;
    await deleteServerHandler({ id: "srv-del-orphan" });
    expect(liveIdentities()).toHaveLength(1);
    // The other person's own row at the same id, PLACED (the create road
    // refuses that id since fix leg 4) and then deleted.
    servers.set("srv-del-orphan", {
      id: "srv-del-orphan",
      scope: "user",
      userId: "u1",
      nangoConnectionId: null,
    });
    sessionUserId = "u1";
    await deleteServerHandler({ id: "srv-del-orphan" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(rows[0].ownerUserId).toBe("u2");
    // It is not lost to its owner: their own delete of the absent id takes it
    // away, which is the road the orphan was always repaired on.
    sessionUserId = "u2";
    await deleteServerHandler({ id: "srv-del-orphan" });
    expect(liveIdentities()).toHaveLength(0);
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3485 fix leg 3: the DRAWN STATE this leg must not move. These are the
// six states proof round 2 photographed on a production build, in the same
// order and reached the same way, with the panel count the round counted for
// each. No frame is taken here; what is measured is the number the page's own
// panel list would carry, so a code leg can say from its tests that the picture
// would come out the same.
// ---------------------------------------------------------------------------
describe("the Sharing tab's panel count across the six proof states (cinatra#3485)", () => {
  it("counts 0, 1, 2, 1, 2, 1 across register, add a key, delete, register again and delete again", async () => {
    sessionActiveOrganizationId = ORG;
    const panelCount = async () => (await renderMcpServersSharingTab()).panelViews?.length ?? 0;

    // 1. before any server.
    expect((await renderMcpServersSharingTab()).section).toBeNull();
    expect(await panelCount()).toBe(0);

    // 2. the server registered with the API-key field left blank.
    await registerKeyless({ id: "proof-keyless-1" });
    expect(await panelCount()).toBe(1);

    // 3. a second server registered WITH a key.
    await createServerHandler({
      id: "proof-keyed-1",
      label: "Keyed server",
      serverUrl: "https://mcp.example",
      scope: "user",
      apiKey: "sk-not-a-real-key",
    });
    expect(await panelCount()).toBe(2);

    // 4. the keyless server deleted.
    await deleteServerHandler({ id: "proof-keyless-1" });
    expect(await panelCount()).toBe(1);

    // 5. a keyless server registered again, which the Setup form mints under a
    //    NEW id every time, so its identity is a fresh one and not the retired
    //    one raised again.
    await registerKeyless({ id: "proof-keyless-2" });
    expect(await panelCount()).toBe(2);
    const live = liveIdentities();
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.connectionId)).toContain("external-mcp-keyless-proof-keyless-2");
    expect(live.map((r) => r.connectionId)).not.toContain("external-mcp-keyless-proof-keyless-1");

    // 6. that second keyless server deleted again.
    await deleteServerHandler({ id: "proof-keyless-2" });
    expect(await panelCount()).toBe(1);
    // One live identity after the last state, the keyed server's, and every
    // keyless identity retired: the reading the round took from the store.
    const after = liveIdentities();
    expect(after).toHaveLength(1);
    expect(after[0].connectionId.startsWith("external-mcp-keyless-")).toBe(false);
    expect(orphanKeylessIdentities()).toEqual([]);
  });
});
