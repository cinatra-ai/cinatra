// cinatra#3460 — a connection saved through a ceiling-declaring connector's
// OWN Setup form registers its identity row through the host's one road, so
// the connector's Sharing tab lists it.
//
// The road under test is the real one: the connector resolves the
// `nango-system` capability through `ctx.capabilities.resolveProviders` (what
// every first-party connector's `register.ts` does to build its deps) and
// persists the verified pointer with `saveNangoConnectionRecord` — exactly the
// call the model-provider connectors' own save makes after their readback
// compare. Nothing under `extensions/**` is involved: the host owns both
// halves.
//
// RED at the branch base (2ac1a342e3c5, the Sharing tab's own branch): the
// save writes the pointer and NO identity row, `listNangoConnectionsByOwner`
// returns nothing for the owner, and `ConnectionSharingSection` renders null —
// zero panels.
//
// The identity table, the permissions store, the canonical store, the session
// and the leaf UI primitives are mocked; the seam, the capability port, the
// use-gate's declaration resolution + ceiling algorithm, the share-surface
// decision, the section's own listing/filtering and the tab body's own panel
// composition (`ConnectorSharingPanels`) are REAL.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const OWNER_USER_ID = "user-seal-admin";
const ORG_ID = "org-lane";
const CONNECTOR_PACKAGE = "@cinatra-ai/anthropic-connector";
const CONNECTOR_KEY = "claude";
const CONNECTION_ID = "cinatra-claude";
// The nango gateway publishes the surface; the ceiling connector resolves it.
const NANGO_GATEWAY = "@cinatra-ai/nango-connector";

// --- the identity table, in memory: the seam WRITES it, the Sharing tab READS it
type IdentityRow = {
  id: string;
  organizationId: string | null;
  connectorPackageId: string;
  connectorKey: string;
  connectionId: string;
  ownerUserId: string;
  createdAt: Date;
  deletedAt: Date | null;
};
const identityRows: IdentityRow[] = [];
let identitySeq = 0;
/** Makes the identity-store insert fail, for the "never fails the save" pin. */
let identityStoreFails = false;

vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  insertNangoConnection: async (input: {
    organizationId: string | null;
    connectorPackageId: string;
    connectorKey: string;
    connectionId: string;
    ownerUserId: string;
  }) => {
    if (identityStoreFails) throw new Error("the identity store is unreachable");
    // Mirrors the store's live-unique (connector_key, connection_id) upsert:
    // an existing live row is RETURNED, never duplicated.
    const existing = identityRows.find(
      (r) =>
        r.connectorKey === input.connectorKey &&
        r.connectionId === input.connectionId &&
        r.deletedAt === null,
    );
    if (existing) return existing;
    const row: IdentityRow = {
      id: `identity-${++identitySeq}`,
      ...input,
      createdAt: new Date(),
      deletedAt: null,
    };
    identityRows.push(row);
    return row;
  },
  listNangoConnectionsByOwner: async (ownerUserId: string) =>
    identityRows.filter((r) => r.ownerUserId === ownerUserId && r.deletedAt === null),
  readNangoConnectionByNaturalKey: async (connectorKey: string, connectionId: string) =>
    identityRows.find(
      (r) =>
        r.connectorKey === connectorKey &&
        r.connectionId === connectionId &&
        r.deletedAt === null,
    ) ?? null,
  softDeleteNangoConnection: async () => {},
}));

// --- the grant store: the seam SEEDS it, the share surface READS it
const seededPolicies = new Map<string, Record<string, unknown>>();
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  seedExtensionAccessPolicyIfAbsent: async (
    kind: string,
    resourceId: string,
    policy: Record<string, unknown>,
  ) => {
    const key = `${kind}:${resourceId}`;
    if (seededPolicies.has(key)) return false;
    seededPolicies.set(key, policy);
    return true;
  },
  readExtensionAccessPolicy: async (kind: string, resourceId: string) =>
    seededPolicies.get(`${kind}:${resourceId}`) ?? null,
  readExtensionCoOwners: async () => [],
  readExtensionInstalledBy: async () => null,
}));

