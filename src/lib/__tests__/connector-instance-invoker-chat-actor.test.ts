import { describe, it, expect, vi, beforeAll } from "vitest";

// cinatra#2024 S9 G1 fix — resolver-level test for the CHAT actor shape.
//
// Prior to this fix, `resolveConnectorInstanceInvokerContext()` in
// register-host-connector-services.ts derived `connectorKey` ONLY from a
// signed `connectorInstancePin` on the delegated actor. The `chat` actor
// carries no such pin by design (request-context.ts's `DelegatedMcpActor`
// doc), so EVERY chat call to `invokeSiteTool`/`listSiteTools` threw
// `connector_key_underivable` unconditionally — a real regression against
// the S7-δ perimeter swap that lists `wordpress_site_tool_call`/
// `wordpress_site_tools_list` as chat-ALLOWED. The pre-fix
// `site-tool-primitives-ship-dark.test.ts` only asserted the POLICY-LAYER
// allowlist function returns true for chat; it never called the resolver, so
// it could not (and did not) catch this gap.
//
// This suite drives the REAL registered `invokeSiteTool` capability end to
// end (through the real `resolveConnectorInstanceInvokerContext` +
// `invokeConnectorInstanceTool`'s real `runSharedGate`/`requireUse` authority
// gate) under a `chat`-delegated ambient MCP request frame — never a mocked
// resolver — proving:
//   1. POSITIVE — an explicit, caller-supplied `instanceId` lets a chat actor
//      reach a real dispatch (connectorKey host-derives to "wordpress"; the
//      live per-instance/org authority gate runs and ALLOWS).
//   2. NEGATIVE (no instanceId) — still fails closed with
//      `connector_key_underivable`, before any authority/catalog code runs.
//   3. NEGATIVE (forged/other-tenant instanceId) — the resolver derives a
//      connectorKey (the row exists), but the REAL live per-instance
//      org-binding gate denies (`instance_org_mismatch`) — proving this is a
//      resolver-input change only, never a loosening of authorization.
//   4. NO DURABLE PIN — two calls from the SAME chat actor, second call
//      targeting a DIFFERENT instance, re-resolve and re-authorize
//      independently (the live org-role check fires again on call 2; a stale
//      cross-call pin would either silently reuse call 1's instance or throw
//      a pin-mismatch error instead of this call's own fresh, correct denial).

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
// acquire → policy evaluate → execute) runs to completion without a DB. -----
vi.mock("@/lib/connector-instance-tool-policy-store", () => ({
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
const wireCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
vi.mock("@/lib/connector-instance-mcp-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connector-instance-mcp-transport")>();
  return {
    ...actual,
    callConnectorInstanceMcpTool: vi.fn(
      async (input: { endpoint: string; authHeader: string; name: string; arguments: Record<string, unknown> }) => {
        wireCalls.push({ name: input.name, arguments: input.arguments });
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
import { InstanceWriteAuthorityError } from "@/lib/connector-instance-write-authority";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

// Two WordPress instance rows: ORG_A owns "wp-valid" (the chat actor's own
// org); ORG_B owns "wp-other-tenant" (a DIFFERENT org's instance — the
// forged/other-tenant negative case).
const WP_ROWS: Record<string, { id: string; orgId: string; siteUrl: string; username: string; applicationPassword: string }> = {
  "wp-valid": {
    id: "wp-valid",
    orgId: "org-a",
    siteUrl: "https://a.example",
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

/** Run `fn` under an ambient MCP request frame carrying a `chat`-delegated
 * actor for (userId, orgId) — the REAL AsyncLocalStorage the transport
 * boundary stamps in production; `resolveExtensionActorContext`/
 * `resolveExtensionActorSummary` (and so `resolveTrustedWriteActor`) read
 * straight off this frame with no DB, matching how the MCP transport
 * actually populates it. */
function runAsChatActor<T>(input: { userId: string; orgId: string }, fn: () => Promise<T>): Promise<T> {
  const frame: McpRequestContext = {
    userId: input.userId,
    orgId: input.orgId,
    delegatedActor: {
      delegation: "chat",
      userId: input.userId,
      orgId: input.orgId,
      platformRole: "member",
    },
  };
  return mcpRequestContextStorage.run(frame, fn);
}

describe("chat actor connector-instance-invoker resolver (cinatra#2024 S9 G1)", () => {
  beforeAll(() => {
    resolveOrgRoleForUser.mockImplementation(async (orgId) => (orgId ? "member" : undefined));
  });

  it("POSITIVE: an explicit instanceId lets a chat actor reach a real dispatch (connectorKey host-derives, no pin, live gate allows)", async () => {
    wireCalls.length = 0;
    resolveOrgRoleForUser.mockClear();

    const result = await runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );

    // The REAL dispatch ran end to end: the live org-membership re-check fired
    // (fresh — never skipped) and the wire triad sequence executed for
    // "wp-valid"'s instance, ending in the real tool result.
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-a", "user-1");
    expect(result).toEqual({ structuredContent: { ok: true } });
    expect(wireCalls.map((c) => c.name)).toEqual([
      "mcp-adapter-discover-abilities",
      "mcp-adapter-get-ability-info",
      "mcp-adapter-execute-ability",
    ]);
  });

  it("NEGATIVE: no instanceId still fails closed (connector_key_underivable), before any authority check runs", async () => {
    resolveOrgRoleForUser.mockClear();

    const call = runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {} }),
    );
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "connector_key_underivable" });

    // The resolver threw before EVER reaching the live authority gate.
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("NEGATIVE: a forged/other-tenant instanceId still fails closed (instance_org_mismatch) — the resolver only derives the connectorKey, never the authorization", async () => {
    resolveOrgRoleForUser.mockClear();

    const call = runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-other-tenant" }),
    );
    await expect(call).rejects.toBeInstanceOf(InstanceWriteAuthorityError);
    await expect(call).rejects.toMatchObject({ reason: "instance_org_mismatch" });

    // The live per-instance gate DID run (re-verified membership) before denying —
    // proving the deny came from the real org-binding check, not a short-circuit.
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("NO DURABLE PIN: two calls from the SAME chat actor re-resolve independently — a second, different-tenant instanceId is denied exactly as a cold call would be", async () => {
    resolveOrgRoleForUser.mockClear();

    // Call 1: a valid, same-org instance — succeeds.
    const first = await runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );
    expect(first).toEqual({ structuredContent: { ok: true } });
    expect(resolveOrgRoleForUser).toHaveBeenCalledTimes(1);

    // Call 2: SAME chat actor, a DIFFERENT (other-tenant) instanceId. If a
    // durable pin had been synthesized from call 1, this would either
    // silently reuse "wp-valid" (wrong instance, worse) or throw
    // `instance_pin_mismatch` (a pin-shaped error) instead of this call's OWN
    // fresh org-binding denial — neither of which is what actually happens.
    const second = runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-other-tenant" }),
    );
    await expect(second).rejects.toBeInstanceOf(InstanceWriteAuthorityError);
    await expect(second).rejects.toMatchObject({ reason: "instance_org_mismatch" });

    // The live authority check ran AGAIN (call count 2, not still 1) — the
    // second call re-resolved and re-authorized from scratch, exactly as a
    // brand-new, unrelated call would.
    expect(resolveOrgRoleForUser).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION GUARD: agent_run without a signed pin is UNCHANGED — still fails closed (the G1 fix is scoped to chat only)", async () => {
    const frame: McpRequestContext = {
      userId: "agent-user",
      orgId: "org-a",
      delegatedActor: {
        delegation: "agent_run",
        userId: "agent-user",
        orgId: "org-a",
        runId: "run-1",
        platformRole: "member",
        oboCeiling: [],
        // deliberately NO connectorInstancePin
      },
    };

    const call = mcpRequestContextStorage.run(frame, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "connector_key_underivable" });
  });

  it("REGRESSION GUARD: public_site_widget without a signed pin is UNCHANGED — still fails closed (the G1 fix is scoped to chat only)", async () => {
    const frame: McpRequestContext = {
      userId: "widget-user",
      orgId: "org-a",
      delegatedActor: {
        delegation: "public_site_widget",
        userId: "widget-user",
        orgId: "org-a",
        instanceId: "wp-valid",
        kind: "wordpress",
        jti: "turn-1",
        platformRole: "member",
        // deliberately NO connectorInstancePin — the widget path is doc'd as
        // "always instance-pinned" in production, but the resolver's own
        // fail-closed branch must hold even in this hypothetical case; the
        // G1 fix must never widen it.
      },
    };

    const call = mcpRequestContextStorage.run(frame, () =>
      invoker.invokeSiteTool({ toolName: "core/get-site-info", args: {}, instanceId: "wp-valid" }),
    );
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "connector_key_underivable" });
  });

  it("listSiteTools gets the SAME chat fix as invokeSiteTool: explicit instanceId reaches a real catalog listing", async () => {
    resolveOrgRoleForUser.mockClear();

    const page = await runAsChatActor({ userId: "user-1", orgId: "org-a" }, () =>
      invoker.listSiteTools({ instanceId: "wp-valid" }),
    );

    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-a", "user-1");
    expect(page.tools.map((t) => t.name)).toEqual(["core/get-site-info"]);
    expect(page.tools[0]?.policyStatus).toBe("allowed");
  });

  it("listSiteTools with no instanceId still fails closed (connector_key_underivable)", async () => {
    resolveOrgRoleForUser.mockClear();

    const call = runAsChatActor({ userId: "user-1", orgId: "org-a" }, () => invoker.listSiteTools({}));
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "connector_key_underivable" });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });
});
