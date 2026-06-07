/**
 * Exercises the mock client's `extensionList` (storefront browse parity).
 *
 * The mock is the drop-in for tests + dev, so its filter/sort/paginate behavior
 * MUST mirror the marketplace `extension_list` ability — otherwise consumers
 * (the listing page) would be exercised against a different shape than prod.
 */

import { describe, it, expect } from "vitest";

import { createMockMarketplaceMcpClient } from "../src/client";
import type { MarketplaceCatalogEntry } from "../src/types";

function entry(over: Partial<MarketplaceCatalogEntry>): MarketplaceCatalogEntry {
  return {
    package_name: "@cinatra-ai/x",
    scope: "cinatra-ai",
    extension_name: "x",
    version: "1.0.0",
    kind_slug: "agent",
    kind_label: "Agent",
    display_name: "@cinatra-ai/x",
    description: null,
    badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
    freshness_at: null,
    rating: { average: 0, count: 0 },
    vendor_logo_key: null,
    permalink: "https://marketplace.cinatra.ai/product/x",
    ...over,
  };
}

describe("mock client — extensionList catalog", () => {
  it("returns an empty catalog when no fixtures are supplied", async () => {
    const out = await createMockMarketplaceMcpClient().extensionList();
    expect(out).toEqual({ items: [], total: 0 });
  });

  it("returns fixture entries and total", async () => {
    const catalog = [
      entry({ package_name: "@cinatra-ai/a", extension_name: "a", kind_slug: "agent" }),
      entry({ package_name: "@cinatra-ai/b", extension_name: "b", kind_slug: "skill", kind_label: "Skill" }),
    ];
    const out = await createMockMarketplaceMcpClient({ catalog }).extensionList();
    expect(out.total).toBe(2);
    expect(out.items.map((e) => e.package_name)).toEqual(["@cinatra-ai/a", "@cinatra-ai/b"]);
  });

  it("filters by kind", async () => {
    const catalog = [
      entry({ package_name: "@cinatra-ai/a", kind_slug: "agent" }),
      entry({ package_name: "@cinatra-ai/b", kind_slug: "skill" }),
    ];
    const out = await createMockMarketplaceMcpClient({ catalog }).extensionList({ kind: "skill" });
    expect(out.total).toBe(1);
    expect(out.items[0].package_name).toBe("@cinatra-ai/b");
  });

  it("an unknown kind matches nothing (mirrors the ability), and an empty kind is no filter", async () => {
    const catalog = [
      entry({ package_name: "@cinatra-ai/a", kind_slug: "agent" }),
      entry({ package_name: "@cinatra-ai/b", kind_slug: "skill" }),
    ];
    const client = createMockMarketplaceMcpClient({ catalog });
    // Unknown kind → empty (NOT "ignore the filter") — matches extension_list.
    expect(await client.extensionList({ kind: "bad" })).toEqual({ items: [], total: 0 });
    // Empty kind → no filter.
    expect((await client.extensionList({ kind: "" })).total).toBe(2);
  });

  it("filters by case-insensitive query over name/package/description", async () => {
    const catalog = [
      entry({ package_name: "@cinatra-ai/blog", display_name: "Blog Writer" }),
      entry({ package_name: "@cinatra-ai/crm", display_name: "CRM Sync", description: "syncs blogs" }),
      entry({ package_name: "@cinatra-ai/mail", display_name: "Mailer" }),
    ];
    const out = await createMockMarketplaceMcpClient({ catalog }).extensionList({ query: "BLOG" });
    expect(out.items.map((e) => e.package_name).sort()).toEqual([
      "@cinatra-ai/blog",
      "@cinatra-ai/crm",
    ]);
    expect(out.total).toBe(2);
  });

  it("paginates with limit/offset while total stays the pre-pagination filtered count", async () => {
    const catalog = Array.from({ length: 5 }, (_, i) =>
      entry({ package_name: `@cinatra-ai/p${i}`, extension_name: `p${i}` }),
    );
    const out = await createMockMarketplaceMcpClient({ catalog }).extensionList({ limit: 2, offset: 1 });
    expect(out.total).toBe(5);
    expect(out.items.map((e) => e.package_name)).toEqual(["@cinatra-ai/p1", "@cinatra-ai/p2"]);
  });

  it("clamps an oversize limit to 100", async () => {
    const catalog = Array.from({ length: 150 }, (_, i) =>
      entry({ package_name: `@cinatra-ai/p${i}`, extension_name: `p${i}` }),
    );
    const out = await createMockMarketplaceMcpClient({ catalog }).extensionList({ limit: 9999 });
    expect(out.total).toBe(150);
    expect(out.items).toHaveLength(100);
  });
});
