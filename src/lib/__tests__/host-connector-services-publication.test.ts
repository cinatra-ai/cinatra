import { describe, it, expect, vi, beforeAll } from "vitest";

// Host per-concern service publication (register-host-connector-services):
// pins (a) the `@cinatra-ai/host:connector-config` PHYSICAL `delete` member
// (the nango legacy-key purge must remove the dead, untrusted row — never
// blank it), (b) the BLOCKING `nango-connection-materializer` capability the
// nango gateway's save path awaits (failures fold into the save result), and
// (c) the transport-DI inversion surface (cinatra#151 Stage 3): the
// per-concern services the openai/anthropic/drupal-mcp/wordpress-mcp
// serverEntry transports adapt into their own deps slots, the old
// `@cinatra-ai/host:nango-connection-storage` id surviving ONLY as the
// deprecation-window compat shim, and the binder naming NO extension package.

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
vi.mock("@/lib/external-mcp-registry", () => ({
  upsertExternalMcpServer: async () => ({}),
  deleteExternalMcpServer: async () => {},
}));
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
// at activation.
vi.mock("@/lib/nango-system", () => ({
  requireNangoSystem: () => ({
    isNangoConfigured: () => false,
    getNangoStatus: () => ({ status: "not_connected", detail: "" }),
    providerConfigKeys: { github: "cinatra-github" },
  }),
}));
vi.mock("@/lib/host-content-editor-dispatch", () => ({ dispatchContentEditorViaA2A: async () => "" }));

const wordpressMaterialized: unknown[] = [];
vi.mock("@/lib/wordpress-api", () => ({
  deleteWordPressInstance: async () => ({}),
  getWordPressAPISettings: () => ({ instances: [] }),
  saveWordPressInstanceFromNangoConnection: async (input: unknown) => {
    wordpressMaterialized.push(input);
  },
}));
const linkedinMaterialized: unknown[] = [];
vi.mock("@/lib/linkedin-api", () => ({
  saveLinkedInAccountFromNangoConnection: async (input: unknown) => {
    linkedinMaterialized.push(input);
    return { id: "acct" };
  },
}));
vi.mock("@/lib/wordpress-mcp-connection", () => ({
  isPrivateUrl: () => false,
  probeWordPressInstanceMcpAdapter: async () => ({}),
  resolveWordPressMcpFallbackEndpoint: () => null,
}));
vi.mock("@/lib/drupal-mcp-connection", () => ({
  probeDrupalMcp: async () => ({}),
  resolveDrupalMcpServerUrl: () => null,
}));
vi.mock("@/lib/drupal-api", () => ({ getDrupalAPISettings: () => ({ instances: [] }) }));

import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
  type HostConnectorConfigService,
  type NangoConnectionMaterializer,
  type HostMcpPaginationService,
  type HostDrupalMcpService,
  type HostWordPressMcpService,
  type HostRuntimeModeService,
  type HostOpenAIConnectionService,
  type HostAnthropicConnectionService,
} from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

function resolveSingle<T>(capability: string): T {
  const providers = resolveCapabilityProviders(capability).filter(
    (p) => p.packageName === "@cinatra-ai/host",
  );
  expect(providers).toHaveLength(1);
  return providers[0].impl as T;
}

beforeAll(async () => {
  // Module load auto-runs registerHostConnectorServices() against the REAL
  // capability registry (the mocked deps keep it inert).
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

  it("the old nango-connection-storage id is OUT of the SDK contract and survives only as the deprecation-window compat shim", () => {
    // The contract no longer mints the id (consumers resolve nango-system).
    expect(
      Object.values(HOST_CONNECTOR_SERVICE_CAPABILITIES),
    ).not.toContain("@cinatra-ai/host:nango-connection-storage");
    // The shim still resolves for already-installed runtime package-store
    // digests, delegating to the nango-system surface at call time.
    const shim = resolveSingle<{
      isConfigured(): boolean;
      getStatus(): { status: string };
      providerConfigKeys: Record<string, string>;
    }>("@cinatra-ai/host:nango-connection-storage");
    expect(shim.isConfigured()).toBe(false);
    expect(shim.getStatus().status).toBe("not_connected");
    expect(shim.providerConfigKeys.github).toBe("cinatra-github");
  });
});
