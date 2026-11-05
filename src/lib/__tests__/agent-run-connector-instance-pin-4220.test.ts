import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// cinatra#4220 — an agent run's site read through the governed invoker, with
// the run's connector-instance binding derived the way dispatch derives it
// (deriveAgentRunConnectorInstanceBinding, the per-instance use gate for the
// run's own user and org) and carried as the signed pin on the run's
// agent_run-delegated MCP frame.
//
// The harness is the chat-actor suite's (connector-instance-invoker-chat-actor
// .test.ts): the REAL registered invoker, the REAL resolver and the REAL
// requireUse gate; only the host stores, the live org-role read and the wire
// are faked. Pinned here:
//   (a)/(b) ALLOWED for a connection the run's user may use (its own, and a
//           shared org connection reached through the pin alone);
//   (c)     REFUSED for another instance of the same org (instance_pin_mismatch,
//           before any authority read or wire call);
//   (d)     REFUSED for a connection of another organisation — at derive time,
//           and for a forged frame pinned to it (instance_org_mismatch);
//   (e)     NO binding for an unusable or unknown start input; an unpinned
//           agent_run frame stays fail-closed (connector_key_underivable);
//   (f)     REFUSED at derive time for a user who lost org membership.

vi.mock("server-only", () => ({}));

// --- heavy host deps the binder pulls at module load (mirrors the proven
// recipe in host-connector-services-publication.test.ts) ------------------
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...args: unknown[]) => args[1],
  writeConnectorConfigToDatabase: () => {},
  deleteConnectorConfig: () => {},
  readOpenAIConnectionFromDatabase: () => ({}),
  readAnthropicConnectionFromDatabase: () => ({}),
  readAnthropicSkillSyncEnabledFromDatabase: () => false,
}));
vi.mock("@/lib/mcp-pagination", () => ({ decodeCursor: () => null, buildListPage: () => ({}) }));
vi.mock("@/lib/external-mcp-registry", () => ({
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY: "cinatra-external-mcp",
  upsertExternalMcpServer: async () => ({}),
  deleteExternalMcpServer: async () => {},
  getExternalMcpServerById: () => null,
  listExternalMcpServers: () => [],
  resolveExternalMcpServerBearer: async () => "bearer-jwt",
  devAttachTwentyBearerFromMintedKey: async () => ({ resolved: false, connectionId: null }),
}));
vi.mock("@/app/campaigns/actions", () => ({
  createExternalMcpServerAction: async () => {},
  deleteExternalMcpServerAction: async () => {},
  saveTwentyConnectionAction: async () => {},
  disconnectTwentyConnectionAction: async () => {},
}));

// --- the ONE module whose behavior this suite actually varies per test:
// the live org-membership re-verification (`createInstanceUseAuthorityGateCore`
// step c-universal) that `connector-instance-write-authority.ts`'s REAL,
// unmocked gate calls on EVERY invocation. Typed `vi.fn` spy so the tests can
// both control its return AND assert it was called (proving re-resolution,
// not a cached decision). ----------------------------------------------------
type AuthzOrgRole = "org_owner" | "org_admin" | "member";
const resolveOrgRoleForUser = vi.fn<
  (orgId: string, userId: string) => Promise<AuthzOrgRole | undefined>
>(async () => undefined);
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({ user: { id: "viewer-1", role: "user" } }),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: async () => undefined,
  resolveOrgRoleForUser: (orgId: string, userId: string) => resolveOrgRoleForUser(orgId, userId),
}));

