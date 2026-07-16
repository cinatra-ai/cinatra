import { describe, it, expect, vi, beforeEach } from "vitest";

// MarketplaceMcpError stays REAL (the malformed-payload subclass extends it and
// tests assert `instanceof`); VendorCredentialsMissingError stays REAL (the
// loader branches on .code). The heavy barrels (registries, extensions/screens)
// + the public http-client + the Verdaccio config loader are mocked so the
// loader's orchestration is tested in isolation. Field mapping itself is
// covered by marketplace-card-model.test.ts.

const { publicListMock, publicDetailMock, loadVerdaccioMock, catalogToCardMock } = vi.hoisted(
  () => ({
    publicListMock: vi.fn(),
    publicDetailMock: vi.fn(),
    loadVerdaccioMock: vi.fn(),
    catalogToCardMock: vi.fn(),
  }),
);

vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  fetchPublicMarketplaceExtensionList: publicListMock,
  fetchPublicMarketplaceExtensionDetail: publicDetailMock,
}));

vi.mock("@cinatra-ai/registries", () => ({
  // Provided so the source's `instanceof InstanceNamespaceNotConfiguredError`
  // resolves to the SAME class the test throws.
  InstanceNamespaceNotConfiguredError: class InstanceNamespaceNotConfiguredError extends Error {},
}));

// Mock the screens barrel so the real (server-component) barrel never loads in
// the node test env. The mapper returns an identifiable shape; its real field
// logic is tested separately. A hoisted spy so a test can assert the enrichment
// OPTS the loader threads in (manifest.logo + manifest.displayName, cinatra#1605).
vi.mock("@cinatra-ai/extensions/screens", () => ({
  catalogEntryToCardData: catalogToCardMock,
}));

vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: loadVerdaccioMock,
}));

import { loadMarketplaceBrowse, loadPublicMarketplaceDetail } from "../marketplace-browse";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import { InstanceNamespaceNotConfiguredError } from "@cinatra-ai/registries";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";
// The REAL generated static manifest — the same source the loader reads — so
// the enrichment wiring test asserts against the actual bundled displayName
// instead of a hardcoded string that could drift on regeneration.
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

beforeEach(() => {
  publicListMock.mockReset();
  publicDetailMock.mockReset();
  loadVerdaccioMock.mockReset();
  catalogToCardMock.mockReset();
  // Default mapper: identifiable shape, gated on a real version (mirrors the
  // real mapper's install-identity guard); ignores the enrichment opts.
  catalogToCardMock.mockImplementation((e: { package_name: string; version: string }) =>
    e.version ? { packageName: e.package_name, packageVersion: e.version } : null,
  );
  loadVerdaccioMock.mockResolvedValue({
    registryUrl: "https://registry.test",
    packageScope: "",
    token: "test-token",
    uiUrl: "",
  });
});

