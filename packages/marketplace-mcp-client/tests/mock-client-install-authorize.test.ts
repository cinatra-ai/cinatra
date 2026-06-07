/**
 * Exercises the mock client's `extensionInstallAuthorize` (gatekept
 * install). The mock is the drop-in for tests + dev, so it auto-grants a
 * deterministic stub when no fixture matches (all live extensions are free →
 * auto-grant), supports per-package(+version) fixtures, and throws a supplied
 * MarketplaceMcpError to simulate a denial.
 */

import { describe, it, expect, vi } from "vitest";

import { createMockMarketplaceMcpClient, MarketplaceMcpError } from "../src/client";
import type { MarketplaceExtensionInstallAuthorizeOutput } from "../src/types";

describe("mock client — extensionInstallAuthorize", () => {
  it("auto-grants a deterministic stub when no fixture matches", async () => {
    const out = await createMockMarketplaceMcpClient().extensionInstallAuthorize({
      package_name: "@cinatra-ai/blog-skills",
      version: "0.1.0",
    });
    expect(out.resolved_version).toBe("0.1.0");
    expect(out.broker_base_url).toContain("/install/v1");
    expect(typeof out.grant).toBe("string");
    expect(out.grant.length).toBeGreaterThan(0);
    expect(out.closure).toEqual([]);
    expect(typeof out.expires_at).toBe("string");
  });

  it("returns an exact-key fixture (packageName@version) verbatim", async () => {
    const fixture: MarketplaceExtensionInstallAuthorizeOutput = {
      grant: "fixed.grant",
      kind: "connector",
      resolved_version: "2.0.0",
      broker_base_url: "https://mk.test/install/v1",
      closure: [{ name: "@scope/dep", version: "1.0.0" }],
      expires_at: "2026-06-04T00:02:00Z",
    };
    const client = createMockMarketplaceMcpClient({
      installAuthorizations: { "@scope/ext@2.0.0": fixture },
    });
    const out = await client.extensionInstallAuthorize({
      package_name: "@scope/ext",
      version: "2.0.0",
    });
    expect(out).toEqual(fixture);
  });

  it("falls back to a packageName-only fixture when no exact version key matches", async () => {
    const fixture: MarketplaceExtensionInstallAuthorizeOutput = {
      grant: "pkg.grant",
      kind: "skill",
      resolved_version: "9.9.9",
      broker_base_url: "https://mk.test/install/v1",
      closure: [],
      expires_at: "2026-06-04T00:02:00Z",
    };
    const client = createMockMarketplaceMcpClient({
      installAuthorizations: { "@scope/ext": fixture },
    });
    const out = await client.extensionInstallAuthorize({
      package_name: "@scope/ext",
      version: "1.0.0",
    });
    expect(out.grant).toBe("pkg.grant");
  });

  it("throws a supplied MarketplaceMcpError to simulate a denial", async () => {
    const client = createMockMarketplaceMcpClient({
      installAuthorizations: {
        "@scope/ext@1.0.0": new MarketplaceMcpError("not entitled", 403, ""),
      },
    });
    await expect(
      client.extensionInstallAuthorize({ package_name: "@scope/ext", version: "1.0.0" }),
    ).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("invokes the onInstallAuthorize spy with the input", async () => {
    const spy = vi.fn();
    const client = createMockMarketplaceMcpClient({ onInstallAuthorize: spy });
    await client.extensionInstallAuthorize({ package_name: "@scope/ext", version: "1.0.0" });
    expect(spy).toHaveBeenCalledWith({ package_name: "@scope/ext", version: "1.0.0" });
  });
});
