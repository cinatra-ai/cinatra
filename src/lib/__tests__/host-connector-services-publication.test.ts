import { describe, it, expect, vi, beforeAll } from "vitest";

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
// at activation. (No @/lib/nango-system mock either: the binder dropped its
// last nango-system edge with the compat shim, cinatra#151 Stage 7.)
vi.mock("@/lib/host-content-editor-dispatch", () => ({ dispatchContentEditorViaA2A: async () => "" }));

const wordpressMaterialized: unknown[] = [];
const wordpressApiCalls: Record<string, unknown[][]> = {
  webhookList: [],
  webhookRegister: [],
  webhookRemove: [],
  createDraft: [],
  readPost: [],
  readPostStatus: [],
  listPublishedPosts: [],
  deletePost: [],
  uploadMedia: [],
  updateDraftMeta: [],
  updatePost: [],
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
vi.mock("@/lib/wordpress-api", () => ({
  deleteWordPressInstance: async () => ({}),
  getWordPressAPISettings: () => ({ instances: [], loggingEnabled: true }),
  getWordPressAPIStatus: () => ({
    status: "connected",
    detail: "1 WordPress instance is configured.",
  }),
  readWordPressInstanceById: (id: string) => (id === WP_ROW.id ? WP_ROW : null),
  saveWordPressInstanceFromNangoConnection: async (input: unknown) => {
    wordpressMaterialized.push(input);
  },
  listWordPressWebhookSubscriptions: async (...args: unknown[]) => {
    wordpressApiCalls.webhookList.push(args);
    return [WP_SUB];
  },
  registerWordPressWebhookSubscription: async (...args: unknown[]) => {
    wordpressApiCalls.webhookRegister.push(args);
    return WP_SUB;
  },
  deleteWordPressWebhookSubscription: async (...args: unknown[]) => {
    wordpressApiCalls.webhookRemove.push(args);
  },
  createWordPressDraft: async (...args: unknown[]) => {
    wordpressApiCalls.createDraft.push(args);
    return { wordpressPostId: 10, adminUrl: "https://wp.example/wp-admin/post.php?post=10&action=edit" };
  },
  readWordPressPost: async (...args: unknown[]) => {
    wordpressApiCalls.readPost.push(args);
    return { id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a" };
  },
  readWordPressPostStatus: async (...args: unknown[]) => {
    wordpressApiCalls.readPostStatus.push(args);
    return { id: 10, status: "draft", adminUrl: "a" };
  },
  listPublishedWordPressPosts: async (...args: unknown[]) => {
    wordpressApiCalls.listPublishedPosts.push(args);
    return { items: [], total: 0 };
  },
  deleteWordPressPost: async (...args: unknown[]) => {
    wordpressApiCalls.deletePost.push(args);
    return { deleted: true, previousStatus: "draft" };
  },
  uploadWordPressMedia: async (...args: unknown[]) => {
    wordpressApiCalls.uploadMedia.push(args);
    return { mediaId: 7, sourceUrl: "https://wp.example/m.png" };
  },
  updateWordPressDraftMeta: async (...args: unknown[]) => {
    wordpressApiCalls.updateDraftMeta.push(args);
    return { id: 10 };
  },
  updateWordPressPost: async (...args: unknown[]) => {
    wordpressApiCalls.updatePost.push(args);
    return { id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a" };
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
  resolveWordPressMcpFallbackEndpoint: (siteUrl: string) =>
    `${siteUrl}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
  resolveWordPressMcpEndpoint: (siteUrl: string) => `${siteUrl}/wp-json/mcp/mcp-adapter-default-server`,
}));
const wpWidgetAuthCalls: Record<string, number> = { read: 0, generate: 0 };
vi.mock("@/lib/wordpress-widget-auth", () => ({
  readWidgetAuthConfig: () => {
    wpWidgetAuthCalls.read += 1;
    return { apiKey: "wpk-existing", webhookSecret: "s-existing", generatedAt: "2026-01-01T00:00:00Z" };
  },
  generateWidgetAuthConfig: () => {
    wpWidgetAuthCalls.generate += 1;
    return { apiKey: "wpk-fresh", webhookSecret: "s-fresh", generatedAt: "2026-01-02T00:00:00Z" };
  },
}));
vi.mock("@/lib/drupal-mcp-connection", () => ({
  probeDrupalMcp: async () => ({}),
  resolveDrupalMcpServerUrl: () => null,
  getDrupalMcpInstanceStatuses: async () => [
    { id: "i-1", name: "Site", siteUrl: "https://d.example", status: "registered", isPrivate: false },
  ],
}));
const drupalApiCalls: Record<string, unknown[][]> = { save: [], delete: [] };
vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: () => ({ instances: [] }),
  getDrupalAPIStatus: async () => ({ instanceCount: 0, instances: [] }),
  saveDrupalInstance: async (...args: unknown[]) => {
    drupalApiCalls.save.push(args);
    return { id: "i-1" };
  },
  deleteDrupalInstance: async (...args: unknown[]) => {
    drupalApiCalls.delete.push(args);
  },
}));
const widgetAuthCalls: Record<string, number> = { read: 0, generate: 0 };
vi.mock("@/lib/drupal-widget-auth", () => ({
  readDrupalWidgetAuthConfig: () => {
    widgetAuthCalls.read += 1;
    return { apiKey: "k-existing", generatedAt: "2026-01-01T00:00:00Z" };
  },
  generateDrupalWidgetAuthConfig: () => {
    widgetAuthCalls.generate += 1;
    return { apiKey: "k-fresh", generatedAt: "2026-01-02T00:00:00Z" };
  },
}));

import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
  type HostConnectorConfigService,
  type NangoConnectionMaterializer,
  type HostMcpPaginationService,
  type HostDrupalMcpService,
  type HostDrupalWidgetAuthService,
  type HostWordPressMcpService,
  type HostWordPressContentService,
  type HostWordPressWidgetAuthService,
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

  it("publishes @cinatra-ai/host:drupal-widget-auth with read + generate (writer) members", () => {
    const widgetAuth = resolveSingle<HostDrupalWidgetAuthService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.drupalWidgetAuth,
    );
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.drupalWidgetAuth).toBe(
      "@cinatra-ai/host:drupal-widget-auth",
    );
    expect(widgetAuth.read()).toEqual({ apiKey: "k-existing", generatedAt: "2026-01-01T00:00:00Z" });
    expect(widgetAuth.generate()).toEqual({ apiKey: "k-fresh", generatedAt: "2026-01-02T00:00:00Z" });
    expect(widgetAuthCalls.read).toBe(1);
    expect(widgetAuthCalls.generate).toBe(1);
  });
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

  it("publishes @cinatra-ai/host:wordpress-content with the full post/media CRUD member set", async () => {
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressContent).toBe(
      "@cinatra-ai/host:wordpress-content",
    );
    const content = resolveSingle<HostWordPressContentService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressContent,
    );

    // createDraft — WRITER; instance row + payload forwarded intact.
    const payload = { title: "T", content: "C", excerpt: "E", status: "draft" as const };
    await expect(content.createDraft({ instance: WP_ROW, payload })).resolves.toEqual({
      wordpressPostId: 10,
      adminUrl: "https://wp.example/wp-admin/post.php?post=10&action=edit",
    });
    expect(wordpressApiCalls.createDraft.at(-1)).toEqual([{ instance: WP_ROW, payload }]);

    // readPost — reader; forwards id + postType.
    await expect(
      content.readPost({ instance: WP_ROW, wordpressPostId: 10, postType: "page" }),
    ).resolves.toEqual({ id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a" });
    expect(wordpressApiCalls.readPost.at(-1)).toEqual([
      { instance: WP_ROW, wordpressPostId: 10, postType: "page" },
    ]);

    // readPostStatus — reader.
    await expect(content.readPostStatus({ instance: WP_ROW, wordpressPostId: 10 })).resolves.toEqual({
      id: 10,
      status: "draft",
      adminUrl: "a",
    });
    expect(wordpressApiCalls.readPostStatus.at(-1)).toEqual([
      { instance: WP_ROW, wordpressPostId: 10 },
    ]);

    // listPublishedPosts — reader; pagination options forwarded.
    await expect(content.listPublishedPosts(WP_ROW, { offset: 10, limit: 10 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(wordpressApiCalls.listPublishedPosts.at(-1)).toEqual([WP_ROW, { offset: 10, limit: 10 }]);

    // deletePost — WRITER.
    await expect(content.deletePost({ instance: WP_ROW, wordpressPostId: 10 })).resolves.toEqual({
      deleted: true,
      previousStatus: "draft",
    });
    expect(wordpressApiCalls.deletePost.at(-1)).toEqual([{ instance: WP_ROW, wordpressPostId: 10 }]);

    // uploadMedia — WRITER.
    const media = { instance: WP_ROW, imageBase64: "QUJD", imageMimeType: "image/png", title: "img" };
    await expect(content.uploadMedia(media)).resolves.toEqual({
      mediaId: 7,
      sourceUrl: "https://wp.example/m.png",
    });
    expect(wordpressApiCalls.uploadMedia.at(-1)).toEqual([media]);

    // updateDraftMeta — WRITER; meta envelope forwarded intact.
    await expect(
      content.updateDraftMeta({ instance: WP_ROW, wordpressPostId: 10, meta: { k: "v" } }),
    ).resolves.toEqual({ id: 10 });
    expect(wordpressApiCalls.updateDraftMeta.at(-1)).toEqual([
      { instance: WP_ROW, wordpressPostId: 10, meta: { k: "v" } },
    ]);

    // updatePost — WRITER; top-level field envelope forwarded intact.
    const fields = { title: "X", status: "draft" as const };
    await expect(
      content.updatePost({ instance: WP_ROW, wordpressPostId: 10, postType: "post", fields }),
    ).resolves.toEqual({ id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a" });
    expect(wordpressApiCalls.updatePost.at(-1)).toEqual([
      { instance: WP_ROW, wordpressPostId: 10, postType: "post", fields },
    ]);
  });

  it("normalizes skew rows missing timestamps (epoch fallback) before reaching the host API", async () => {
    const content = resolveSingle<HostWordPressContentService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressContent,
    );
    const skewRow = { id: "wp-2", name: "S", siteUrl: "https://wp2.example", username: "u", applicationPassword: "p" };
    await content.readPostStatus({ instance: skewRow, wordpressPostId: 1 });
    const forwarded = (wordpressApiCalls.readPostStatus.at(-1)![0] as { instance: Record<string, unknown> }).instance;
    expect(forwarded.createdAt).toBe(new Date(0).toISOString());
    expect(forwarded.updatedAt).toBe(new Date(0).toISOString());
    expect(forwarded.id).toBe("wp-2");
  });

  it("publishes @cinatra-ai/host:wordpress-widget-auth with read + generate (writer) members", () => {
    const widgetAuth = resolveSingle<HostWordPressWidgetAuthService>(
      HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressWidgetAuth,
    );
    expect(HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressWidgetAuth).toBe(
      "@cinatra-ai/host:wordpress-widget-auth",
    );
    expect(widgetAuth.read()).toEqual({
      apiKey: "wpk-existing",
      webhookSecret: "s-existing",
      generatedAt: "2026-01-01T00:00:00Z",
    });
    expect(widgetAuth.generate()).toEqual({
      apiKey: "wpk-fresh",
      webhookSecret: "s-fresh",
      generatedAt: "2026-01-02T00:00:00Z",
    });
    expect(wpWidgetAuthCalls.read).toBe(1);
    expect(wpWidgetAuthCalls.generate).toBe(1);
  });
});
