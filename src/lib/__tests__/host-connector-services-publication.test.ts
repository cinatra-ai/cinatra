import { describe, it, expect, vi, beforeAll } from "vitest";

// Host per-concern service publication (register-transport-connectors):
// pins the ADDITIVE Stage-0 surface of the nango serverEntry cutover
// (cinatra#151) — (a) the `@cinatra-ai/host:connector-config` service now
// carries the PHYSICAL `delete` member (the nango legacy-key purge must
// remove the dead, untrusted row — never blank it), and (b) the BLOCKING
// `nango-connection-materializer` capability the nango gateway's save path
// will await for linkedin/wordpress account materialization (failures fold
// into the save result — the inline fail-blocking semantics preserved).

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
vi.mock("@cinatra-ai/openai-connector/deps", () => ({ registerOpenAIConnector: () => {} }));
vi.mock("@cinatra-ai/anthropic-connector", () => ({ registerAnthropicConnector: () => {} }));
vi.mock("@cinatra-ai/drupal-mcp-connector", () => ({ registerDrupalConnector: () => {} }));
vi.mock("@cinatra-ai/wordpress-mcp-connector", () => ({ registerWordPressConnector: () => {} }));
vi.mock("@cinatra-ai/nango-connector", () => ({
  buildBearerAuthHeaderFromNango: async () => null,
  CINATRA_NANGO_CONNECTION_IDS: {},
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: {},
  clearNangoConnectionRecords: async () => {},
  deleteNangoConnection: async () => {},
  ensureNangoConnectorIntegration: async () => null,
  ensureNangoIntegration: async () => null,
  getNangoCredentials: async () => null,
  getNangoFrontendConfig: () => ({}),
  getNangoStatus: () => ({ status: "not_connected" }),
  getPrimarySavedNangoConnection: () => null,
  importNangoConnection: async () => ({}),
  isNangoConfigured: () => false,
  removeNangoConnectionRecord: async () => {},
  saveNangoConnectionRecord: async () => {},
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
  // Module load auto-runs registerTransportConnectors() against the REAL
  // capability registry (the mocked deps keep it inert).
  await import("@/lib/register-transport-connectors");
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