// --- the connector's DECLARED CEILING, as the W1 registration cache carries it
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async (packageName: string) =>
    packageName === CONNECTOR_PACKAGE
      ? [
          {
            organizationId: ORG_ID,
            accessDeclaration: {
              formatVersion: 1,
              mode: "only",
              scope: "admin",
              source: "declared",
            },
          },
        ]
      : [],
}));

// --- the VALIDATED session the identity row's owner must come from
const auth = vi.hoisted(() => ({
  // "session" — a signed-in actor; "none" — a read that returns null;
  // "throws" — a boot/background road with no request context at all.
  mode: "session" as "session" | "none" | "throws",
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => {
    if (auth.mode === "throws") throw new Error("no request context");
    if (auth.mode === "none") return null;
    return {
      user: { id: OWNER_USER_ID, name: "Seal Admin", email: "admin@example.test", image: null },
      session: { activeOrganizationId: ORG_ID },
    };
  },
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {},
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: async () => [
    { id: ORG_ID, name: "Lane workspace", teams: [] },
  ],
  readProjectsForUser: async () => [],
}));

// --- leaf UI: identity-carrying stand-ins so the panel list is countable. The
// tab body (`ConnectorSharingPanels`) that composes them stays REAL.
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

import { createExtensionHostContext } from "@/lib/extension-host-context";
import {
  __resetCapabilityRegistry,
  registerCapabilityProvider,
} from "@/lib/extension-capabilities-registry";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { ConnectionSharingSection } from "@/components/extensions/connection-sharing-section";
import {
  ConnectorSharingPanels,
  type ConnectorSharingPanelsProps,
} from "@/components/extensions/connector-sharing-panels";

/** The pointer records the fake gateway persisted (the pre-#3460 behaviour). */
const savedPointerRecords: Array<{ connectorKey: string; connectionId: string }> = [];

/** A stand-in for the nango gateway's published surface. Only the members this
 * road touches are implemented. */
function fakeNangoSystemSurface() {
  return {
    isNangoConfigured: () => true,
    getNangoStatus: () => ({ status: "connected" as const, detail: "" }),
    getNangoSettings: () => ({}),
    providerConfigKeys: { [CONNECTOR_KEY]: "anthropic" },
    connectionIds: { [CONNECTOR_KEY]: CONNECTION_ID },
    saveNangoConnectionRecord: async (
      connectorKey: string,
      record: { connectionId: string; providerConfigKey: string },
    ) => {
      savedPointerRecords.push({ connectorKey, connectionId: record.connectionId });
    },
  };
}

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

/**
 * The Sharing tab as a person reaches it: the section renders, and the tab's
 * BODY is the real `ConnectorSharingPanels` the section hands its panel views
 * to. Returns the panel views the section computed and the body those views
 * draw (the identity rows, the roll-up treatment and the locked picker).
 */
async function renderSharingTab(): Promise<{
  section: unknown;
  panelViews: ConnectorSharingPanelsProps["panels"] | null;
  body: unknown;
}> {
  const section = await ConnectionSharingSection({ packageId: CONNECTOR_PACKAGE, variant: "tab" });
  const [bodyProps] = collectPropsOfType(section, ConnectorSharingPanels);
  if (!bodyProps) return { section, panelViews: null, body: null };
  const props = bodyProps as unknown as ConnectorSharingPanelsProps;
  return { section, panelViews: props.panels, body: ConnectorSharingPanels(props) };
}

/** The connector's own save road: resolve `nango-system` through the extension
 * capability port (what `register.ts` does) and persist the verified pointer. */
async function saveThroughTheConnectorsOwnRoad(): Promise<void> {
  const ctx = createExtensionHostContext(CONNECTOR_PACKAGE, ["capabilities"]);
  const surface = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)[0]?.impl as {
    saveNangoConnectionRecord: (
      connectorKey: string,
      record: { connectionId: string; providerConfigKey: string; metadata?: unknown },
      options?: { multiple?: boolean },
    ) => Promise<unknown>;
  };
  await surface.saveNangoConnectionRecord(
    CONNECTOR_KEY,
    { connectionId: CONNECTION_ID, providerConfigKey: "anthropic", metadata: {} },
    { multiple: false },
  );
}

