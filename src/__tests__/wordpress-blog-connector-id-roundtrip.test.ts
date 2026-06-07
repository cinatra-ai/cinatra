// Binding non-regression test for `WordPressInstanceSettings.blogConnectorId`.
//
// Validates the two save paths the field has to round-trip through:
//
//   1. `saveWordPressInstance` (manual edit) preserves `blogConnectorId`
//      when the caller does NOT pass an override. The save path
//      constructs `nextInstance` field-by-field (no `...existing` spread),
//      so without explicit preservation any field outside the known set
//      would silently disappear on every edit-save.
//
//   2. `saveWordPressInstanceFromNangoConnection` (Nango reconnect) MUST
//      preserve `blogConnectorId` from the existing row unconditionally —
//      Nango knows nothing about Cinatra's blog-connector bindings, so a
//      disconnect→reconnect flow without preservation would route the
//      live example-namespace site back to the generic connector.
//
// The test mocks the I/O-bound helpers and exercises the constructors
// against an in-memory wordpress connector_config blob.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => {
  let blob: { instances: unknown[]; loggingEnabled?: boolean } = { instances: [] };
  return {
    readConnectorConfigFromDatabase: vi.fn(() => blob),
    writeConnectorConfigToDatabase: vi.fn((_k: string, v: typeof blob) => {
      blob = v;
    }),
    __getBlob: () => blob,
    __setBlob: (v: typeof blob) => {
      blob = v;
    },
  };
});

vi.mock("@/lib/nango", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: {
    wordpress: "wordpress-config",
  },
  deleteNangoConnection: vi.fn(),
  getNangoConnection: vi.fn(),
  ensureNangoIntegration: vi.fn(),
  getNangoCredentials: vi.fn().mockResolvedValue({
    username: "operator",
    password: "app-password",
  }),
  importNangoConnection: vi.fn(),
  isNangoConfigured: vi.fn().mockReturnValue(true),
}));

// The two save paths invoke `validateWordPressInstanceConnection` which
// performs an HTTPS HEAD/GET on `<siteUrl>/wp-json/wp/v2/posts?per_page=1`
// plus `/users/me`. We stub global fetch to return a minimal "happy path"
// response covering both probe calls. Any unmocked request would surface
// as a test failure.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 1, name: "example-namespace" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

describe("WordPressInstanceSettings.blogConnectorId round-trip", () => {
  beforeEach(async () => {
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (v: { instances: unknown[]; loggingEnabled?: boolean }) => void;
    };
    dbMod.__setBlob({ instances: [] });
  });

  it("saveWordPressInstance preserves blogConnectorId across edit-save when not passed", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (v: { instances: unknown[] }) => void;
      __getBlob: () => { instances: Array<{ id: string; blogConnectorId?: string }> };
    };
    dbMod.__setBlob({
      instances: [
        {
          id: "wp-1",
          name: "Existing",
          siteUrl: "https://example-namespace.com",
          username: "operator",
          applicationPassword: "app-password",
          providerConfigKey: "wordpress-config",
          connectionId: "wp-1",
          lastValidatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          blogConnectorId: "example-namespace",
        },
      ],
    });

    await saveWordPressInstance({
      id: "wp-1",
      siteUrl: "https://example-namespace.com",
      username: "operator",
      applicationPassword: "app-password",
    });

    const blob = dbMod.__getBlob();
    expect(blob.instances).toHaveLength(1);
    expect(blob.instances[0]?.blogConnectorId).toBe("example-namespace");
  });

  it("saveWordPressInstanceFromNangoConnection preserves existing blogConnectorId across reconnect", async () => {
    const { saveWordPressInstanceFromNangoConnection } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (v: { instances: unknown[] }) => void;
      __getBlob: () => { instances: Array<{ id: string; blogConnectorId?: string }> };
    };
    dbMod.__setBlob({
      instances: [
        {
          id: "wp-1",
          name: "Existing",
          siteUrl: "https://example-namespace.com",
          username: "operator",
          applicationPassword: "app-password",
          providerConfigKey: "wordpress-config",
          connectionId: "conn-1",
          lastValidatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          blogConnectorId: "example-namespace",
        },
      ],
    });

    await saveWordPressInstanceFromNangoConnection({
      siteUrl: "https://example-namespace.com",
      providerConfigKey: "wordpress-config",
      connectionId: "conn-1",
    });

    const blob = dbMod.__getBlob();
    expect(blob.instances).toHaveLength(1);
    expect(blob.instances[0]?.blogConnectorId).toBe("example-namespace");
  });

  it("saveWordPressInstance accepts blogConnectorId as a first-class override", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __getBlob: () => { instances: Array<{ id: string; blogConnectorId?: string }> };
    };
    const saved = await saveWordPressInstance({
      siteUrl: "https://example.com",
      username: "operator",
      applicationPassword: "app-password",
      blogConnectorId: "example-namespace",
    });
    expect(saved.blogConnectorId).toBe("example-namespace");
    const blob = dbMod.__getBlob();
    expect(blob.instances[0]?.blogConnectorId).toBe("example-namespace");
  });

  // Re-read through the public reader path (not just the raw JSON blob)
  // sees `blogConnectorId`. Catches any future normalizer-pipeline change
  // that silently strips the field on the read path.
  it("getWordPressAPISettings normalizer surfaces blogConnectorId on re-read", async () => {
    const { saveWordPressInstance, getWordPressAPISettings, readWordPressInstanceById } =
      await import("@/lib/wordpress-api");

    const saved = await saveWordPressInstance({
      siteUrl: "https://example.com",
      username: "operator",
      applicationPassword: "app-password",
      blogConnectorId: "example-namespace",
    });

    const settings = getWordPressAPISettings();
    expect(settings.instances[0]?.blogConnectorId).toBe("example-namespace");

    const byId = readWordPressInstanceById(saved.id);
    expect(byId?.blogConnectorId).toBe("example-namespace");
  });
});
