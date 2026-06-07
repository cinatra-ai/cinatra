import { describe, it, expect, vi, beforeEach } from "vitest";

// MarketplaceMcpError stays REAL (the malformed-payload subclass extends it and
// tests assert `instanceof`); VendorCredentialsMissingError stays REAL (the
// loader branches on .code). The heavy barrels (registries, extensions/screens)
// + the public http-client + the Verdaccio config loader are mocked so the
// loader's orchestration is tested in isolation. Field mapping itself is
// covered by marketplace-card-model.test.ts.

const { publicListMock, loadVerdaccioMock } = vi.hoisted(() => ({
  publicListMock: vi.fn(),
  loadVerdaccioMock: vi.fn(),
}));

vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  fetchPublicMarketplaceExtensionList: publicListMock,
}));

vi.mock("@cinatra-ai/registries", () => ({
  // Provided so the source's `instanceof InstanceNamespaceNotConfiguredError`
  // resolves to the SAME class the test throws.
  InstanceNamespaceNotConfiguredError: class InstanceNamespaceNotConfiguredError extends Error {},
}));

// Mock the screens barrel so the real (server-component) barrel never loads in
// the node test env. The mapper returns an identifiable shape; its real field
// logic is tested separately.
vi.mock("@cinatra-ai/extensions/screens", () => ({
  catalogEntryToCardData: (e: { package_name: string; version: string }) =>
    e.version ? { packageName: e.package_name, packageVersion: e.version } : null,
}));

vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: loadVerdaccioMock,
}));

import { loadMarketplaceBrowse } from "../marketplace-browse";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import { InstanceNamespaceNotConfiguredError } from "@cinatra-ai/registries";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";

beforeEach(() => {
  publicListMock.mockReset();
  loadVerdaccioMock.mockReset();
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