/** The same road with a scope carried on the RECORD itself — the shape the
 * gateway's own normalization lets WIN over the options' scope (its stored
 * record spreads the record last). */
async function saveThroughTheConnectorsOwnRoadWithRecordScope(
  recordScope: "app" | "user",
  options: { scope?: "app" | "user"; userId?: string; multiple?: boolean },
): Promise<void> {
  const ctx = createExtensionHostContext(CONNECTOR_PACKAGE, ["capabilities"]);
  const surface = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)[0]?.impl as {
    saveNangoConnectionRecord: (
      connectorKey: string,
      record: { connectionId: string; providerConfigKey: string; scope?: "app" | "user" },
      options?: { scope?: "app" | "user"; userId?: string; multiple?: boolean },
    ) => Promise<unknown>;
  };
  await surface.saveNangoConnectionRecord(
    CONNECTOR_KEY,
    { connectionId: CONNECTION_ID, providerConfigKey: "anthropic", scope: recordScope },
    options,
  );
}

/** The same road with an explicit scope/options shape (the surface contract's
 * third argument), for the scope-dependent grant seed. */
async function saveThroughTheConnectorsOwnRoadWithOptions(options: {
  scope?: "app" | "user";
  userId?: string;
  multiple?: boolean;
}): Promise<void> {
  const ctx = createExtensionHostContext(CONNECTOR_PACKAGE, ["capabilities"]);
  const surface = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)[0]?.impl as {
    saveNangoConnectionRecord: (
      connectorKey: string,
      record: { connectionId: string; providerConfigKey: string },
      options?: { scope?: "app" | "user"; userId?: string; multiple?: boolean },
    ) => Promise<unknown>;
  };
  await surface.saveNangoConnectionRecord(
    CONNECTOR_KEY,
    { connectionId: CONNECTION_ID, providerConfigKey: "anthropic" },
    options,
  );
}

/** The policy the one-time grant seed wrote for the saved connection's row. */
function seededPolicyForTheSavedConnection(): Record<string, unknown> | undefined {
  const row = identityRows[0];
  return row ? seededPolicies.get(`connection:${row.id}`) : undefined;
}

