import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Host per-concern service publication (register-host-connector-services):
// pins (a) the `@cinatra-ai/host:connector-config` PHYSICAL `delete` member
// (the nango legacy-key purge must remove the dead, untrusted row — never
// blank it), (b) the BLOCKING `nango-connection-materializer` capability the
// nango gateway's save path awaits (failures fold into the save result), and
// (c) the transport-DI inversion surface (cinatra#151 Stage 3): the
// per-concern services the openai/anthropic/drupal-mcp/wordpress-mcp
// serverEntry transports adapt into their own deps slots, the binder naming
// NO extension package, and (d) the zero-floor end-state (cinatra#151
// Stage 7): the legacy `@cinatra-ai/host:nango-connection-storage` id is
// FULLY retired — its deprecation-window compat shim is gone and the id
// resolves to NOTHING.

vi.mock("server-only", () => ({}));

// Heavy host deps the binder pulls at module load — stubbed so the boot-time
// auto-run (registerTransportConnectors()) completes in a unit context.
const dbCalls: Record<string, unknown[][]> = { read: [], write: [], delete: [] };
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...args: unknown[]) => {
    dbCalls.read.push(args);
    return args[1];
  },
  writeConnectorConfigToDatabase: (...args: unknown[]) => {
    dbCalls.write.push(args);
  },
  deleteConnectorConfig: (...args: unknown[]) => {
    dbCalls.delete.push(args);
  },
  readOpenAIConnectionFromDatabase: () => ({}),
  readAnthropicConnectionFromDatabase: () => ({}),
}));
vi.mock("@/lib/mcp-pagination", () => ({ decodeCursor: () => null, buildListPage: () => ({}) }));
const EXT_MCP_ROW = {
  id: "twenty-workspace",
  label: "Twenty (workspace)",
  serverUrl: "https://twenty.example/mcp",
  nangoConnectionId: "nango-1",
  scope: "workspace" as const,
  orgId: null,
  userId: null,
  enabled: true,
  allowedTools: null,
  allowedCatalogTools: ["people_search"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};
const extMcpCalls: Record<string, unknown[][]> = { resolveBearer: [] };
vi.mock("@/lib/external-mcp-registry", () => ({
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY: "cinatra-external-mcp",
  upsertExternalMcpServer: async () => ({}),
  deleteExternalMcpServer: async () => {},
  getExternalMcpServerById: (id: string) => (id === EXT_MCP_ROW.id ? EXT_MCP_ROW : null),
  listExternalMcpServers: () => [EXT_MCP_ROW],
  resolveExternalMcpServerBearer: async (...args: unknown[]) => {
    extMcpCalls.resolveBearer.push(args);
    return "bearer-jwt";
  },
}));
// mcp-server-connector setup-page surface (cinatra#612): the host binds the
// create/delete server actions, the viewer-context resolver, the Nango
// readiness flag, and the private-URL guard into the external-mcp-registry
// service. Stub the heavy "use server" actions module + the auth/nango edges so
// the boot-time auto-run completes in a unit context.
const extMcpActionCalls: Record<string, FormData[]> = { create: [], delete: [] };
const twentyActionCalls: Record<string, FormData[]> = { save: [], disconnect: [] };
vi.mock("@/app/campaigns/actions", () => ({
  createExternalMcpServerAction: async (fd: FormData) => {
    extMcpActionCalls.create.push(fd);
  },
  deleteExternalMcpServerAction: async (fd: FormData) => {
    extMcpActionCalls.delete.push(fd);
  },
  saveTwentyConnectionAction: async (fd: FormData) => {
    twentyActionCalls.save.push(fd);
  },
  disconnectTwentyConnectionAction: async (fd: FormData) => {
    twentyActionCalls.disconnect.push(fd);
  },
}));
// The REAL "use server" wrapper module (deliberately NOT mocked): the
// server-reference regression below pins the published deps to ITS exports by
// identity. It is feather-weight (no static imports; the heavy
// `@/app/campaigns/actions` graph is lazy-imported per invocation, and the
// vi.mock above intercepts that dynamic import).
import * as connectorSetupActions from "@/app/campaigns/connector-setup-actions";
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({ user: { id: "viewer-1", role: "user,admin" } }),
  isPlatformAdmin: (s: { user?: { role?: string | null } } | null | undefined) =>
    String(s?.user?.role ?? "").split(",").map((v) => v.trim()).includes("admin"),
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
// No extension-package mocks: the binder imports NO extension package since
// the transport-DI inversion (cinatra#151 Stage 3) — the transports self-bind
// at activation. (No @/lib/nango-system mock either: the binder dropped its
// last nango-system edge with the compat shim, cinatra#151 Stage 7.)
vi.mock("@/lib/host-content-editor-dispatch", () => ({ dispatchContentEditorViaA2A: async () => "" }));

const wordpressMaterialized: unknown[] = [];
const wordpressApiCalls: Record<string, unknown[][]> = {
  webhookList: [],
  webhookRegister: [],
  webhookRemove: [],
  save: [],
  devPersist: [],
  delete: [],
};
const WP_ROW = {
  id: "wp-1",
  name: "Site",
  siteUrl: "https://wp.example",
  username: "u",
  applicationPassword: "p",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};
const WP_SUB = {
  id: "sub-1",
  event_type: "post_published",
  target_url: "https://app.example/api/webhooks/wordpress",
  post_types: [] as string[],
  created_at: "2026-01-03T00:00:00Z",
};
// The relocated WordPress client the wordpress-mcp-connector registers under
// `@cinatra-ai/host:wordpress-mcp` (cinatra#975 Wave 3) — the host publication
// DELEGATES its client-backed members here (owner-pinned, fail-loud).
const wordpressConnectorClient = {
  listInstances: () => [] as unknown[],
  getAPIStatus: () => ({
    status: "connected",
    detail: "1 WordPress instance is configured.",
  }),
  getAPISettings: () => ({ instances: [], loggingEnabled: true }),
  readInstanceById: (id: string) => (id === WP_ROW.id ? WP_ROW : null),
  deleteInstance: async (...args: unknown[]) => {
    wordpressApiCalls.delete.push(args);
  },
  webhookSubscriptions: {
    list: async (...args: unknown[]) => {
      wordpressApiCalls.webhookList.push(args);
      return [WP_SUB];
    },
    register: async (...args: unknown[]) => {
      wordpressApiCalls.webhookRegister.push(args);
      return WP_SUB;
    },
    remove: async (...args: unknown[]) => {
      wordpressApiCalls.webhookRemove.push(args);
    },
  },
  // --- additive relocated-client members (core export names) ---------------
  validateWordPressInstanceConnection: async () => ({}),
  saveWordPressInstance: async (...args: unknown[]) => {
    wordpressApiCalls.save.push(args);
    return { id: WP_ROW.id, connectionId: "nango-wp-1" };
  },
  saveWordPressInstanceFromNangoConnection: async (input: unknown) => {
    wordpressMaterialized.push(input);
  },
  persistLocalDevWordPressInstanceUnvalidated: async (...args: unknown[]) => {
    wordpressApiCalls.devPersist.push(args);
    return { id: WP_ROW.id, connectionId: "nango-wp-1" };
  },
  setWordPressInstanceBlogConnector: () => {},
  saveWordPressLoggingSettings: async () => {},
  getWordPressLoggingSettings: () => ({ enabled: true, directory: "/data/logs/x" }),
  listWordPressInstances: async () => [],
  readLatestPublishedWordPressPost: async () => null,
};
const linkedinMaterialized: unknown[] = [];
// The relocated LinkedIn client the linkedin-connector registers under
// `@cinatra-ai/host:linkedin-connection` (cinatra#975 Wave 3) — the host no
// longer publishes the id; the nango materializer's linkedin branch resolves
// THIS provider (owner-pinned, fail-loud).
const linkedinConnectorClient = {
  getStatus: async () => ({ status: "connected", detail: "1 LinkedIn account is connected." }),
  getSettings: async () => ({ accounts: [] }),
  listAccounts: async () => [],
  listDestinations: async () => [],
  publishPost: async () => ({ postUrn: "urn:li:share:1", postUrl: "https://l.example" }),
  saveAccountFromNangoConnection: async (input: unknown) => {
    linkedinMaterialized.push(input);
  },
  getLoggingSettings: () => ({ enabled: true, directory: "/data/logs/li" }),
};
const youtubeApiCalls: Record<string, number> = { getConfiguredAccessToken: 0 };
// The relocated youtube client the youtube-connector registers under
// `@cinatra-ai/host:youtube-connection` (cinatra#975 Wave 3) — the host KEEPS
// a thin null-degrading delegation on this id (its consumer is the
// media-feeds connector, a different extension with no dependency edge).
const youtubeConnectorClient = {
  getConfiguredAccessToken: async () => {
    youtubeApiCalls.getConfiguredAccessToken += 1;
    return "yt-access-token";
  },
  getStatus: () => ({ status: "connected", detail: "Connected." }),
  clearSettings: async () => {},
};
vi.mock("@/lib/wordpress-mcp-connection", () => ({
  probeWordPressInstanceMcpAdapter: async () => ({}),
  invalidateWordPressMcpProbeCache: () => {},
  resolveWordPressMcpFallbackEndpoint: (siteUrl: string) =>
    `${siteUrl}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
  resolveWordPressMcpEndpoint: (siteUrl: string) => `${siteUrl}/wp-json/mcp/mcp-adapter-default-server`,
}));
// The private-URL policy is now the neutral `@/lib/url-policy` module
// (cinatra#975) — register-host-connector-services resolves `isPrivateUrl`
// from there and republishes it into the drupal/wordpress/external-mcp
// capabilities. Stub it false so the published-member assertions stay
// deterministic.
vi.mock("@/lib/url-policy", () => ({
  isPrivateUrl: () => false,
}));
// The widget-auth stores INVERTED to their owning connectors (cinatra#975 Wave
// 2): the host no longer imports/publishes them, so there is nothing to mock or
// assert here — the connectors register the capability from their own
// register(ctx) and core resolves it lazily (widget-auth-provider.test.ts).
vi.mock("@/lib/drupal-mcp-connection", () => ({
  probeDrupalMcp: async () => ({}),
  probeDrupalMcpWithBearer: async () => "registered",
  invalidateDrupalMcpProbeCache: () => {},
  resolveDrupalMcpServerUrl: () => null,
  getDrupalMcpInstanceStatuses: async () => [
    { id: "i-1", name: "Site", siteUrl: "https://d.example", status: "registered", isPrivate: false },
  ],
}));
const drupalApiCalls: Record<string, unknown[][]> = { save: [], delete: [], devPersist: [] };
// The relocated Drupal instance client the drupal-mcp-connector registers
// under `@cinatra-ai/host:drupal-mcp` (cinatra#975 Wave 3) — the host
// publication DELEGATES its client-backed members here.
const drupalConnectorClient = {
  listInstances: () => [] as unknown[],
  getAPIStatus: async () => ({ instanceCount: 0, instances: [] }),
  saveInstance: async (...args: unknown[]) => {
    drupalApiCalls.save.push(args);
    return { id: "i-1" };
  },
  deleteInstance: async (...args: unknown[]) => {
    drupalApiCalls.delete.push(args);
  },
  devPersistLocalInstanceUnvalidated: async (...args: unknown[]) => {
    drupalApiCalls.devPersist.push(args);
    return { id: "i-1" };
  },
};
// The per-instance connection use-gate seam (#975 Wave 3 prerequisite, epic
// #978): the binder folds the seam's `identity | null` returns to outcome
// booleans, so the mock returns an identity row / null / a marker-carrying
// deny per call to pin the fold + the fail-loud deny propagation. The
// CLASSIFIER is the REAL one (importOriginal) — the published member must be
// the seam's marker-field check by identity, not a test stand-in.
const instanceGateCalls: Record<string, unknown[][]> = {
  resolveOrSeed: [],
  enforce: [],
  enforcePerUser: [],
  authorizeWorker: [],
  sessionBinding: [],
};
const instanceGateMock = {
  resolveOrSeedInstanceIdentity: async (...args: unknown[]) => {
    instanceGateCalls.resolveOrSeed.push(args);
    const input = args[0] as { connectionId: string };
    return input.connectionId === "no-owner-conn" ? null : { id: "identity-1" };
  },
  enforceInstanceConnectionUse: async (...args: unknown[]) => {
    instanceGateCalls.enforce.push(args);
    const input = args[0] as { connectionId: string };
    if (input.connectionId === "denied-conn") {
      const denied = new Error("use denied") as Error & { connectionUseDenied?: true };
      denied.connectionUseDenied = true;
      throw denied;
    }
    return input.connectionId === "no-owner-conn" ? null : { id: "identity-1" };
  },
  enforcePerUserInstanceConnectionUse: async (...args: unknown[]) => {
    instanceGateCalls.enforcePerUser.push(args);
    return { id: "identity-1" };
  },
  authorizeWorkerConnectionUse: async (...args: unknown[]) => {
    instanceGateCalls.authorizeWorker.push(args);
    const input = args[0] as { connectionId: string };
    return input.connectionId !== "no-identity-conn";
  },
  resolveTrustedSessionBinding: async (...args: unknown[]) => {
    instanceGateCalls.sessionBinding.push(args);
    return { orgId: "org-1", runBy: "admin-1" };
  },
};
vi.mock("@/lib/instance-connection-actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instance-connection-actor")>();
  return { ...actual, ...instanceGateMock };
});
import {
  type HostConnectorConfigService,
  type NangoConnectionMaterializer,
  type HostMcpPaginationService,
  type HostDrupalMcpService,
  type HostWordPressMcpService,
  type HostInstanceWriteAuthorityService,
  type HostExternalMcpRegistryService,
  type HostInstanceConnectionGateService,
  type HostRuntimeModeService,
  type HostOpenAIConnectionService,
  type HostAnthropicConnectionService,
} from "@cinatra-ai/sdk-extensions";
import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
import {
  registerCapabilityProvider,
  invalidateProvidersForPackage,
  resolveCapabilityProviders,
} from "@/lib/extension-capabilities-registry";

// The owning connector package names — in TEST code only (the coupling gates
// exempt tests); production core derives them from the connectors-catalog
// (see @/lib/connector-client-providers).
const WORDPRESS_CONNECTOR_PKG = "@cinatra-ai/wordpress-mcp-connector";
const DRUPAL_CONNECTOR_PKG = "@cinatra-ai/drupal-mcp-connector";
const LINKEDIN_CONNECTOR_PKG = "@cinatra-ai/linkedin-connector";
const YOUTUBE_CONNECTOR_PKG = "@cinatra-ai/youtube-connector";

/** Register the fake CONNECTOR-owned relocated clients the host publication
 * delegates to (cinatra#975 Wave 3) under their owning package names. */
function registerConnectorClients() {
  registerCapabilityProvider("@cinatra-ai/host:wordpress-mcp", {
    packageName: WORDPRESS_CONNECTOR_PKG,
    impl: wordpressConnectorClient,
  });
  registerCapabilityProvider("@cinatra-ai/host:drupal-mcp", {
    packageName: DRUPAL_CONNECTOR_PKG,
    impl: drupalConnectorClient,
  });
  registerCapabilityProvider("@cinatra-ai/host:linkedin-connection", {
    packageName: LINKEDIN_CONNECTOR_PKG,
    impl: linkedinConnectorClient,
  });
  registerCapabilityProvider("@cinatra-ai/host:youtube-connection", {
    packageName: YOUTUBE_CONNECTOR_PKG,
    impl: youtubeConnectorClient,
  });
}

function resolveSingle<T>(capability: string): T {
  const providers = resolveCapabilityProviders(capability).filter(
    (p) => p.packageName === "@cinatra-ai/host",
  );
  expect(providers).toHaveLength(1);
  return providers[0].impl as T;
}

beforeAll(async () => {
  // Module load auto-runs registerHostConnectorServices() against the REAL
  // capability registry (the mocked deps keep it inert). The delegating
  // members resolve the connector-owned relocated clients LAZILY per call, so
  // registration order host-vs-connector is immaterial.
  registerConnectorClients();
  await import("@/lib/register-host-connector-services");
});

describe("host connector-config service (Stage-0 delete member)", () => {
  it("publishes read/write/delete, with delete bound to the PHYSICAL row delete", () => {
    const svc = resolveSingle<HostConnectorConfigService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.connectorConfig,
    );
    expect(typeof svc.read).toBe("function");
    expect(typeof svc.write).toBe("function");
    expect(typeof svc.delete).toBe("function");

    expect(svc.read("some-id", { a: 1 })).toEqual({ a: 1 });
    svc.write("some-id", { b: 2 });
    svc.delete("dead-key");
    expect(dbCalls.read.at(-1)).toEqual(["some-id", { a: 1 }]);
    expect(dbCalls.write.at(-1)).toEqual(["some-id", { b: 2 }]);
    expect(dbCalls.delete.at(-1)).toEqual(["dead-key"]);
  });
});

describe("anthropic-skill-config capability (cinatra#1104 — connector-owned Skills tab)", () => {
  it("publishes @cinatra-ai/host:anthropic-skill-config with the { read, write } shape the connector structurally resolves", () => {
    // A host-LOCAL id (deliberately NOT a HOST_CONNECTOR_SERVICE_CAPABILITIES /
    // sdk-extensions entry) that the anthropic-connector's `tryAnthropicSkillConfig`
    // resolves by this exact string and guards on BOTH members being functions
    // before use (anthropic-connector#44). Pin the id + shape so a refactor can't
    // silently break the connector's resolution.
    const cap = resolveSingle<{ read: unknown; write: unknown }>(
      "@cinatra-ai/host:anthropic-skill-config",
    );
    expect(typeof cap.read).toBe("function");
    expect(typeof cap.write).toBe("function");
  });
});

describe("nango-connection-materializer capability (blocking save-path hooks)", () => {
  it("materializes a wordpress save (site URL required, fail-loud when missing)", async () => {
    const m = resolveSingle<NangoConnectionMaterializer>(
      NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
    );
    await expect(
      m.materialize({
        connectorKey: "wordpress",
        providerConfigKey: "cinatra-wordpress",
        connectionId: "c-1",
        siteUrl: "https://example.com",
      }),
    ).resolves.toEqual({ handled: true });
    expect(wordpressMaterialized.at(-1)).toEqual({
      siteUrl: "https://example.com",
      providerConfigKey: "cinatra-wordpress",
      connectionId: "c-1",
    });

    await expect(
      m.materialize({
        connectorKey: "wordpress",
        providerConfigKey: "cinatra-wordpress",
        connectionId: "c-2",
      }),
    ).rejects.toThrow(/WordPress site domain/);
  });

  it("materializes a linkedin save and reports handled", async () => {
    const m = resolveSingle<NangoConnectionMaterializer>(
      NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
    );
    await expect(
      m.materialize({
        connectorKey: "linkedin",
        providerConfigKey: "cinatra-linkedin",
        connectionId: "c-3",
      }),
    ).resolves.toEqual({ handled: true });
    expect(linkedinMaterialized.at(-1)).toEqual({
      providerConfigKey: "cinatra-linkedin",
      connectionId: "c-3",
    });
  });

  it("FAILS LOUD when the owning connector is absent (never a silent half-saved connection)", async () => {
    const m = resolveSingle<NangoConnectionMaterializer>(
      NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
    );
    invalidateProvidersForPackage(WORDPRESS_CONNECTOR_PKG);
    try {
      await expect(
        m.materialize({
          connectorKey: "wordpress",
          providerConfigKey: "cinatra-wordpress",
          connectionId: "c-9",
          siteUrl: "https://example.com",
        }),
      ).rejects.toThrow(/wordpress-mcp" unavailable[\s\S]*wordpress-mcp-connector/);
    } finally {
      registerConnectorClients();
    }
  });

  it("reports handled:false for keys with no host materializer (caller fails loud)", async () => {
    const m = resolveSingle<NangoConnectionMaterializer>(
      NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
    );
    await expect(
      m.materialize({ connectorKey: "github", providerConfigKey: "cinatra-github", connectionId: "c-4" }),
    ).resolves.toEqual({ handled: false });
  });
});

describe("transport-DI inversion services (cinatra#151 Stage 3)", () => {
  it("publishes the per-concern services the serverEntry transports adapt", () => {
    const svc = HOST_CONNECTOR_SERVICE_CAPABILITIES;
    const pagination = resolveSingle<HostMcpPaginationService>(svc.mcpPagination);
    expect(typeof pagination.decodeCursor).toBe("function");
    expect(typeof pagination.buildListPage).toBe("function");

    const drupal = resolveSingle<HostDrupalMcpService>(svc.drupalMcp);
    expect(drupal.listInstances()).toEqual([]);
    expect(typeof drupal.probe).toBe("function");
    expect(typeof drupal.resolveServerUrl).toBe("function");
    expect(typeof drupal.isPrivateUrl).toBe("function");

    const wordpress = resolveSingle<HostWordPressMcpService>(svc.wordpressMcp);
    expect(wordpress.listInstances()).toEqual([]);
    expect(typeof wordpress.probeAdapter).toBe("function");
    expect(typeof wordpress.deleteInstance).toBe("function");

    const runtimeMode = resolveSingle<HostRuntimeModeService>(svc.runtimeMode);
    expect(runtimeMode.isDevelopment()).toBe(false);

    const openai = resolveSingle<HostOpenAIConnectionService>(svc.openaiConnection);
    expect(typeof openai.readRowFromDatabase).toBe("function");
    expect(typeof openai.read).toBe("function");
    expect(typeof openai.update).toBe("function");
    expect(typeof openai.clear).toBe("function");
    expect(typeof openai.updateLoggingEnabled).toBe("function");

    const anthropic = resolveSingle<HostAnthropicConnectionService>(svc.anthropicConnection);
    expect(typeof anthropic.readRowFromDatabase).toBe("function");

    expect(typeof resolveSingle<{ dispatch: unknown }>(svc.contentEditorDispatch).dispatch).toBe(
      "function",
    );
    expect(typeof resolveSingle<{ create: unknown }>(svc.notifications).create).toBe("function");
    expect(typeof resolveSingle<{ read: unknown }>(svc.skillsCatalog).read).toBe("function");
  });

  it("the old nango-connection-storage id is FULLY retired — out of the SDK contract AND no longer published (cinatra#151 Stage 7)", () => {
    // The contract no longer mints the id (consumers resolve nango-system).
    expect(
      Object.values(HOST_CONNECTOR_SERVICE_CAPABILITIES),
    ).not.toContain("@cinatra-ai/host:nango-connection-storage");
    // The deprecation-window compat shim is GONE: the id resolves to NOTHING.
    // A runtime package-store digest predating the Stage 3 re-point gets a
    // capability-resolution miss at call time and must be refreshed from the
    // marketplace.
    expect(
      resolveCapabilityProviders("@cinatra-ai/host:nango-connection-storage"),
    ).toEqual([]);
  });
});

describe("drupal instance-admin + widget-auth services (cinatra#172 Stage H2)", () => {
  // Grant-drift coverage: one assertion row per NEW/EXTENDED service MEMBER —
  // the publication test pins the full member set, not just the service id.
  it("extends @cinatra-ai/host:drupal-mcp with the instance-admin surface (every member bound)", async () => {
    const drupal = resolveSingle<HostDrupalMcpService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.drupalMcp,
    );
    // Pre-H2 members survive unchanged.
    expect(drupal.listInstances()).toEqual([]);
    expect(typeof drupal.probe).toBe("function");
    expect(typeof drupal.resolveServerUrl).toBe("function");
    expect(typeof drupal.isPrivateUrl).toBe("function");

    // Actor-scoped lister is bound; with the mocked-empty instance settings it
    // resolves to [] (fail-closed short-circuit before any actor/authority resolution).
    expect(typeof drupal.listAuthorizedInstances).toBe("function");
    await expect(drupal.listAuthorizedInstances!()).resolves.toEqual([]);

    // getAPIStatus — the connector's drupal_status primitive read.
    await expect(drupal.getAPIStatus()).resolves.toEqual({ instanceCount: 0, instances: [] });

    // saveInstance — WRITER; forwards the input envelope and returns the row.
    await expect(
      drupal.saveInstance({ name: "Site", siteUrl: "https://d.example", mcpApiKey: "k".repeat(12) }),
    ).resolves.toEqual({ id: "i-1" });
    expect(drupalApiCalls.save.at(-1)).toEqual([
      { name: "Site", siteUrl: "https://d.example", mcpApiKey: "k".repeat(12) },
    ]);

    // deleteInstance — WRITER; forwards the id.
    await expect(drupal.deleteInstance("i-1")).resolves.toBeUndefined();
    expect(drupalApiCalls.delete.at(-1)).toEqual(["i-1"]);

    // getInstanceStatuses — host probe + Nango bearer stays host-side.
    await expect(drupal.getInstanceStatuses()).resolves.toEqual([
      { id: "i-1", name: "Site", siteUrl: "https://d.example", status: "registered", isPrivate: false },
    ]);
  });

  // The drupal widget-auth store INVERTED to the drupal-mcp-connector
  // (cinatra#975 Wave 2): the host publishes no `drupal-widget-auth` service —
  // the connector registers the capability from its own register(ctx).
});

describe("wordpress connection-admin + content + widget-auth services (cinatra#172 Stage H3)", () => {
  // Grant-drift coverage: one assertion row per NEW/EXTENDED service MEMBER —
  // the publication test pins the full member set, not just the service id.
  it("extends @cinatra-ai/host:wordpress-mcp with the connection/instance-admin surface (every member bound)", async () => {
    const wordpress = resolveSingle<HostWordPressMcpService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressMcp,
    );
    // Pre-H3 members survive unchanged.
    expect(wordpress.listInstances()).toEqual([]);
    expect(typeof wordpress.probeAdapter).toBe("function");
    expect(typeof wordpress.resolveServerUrl).toBe("function");
    expect(typeof wordpress.isPrivateUrl).toBe("function");
    expect(typeof wordpress.deleteInstance).toBe("function");

    // Actor-scoped lister is bound; with the mocked-empty instance settings it
    // resolves to [] (fail-closed short-circuit before any actor/authority resolution).
    expect(typeof wordpress.listAuthorizedInstances).toBe("function");
    await expect(wordpress.listAuthorizedInstances!()).resolves.toEqual([]);

    // getAPIStatus — the connector's wordpress_status primitive read (SYNC).
    expect(wordpress.getAPIStatus()).toEqual({
      status: "connected",
      detail: "1 WordPress instance is configured.",
    });

    // getAPISettings — full settings document (rows + logging flag).
    expect(wordpress.getAPISettings()).toEqual({ instances: [], loggingEnabled: true });

    // readInstanceById — row lookup, null on unknown id.
    expect(wordpress.readInstanceById("wp-1")).toEqual(WP_ROW);
    expect(wordpress.readInstanceById("nope")).toBeNull();

    // resolveEndpoint — the PRIMARY pretty-permalink form (`/wp-json/...`),
    // DISTINCT from resolveServerUrl (the FALLBACK `index.php?rest_route=`
    // form). The two members must stay separately bound — conflating them
    // was the H3 design's named hazard. Pin BOTH forms and their inequality.
    expect(wordpress.resolveEndpoint("https://wp.example")).toBe(
      "https://wp.example/wp-json/mcp/mcp-adapter-default-server",
    );
    expect(wordpress.resolveServerUrl("https://wp.example")).toBe(
      "https://wp.example/index.php?rest_route=/mcp/mcp-adapter-default-server",
    );
    expect(wordpress.resolveEndpoint("https://wp.example")).not.toBe(
      wordpress.resolveServerUrl("https://wp.example"),
    );

    // webhookSubscriptions.list — remote read, forwards the instance row.
    await expect(wordpress.webhookSubscriptions.list(WP_ROW)).resolves.toEqual([WP_SUB]);
    expect(wordpressApiCalls.webhookList.at(-1)).toEqual([WP_ROW]);

    // webhookSubscriptions.register — WRITER; forwards row + subscription.
    const sub = { event_type: "post_published", target_url: "https://app.example/api/webhooks/wordpress", post_types: [] };
    await expect(wordpress.webhookSubscriptions.register(WP_ROW, sub)).resolves.toEqual(WP_SUB);
    expect(wordpressApiCalls.webhookRegister.at(-1)).toEqual([WP_ROW, sub]);

    // webhookSubscriptions.remove — WRITER; forwards row + subscription id.
    await expect(wordpress.webhookSubscriptions.remove(WP_ROW, "sub-1")).resolves.toBeUndefined();
    expect(wordpressApiCalls.webhookRemove.at(-1)).toEqual([WP_ROW, "sub-1"]);
  });

  it("the wordpress-content id is NO LONGER host-published — the connector owns the full content service (cinatra#975 Wave 3)", () => {
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressContent).toBe(
      "@cinatra-ai/host:wordpress-content",
    );
    // The relocated client (wordpress-mcp-connector#57) registers the full
    // member set from its own register(ctx); core resolves it owner-pinned
    // through @/lib/connector-client-providers (fail-loud degradation —
    // connector-client-providers.test.ts). The host publishes NOTHING here,
    // and the connector's own deps slot falls back to its self-registration.
    const hostProviders = resolveCapabilityProviders(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressContent,
    ).filter((p) => p.packageName === "@cinatra-ai/host");
    expect(hostProviders).toEqual([]);
  });

  // The wordpress widget-auth store INVERTED to the wordpress-mcp-connector
  // (cinatra#975 Wave 2): the host publishes no `wordpress-widget-auth`
  // service — the connector registers the capability from its own register(ctx).
});

describe("per-user/per-instance write authority service (cinatra#409)", () => {
  it("publishes @cinatra-ai/host:instance-write-authority with a HOST-BOUND selectForConnector guard", () => {
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceWriteAuthority).toBe(
      "@cinatra-ai/host:instance-write-authority",
    );
    const authority = resolveSingle<HostInstanceWriteAuthorityService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceWriteAuthority,
    );
    // The two CMS content connectors bind their own static KIND → a guard. The
    // host maps the kind to BOTH the package id and the instance reader.
    const wp = authority.selectForConnector("wordpress");
    const drupal = authority.selectForConnector("drupal");
    expect(typeof wp.requireWrite).toBe("function");
    expect(typeof drupal.requireWrite).toBe("function");
    // An unknown connector kind THROWS host-side — the package whose policy is
    // evaluated and the instance reader can never be arbitrary caller input
    // (codex must-fix). A package id passed where a KIND is expected is unknown.
    // The contract type is the closed union `"wordpress" | "drupal"`; cast to
    // exercise the RUNTIME guard against an off-union string.
    const selectAny = authority.selectForConnector as (kind: string) => unknown;
    expect(() => selectAny("@attacker/evil")).toThrow();
    expect(() => selectAny("@cinatra-ai/wordpress-mcp-connector")).toThrow();
  });
});

describe("transport-tail connection services (cinatra#172 Stage H4)", () => {
  // Grant-drift coverage: one assertion row per NEW/EXTENDED service MEMBER —
  // the publication test pins the full member set, not just the service id.
  it("extends @cinatra-ai/host:external-mcp-registry with the read + bearer-mint surface (every member bound)", async () => {
    // The host extends the published service with the mcp-server-connector
    // setup-page surface (cinatra#612) via a host-LOCAL type (not the SDK
    // contract — the connector resolves these members structurally). Type the
    // resolved registry with that extended shape so the new members typecheck.
    type ExternalMcpRegistrySetupSurface = HostExternalMcpRegistryService & {
      createServerAction(formData: FormData): Promise<void>;
      deleteServerAction(formData: FormData): Promise<void>;
      saveTwentyConnectionAction(formData: FormData): Promise<void>;
      disconnectTwentyConnectionAction(formData: FormData): Promise<void>;
      resolveViewerContext(): Promise<{ isAdmin: boolean; userId: string }>;
      isConnectionServiceReady(): boolean;
      isPrivateUrl(serverUrl: string): boolean;
    };
    const registry = resolveSingle<ExternalMcpRegistrySetupSurface>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.externalMcpRegistry,
    );
    // Pre-H4 WRITER members survive unchanged.
    expect(typeof registry.upsertServer).toBe("function");
    expect(typeof registry.deleteServer).toBe("function");

    // getServerById — row lookup, null on unknown id.
    expect(registry.getServerById("twenty-workspace")).toEqual(EXT_MCP_ROW);
    expect(registry.getServerById("nope")).toBeNull();

    // listServers — full registry read.
    expect(registry.listServers()).toEqual([EXT_MCP_ROW]);

    // resolveBearer — in-process bearer mint; forwards the full row (the
    // TRUSTED server-side path that bypasses the LLM-facing Layer-B proxy —
    // the contract's TRUST note documents this posture).
    await expect(registry.resolveBearer(EXT_MCP_ROW)).resolves.toBe("bearer-jwt");
    expect(extMcpCalls.resolveBearer.at(-1)).toEqual([EXT_MCP_ROW]);

    // --- mcp-server-connector setup-page surface (cinatra#612) -------------
    // The carved "MCP Servers" connector binds these into its deps slot. The
    // create/delete WRITE actions delegate to the host server actions (which
    // own the admin-authorization boundary + redirect) — bound, never
    // reimplemented here.
    const createFd = new FormData();
    await registry.createServerAction(createFd);
    expect(extMcpActionCalls.create.at(-1)).toBe(createFd);
    const deleteFd = new FormData();
    await registry.deleteServerAction(deleteFd);
    expect(extMcpActionCalls.delete.at(-1)).toBe(deleteFd);

    // resolveViewerContext — admin flag + user id from the auth session.
    await expect(registry.resolveViewerContext()).resolves.toEqual({
      isAdmin: true,
      userId: "viewer-1",
    });

    // isConnectionServiceReady — Nango readiness for the API-key advisory.
    expect(registry.isConnectionServiceReady()).toBe(true);

    // isPrivateUrl — the LLM-reachability guard (mocked false here).
    expect(registry.isPrivateUrl("https://mcp.example.com")).toBe(false);
  });

  // --- twenty-connector#39 regression: the published setup-page actions must
  // be REAL server-action references, not adapter closures. -----------------
  //
  // (Scope note, cinatra#1097: the CURRENT twenty-connector binds
  // connector-local "use server" actions and only CALLS these members at POST
  // time; the direct `<form action={…}>` binding below remains true for the
  // mcp-server-connector bundled-react fallback and for a lock-pinned OLDER
  // twenty-connector — the compat window the bridge keeps reflecting.)
  //
  // The connectors bind these members DIRECTLY into `<form action={…}>`; React
  // only serializes a function into the RSC client payload when it carries a
  // server-reference marker, which the Next compiler attaches to exports of a
  // `"use server"` module. A closure defined in the (non-"use server") binder
  // rendered the twenty setup page a deterministic 500 for every admin
  // (digest 1769553696) while every unit suite passed — nothing asserted the
  // reference identity. The vitest pipeline does not run the Next "use server"
  // transform (so `$$typeof`/`$$id` cannot be asserted here directly); the
  // equivalent unit-fidelity pin is IDENTITY to the exports of a module whose
  // FIRST statement is the `"use server"` directive — exactly the two facts
  // the compiler needs to mint the marker. The live/browser fidelity lives in
  // tests/e2e/render-smoke (connector setup routes).
  it("publishes the setup-page form actions AS the exports of the 'use server' connector-setup-actions module (identity, not wrappers) — twenty-connector#39", async () => {
    type ExternalMcpRegistrySetupSurface = HostExternalMcpRegistryService & {
      createServerAction(formData: FormData): Promise<void>;
      deleteServerAction(formData: FormData): Promise<void>;
      saveTwentyConnectionAction(formData: FormData): Promise<void>;
      disconnectTwentyConnectionAction(formData: FormData): Promise<void>;
    };
    const registry = resolveSingle<ExternalMcpRegistrySetupSurface>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.externalMcpRegistry,
    );

    // Identity — a re-wrapping closure (`async (fd) => …`) would fail these
    // even though it is `typeof === "function"` and behaviorally identical in
    // a unit context. This is the assertion that was missing when the bug
    // shipped.
    expect(registry.createServerAction).toBe(
      connectorSetupActions.createExternalMcpServerAction,
    );
    expect(registry.deleteServerAction).toBe(
      connectorSetupActions.deleteExternalMcpServerAction,
    );
    expect(registry.saveTwentyConnectionAction).toBe(
      connectorSetupActions.saveTwentyConnectionAction,
    );
    expect(registry.disconnectTwentyConnectionAction).toBe(
      connectorSetupActions.disconnectTwentyConnectionAction,
    );

    // The module those exports come from must be compiled as a server-action
    // module: its FIRST statement is the "use server" directive.
    const actionsModulePath = path.resolve(
      __dirname,
      "..",
      "..",
      "app",
      "campaigns",
      "connector-setup-actions.ts",
    );
    const actionsSource = fs.readFileSync(actionsModulePath, "utf-8");
    expect(actionsSource.startsWith(`"use server";`)).toBe(true);

    // Behavior parity: the references still lazy-load + forward to the real
    // campaign actions on invocation (the vi.mock intercepts the inner dynamic
    // import) — the twenty members were previously untested here at all.
    const saveFd = new FormData();
    await registry.saveTwentyConnectionAction(saveFd);
    expect(twentyActionCalls.save.at(-1)).toBe(saveFd);
    const disconnectFd = new FormData();
    await registry.disconnectTwentyConnectionAction(disconnectFd);
    expect(twentyActionCalls.disconnect.at(-1)).toBe(disconnectFd);

    // RENDER + POST-back resolution: the connector dispatch route must import
    // the server-reference BRIDGE (which reflects the route layer's
    // compiler-minted reference metadata onto the boot-published instances AND
    // anchors the "use server" module into the route graph so the action id
    // resolves there). Pin both imports so a refactor cannot silently drop
    // either half — dropping the bridge re-ships the twenty-connector#39 500.
    const dispatchPagePath = path.resolve(
      __dirname,
      "..",
      "..",
      "app",
      "connectors",
      "[vendor]",
      "[slug]",
      "[subroute]",
      "page.tsx",
    );
    const dispatchPageSource = fs.readFileSync(dispatchPagePath, "utf-8");
    expect(dispatchPageSource).toContain(
      `import "@/lib/connector-setup-action-references.server";`,
    );
    const bridgePath = path.resolve(
      __dirname,
      "..",
      "connector-setup-action-references.server.ts",
    );
    const bridgeSource = fs.readFileSync(bridgePath, "utf-8");
    expect(bridgeSource).toContain(
      `from "@/app/campaigns/connector-setup-actions"`,
    );
  });

  // --- twenty-connector#39 regression, part 2: the RSC-layer bridge reflects
  // the compiler-minted server-reference metadata onto the boot-published
  // instances. The boot (instrumentation) graph never runs the "use server"
  // transform, so WITHOUT this reflection the connector's boot-captured deps
  // members stay unmarked and the setup page 500s at form render even though
  // they are exports of a genuine "use server" module. ----------------------
  it("bridge reflects server-reference metadata ($$typeof/$$id) onto the published action instances — twenty-connector#39", async () => {
    const { reflectConnectorSetupActionReferences, copyServerReferenceProps } =
      await import("@/lib/connector-setup-action-references.server");

    // Simulate the two compilations: an untransformed boot instance (what the
    // registry publishes) and the route layer's transformed instance carrying
    // the compiler-minted reference metadata.
    const makePair = () => {
      const bootInstance = (async () => {}) as (formData: FormData) => Promise<void>;
      const transformed = (async () => {}) as (formData: FormData) => Promise<void>;
      Object.defineProperties(transformed, {
        $$typeof: { value: Symbol.for("react.server.reference") },
        $$id: { value: "40deadbeef".padEnd(40, "0") },
        $$bound: { value: null },
      });
      return { bootInstance, transformed };
    };

    const save = makePair();
    const disconnect = makePair();
    const impl: Record<string, unknown> = {
      saveTwentyConnectionAction: save.bootInstance,
      disconnectTwentyConnectionAction: disconnect.bootInstance,
    };
    reflectConnectorSetupActionReferences(impl, {
      saveTwentyConnectionAction: save.transformed,
      disconnectTwentyConnectionAction: disconnect.transformed,
    });

    // The PUBLISHED instances (the very objects the connector captured into
    // its deps slot at boot) now carry the reference marker, in place.
    for (const pair of [save, disconnect]) {
      const decorated = pair.bootInstance as unknown as Record<string, unknown>;
      expect(decorated.$$typeof).toBe(Symbol.for("react.server.reference"));
      expect(decorated.$$id).toBe("40deadbeef".padEnd(40, "0"));
      expect(decorated).not.toBe(pair.transformed);
    }

    // Fail-soft floors: an untransformed layer (no $$id) and an unpublished
    // registry must both no-op, never throw.
    const plainA = (async () => {}) as (formData: FormData) => Promise<void>;
    const plainB = (async () => {}) as (formData: FormData) => Promise<void>;
    reflectConnectorSetupActionReferences(
      { saveTwentyConnectionAction: plainA },
      { saveTwentyConnectionAction: plainB },
    );
    expect(
      (plainA as unknown as Record<string, unknown>).$$id,
    ).toBeUndefined();
    expect(() =>
      reflectConnectorSetupActionReferences(undefined, {}),
    ).not.toThrow();

    // copyServerReferenceProps copies every transform-added own prop but never
    // clobbers length/name.
    const target = (async () => {}) as (formData: FormData) => Promise<void>;
    copyServerReferenceProps(
      save.transformed as (formData: FormData) => Promise<void>,
      target,
    );
    expect((target as unknown as Record<string, unknown>).$$id).toBe(
      "40deadbeef".padEnd(40, "0"),
    );
    expect(target.name).toBe("target");
  });

  // --- cinatra#1068 regression: re-copy over a target React has ALREADY
  // registered as a real <form action>. React's server-reference registration
  // re-defines $$typeof/$$id/$$bound as NON-configurable data props on the
  // published instance; the next bridge re-evaluation (Turbopack HMR / a
  // second compilation layer) re-copies the same descriptors and previously
  // threw `TypeError: Cannot redefine property: $$typeof` — an intermittent
  // dev 500 on the connector setup dispatch route. A locked prop with the
  // identical value must be skipped; the copy must stay correct for fresh
  // (unlocked) targets. -----------------------------------------------------
  it("re-copy over a React-registered (non-configurable $$typeof/$$id/$$bound) reference is safe — cinatra#1068", async () => {
    const { copyServerReferenceProps } = await import(
      "@/lib/connector-setup-action-references.server"
    );

    const transformed = (async () => {}) as (formData: FormData) => Promise<void>;
    Object.defineProperties(transformed, {
      $$typeof: { value: Symbol.for("react.server.reference") },
      $$id: { value: "40deadbeef".padEnd(40, "0") },
      $$bound: { value: null },
    });
    const published = (async () => {}) as (formData: FormData) => Promise<void>;

    // First bridge evaluation decorates the boot-published instance.
    copyServerReferenceProps(transformed, published);

    // React registers the decorated instance as a form action: the reference
    // props become NON-configurable data props holding the SAME values (the
    // shared registry symbol + the deterministic compiler-minted id).
    for (const prop of ["$$typeof", "$$id", "$$bound"]) {
      const current = Object.getOwnPropertyDescriptor(published, prop)!;
      Object.defineProperty(published, prop, {
        value: current.value,
        writable: false,
        enumerable: current.enumerable,
        configurable: false,
      });
    }

    // Second bridge evaluation (HMR / another layer): must NOT throw, and the
    // locked metadata must survive intact.
    expect(() =>
      copyServerReferenceProps(transformed, published),
    ).not.toThrow();
    const locked = published as unknown as Record<string, unknown>;
    expect(locked.$$typeof).toBe(Symbol.for("react.server.reference"));
    expect(locked.$$id).toBe("40deadbeef".padEnd(40, "0"));
    expect(
      Object.getOwnPropertyDescriptor(published, "$$typeof")!.configurable,
    ).toBe(false);

    // Still correct for a FRESH (unlocked) target after the guard: props land
    // configurable so later re-copies keep working.
    const fresh = (async () => {}) as (formData: FormData) => Promise<void>;
    copyServerReferenceProps(transformed, fresh);
    expect((fresh as unknown as Record<string, unknown>).$$id).toBe(
      "40deadbeef".padEnd(40, "0"),
    );
    expect(
      Object.getOwnPropertyDescriptor(fresh, "$$typeof")!.configurable,
    ).toBe(true);
  });

  it("the github/linkedin connection ids are NO LONGER host-published — each owning connector registers its relocated client (cinatra#975 Wave 3)", () => {
    // The ids stay minted in the SDK contract (the connectors register under
    // them; consumers resolve them), but the HOST provider is retired: the
    // relocated clients (github-connector#36 / linkedin-connector#42) carry
    // the full former member sets — the SDK contract members with the
    // identical token/PAT-stripping posture, PLUS the additive core-call-site
    // members — pinned by each connector's own suite. Core resolves them
    // owner-pinned through @/lib/connector-client-providers (tested
    // degradation there).
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.githubConnection).toBe(
      "@cinatra-ai/host:github-connection",
    );
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.linkedinConnection).toBe(
      "@cinatra-ai/host:linkedin-connection",
    );
    for (const id of [
      HOST_CONNECTOR_SERVICE_CAPABILITIES.githubConnection,
      HOST_CONNECTOR_SERVICE_CAPABILITIES.linkedinConnection,
    ]) {
      const hostProviders = resolveCapabilityProviders(id).filter(
        (p) => p.packageName === "@cinatra-ai/host",
      );
      expect(hostProviders).toEqual([]);
    }
    // The registered fake connector client is the sole linkedin provider —
    // the nango materializer's linkedin branch (asserted above) resolved THIS.
    const linkedinProviders = resolveCapabilityProviders(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.linkedinConnection,
    );
    expect(linkedinProviders.map((p) => p.packageName)).toEqual([LINKEDIN_CONNECTOR_PKG]);
  });

  it("youtube-connection KEEPS a host-published NULL-DEGRADING delegation (its consumer is another extension — codex Wave-3 round-1 finding 1)", async () => {
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.youtubeConnection).toBe(
      "@cinatra-ai/host:youtube-connection",
    );
    const youtube = resolveSingle<{ getConfiguredAccessToken(): Promise<string | null> }>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.youtubeConnection,
    );
    // Delegates to the connector-owned relocated client when present…
    const before = youtubeApiCalls.getConfiguredAccessToken;
    await expect(youtube.getConfiguredAccessToken()).resolves.toBe("yt-access-token");
    expect(youtubeApiCalls.getConfiguredAccessToken).toBe(before + 1);
    // …and degrades to null (the former "no usable credential" contract) when
    // the youtube connector is absent — media_feed_youtube_list keeps its
    // token-missing domain error instead of a wiring throw.
    invalidateProvidersForPackage(YOUTUBE_CONNECTOR_PKG);
    try {
      await expect(youtube.getConfiguredAccessToken()).resolves.toBeNull();
    } finally {
      registerConnectorClients();
    }
    // Single reader by design — no writer members on the host delegation.
    expect(Object.keys(youtube)).toEqual(["getConfiguredAccessToken"]);
  });

  it("publishes @cinatra-ai/host:instance-connection-gate delegating to the host seam (#975 Wave 3 prerequisite)", async () => {
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate).toBe(
      "@cinatra-ai/host:instance-connection-gate",
    );
    const gate = resolveSingle<HostInstanceConnectionGateService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate,
    );

    // Identity-row internals never cross the boundary: the seam's
    // `identity | null` folds to outcome booleans.
    await expect(
      gate.resolveOrSeedInstanceIdentity({
        connectorKey: "wordpress",
        connectionId: "conn-1",
        binding: { orgId: "org-1", runBy: "admin-1" },
      }),
    ).resolves.toEqual({ identityResolved: true });
    expect(instanceGateCalls.resolveOrSeed.at(-1)).toEqual([
      { connectorKey: "wordpress", connectionId: "conn-1", binding: { orgId: "org-1", runBy: "admin-1" } },
    ]);

    await expect(
      gate.enforceInstanceConnectionUse({
        connectorKey: "wordpress",
        connectionId: "conn-1",
        source: "wordpress-api",
      }),
    ).resolves.toEqual({ gated: true });

    await expect(
      gate.enforcePerUserInstanceConnectionUse({
        connectorKey: "linkedin",
        connectionId: "li-conn",
        userId: "user-42",
        source: "linkedin-api",
      }),
    ).resolves.toEqual({ gated: true });

    await expect(
      gate.authorizeWorkerConnectionUse({
        connectorKey: "youtube",
        connectionId: "yt-conn",
        source: "media-feeds-scraper",
      }),
    ).resolves.toBe(true);

    await expect(gate.resolveTrustedSessionBinding()).resolves.toEqual({
      orgId: "org-1",
      runBy: "admin-1",
    });
  });

  it("instance-connection-gate DEGRADATION: no resolvable identity folds to { gated:false } / { identityResolved:false } (the pre-#967 ungated fallback), and the worker gate fails CLOSED to bare false", async () => {
    const gate = resolveSingle<HostInstanceConnectionGateService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate,
    );

    await expect(
      gate.resolveOrSeedInstanceIdentity({ connectorKey: "wordpress", connectionId: "no-owner-conn" }),
    ).resolves.toEqual({ identityResolved: false });
    await expect(
      gate.enforceInstanceConnectionUse({
        connectorKey: "wordpress",
        connectionId: "no-owner-conn",
        source: "wordpress-api",
      }),
    ).resolves.toEqual({ gated: false });
    // The actor-less worker gate: a bare boolean (falsy on no-identity so a
    // naive `if (await …)` reads the fail-closed outcome correctly).
    await expect(
      gate.authorizeWorkerConnectionUse({
        connectorKey: "youtube",
        connectionId: "no-identity-conn",
        source: "media-feeds-scraper",
      }),
    ).resolves.toBe(false);
  });

  it("instance-connection-gate FAIL-LOUD: a use-gate DENY propagates out of the enforce members and the published classifier identifies it", async () => {
    const gate = resolveSingle<HostInstanceConnectionGateService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate,
    );

    let thrown: unknown;
    try {
      await gate.enforceInstanceConnectionUse({
        connectorKey: "wordpress",
        connectionId: "denied-conn",
        source: "wordpress-api",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The published classifier is the REAL seam classifier (marker-field
    // check): deny -> true; a generic error -> false.
    expect(gate.isConnectionUseDenied(thrown)).toBe(true);
    expect(gate.isConnectionUseDenied(new Error("boom"))).toBe(false);
  });
});