vi.mock("@/lib/nango-system", () => ({ getNangoStatus: () => ({ status: "connected" }) }));
vi.mock("@/lib/instance-secrets", () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string) => v }));
vi.mock("@/lib/mcp-self-client", () => ({ buildAppMcpSelfClientHeaders: () => ({}) }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/runtime-mode", () => ({ isAppDevelopmentMode: () => false }));
vi.mock("@/lib/notifications", () => ({ createNotification: async () => {} }));
vi.mock("@/lib/openai-connection-store", () => ({
  readOpenAIConnection: () => ({}),
  updateOpenAIConnection: () => {},
  clearOpenAIConnection: () => {},
  updateOpenAILoggingEnabled: () => {},
}));
vi.mock("@cinatra-ai/google-oauth-connection", () => ({
  getGoogleOAuthStatus: async () => ({ status: "not_connected" }),
  googleApiFetch: async () => ({}),
  refreshGoogleOAuthAccessTokenIfNeeded: async () => ({}),
}));
vi.mock("@/lib/host-content-editor-dispatch", () => ({ dispatchContentEditorViaA2A: async () => "" }));
vi.mock("@/lib/wordpress-mcp-connection", () => ({
  probeWordPressInstanceMcpAdapter: async () => ({}),
  probeWordPressInstanceMcpServer: async () => ({}),
  invalidateWordPressMcpProbeCache: () => {},
  resolveWordPressMcpFallbackEndpoint: (siteUrl: string) => `${siteUrl}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
  resolveWordPressMcpEndpoint: (siteUrl: string) => `${siteUrl}/wp-json/mcp/mcp-adapter-default-server`,
}));
vi.mock("@/lib/url-policy", () => ({ isPrivateUrl: () => false }));
vi.mock("@/lib/drupal-mcp-connection", () => ({
  probeDrupalMcp: async () => ({}),
  probeDrupalMcpWithBearer: async () => "registered",
  invalidateDrupalMcpProbeCache: () => {},
  resolveDrupalMcpServerUrl: () => null,
  getDrupalMcpInstanceStatuses: async () => [],
}));
vi.mock("@/lib/instance-connection-actor", () => ({
  resolveOrSeedInstanceIdentity: async () => null,
  enforceInstanceConnectionUse: async () => null,
  enforcePerUserInstanceConnectionUse: async () => null,
  authorizeWorkerConnectionUse: async () => true,
  isConnectionUseDeniedError: () => false,
  resolveTrustedSessionBinding: async () => null,
}));

// --- the per-instance ORG-BINDING gate's own DB fallbacks (cf.
// connector-instance-write-authority.ts step (e) / connector-policy.ts). No
// canonical migrated row + no legacy policy row ⇒ the ABSENT/legacy-fallback
// path in `enforceConnectorPolicy`, which resolves the connector's SHIPPED
// catalog visibility (real, unmocked `STATIC_EXTENSION_MANIFEST` — the
// wordpress-mcp-connector's shipped declaration is `default:"workspace"`) and
// allows any actor for a non-manage call. Mocked here ONLY to avoid a real
// synchronous Postgres attempt (`runPostgresQueriesSync`, a 30s-timeout worker
// thread) in a unit context — never to fabricate a permissive decision the
// real code wouldn't reach on its own absent-row fallback. -----------------
vi.mock("@/lib/connector-access-resolver", () => ({
  resolveConnectorCanonicalAccessSync: () => ({ status: "absent" as const }),
}));
vi.mock("@/lib/connector-policy-store", () => ({
  readConnectorAccessPolicy: () => null,
  listConnectorAccessPoliciesForOrg: () => [],
  upsertConnectorAccessPolicy: () => {},
  batchUpsertConnectorPoliciesForFixture: () => {},
  deleteConnectorAccessPolicy: () => {},
}));

// --- the invoker's own per-instance tool-policy + multi-server enrollment
// stores (cinatra#2018 S3 / §2.6). Mocked to a deterministic in-memory "open,
// one default-enrolled server" shape so the REAL invoker pipeline (catalog
// acquire → policy evaluate → execute) runs to completion without a DB.
// importOriginal-SPREAD, not a bare factory: register-host-connector-services
// (loaded by this suite) references more of this store's exports than the two
// overridden here (e.g. `writeInstanceToolPolicy` via the #2022 settings
// seam), and a partial factory crashes module registration the moment a new
// export is referenced — the packages/agents instance-identity mock class.
// The real (un-overridden) exports are never CALLED by this suite; only the
// two deterministic overrides below are exercised. ---------------------------
vi.mock("@/lib/connector-instance-tool-policy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connector-instance-tool-policy-store")>()),
  readInstanceToolPolicy: async (connectorKey: string, instanceId: string) => ({
    connectorKey,
    instanceId,
    mode: "open" as const,
    updatedBy: "test",
    updatedAt: "2026-01-01T00:00:00Z",
  }),
  ensureDefaultOpenPolicy: async () => ({ created: false }),
}));
import { CATALOG_DEFAULT_SERVER_ID } from "@/lib/connector-instance-catalog-cache";
vi.mock("@/lib/connector-instance-server-store", () => ({
  listEnrolledServers: async () => [
    { serverId: CATALOG_DEFAULT_SERVER_ID, exposureMode: "triad-only", restPath: "/mcp" },
  ],
  ensureDefaultServerEnrollment: async () => {},
  readServer: async () => null,
  recordServerExposureMode: async () => {},
  recordServerStatus: async () => {},
  retireServersForInstance: async () => {},
}));

// --- the WIRE transport (`@/lib/connector-instance-mcp-transport`): only the
// two wire-calling functions are replaced (importOriginal so `InvokerError` /
// `TRIAD_*` constants stay the REAL classes/values this suite asserts
// against). The mocked wire answers the triad discover/get-ability-info/
// execute sequence for ONE benign read tool, `core/get-site-info`. ---------
const wireCalls: Array<{ endpoint: string; name: string; arguments: Record<string, unknown> }> = [];
vi.mock("@/lib/connector-instance-mcp-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connector-instance-mcp-transport")>();
  return {
    ...actual,
    callConnectorInstanceMcpTool: vi.fn(
      async (input: { endpoint: string; authHeader: string; name: string; arguments: Record<string, unknown> }) => {
        wireCalls.push({ endpoint: input.endpoint, name: input.name, arguments: input.arguments });
        if (input.name === actual.TRIAD_DISCOVER_ABILITIES) {
          return { abilities: [{ name: "core/get-site-info" }] };
        }
        if (input.name === actual.TRIAD_GET_ABILITY_INFO) {
          return { input_schema: {}, meta: { annotations: { readOnlyHint: true } } };
        }
        // TRIAD_EXECUTE_ABILITY — the final, real tool-call result.
        return { structuredContent: { ok: true } };
      },
    ),
    listConnectorInstanceMcpTools: vi.fn(async () => []),
  };
});

import { registerCapabilityProvider, resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";
import type { HostConnectorInstanceInvokerService } from "@cinatra-ai/sdk-extensions";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import {
  InstanceWriteAuthorityError,
  deriveAgentRunConnectorInstanceBinding,
} from "@/lib/connector-instance-write-authority";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

// Three WordPress instance rows: ORG_A owns "wp-valid" and "wp-valid-2" (two
// connections of the run's own org); ORG_B owns "wp-other-tenant" (a DIFFERENT
// org's instance — the other-organisation refused case).
const WP_ROWS: Record<string, { id: string; orgId: string; siteUrl: string; username: string; applicationPassword: string }> = {
  "wp-valid": {
    id: "wp-valid",
    orgId: "org-a",
    siteUrl: "https://a.example",
    username: "u",
    applicationPassword: "p",
  },
  "wp-valid-2": {
    id: "wp-valid-2",
    orgId: "org-a",
    siteUrl: "https://a2.example",
    username: "u",
    applicationPassword: "p",
  },
  "wp-other-tenant": {
    id: "wp-other-tenant",
    orgId: "org-b",
    siteUrl: "https://b.example",
    username: "u",
    applicationPassword: "p",
  },
};
// The FULL `WordPressInstanceAdminClient` structural shape — `resolveWordPressInstanceAdmin()`
// (connector-client-providers.ts's `isWordPressInstanceAdminClient` guard)
// fail-closes to `null` (treating the connector as absent) unless every one of
// these members is present, so a minimal/partial fake would silently degrade
// every lookup to "instance not found" rather than exercising the real gate.
const wordpressConnectorClient = {
  listInstances: () => Object.values(WP_ROWS),
  getAPIStatus: () => ({ status: "connected", detail: "" }),
  getAPISettings: () => ({ instances: Object.values(WP_ROWS), loggingEnabled: false }),
  readInstanceById: (id: string) => WP_ROWS[id] ?? null,
  deleteInstance: async () => {},
  validateWordPressInstanceConnection: async () => ({}),
  saveWordPressInstance: async () => ({ id: "wp-valid", connectionId: "nango-1" }),
  saveWordPressInstanceFromNangoConnection: async () => {},
  persistLocalDevWordPressInstanceUnvalidated: async () => ({ id: "wp-valid", connectionId: "nango-1" }),
  setWordPressInstanceBlogConnector: () => {},
  saveWordPressLoggingSettings: async () => {},
  getWordPressLoggingSettings: () => ({ enabled: false, directory: "/data/logs/x" }),
  listWordPressInstances: async () => [],
  readLatestPublishedWordPressPost: async () => null,
  webhookSubscriptions: {
    list: async () => [],
    register: async () => ({}),
    remove: async () => {},
  },
};
const drupalConnectorClient = {
  listInstances: () => [] as unknown[],
  getAPIStatus: async () => ({ instanceCount: 0, instances: [] }),
  saveInstance: async () => ({ id: "d-1" }),
  deleteInstance: async () => {},
  devPersistLocalInstanceUnvalidated: async () => ({ id: "d-1" }),
};

function resolveSingle<T>(capability: string): T {
  const providers = resolveCapabilityProviders(capability).filter((p) => p.packageName === "@cinatra-ai/host");
  expect(providers).toHaveLength(1);
  return providers[0].impl as T;
}

let invoker: HostConnectorInstanceInvokerService;

beforeAll(async () => {
  registerCapabilityProvider("@cinatra-ai/host:wordpress-mcp", {
    packageName: "@cinatra-ai/wordpress-mcp-connector",
    impl: wordpressConnectorClient,
  });
  registerCapabilityProvider("@cinatra-ai/host:drupal-mcp", {
    packageName: "@cinatra-ai/drupal-mcp-connector",
    impl: drupalConnectorClient,
  });
  // Module load auto-runs registerHostConnectorServices() (register-host-
  // connector-services.ts's own last line) against the REAL capability
  // registry — the mocks above keep it inert everywhere except the invoker
  // path this suite drives.
  await import("@/lib/register-host-connector-services");
  invoker = resolveSingle<HostConnectorInstanceInvokerService>(
    HOST_CONNECTOR_SERVICE_CAPABILITIES.connectorInstanceInvoker,
  );
});

const ORG_A = "org-a";
const USER = "user-1";

function runAsPinnedAgentRun<T>(
  pin: { connectorKey: string; instanceId: string } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const frame: McpRequestContext = {
    userId: USER,
    orgId: ORG_A,
    delegatedActor: {
      delegation: "agent_run",
      userId: USER,
      orgId: ORG_A,
      runId: "run-4220",
      platformRole: "member",
      oboCeiling: [],
      ...(pin ? { connectorInstancePin: pin } : {}),
    },
  };
  return mcpRequestContextStorage.run(frame, fn);
}

const TRIAD = [
  "mcp-adapter-discover-abilities",
  "mcp-adapter-get-ability-info",
  "mcp-adapter-execute-ability",
];

describe("cinatra#4220 — an agent run's site read through its derived connector-instance binding", () => {
  beforeEach(() => {
    wireCalls.length = 0;
    resolveOrgRoleForUser.mockReset();
    resolveOrgRoleForUser.mockImplementation(async () => "member");
  });

  it("(a) ALLOWED: the run's own connection — derive binds it, and the pinned read runs the triad", async () => {
    resolveOrgRoleForUser.mockImplementation(async () => "org_admin");
    const binding = await deriveAgentRunConnectorInstanceBinding({
      runId: "run-4220",
      runBy: USER,
      orgId: ORG_A,
      inputParams: { instanceId: "wp-valid" },
    });
    expect(binding).toEqual({ connectorKey: "wordpress", instanceId: "wp-valid" });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith(ORG_A, USER);

    const result = await runAsPinnedAgentRun(binding!, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );
    expect(result).toEqual({ structuredContent: { ok: true } });
    // The triad ends in the real execute call (discovery may be served from the
    // catalog cache on a repeated run, so only its last step is pinned).
    expect(wireCalls[wireCalls.length - 1]?.name).toBe(TRIAD[2]);
    for (const c of wireCalls) expect(c.endpoint).toMatch(/^https:\/\/a\.example\//);
  });

  it("(b) ALLOWED: a shared org connection for a plain member — the pin alone selects it", async () => {
    const binding = await deriveAgentRunConnectorInstanceBinding({
      runId: "run-4220",
      runBy: USER,
      orgId: ORG_A,
      inputParams: { instanceId: "wp-valid-2" },
    });
    expect(binding).toEqual({ connectorKey: "wordpress", instanceId: "wp-valid-2" });

    const result = await runAsPinnedAgentRun(binding!, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {} }),
    );
    expect(result).toEqual({ structuredContent: { ok: true } });
    expect(wireCalls[wireCalls.length - 1]?.name).toBe(TRIAD[2]);
    for (const c of wireCalls) expect(c.endpoint).toMatch(/^https:\/\/a2\.example\//);
  });

  it("(c) REFUSED: another instance of the same org than the run is bound to (instance_pin_mismatch)", async () => {
    const binding = await deriveAgentRunConnectorInstanceBinding({
      runId: "run-4220",
      runBy: USER,
      orgId: ORG_A,
      inputParams: { instanceId: "wp-valid" },
    });
    expect(binding).toEqual({ connectorKey: "wordpress", instanceId: "wp-valid" });
    resolveOrgRoleForUser.mockClear();

    const call = runAsPinnedAgentRun(binding!, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid-2" }),
    );
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "instance_pin_mismatch" });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(0);
  });

  it("(d) REFUSED: a connection of another organisation — at derive, and for a forged pinned frame (instance_org_mismatch)", async () => {
    const derive = deriveAgentRunConnectorInstanceBinding({
      runId: "run-4220",
      runBy: USER,
      orgId: ORG_A,
      inputParams: { instanceId: "wp-other-tenant" },
    });
    await expect(derive).rejects.toBeInstanceOf(InstanceWriteAuthorityError);
    await expect(derive).rejects.toMatchObject({ reason: "instance_org_mismatch" });

    const call = runAsPinnedAgentRun({ connectorKey: "wordpress", instanceId: "wp-other-tenant" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {} }),
    );
    await expect(call).rejects.toBeInstanceOf(InstanceWriteAuthorityError);
    await expect(call).rejects.toMatchObject({ reason: "instance_org_mismatch" });
    expect(wireCalls).toHaveLength(0);
  });

  it("(e) NO binding for an unusable or unknown start input; an unpinned agent_run read stays fail-closed", async () => {
    const base = { runId: "run-4220", runBy: USER, orgId: ORG_A };
    await expect(deriveAgentRunConnectorInstanceBinding({ ...base, inputParams: {} })).resolves.toBeNull();
    await expect(
      deriveAgentRunConnectorInstanceBinding({ ...base, inputParams: { instanceId: " wp-valid" } }),
    ).resolves.toBeNull();
    await expect(
      deriveAgentRunConnectorInstanceBinding({ ...base, inputParams: { instanceId: "wp-unknown" } }),
    ).resolves.toBeNull();

    const call = runAsPinnedAgentRun(undefined, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "connector_key_underivable" });
    expect(wireCalls).toHaveLength(0);
  });

  it("(f) REFUSED at derive: a run user who is no longer an org member (member_without_org_membership)", async () => {
    resolveOrgRoleForUser.mockImplementation(async () => undefined);
    const derive = deriveAgentRunConnectorInstanceBinding({
      runId: "run-4220",
      runBy: USER,
      orgId: ORG_A,
      inputParams: { instanceId: "wp-valid" },
    });
    await expect(derive).rejects.toBeInstanceOf(InstanceWriteAuthorityError);
    await expect(derive).rejects.toMatchObject({ reason: "member_without_org_membership" });
  });
});