describe("loadMarketplaceBrowse", () => {
  it("returns the anonymous public storefront catalog with install-ready package versions", async () => {
    publicListMock.mockResolvedValue({
      items: [{ package_name: "@a/x", version: "1.0.0" }],
      total: 1,
    });

    const res = await loadMarketplaceBrowse();

    expect(res).toMatchObject({ kind: "storefront", registryConnected: true });
    expect(res.cards).toEqual([{ packageName: "@a/x", packageVersion: "1.0.0" }]);
    expect(publicListMock).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(publicListMock).toHaveBeenCalledTimes(1);
  });

  it("threads the static-manifest displayName into the card mapper for a bundled package (cinatra#1605)", async () => {
    // A bundled package whose catalog entry OMITS display_name must still
    // resolve a human name from the static manifest — so the loader injects the
    // manifest displayName by EXACT package identity. Asserted against the real
    // manifest value (no hardcoded string that could drift).
    const pkg = "@cinatra-ai/default-artifact";
    const expected = STATIC_EXTENSION_MANIFEST[pkg]?.displayName;
    expect(expected).toBeTruthy(); // guards the fixture package still ships
    publicListMock.mockResolvedValue({
      items: [{ package_name: pkg, version: "0.1.0" }],
      total: 1,
    });

    await loadMarketplaceBrowse();

    expect(catalogToCardMock).toHaveBeenCalledWith(
      expect.objectContaining({ package_name: pkg }),
      expect.objectContaining({ manifestDisplayName: expected }),
    );
  });

  it("matches the manifest by EXACT package identity — a near-collision name does NOT borrow a bundled displayName (cinatra#1605)", async () => {
    // A package_name that is a prefix/suffix neighbour of a real bundled key
    // must NOT fuzzy-match it. Proves the lookup is `MANIFEST[name]` (exact key)
    // and can never leak one extension's human name onto a look-alike identity.
    const bundled = "@cinatra-ai/default-artifact";
    expect(STATIC_EXTENSION_MANIFEST[bundled]?.displayName).toBeTruthy();
    for (const nearMiss of [
      "@cinatra-ai/default-artifactx", // suffix neighbour
      "@cinatra-ai/default-artifac", // truncated neighbour
      "@cinatra-ai/default", // scope-prefix neighbour
    ]) {
      expect(STATIC_EXTENSION_MANIFEST[nearMiss]).toBeUndefined(); // guard: truly absent
      publicListMock.mockReset();
      publicListMock.mockResolvedValue({
        items: [{ package_name: nearMiss, version: "1.0.0" }],
        total: 1,
      });

      await loadMarketplaceBrowse();

      expect(catalogToCardMock).toHaveBeenCalledWith(
        expect.objectContaining({ package_name: nearMiss }),
        expect.objectContaining({ manifestDisplayName: null }),
      );
    }
  });

  it("injects a null manifestDisplayName for a not-bundled (storefront-only) package", async () => {
    // A package the host does not bundle is absent from the static manifest, so
    // the loader passes null and the name resolution degrades to the catalog
    // display_name / package name — never crashing on an unknown package.
    publicListMock.mockResolvedValue({
      items: [{ package_name: "@storefront-only/mystery", version: "1.0.0" }],
      total: 1,
    });

    await loadMarketplaceBrowse();

    expect(catalogToCardMock).toHaveBeenCalledWith(
      expect.objectContaining({ package_name: "@storefront-only/mystery" }),
      expect.objectContaining({ manifestDisplayName: null }),
    );
  });

  it("pages the storefront catalog past the 100-per-call public catalog clamp", async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({
      package_name: `@a/p${i}`,
      version: "1.0.0",
    }));
    publicListMock.mockImplementation((input: { limit?: number; offset?: number } = {}) => {
      const start = input.offset ?? 0;
      const size = Math.min(input.limit ?? 100, 100);
      return Promise.resolve({ items: all.slice(start, start + size), total: all.length });
    });

    const res = await loadMarketplaceBrowse();

    expect(res.kind).toBe("storefront");
    expect(res.cards).toHaveLength(150);
    expect(res.cards[149]?.packageName).toBe("@a/p149");
    // Two pages: offset 0 (100 items), then offset 100 (final 50 -> short page -> stop).
    expect(publicListMock).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(publicListMock).toHaveBeenCalledWith({ limit: 100, offset: 100 });
    expect(publicListMock).toHaveBeenCalledTimes(2);
  });

  it("registryConnected=true when the install registry config probe loads", async () => {
    publicListMock.mockResolvedValue({ items: [], total: 0 });
    loadVerdaccioMock.mockResolvedValue({
      registryUrl: "https://registry.test",
      packageScope: "",
      token: "test-token",
      uiUrl: "",
    });

    await expect(loadMarketplaceBrowse()).resolves.toMatchObject({
      kind: "storefront",
      registryConnected: true,
    });
  });

  it("registryConnected=false when the registry config is genuinely missing", async () => {
    publicListMock.mockResolvedValue({ items: [], total: 0 });
    loadVerdaccioMock.mockRejectedValue(
      new VendorCredentialsMissingError("none", "VENDOR_CREDENTIALS_MISSING"),
    );

    await expect(loadMarketplaceBrowse()).resolves.toMatchObject({
      kind: "storefront",
      registryConnected: false,
    });
  });

  it("registryConnected=false when the Verdaccio identity is not configured", async () => {
    publicListMock.mockResolvedValue({ items: [], total: 0 });
    loadVerdaccioMock.mockRejectedValue(new InstanceNamespaceNotConfiguredError());

    await expect(loadMarketplaceBrowse()).resolves.toMatchObject({
      kind: "storefront",
      registryConnected: false,
    });
  });

  it("a corrupt/decrypt registry config surfaces loudly instead of enabling Install", async () => {
    publicListMock.mockResolvedValue({ items: [], total: 0 });
    loadVerdaccioMock.mockRejectedValue(
      new VendorCredentialsMissingError("bad", "CONSUMER_VERDACCIO_ATTACHMENT_CORRUPTED"),
    );

    await expect(loadMarketplaceBrowse()).rejects.toBeInstanceOf(VendorCredentialsMissingError);
  });

  it("throws loudly on a malformed public catalog response", async () => {
    for (const bad of [
      {},
      { items: null, total: 0 },
      { items: "nope", total: 0 },
      { items: [], total: -1 },
      { items: [], total: "5" },
      null,
    ]) {
      publicListMock.mockReset();
      publicListMock.mockResolvedValue(bad);

      await expect(loadMarketplaceBrowse()).rejects.toBeInstanceOf(MarketplaceMcpError);
    }
  });

  it("a malformed payload whose content contains not-found phrasing still surfaces loudly", async () => {
    for (const bad of [
      { items: "bad", total: 0, error: "not served" },
      { items: null, total: 0, note: "tool not found cinatra/extension-list" },
      { items: {}, total: 0, jsonrpc: "-32601" },
    ]) {
      publicListMock.mockReset();
      publicListMock.mockResolvedValue(bad);

      await expect(loadMarketplaceBrowse()).rejects.toBeInstanceOf(MarketplaceMcpError);
    }
  });

  it("propagates public catalog 404 errors loudly with no authenticated fallback", async () => {
    publicListMock.mockRejectedValue(new MarketplaceMcpError("route not found", 404, ""));

    await expect(loadMarketplaceBrowse()).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("propagates non-404 storefront 5xx errors loudly", async () => {
    publicListMock.mockRejectedValue(new MarketplaceMcpError("bad gateway", 502, ""));

    await expect(loadMarketplaceBrowse()).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("propagates raw public catalog errors loudly", async () => {
    publicListMock.mockRejectedValue({ code: -32601, message: "Method not found" });

    await expect(loadMarketplaceBrowse()).rejects.toMatchObject({ code: -32601 });
  });
});

describe("loadPublicMarketplaceDetail", () => {
  it("projects a public ExtensionDetail into the client-safe modal view", async () => {
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      description: "Forecasts.",
      longDescription: null,
      readmeMarkdown: "# Weather",
      license: "MIT",
      commerceBadge: { text: "Open source", variant: "oss", license: "MIT" },
      freshnessAt: "2026-06-20T10:00:00Z",
      installCount: 128,
      permalink: "https://marketplace.cinatra.ai/product/weather-agent",
      sdkAbiRange: "^2",
      iconUrl: "https://cdn.example/i.png",
      ratingSummary: { average: 4.5, total: 2, counts: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 1 } },
      reviews: [{ author: "Grace", verifiedOwner: true, date: "2026-06-21T08:00:00Z", rating: 5, text: "Accurate." }],
      vendor: { name: "WeatherWorks", slug: "weatherworks", storeUrl: "https://marketplace.cinatra.ai/store/weatherworks/" },
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.displayName).toBe("Weather Agent");
    expect(res.detail.kindLabel).toBe("Agent");
    expect(res.detail.cost).toBe("Open source");
    expect(res.detail.license).toBe("MIT");
    expect(res.detail.installCount).toBe(128);
    expect(res.detail.sdkAbiRange).toBe("^2");
    expect(res.detail.ratingSummary.total).toBe(2);
    expect(res.detail.reviews).toHaveLength(1);
    expect(res.detail.vendor?.storeUrl).toBe("https://marketplace.cinatra.ai/store/weatherworks/");
    expect(res.detail.iconUrl).toBe("https://cdn.example/i.png");
  });

  it("forces the neutral 'Extension' label for a served 'workflow' kind — the wire kindLabel is not trusted (cinatra#1035)", async () => {
    // The storefront may still serve a workflow detail until the Slice B delist.
    // Its detail modal byline must NOT read "Workflow …" even when the wire
    // ships kindLabel "Workflow": a removed/unmapped kind forces "Extension".
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/legacy-pipeline",
      name: "@vendor/legacy-pipeline",
      kind: "workflow",
      currentVisibility: "public",
      displayName: "Legacy Pipeline",
      kindLabel: "Workflow",
      latestVersion: "0.9.0",
      description: "A retired workflow extension.",
      longDescription: null,
      readmeMarkdown: null,
      license: "MIT",
      commerceBadge: { text: "Open source", variant: "oss", license: "MIT" },
      freshnessAt: null,
      installCount: null,
      permalink: null,
      sdkAbiRange: null,
      iconUrl: null,
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: { name: "Acme", slug: "acme", storeUrl: null },
    });

    const res = await loadPublicMarketplaceDetail("@vendor/legacy-pipeline");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.displayName).toBe("Legacy Pipeline");
    expect(res.detail.kindLabel).toBe("Extension");
  });

  it("projects compatibleUpTo/changelog/dependencies (§V modal fields, cinatra#989)", async () => {
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      // "v"-prefixed on the wire; the projection stores the bare version
      // (the "Cinatra v" prefix is presentation, applied at the render).
      compatibleUpTo: ["v", "0.2.0"].join(""),
      changelog: [
        { version: "3.1.0", date: "2026-06-20", notes: ["Hourly forecasts."] },
      ],
      dependencies: [
        {
          packageName: "@cinatra-ai/geo-connector",
          name: "Geo Connector",
          kind: "connector",
          versionRange: "^1.0.0",
        },
      ],
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.compatibleUpTo).toBe("0.2.0");
    expect(res.detail.changelog).toEqual([
      { version: "3.1.0", date: "2026-06-20", notes: ["Hourly forecasts."] },
    ]);
    expect(res.detail.dependencies).toEqual([
      {
        packageName: "@cinatra-ai/geo-connector",
        name: "Geo Connector",
        kind: "connector",
        versionRange: "^1.0.0",
      },
    ]);
  });

  it("degrades absent §V fields safely: no compatibleUpTo, empty changelog, no dependencies (today's storefront payload)", async () => {
    // The live storefront detail endpoint serves none of these fields yet
    // (marketplace#190 workstream C) — the projection must yield the spec
    // empty states, never crash and never fabricate content.
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.compatibleUpTo).toBeNull();
    expect(res.detail.changelog).toEqual([]);
    expect(res.detail.dependencies).toEqual([]);
  });

  it("never projects a banner: a wire bannerUrl does not reach the client-safe view (the §V modal has no banner surface)", async () => {
    // Owner-flagged invention guard (PR #995 review): the §V drawing has no
    // banner / coloured ground in the modal. `bannerUrl` stays an unused wire
    // field (the full-page route header keeps its own path); the modal's
    // client-safe projection must not carry it at all.
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      bannerUrl: "https://cdn.example/banner.png",
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect("bannerUrl" in res.detail).toBe(false);
  });

  it("wrong-data-field guard: a raw cinatra.dependencies map projects as kindless rows (only this field is ever read — a packument npm-deps block has no wire field)", async () => {
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      // The raw manifest map form (marketplace#190 may serve it unenriched).
      dependencies: { "@cinatra-ai/geo-connector": "^1.0.0" },
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.dependencies).toEqual([
      {
        packageName: "@cinatra-ai/geo-connector",
        name: "@cinatra-ai/geo-connector",
        kind: null,
        versionRange: "^1.0.0",
      },
    ]);
  });

  it("scheme-guards the icon fallback: a non-http(s) iconAssetUrl is dropped to null (never reaches <img src>)", async () => {
    // iconUrl is sanitized upstream, but iconAssetUrl is a raw passthrough; the
    // projection must drop a non-http(s) fallback so it cannot reach the modal.
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      iconUrl: null,
      iconAssetUrl: "javascript:alert(document.cookie)",
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.iconUrl).toBeNull();
  });

  it("keeps a valid http(s) iconAssetUrl when the sanitized iconUrl is absent", async () => {
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/weather-agent",
      name: "@vendor/weather-agent",
      kind: "agent",
      currentVisibility: "public",
      displayName: "Weather Agent",
      kindLabel: "Agent",
      latestVersion: "3.1.0",
      iconUrl: null,
      iconAssetUrl: "https://cdn.example/asset.png",
      ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      reviews: [],
      vendor: null,
    });

    const res = await loadPublicMarketplaceDetail("@vendor/weather-agent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.detail.iconUrl).toBe("https://cdn.example/asset.png");
  });

  it("returns not_found for a malformed scoped name without hitting the marketplace", async () => {
    const res = await loadPublicMarketplaceDetail("not-a-scoped-name");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(publicDetailMock).not.toHaveBeenCalled();
  });

  it("treats a non-public visibility as not_found (defense in depth)", async () => {
    publicDetailMock.mockResolvedValue({
      packageName: "@vendor/private-agent",
      name: "@vendor/private-agent",
      kind: "agent",
      currentVisibility: "unknown",
    });
    const res = await loadPublicMarketplaceDetail("@vendor/private-agent");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("maps a 404 MarketplaceMcpError to not_found", async () => {
    publicDetailMock.mockRejectedValue(new MarketplaceMcpError("nope", 404, ""));
    const res = await loadPublicMarketplaceDetail("@vendor/missing-agent");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("maps any other failure to error (retryable, never a crash)", async () => {
    publicDetailMock.mockRejectedValue(new MarketplaceMcpError("boom", 502, ""));
    const res = await loadPublicMarketplaceDetail("@vendor/flaky-agent");
    expect(res).toEqual({ ok: false, reason: "error" });
  });
});
