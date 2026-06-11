// Per-consumer degradation contract for guardedOptional generated-map entries
// (cinatra#7). Each consuming surface receives a MOCKED generated map
// whose guarded loader resolves the standardized degraded result (the
// post-build-absence path) next to a healthy entry, and must degrade PER
// ENTRY: skip/null/warn for the absent one, normal behavior for the present
// one — never a thrown aggregate failure. The /connectors readiness 500
// (cinatra#110) is the canonical regression this family guards against.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guardedExtensionImport } from "../extension-load-guard";

const ABSENT_PKG = "@cinatra-ai/media-feeds-connector";

function absentLoader(specifier: string) {
  // A REAL guarded loader whose importer fails with a target-absent error —
  // exactly what a guardedOptional emitted entry produces post-uninstall.
  const err = new Error(`Cannot find module '${specifier}'`) as Error & { code: string };
  err.code = "ERR_MODULE_NOT_FOUND";
  return guardedExtensionImport(specifier, async () => {
    throw err;
  });
}

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/lib/generated/extensions.server");
});

describe("connector entry modules (loadConnectorModule)", () => {
  it("degrades an absent optional module to null (same as not-bundled) and keeps present modules loading", async () => {
    vi.doMock("@/lib/generated/extensions.server", () => ({
      GENERATED_CONNECTOR_ENTRY_MODULES: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(ABSENT_PKG),
        },
        "healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector", async () => ({
            ok: true,
          })),
        },
      },
    }));
    const { loadConnectorModule, hasConnectorModule } = await import(
      "@/lib/connector-modules.server"
    );
    expect(hasConnectorModule("media-feeds-connector")).toBe(true);
    await expect(loadConnectorModule("media-feeds-connector")).resolves.toBeNull();
    await expect(loadConnectorModule("healthy-connector")).resolves.toEqual({ ok: true });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("media-feeds-connector"),
    );
  });
});

describe("connector MCP modules + primitive handlers", () => {
  it("skips the absent entry per slug and still registers the present one", async () => {
    vi.doMock("@/lib/generated/extensions.server", () => ({
      GENERATED_CONNECTOR_MCP_MODULES: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/mcp-module`),
          factory: "createMediaFeedsModule",
        },
        "healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector/mcp-module", async () => ({
            createHealthyModule: () => ({ registerCapabilities: () => {} }),
          })),
          factory: "createHealthyModule",
        },
      },
      GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/mcp-handlers`),
          factory: "createMediaFeedsPrimitiveHandlers",
        },
        "healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector/mcp-handlers", async () => ({
            createHealthyPrimitiveHandlers: () => ({ healthy_tool: async () => "ok" }),
          })),
          factory: "createHealthyPrimitiveHandlers",
        },
      },
    }));
    const { loadConnectorMcpModules, loadConnectorPrimitiveHandlers } = await import(
      "@/lib/connector-mcp-registration.server"
    );
    const modules = await loadConnectorMcpModules();
    expect(modules).toHaveLength(1);
    const handlers = await loadConnectorPrimitiveHandlers();
    expect(Object.keys(handlers)).toEqual(["healthy_tool"]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping this MCP surface entry"),
    );
  });
});