describe("a ceiling connector's own save road registers the connection identity (cinatra#3460)", () => {
  beforeEach(() => {
    identityRows.length = 0;
    savedPointerRecords.length = 0;
    seededPolicies.clear();
    identitySeq = 0;
    identityStoreFails = false;
    auth.mode = "session";
    __resetCapabilityRegistry();
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: NANGO_GATEWAY,
      impl: fakeNangoSystemSurface(),
    });
  });

  // The capability registry is a process-global (globalThis symbol) shared by
  // every test FILE a vitest worker runs, so this file clears what it
  // registered — a leftover fake nango surface would leak into a sibling file.
  afterEach(() => {
    identityStoreFails = false;
    __resetCapabilityRegistry();
    identityRows.length = 0;
    savedPointerRecords.length = 0;
    seededPolicies.clear();
    vi.restoreAllMocks();
  });

  it("premise: the connector's own road persists the pointer record", async () => {
    await saveThroughTheConnectorsOwnRoad();
    expect(savedPointerRecords).toEqual([
      { connectorKey: CONNECTOR_KEY, connectionId: CONNECTION_ID },
    ]);
  });

  it("writes the identity row for the saved connection, owned by the session user", async () => {
    await saveThroughTheConnectorsOwnRoad();
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]).toMatchObject({
      connectorPackageId: CONNECTOR_PACKAGE,
      connectorKey: CONNECTOR_KEY,
      connectionId: CONNECTION_ID,
      ownerUserId: OWNER_USER_ID,
      organizationId: ORG_ID,
    });
  });

  it("the Sharing tab's panel list carries ONE panel for it — no roll-up above a single connection", async () => {
    await saveThroughTheConnectorsOwnRoad();
    const { section, panelViews, body } = await renderSharingTab();
    expect(section).not.toBeNull();
    expect(panelViews).toHaveLength(1);
    expect(panelViews?.[0]).toMatchObject({ name: CONNECTION_ID, url: CONNECTOR_KEY });
    // The connection's own panel heads the tab: its identity row is drawn, and
    // no roll-up card sits above a single connection.
    expect(countElementsOfType(body, stubs.ConnectionRowStub)).toBe(1);
    expect(countElementsOfType(body, stubs.ConnectionsStatusCardStub)).toBe(0);
    expect(countElementsOfType(body, stubs.ExtensionPermissionsClientStub)).toBe(1);
  });

  it("the panel's picker is LOCKED on the connector's ceiling", async () => {
    await saveThroughTheConnectorsOwnRoad();
    const { panelViews, body } = await renderSharingTab();
    expect(panelViews?.[0]?.scopeConstraint).toBe("locked");
    const pickers = collectPropsOfType(body, stubs.ExtensionPermissionsClientStub);
    expect(pickers).toHaveLength(1);
    expect(pickers[0].kind).toBe("connection");
    expect(pickers[0].accessDisabledScopes).toBeDefined();
    expect(pickers[0].accessScopeNote).toContain('only:"admin"');
  });

  it("a save with NO validated actor writes no identity row and never fails the save", async () => {
    auth.mode = "none";
    await expect(saveThroughTheConnectorsOwnRoad()).resolves.toBeUndefined();
    expect(savedPointerRecords).toHaveLength(1);
    expect(identityRows).toHaveLength(0);
  });

  it("a save on a road with no request context at all never fails the save", async () => {
    auth.mode = "throws";
    await expect(saveThroughTheConnectorsOwnRoad()).resolves.toBeUndefined();
    expect(savedPointerRecords).toHaveLength(1);
    expect(identityRows).toHaveLength(0);
  });

  it("a connector key with no known connector package never fails the save", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createExtensionHostContext(CONNECTOR_PACKAGE, ["capabilities"]);
    const surface = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)[0]
      ?.impl as unknown as {
      saveNangoConnectionRecord: (
        connectorKey: string,
        record: { connectionId: string; providerConfigKey: string },
      ) => Promise<unknown>;
    };
    await expect(
      surface.saveNangoConnectionRecord("aConnectorKeyNoPackageIsKnownFor", {
        connectionId: "c-1",
        providerConfigKey: "p-1",
      }),
    ).resolves.toBeUndefined();
    expect(identityRows).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("re-saving the same connection is idempotent — still exactly one panel", async () => {
    await saveThroughTheConnectorsOwnRoad();
    await saveThroughTheConnectorsOwnRoad();
    expect(identityRows).toHaveLength(1);
    const { panelViews, body } = await renderSharingTab();
    expect(panelViews).toHaveLength(1);
    expect(countElementsOfType(body, stubs.ConnectionRowStub)).toBe(1);
  });
  // --- converge round 1, finding 1: the seed follows the SAVED SCOPE --------

  it("an APP-scope save seeds the workspace grant the save route seeds for the same scope", async () => {
    // A connector's Setup form saves without a scope, and the gateway persists
    // that as an APP-scope connection — org-shared by construction. The save
    // route seeds exactly that with "workspace"; an owner-only seed here could
    // never be corrected later (the seed is insert-if-absent).
    await saveThroughTheConnectorsOwnRoad();
    const policy = seededPolicyForTheSavedConnection();
    expect(policy).toBeDefined();
    expect(policy?.runListVisibility).toEqual(["workspace"]);
    expect(policy?.runDataVisibility).toEqual(["workspace"]);
    expect(policy?.runExecuteVisibility).toEqual(["workspace"]);
  });

  it("a USER-scope save keeps the never-auto-share OWNER default", async () => {
    await saveThroughTheConnectorsOwnRoadWithOptions({ scope: "user", userId: OWNER_USER_ID });
    expect(identityRows).toHaveLength(1);
    const policy = seededPolicyForTheSavedConnection();
    expect(policy).toBeDefined();
    expect(policy?.runListVisibility).not.toContain("workspace");
    expect(policy?.runDataVisibility).not.toContain("workspace");
  });

  // --- converge round 2, finding 2: the seed follows the scope the gateway
  // actually PERSISTS, not the one the options asked for ------------------

  it("a record-carried USER scope wins over an APP scope in the options — the seed stays owner-only", async () => {
    // The gateway stores `{ scope: options.scope ?? record.scope ?? "app", ...record }`,
    // so a scope on the RECORD is what lands in the pointer. Reading the options
    // first would seed a WORKSPACE grant on a connection stored as the person's
    // own — and the seed is insert-if-absent, so nothing could take it back.
    await saveThroughTheConnectorsOwnRoadWithRecordScope("user", {
      scope: "app",
      userId: OWNER_USER_ID,
    });
    expect(identityRows).toHaveLength(1);
    const policy = seededPolicyForTheSavedConnection();
    expect(policy).toBeDefined();
    expect(policy?.runListVisibility).not.toContain("workspace");
    expect(policy?.runDataVisibility).not.toContain("workspace");
    expect(policy?.runExecuteVisibility).not.toContain("workspace");
  });

  it("a record-carried APP scope still seeds the workspace grant", async () => {
    await saveThroughTheConnectorsOwnRoadWithRecordScope("app", {});
    expect(identityRows).toHaveLength(1);
    const policy = seededPolicyForTheSavedConnection();
    expect(policy?.runListVisibility).toEqual(["workspace"]);
  });

  // --- converge round 1, finding 2: a failed registration never fails the
  // save (the connector's own sync-failure road would clear the pointer and
  // best-effort DELETE the remote connection) ------------------------------

  it("a FOREIGN identity row never fails the connector's save and never takes the row away from its owner", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    identityRows.push({
      id: "identity-foreign",
      organizationId: ORG_ID,
      connectorPackageId: CONNECTOR_PACKAGE,
      connectorKey: CONNECTOR_KEY,
      connectionId: CONNECTION_ID,
      ownerUserId: "user-somebody-else",
      createdAt: new Date(),
      deletedAt: null,
    });
    await expect(saveThroughTheConnectorsOwnRoad()).resolves.toBeUndefined();
    expect(savedPointerRecords).toHaveLength(1);
    // The other owner's row stands, no second row was minted, and no grant was
    // seeded under this actor.
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].ownerUserId).toBe("user-somebody-else");
    expect(seededPolicies.size).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it("an identity-store failure never fails the connector's save", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    identityStoreFails = true;
    await expect(saveThroughTheConnectorsOwnRoad()).resolves.toBeUndefined();
    expect(savedPointerRecords).toHaveLength(1);
    expect(identityRows).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });

  // --- converge round 1, finding 3: every other member is forwarded with a
  // STABLE identity -------------------------------------------------------

  it("every other member of the surface is forwarded unchanged, with a stable identity", async () => {
    const ctx = createExtensionHostContext(CONNECTOR_PACKAGE, ["capabilities"]);
    const surface = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)[0]
      ?.impl as unknown as Record<string, unknown>;
    // Read twice: a caller that memoizes, compares or de-duplicates a member by
    // reference must see the SAME function object both times.
    expect(surface.getNangoStatus).toBe(surface.getNangoStatus);
    expect(surface.isNangoConfigured).toBe(surface.isNangoConfigured);
    // And it still behaves like the real member.
    expect((surface.isNangoConfigured as () => boolean)()).toBe(true);
    expect((surface.getNangoStatus as () => { status: string })().status).toBe("connected");
    // Non-function members pass through by value.
    expect(surface.connectionIds).toMatchObject({ [CONNECTOR_KEY]: CONNECTION_ID });
  });
});
