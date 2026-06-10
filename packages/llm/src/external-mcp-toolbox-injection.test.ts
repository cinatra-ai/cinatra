/**
 * Manifest-driven external-MCP toolbox injection contract.
 *
 * `buildExternalMcpServerTools` enumerates the generated extension manifest
 * and selects records carrying the `providesExternalMcpToolbox` capability
 * marker; selected records resolve through the generated first-party toolbox
 * loader map when an entry exists, else through the `external_mcp_servers`
 * registry (`buildSingleExternalMcpTool`) by slug.
 *
 * No-host-edit acceptance: a FIXTURE extension record is picked up with NO
 * host edit — these tests toggle the fixture's capability marker on/off
 * (mocking only the generated manifest + the external-MCP registry resolver)
 * and assert injection follows the marker, with zero source change in
 * packages/llm or src/lib between the assertions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmMcpServerTool } from "./types";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const fixtureRecord = {
    packageName: "@cinatra-fixtures/fixture-external-mcp",
    scope: "cinatra-fixtures",
    kind: "connector" as const,
    version: "0.0.1",
    sourceDir: "extensions/cinatra-fixtures/fixture-external-mcp",
    serverEntry: null,
    hasOas: false,
    hasMcpModule: false,
    hasSetupPage: false,
    hasSettingsPage: false,
    uiSurface: null,
    configSchema: null,
    requestedHostPorts: [],
    providesExternalMcpToolbox: false,
    sdkAbiRange: null,
    dependencies: [],
    displayName: null,
    logo: null,
  };
  const builderRecord = {
    ...fixtureRecord,
    packageName: "@cinatra-fixtures/fixture-builder-mcp",
    sourceDir: "extensions/cinatra-fixtures/fixture-builder-mcp",
  };
  const manifest: Record<string, typeof fixtureRecord> = {
    [fixtureRecord.packageName]: fixtureRecord,
    [builderRecord.packageName]: builderRecord,
  };
  const toolboxEntries: Record<string, { load: () => Promise<unknown>; factory: string }> = {};
  return { fixtureRecord, builderRecord, manifest, toolboxEntries };
});

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: h.manifest,
  GENERATED_EXTERNAL_MCP_TOOLBOXES: h.toolboxEntries,
}));

// The external_mcp_servers resolver (host registry).
vi.mock("@/lib/external-mcp-registry", () => ({
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

// Keep the credentials adapter inert — irrelevant to toolbox enumeration.
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: vi.fn(() => ({ publicBaseUrl: null })),
  getLlmMcpCredentials: vi.fn(async () => null),
  getLocalTokenEndpointUrl: vi.fn(() => null),
  getLocalMcpServerUrl: vi.fn(() => null),
  hasLlmMcpAccess: vi.fn(async () => false),
  getLlmMcpAccessStatus: vi.fn(async () => ({ ok: false })),
}));

import { buildSingleExternalMcpTool } from "@/lib/external-mcp-registry";
import { buildExternalMcpServerTools } from "./mcp-access";

const fixtureSlug = "fixture-external-mcp";
const builderSlug = "fixture-builder-mcp";

const registryTool: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: `external-${fixtureSlug}`,
  serverUrl: "https://fixture.example.com/mcp",
  serverDescription: "External MCP server: fixture",
  allowedTools: null,
  requireApproval: "never",
};

const builderTool: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "fixture-builder",
  serverUrl: "https://builder.example.com/mcp",
  serverDescription: "Fixture builder MCP",
  allowedTools: null,
  requireApproval: "never",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fixtureRecord.providesExternalMcpToolbox = false;
  h.builderRecord.providesExternalMcpToolbox = false;
  for (const key of Object.keys(h.toolboxEntries)) delete h.toolboxEntries[key];
});

describe("buildExternalMcpServerTools — manifest capability-marker selection", () => {
  it("injects a fixture extension's toolbox when its record declares the marker (registry-resolved)", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = true;
    vi.mocked(buildSingleExternalMcpTool).mockResolvedValueOnce(registryTool);

    const tools = await buildExternalMcpServerTools("openai");

    expect(vi.mocked(buildSingleExternalMcpTool)).toHaveBeenCalledWith(fixtureSlug);
    expect(tools).toEqual([registryTool]);
  });

  it("does NOT inject the fixture when the marker is absent — registry never consulted", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = false;

    const tools = await buildExternalMcpServerTools("openai");

    expect(tools).toEqual([]);
    expect(vi.mocked(buildSingleExternalMcpTool)).not.toHaveBeenCalled();
  });

  it("prefers a generated first-party toolbox entry over the registry for the same slug", async () => {
    h.builderRecord.providesExternalMcpToolbox = true;
    const buildTools = vi.fn(async () => [builderTool]);
    h.toolboxEntries[builderSlug] = {
      load: async () => ({ createFixtureExternalMcpToolbox: () => ({ buildTools }) }),
      factory: "createFixtureExternalMcpToolbox",
    };

    const tools = await buildExternalMcpServerTools("openai");

    expect(buildTools).toHaveBeenCalledWith("openai");
    expect(tools).toEqual([builderTool]);
    expect(vi.mocked(buildSingleExternalMcpTool)).not.toHaveBeenCalled();
  });

  it("isolates a failing extension — other marker-bearing toolboxes still inject", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = true;
    h.builderRecord.providesExternalMcpToolbox = true;
    h.toolboxEntries[builderSlug] = {
      load: async () => ({
        createFixtureExternalMcpToolbox: () => ({
          buildTools: async () => {
            throw new Error("builder exploded");
          },
        }),
      }),
      factory: "createFixtureExternalMcpToolbox",
    };
    vi.mocked(buildSingleExternalMcpTool).mockResolvedValueOnce(registryTool);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = await buildExternalMcpServerTools("openai");

    expect(tools).toEqual([registryTool]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats a loader entry with a missing factory export as that extension failing (fail-loud loader, caught per extension)", async () => {
    h.builderRecord.providesExternalMcpToolbox = true;
    h.toolboxEntries[builderSlug] = {
      load: async () => ({}),
      factory: "createFixtureExternalMcpToolbox",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = await buildExternalMcpServerTools("openai");

    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns (without throwing) when a marker-bearing extension has neither a builder nor a registry row", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = true;
    vi.mocked(buildSingleExternalMcpTool).mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = await buildExternalMcpServerTools("openai");

    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skipRegistryFallback suppresses the registry fallback but keeps first-party builders", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = true;
    h.builderRecord.providesExternalMcpToolbox = true;
    h.toolboxEntries[builderSlug] = {
      load: async () => ({ createFixtureExternalMcpToolbox: () => ({ buildTools: async () => [builderTool] }) }),
      factory: "createFixtureExternalMcpToolbox",
    };

    const tools = await buildExternalMcpServerTools("openai", { skipRegistryFallback: true });

    expect(tools).toEqual([builderTool]);
    expect(vi.mocked(buildSingleExternalMcpTool)).not.toHaveBeenCalled();
  });

  it("drops malformed builder output inside the per-extension boundary (non-array + invalid entries)", async () => {
    h.fixtureRecord.providesExternalMcpToolbox = true;
    h.builderRecord.providesExternalMcpToolbox = true;
    // builder returns a non-array → that extension contributes nothing
    h.toolboxEntries[builderSlug] = {
      load: async () => ({
        createFixtureExternalMcpToolbox: () => ({ buildTools: async () => null }),
      }),
      factory: "createFixtureExternalMcpToolbox",
    };
    // fixture's builder returns one valid + one malformed entry
    h.toolboxEntries[fixtureSlug] = {
      load: async () => ({
        createFixtureExternalMcpToolbox: () => ({
          buildTools: async () => [registryTool, { bogus: true }],
        }),
      }),
      factory: "createFixtureExternalMcpToolbox",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = await buildExternalMcpServerTools("openai");

    expect(tools).toEqual([registryTool]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