describe("external MCP toolboxes (loadExternalMcpToolboxBySlug)", () => {
  it("degrades an absent optional toolbox to null (registry path) instead of throwing", async () => {
    vi.doMock("@/lib/generated/extensions.server", () => ({
      GENERATED_EXTERNAL_MCP_TOOLBOXES: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/mcp-toolbox`),
          factory: "createMediaFeedsExternalMcpToolbox",
        },
        "healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector/mcp-toolbox", async () => ({
            createHealthyExternalMcpToolbox: () => ({ buildTools: () => [] }),
          })),
          factory: "createHealthyExternalMcpToolbox",
        },
      },
    }));
    const { loadExternalMcpToolboxBySlug } = await import(
      "@/lib/external-mcp-toolbox-loader.server"
    );
    await expect(loadExternalMcpToolboxBySlug("media-feeds-connector")).resolves.toBeNull();
    const healthy = await loadExternalMcpToolboxBySlug("healthy-connector");
    expect(healthy).not.toBeNull();
    expect(typeof healthy?.buildTools).toBe("function");
  });
});

describe("widget-stream agents (buildWidgetChatTool)", () => {
  it("throws the TYPED absent error for an absent optional widget module (route degrades to 503, not 500)", async () => {
    const { buildWidgetChatTool } = await import("@/lib/widget-stream-agents.server");
    const { ExtensionModuleAbsentError } = await import("@/lib/extension-load-guard");
    const entry = {
      resolution: "guardedOptional" as const,
      load: absentLoader(`${ABSENT_PKG}/widget-chat-tool`),
      packageName: ABSENT_PKG,
      factory: "createMediaFeedsWidgetChatTool",
      label: "Media feeds",
      subjectNoun: "post",
      skillCapability: "cap",
      contextFields: [],
      auth: { tokenConfigKey: "t", instancesConfigKey: "i", requiredInstanceFields: [] },
    };
    await expect(buildWidgetChatTool("media-feeds", entry, {})).rejects.toBeInstanceOf(
      ExtensionModuleAbsentError,
    );
  });
});

describe("chat-widget catalog (resolveChatWidgetManifests)", () => {
  it("skips an absent optional widget package per entry and keeps the present one", async () => {
    const manifest = { id: "healthy.widget", description: "healthy widget manifest" };
    vi.doMock("@/lib/generated/extensions.server", () => ({
      STATIC_EXTENSION_MANIFEST: {},
      GENERATED_CHAT_WIDGET_MODULES: {
        [ABSENT_PKG]: {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/widgets`),
        },
        "@cinatra-ai/healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector/widgets", async () => ({
            widgets: [],
          })),
        },
      },
      GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {
        [ABSENT_PKG]: {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/widgets/manifest`),
        },
        "@cinatra-ai/healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport(
            "@cinatra-ai/healthy-connector/widgets/manifest",
            async () => ({ manifest }),
          ),
        },
      },
    }));
    vi.doMock("@cinatra-ai/extensions", () => ({
      readEffectiveStatusByPackageNames: async () =>
        new Map([
          [ABSENT_PKG, "active"],
          ["@cinatra-ai/healthy-connector", "active"],
        ]),
    }));
    const { resolveChatWidgetManifests } = await import("@/lib/chat-widget-catalog.server");
    const manifests = await resolveChatWidgetManifests();
    expect(manifests).toEqual([manifest]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("absent post-build"),
    );
    vi.doUnmock("@cinatra-ai/extensions");
  });
});

describe("static bundle loader (importServerEntry)", () => {
  it("converts a degraded server entry into a per-extension FAILED activation result (boot continues)", async () => {
    vi.doMock("@/lib/generated/extensions.server", () => ({
      STATIC_EXTENSION_RECORDS: [
        {
          packageName: ABSENT_PKG,
          serverEntry: "./register",
          requestedHostPorts: [],
          sdkAbiRange: null,
        },
        {
          packageName: "@cinatra-ai/healthy-connector",
          serverEntry: "./register",
          requestedHostPorts: [],
          sdkAbiRange: null,
        },
      ],
      GENERATED_EXTENSION_SERVER_ENTRIES: {
        [ABSENT_PKG]: {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/register`),
        },
        "@cinatra-ai/healthy-connector": {
          resolution: "guardedOptional",
          load: guardedExtensionImport("@cinatra-ai/healthy-connector/register", async () => ({
            register: () => {},
          })),
        },
      },
    }));
    vi.doMock("@cinatra-ai/extensions", () => ({
      readEffectiveStatusByPackageNames: async () =>
        new Map([
          [ABSENT_PKG, "active"],
          ["@cinatra-ai/healthy-connector", "active"],
        ]),
    }));
    vi.doMock("@/lib/static-bundle-lifecycle", () => ({
      ensureStaticBundleLifecycleAnchors: async () => ({
        seededLive: [],
        seededArchived: [],
        failed: [],
      }),
    }));
    vi.doMock("@/lib/extension-host-context", () => ({
      createExtensionHostContext: () => ({}),
    }));
    const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
    const results = await loadStaticBundleExtensions();
    const absent = results.find((r) => r.packageName === ABSENT_PKG);
    const healthy = results.filter(
      (r) => r.packageName === "@cinatra-ai/healthy-connector",
    );
    expect(absent?.status).toBe("failed");
    expect(healthy.some((r) => r.status === "registered")).toBe(true);
    vi.doUnmock("@cinatra-ai/extensions");
    vi.doUnmock("@/lib/static-bundle-lifecycle");
    vi.doUnmock("@/lib/extension-host-context");
  });
});

describe("connector setup/settings pages", () => {
  it("exposes entry.load so the dispatch surface can detect the degraded result (requires-rebuild path)", async () => {
    vi.doMock("@/lib/generated/connector-setup-pages", () => ({
      GENERATED_CONNECTOR_SETUP_PAGES: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/setup-page`),
        },
      },
      GENERATED_CONNECTOR_SETTINGS_PAGES: {
        "media-feeds-connector": {
          resolution: "guardedOptional",
          load: absentLoader(`${ABSENT_PKG}/settings-page`),
        },
      },
    }));
    const { getConnectorSetupPageLoader, getConnectorSettingsPageLoader } = await import(
      "@/lib/connector-setup-pages"
    );
    const { isDegradedExtensionLoad } = await import("@/lib/extension-load-guard");
    const setupLoader = getConnectorSetupPageLoader("media-feeds-connector");
    expect(setupLoader).not.toBeNull();
    const mod = await setupLoader!();
    expect(isDegradedExtensionLoad(mod)).toBe(true);
    const settingsLoader = getConnectorSettingsPageLoader("media-feeds-connector");
    const settingsMod = await settingsLoader!();
    expect(isDegradedExtensionLoad(settingsMod)).toBe(true);
    vi.doUnmock("@/lib/generated/connector-setup-pages");
  });
});
