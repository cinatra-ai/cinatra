import { describe, it, expect } from "vitest";
import type { MarketplaceCatalogEntry } from "@cinatra-ai/marketplace-mcp-client";
import {
  catalogEntryToCardData,
  resolveMarketplaceCardCta,
  marketplaceDetailHref,
} from "../screens/marketplace-card-model";

function catalogEntry(over: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
  return {
    package_name: "@cinatra-ai/blog-skills",
    scope: "cinatra-ai",
    extension_name: "blog-skills",
    version: "0.1.0",
    kind_slug: "skill",
    kind_label: "Skill",
    display_name: "Blog Skills",
    description: "Blog authoring skills",
    badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
    freshness_at: "2026-06-01T00:00:00Z",
    rating: { average: 4, count: 12 },
    vendor_logo_key: null,
    permalink: "https://marketplace.cinatra.ai/product/blog-skills",
    ...over,
  };
}

describe("catalogEntryToCardData", () => {
  it("maps every parity field and the install identifiers", () => {
    const card = catalogEntryToCardData(catalogEntry());
    expect(card).not.toBeNull();
    expect(card!.packageName).toBe("@cinatra-ai/blog-skills");
    expect(card!.packageVersion).toBe("0.1.0");
    expect(card!.displayName).toBe("Blog Skills");
    expect(card!.description).toBe("Blog authoring skills");
    expect(card!.kindSlug).toBe("skill");
    expect(card!.kindLabel).toBe("Skill");
    expect(card!.badge).toEqual({ text: "Open source", variant: "oss" });
    expect(card!.freshnessAt).toBe("2026-06-01T00:00:00Z");
    expect(card!.rating).toEqual({ average: 4, count: 12 });
    expect(card!.detailHref).toBe("/configuration/marketplace/cinatra-ai/blog-skills");
  });

  it("normalizes unmapped kinds to unknown/Extension and still renders", () => {
    // kind_label intentionally empty so the mapper must fall back centrally.
    const card = catalogEntryToCardData(
      catalogEntry({ kind_slug: "context" as never, kind_label: "" }),
    );
    expect(card!.kindSlug).toBe("unknown");
    expect(card!.kindLabel).toBe("Extension");
  });

  it("fails closed (returns null) when the install version is missing — install-identifier guard", () => {
    expect(catalogEntryToCardData(catalogEntry({ version: "" }))).toBeNull();
    expect(catalogEntryToCardData(catalogEntry({ version: "  " }))).toBeNull();
  });

  it("fails closed (returns null) when the package_name is missing", () => {
    expect(catalogEntryToCardData(catalogEntry({ package_name: "" }))).toBeNull();
  });

  it("keeps a null commerce badge / rating when the ability omits them", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ badge: null as never, rating: null as never, freshness_at: null }),
    );
    expect(card!.badge).toBeNull();
    expect(card!.rating).toBeNull();
    expect(card!.freshnessAt).toBeNull();
  });
});

describe("resolveMarketplaceCardCta", () => {
  const card = { packageVersion: "2.0.0" };

  it("not installed → install (enabled when registry connected, disabled when not)", () => {
    expect(resolveMarketplaceCardCta(card, undefined, true)).toEqual({ state: "install", disabled: false });
    expect(resolveMarketplaceCardCta(card, undefined, false)).toEqual({ state: "install", disabled: true });
  });

  it("archived → restore (registry-independent)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: true }, false)).toEqual({
      state: "restore",
    });
  });

  it("installed older → update (disabled when registry not connected)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: false }, true)).toEqual({
      state: "update",
      disabled: false,
    });
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: false }, false)).toEqual({
      state: "update",
      disabled: true,
    });
  });

  it("installed current/newer → installed (no spurious update for a prerelease catalog version)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "2.0.0", isArchived: false }, true)).toEqual({
      state: "installed",
    });
    // Installed stable 2.0.0; catalog shows 2.0.0-rc.1 (a prerelease) → NOT an update.
    expect(
      resolveMarketplaceCardCta({ packageVersion: "2.0.0-rc.1" }, { version: "2.0.0", isArchived: false }, true),
    ).toEqual({ state: "installed" });
  });
});

describe("marketplaceDetailHref", () => {
  it("drops the leading @ for the detail route", () => {
    expect(marketplaceDetailHref("@cinatra-ai/foo")).toBe("/configuration/marketplace/cinatra-ai/foo");
  });
});
