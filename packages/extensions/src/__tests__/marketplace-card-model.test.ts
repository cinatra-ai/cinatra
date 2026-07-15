import { describe, it, expect } from "vitest";
import type { MarketplaceCatalogEntry } from "@cinatra-ai/marketplace-mcp-client";
import {
  catalogEntryToCardData,
  resolveCardDisplayName,
  normalizeCardDescription,
  resolveMarketplaceCardCta,
  resolveCardPriceLabel,
  resolveCardIconChain,
  safeManifestLogoSrc,
  deriveIconSlug,
  marketplaceDetailHref,
  type MarketplaceCardData,
} from "../screens/marketplace-card-model";

// A representative sanitized inline-SVG logo data URI — the EXACT form the
// manifest generator emits for `cinatra.logo`.
const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

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

describe("catalogEntryToCardData — listing-card fields (install count, icon/vendor URLs, ABI range)", () => {
  it("maps a clean install count, icon URL, vendor-logo URL (WP-media descriptor shape), and ABI range", () => {
    // The LIVE storefront catalog serves icon_url/vendor_logo_url as a
    // {url, width, height} descriptor — the same WP-media shape the public
    // detail endpoint's icon_url already carries (cinatra#1003) — not a bare
    // string. A prior bare-string-only mapping silently discarded every real
    // asset on every listing.
    const card = catalogEntryToCardData(
      catalogEntry({
        install_count: 2147,
        icon_url: { url: "https://assets.example/icon.png", width: 256, height: 256 },
        vendor_logo_url: { url: "https://assets.example/vendor.png", width: 256, height: 256 },
        sdk_abi_range: "^2",
      }),
    );
    expect(card!.installCount).toBe(2147);
    expect(card!.iconUrl).toBe("https://assets.example/icon.png");
    expect(card!.vendorLogoUrl).toBe("https://assets.example/vendor.png");
    expect(card!.sdkAbiRange).toBe("^2");
  });

  it("still accepts a bare string icon/vendor-logo URL (a pre-descriptor catalog build)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({
        icon_url: "https://assets.example/icon.png",
        vendor_logo_url: "https://assets.example/vendor.png",
      }),
    );
    expect(card!.iconUrl).toBe("https://assets.example/icon.png");
    expect(card!.vendorLogoUrl).toBe("https://assets.example/vendor.png");
  });

  it("degrades a descriptor with a blank/absent `url` field to null (never a broken-image placeholder)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({
        icon_url: { url: null, width: 256, height: 256 },
        vendor_logo_url: { width: 256, height: 256 },
      }),
    );
    expect(card!.iconUrl).toBeNull();
    expect(card!.vendorLogoUrl).toBeNull();
  });

  it("degrades every new field to null when the marketplace omits them (older catalog)", () => {
    // No new fields on the fixture → all optional, all null. Tolerant of an
    // L4-backend that has not shipped the catalog fields yet.
    const card = catalogEntryToCardData(catalogEntry());
    expect(card!.installCount).toBeNull();
    expect(card!.iconUrl).toBeNull();
    expect(card!.vendorLogoUrl).toBeNull();
    expect(card!.sdkAbiRange).toBeNull();
  });

  it("rejects a garbage install count (negative / non-number / NaN / Infinity → null)", () => {
    expect(
      catalogEntryToCardData(catalogEntry({ install_count: -5 }))!.installCount,
    ).toBeNull();
    expect(
      catalogEntryToCardData(catalogEntry({ install_count: NaN }))!.installCount,
    ).toBeNull();
    expect(
      catalogEntryToCardData(catalogEntry({ install_count: Infinity }))!.installCount,
    ).toBeNull();
    expect(
      catalogEntryToCardData(catalogEntry({ install_count: "12" as never }))!.installCount,
    ).toBeNull();
    // A fractional count floors to a whole installation.
    expect(
      catalogEntryToCardData(catalogEntry({ install_count: 3.9 }))!.installCount,
    ).toBe(3);
  });

  it("trims/blank-collapses the optional URL + ABI fields to null", () => {
    const card = catalogEntryToCardData(
      catalogEntry({
        icon_url: "  ",
        vendor_logo_url: "  https://v.example/logo.png  ",
        sdk_abi_range: "",
      }),
    );
    expect(card!.iconUrl).toBeNull();
    expect(card!.vendorLogoUrl).toBe("https://v.example/logo.png");
    expect(card!.sdkAbiRange).toBeNull();
  });
});

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

  it("strips the leading markdown heading marker from the card description (cinatra#205)", () => {
    // Storefront flattens each README into a single-line description that still
    // carries the leading H1; the card renders it raw, so the `#` must be
    // stripped at the mapper layer (once), never reach the <p>.
    const card = catalogEntryToCardData(
      catalogEntry({
        description: "# Email Outreach Agent Run an outbound email campaign from scratch.",
      }),
    );
    expect(card!.description).toBe(
      "Email Outreach Agent Run an outbound email campaign from scratch.",
    );
  });
});

describe("resolveCardDisplayName — human-name fallback order (cinatra#1605)", () => {
  // Anti-lookalike (cinatra#1528 / conformance seed-data discipline): the
  // manifest display name shares NO token with the package name OR its slug, so
  // a resolver that leaks / prettifies the package name can NEVER coincidentally
  // produce the expected value — the assertion is a genuine RED, not a lookalike
  // pass. (A shared-token pair like "@…/default-artifact" ↔ "Default Artifact"
  // would let a slug-prettifier pass, so it is deliberately avoided here.)
  const PKG = "@cinatra-ai/quill-scribe"; // tokens: cinatra, ai, quill, scribe
  const SLUG = "quill-scribe";
  const MANIFEST_NAME = "Ledger Beacon"; // tokens: ledger, beacon — disjoint
  // Every plausible prettification of the package name / slug. The resolved
  // human name must equal NONE of these (it is the manifest name, not a
  // derived-from-package-name string).
  const PRETTIFY_CANDIDATES = [
    SLUG,
    "Quill Scribe",
    "Quill-Scribe",
    "quill scribe",
    "Cinatra Ai Quill Scribe",
    PKG,
  ];

  it("prefers a non-empty trimmed catalog display_name (current marketplace data wins)", () => {
    // Catalog name present AND a different manifest name present → catalog wins.
    expect(resolveCardDisplayName("Blog Skills", MANIFEST_NAME, PKG)).toBe("Blog Skills");
    expect(resolveCardDisplayName("  Blog Skills  ", MANIFEST_NAME, PKG)).toBe("Blog Skills");
  });

  it("falls back to the static manifest displayName when the catalog omits display_name (bundled rescue)", () => {
    // display_name absent/blank/whitespace → the manifest human name resolves,
    // NOT the raw package name (the #1605 symptom). MANIFEST_NAME shares no
    // token with PKG, so this proves the manifest tier was chosen — not a
    // prettified package name that happens to look like it.
    for (const absent of [undefined, null, "", "   "]) {
      const resolved = resolveCardDisplayName(absent, MANIFEST_NAME, PKG);
      expect(resolved).toBe(MANIFEST_NAME);
      for (const pretty of PRETTIFY_CANDIDATES) expect(resolved).not.toBe(pretty);
    }
  });

  it("uses the raw package name ONLY as a true last resort (neither catalog nor manifest supplied a name)", () => {
    expect(resolveCardDisplayName(undefined, undefined, PKG)).toBe(PKG);
    expect(resolveCardDisplayName("", null, PKG)).toBe(PKG);
    expect(resolveCardDisplayName("  ", "  ", PKG)).toBe(PKG);
  });

  it("never prettifies or substitutes the slug for the package name at the last resort (anti-lookalike)", () => {
    // Last-resort output is the package name VERBATIM — no derived pretty name.
    const resolved = resolveCardDisplayName(undefined, undefined, PKG);
    expect(resolved).toBe(PKG);
    expect(resolved).not.toBe(MANIFEST_NAME);
    // It is the untouched scoped npm name: no space-separated prettification.
    expect(resolved).toBe("@cinatra-ai/quill-scribe");
    expect(resolved).not.toContain(" ");
  });
});

describe("catalogEntryToCardData — display-name resolution (cinatra#1605)", () => {
  // The install popup title, the listing-card title, and the detail modal all
  // consume `card.displayName`; fixing it at the model covers all three (AC5).
  // Anti-lookalike pair (shares no token with the package name/slug), so binding
  // MANIFEST_NAME proves the manifest tier was chosen — never a prettified
  // package name that merely resembles it.
  const PKG = "@cinatra-ai/quill-scribe";
  const MANIFEST_NAME = "Ledger Beacon";

  it("keeps the catalog display_name when present, even if a manifest name is injected", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: PKG, display_name: "Catalog Name" }),
      { manifestDisplayName: MANIFEST_NAME },
    );
    expect(card!.displayName).toBe("Catalog Name");
  });

  it("resolves the injected manifest displayName when the catalog entry lacks display_name (the popup no longer shows the package name)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: PKG, display_name: "" as never }),
      { manifestDisplayName: MANIFEST_NAME },
    );
    expect(card!.displayName).toBe(MANIFEST_NAME);
    expect(card!.displayName).not.toBe(PKG);
    // Not a prettified slug either (anti-lookalike): shares no token with PKG.
    expect(card!.displayName).not.toBe("Quill Scribe");
    expect(card!.displayName).not.toBe("quill-scribe");
  });

  it("a bundled extension (present in the static manifest) NEVER falls through to the package name (AC3)", () => {
    // The manifest tier is the guarantee for a bundled package with no catalog
    // display_name — the package name must not appear as the title.
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: PKG, display_name: undefined as never }),
      { manifestDisplayName: MANIFEST_NAME },
    );
    expect(card!.displayName).not.toBe(card!.packageName);
    expect(card!.displayName).toBe(MANIFEST_NAME);
  });

  it("falls to the package name only when neither the catalog nor the manifest supplies a name (data gap, not a routine state)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: PKG, display_name: "" as never }),
      { manifestDisplayName: null },
    );
    expect(card!.displayName).toBe(PKG);
  });

  it("un-enriched call (no manifest injected) still resolves the catalog display_name", () => {
    const card = catalogEntryToCardData(catalogEntry({ display_name: "Blog Skills" }));
    expect(card!.displayName).toBe("Blog Skills");
  });
});

describe("normalizeCardDescription", () => {
  it("strips a leading ATX heading marker (#…######) and trims", () => {
    expect(normalizeCardDescription("# Title rest of prose")).toBe("Title rest of prose");
    expect(normalizeCardDescription("###### Deep heading then text")).toBe(
      "Deep heading then text",
    );
    expect(normalizeCardDescription("   #   Padded heading")).toBe("Padded heading");
  });

  it("leaves a description with no leading heading untouched (aside from trimming)", () => {
    expect(normalizeCardDescription("Plain prose description")).toBe(
      "Plain prose description",
    );
    expect(normalizeCardDescription("  spaced prose  ")).toBe("spaced prose");
  });

  it("preserves a legitimate mid-text or no-space '#' (no false heading strip)", () => {
    // Requires whitespace after the hashes, so "#1 ranked" / "#hashtag" are NOT
    // ATX headings and survive intact.
    expect(normalizeCardDescription("#1 ranked outreach tool")).toBe(
      "#1 ranked outreach tool",
    );
    expect(normalizeCardDescription("Rated #1 by users")).toBe("Rated #1 by users");
    expect(normalizeCardDescription("#hashtag heavy copy")).toBe("#hashtag heavy copy");
  });

  it("collapses a heading-only / blank / non-string description to null", () => {
    expect(normalizeCardDescription("# ")).toBeNull();
    expect(normalizeCardDescription("   ")).toBeNull();
    expect(normalizeCardDescription("")).toBeNull();
    expect(normalizeCardDescription(null)).toBeNull();
    expect(normalizeCardDescription(undefined)).toBeNull();
  });
});

describe("resolveMarketplaceCardCta (six-state, cinatra#988)", () => {
  const card = { packageVersion: "2.0.0" };

  it("not installed → install (enabled when registry connected, disabled when not)", () => {
    expect(resolveMarketplaceCardCta(card, undefined, true, "compatible")).toEqual({ state: "install", disabled: false });
    expect(resolveMarketplaceCardCta(card, undefined, false, "compatible")).toEqual({ state: "install", disabled: true });
  });

  it("not installed + undeclared ABI (unknown) stays installable — exactly as lenient as the install gate", () => {
    expect(resolveMarketplaceCardCta(card, undefined, true, "unknown")).toEqual({ state: "install", disabled: false });
  });

  it("not installed + incompatible ABI → incompatible install (never softer than the install gate)", () => {
    expect(resolveMarketplaceCardCta(card, undefined, true, "incompatible")).toEqual({
      state: "incompatible",
      blockedAction: "install",
    });
    // Registry state cannot soften/override the ABI refusal.
    expect(resolveMarketplaceCardCta(card, undefined, false, "incompatible")).toEqual({
      state: "incompatible",
      blockedAction: "install",
    });
  });

  it("installed older + incompatible NEWER catalog version → incompatible update (the update gate refusal)", () => {
    // Updating would fetch + activate the incompatible catalog version, so an
    // enabled Update would be softer than the gate — grey it out too.
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: false }, true, "incompatible")).toEqual({
      state: "incompatible",
      blockedAction: "update",
    });
  });

  it("incompatible never gates actionless/DB-only states — restore + installed keep their state", () => {
    // Restore reactivates the already-installed version (no catalog fetch);
    // Installed has no action to gate.
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: true }, true, "incompatible")).toEqual({
      state: "restore",
    });
    expect(resolveMarketplaceCardCta(card, { version: "2.0.0", isArchived: false }, true, "incompatible")).toEqual({
      state: "installed",
    });
  });

  it("archived → restore (registry-independent)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: true }, false, "compatible")).toEqual({
      state: "restore",
    });
  });

  it("installed older → update (disabled when registry not connected)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: false }, true, "compatible")).toEqual({
      state: "update",
      disabled: false,
    });
    expect(resolveMarketplaceCardCta(card, { version: "1.0.0", isArchived: false }, false, "compatible")).toEqual({
      state: "update",
      disabled: true,
    });
  });

  it("installed current/newer → installed (no spurious update for a prerelease catalog version)", () => {
    expect(resolveMarketplaceCardCta(card, { version: "2.0.0", isArchived: false }, true, "compatible")).toEqual({
      state: "installed",
    });
    // Installed stable 2.0.0; catalog shows 2.0.0-rc.1 (a prerelease) → NOT an update.
    expect(
      resolveMarketplaceCardCta({ packageVersion: "2.0.0-rc.1" }, { version: "2.0.0", isArchived: false }, true, "compatible"),
    ).toEqual({ state: "installed" });
  });
});

describe("catalogEntryToCardData — publisher/vendor block (§IV publisher line, cinatra#988)", () => {
  it("maps a full vendor block (name + store URL)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({
        vendor: { name: "Foundry", slug: "foundry", store_url: "https://marketplace.cinatra.ai/store/foundry" },
      }),
    );
    expect(card!.vendor).toEqual({
      name: "Foundry",
      storeUrl: "https://marketplace.cinatra.ai/store/foundry",
    });
  });

  it("NEVER substitutes the slug for a blank name — a nameless vendor degrades to null (cinatra#1528)", () => {
    // The retired `name ?? slug` fallback rendered the machine slug as the
    // vendor. A blank name now degrades to null and the §I render resolves that
    // to the explicit missing-vendor placeholder — the slug is never the label.
    const card = catalogEntryToCardData(
      catalogEntry({ vendor: { name: "  ", slug: "machine-slug-sentinel", store_url: null } }),
    );
    expect(card!.vendor).toBeNull();
  });

  it("keeps only the human name (slug ignored) when both are present", () => {
    const card = catalogEntryToCardData(
      catalogEntry({
        vendor: { name: "Foundry", slug: "machine-slug-sentinel", store_url: null },
      }),
    );
    expect(card!.vendor).toEqual({ name: "Foundry", storeUrl: null });
  });

  it("drops the store URL along with the block when the name is absent (a nameless vendor is never linked)", () => {
    expect(
      catalogEntryToCardData(
        catalogEntry({ vendor: { name: " ", slug: "machine-slug-sentinel", store_url: "https://x" } }),
      )!.vendor,
    ).toBeNull();
  });

  it("degrades to null (no publisher line vendor) when the catalog omits or blanks the block", () => {
    expect(catalogEntryToCardData(catalogEntry())!.vendor).toBeNull();
    expect(catalogEntryToCardData(catalogEntry({ vendor: null }))!.vendor).toBeNull();
    expect(
      catalogEntryToCardData(catalogEntry({ vendor: { name: " ", slug: "", store_url: "x" } }))!.vendor,
    ).toBeNull();
  });
});

describe("resolveCardPriceLabel (§IV price row, cinatra#988)", () => {
  it("maps the three commerce variants to the spec price strings", () => {
    expect(resolveCardPriceLabel({ text: "Open source", variant: "oss" })).toBe("Free, Open Source");
    expect(resolveCardPriceLabel({ text: "Free", variant: "free" })).toBe("Free");
    expect(resolveCardPriceLabel({ text: "$9/mo", variant: "price" })).toBe("$9/mo");
  });

  it("renders no price row for a badge-less card (wire defence)", () => {
    expect(resolveCardPriceLabel(null)).toBeNull();
  });
});

describe("marketplaceDetailHref", () => {
  it("drops the leading @ for the detail route", () => {
    expect(marketplaceDetailHref("@cinatra-ai/foo")).toBe("/configuration/marketplace/cinatra-ai/foo");
  });
});

// ---------------------------------------------------------------------------
// cinatra#1325 — the card icon resolves the SAME chain /connectors uses:
//   manifest.logo → client icon map → catalog icon_url → vendor logo → kind emblem
// ---------------------------------------------------------------------------

describe("safeManifestLogoSrc — the extension's own logo guard (cinatra#1325)", () => {
  it("passes the exact sanitized inline-SVG data URI the manifest generator emits", () => {
    expect(safeManifestLogoSrc(LOGO_DATA_URI)).toBe(LOGO_DATA_URI);
  });

  it("passes a plain http(s) hosted logo URL", () => {
    expect(safeManifestLogoSrc("https://assets.example/logo.svg")).toBe(
      "https://assets.example/logo.svg",
    );
  });

  it("REJECTS a bare/arbitrary data: payload — only the bounded image/svg+xml;base64 form is trusted", () => {
    expect(safeManifestLogoSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeManifestLogoSrc("data:image/svg+xml,<svg/>")).toBeNull(); // not base64-marked
    expect(safeManifestLogoSrc("data:application/octet-stream;base64,AAAA")).toBeNull();
  });

  it("REJECTS an active/dangerous scheme and blank/non-string input", () => {
    expect(safeManifestLogoSrc("javascript:alert(1)")).toBeNull();
    expect(safeManifestLogoSrc("not a url")).toBeNull();
    expect(safeManifestLogoSrc("   ")).toBeNull();
    expect(safeManifestLogoSrc(null)).toBeNull();
    expect(safeManifestLogoSrc(42)).toBeNull();
  });
});

describe("deriveIconSlug — the client-icon-map key (cinatra#1325)", () => {
  it("strips the npm scope to the /connectors + ICON_BY_SLUG slug", () => {
    expect(deriveIconSlug("@cinatra-ai/youtube-connector")).toBe("youtube-connector");
    expect(deriveIconSlug("@cinatra-ai/linkedin-connector")).toBe("linkedin-connector");
  });

  it("returns a bare (unscoped) name as-is and degrades garbage to null", () => {
    expect(deriveIconSlug("plane-connector")).toBe("plane-connector");
    expect(deriveIconSlug("")).toBeNull();
    expect(deriveIconSlug("   ")).toBeNull();
    expect(deriveIconSlug("@cinatra-ai/")).toBeNull();
  });
});

describe("catalogEntryToCardData — cinatra#1325 icon-chain enrichment", () => {
  it("populates manifestLogoUrl from the injected manifest.logo + iconSlug from the package name", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: "@cinatra-ai/youtube-connector", kind_slug: "connector" }),
      { manifestLogo: LOGO_DATA_URI },
    );
    expect(card!.manifestLogoUrl).toBe(LOGO_DATA_URI);
    expect(card!.iconSlug).toBe("youtube-connector");
  });

  it("leaves manifestLogoUrl null when no manifest.logo is injected (un-enriched / storefront-only)", () => {
    const card = catalogEntryToCardData(
      catalogEntry({ package_name: "@cinatra-ai/youtube-connector" }),
    );
    expect(card!.manifestLogoUrl).toBeNull();
    expect(card!.iconSlug).toBe("youtube-connector");
  });

  it("guards an injected manifest.logo through safeManifestLogoSrc (a bad scheme → null)", () => {
    const card = catalogEntryToCardData(catalogEntry(), {
      manifestLogo: "javascript:alert(1)",
    });
    expect(card!.manifestLogoUrl).toBeNull();
  });
});

describe("resolveCardIconChain — the explicit fallback order (cinatra#1325)", () => {
  function card(over: Partial<MarketplaceCardData> = {}): MarketplaceCardData {
    return { ...catalogEntryToCardData(catalogEntry())!, ...over };
  }

  // TIER 1: manifest.logo — first in EVERY branch.
  it("puts manifest.logo first when there is no client icon (tier 1 → catalog → vendor)", () => {
    const chain = resolveCardIconChain(
      card({
        manifestLogoUrl: LOGO_DATA_URI,
        iconUrl: "https://a.example/catalog.png",
        vendorLogoUrl: "https://a.example/vendor.png",
      }),
      { hasClientIcon: false },
    );
    expect(chain.imageSrcs).toEqual([
      LOGO_DATA_URI,
      "https://a.example/catalog.png",
      "https://a.example/vendor.png",
    ]);
    expect(chain.emblem).toBe("kind-emblem");
  });

  // TIER 2: client icon map — BEATS catalog icon_url + vendor logo.
  it("drops the catalog + vendor <img> tiers when a client icon exists — the client icon wins over catalog", () => {
    const chain = resolveCardIconChain(
      card({
        manifestLogoUrl: null,
        iconUrl: "https://a.example/catalog.png",
        vendorLogoUrl: "https://a.example/vendor.png",
      }),
      { hasClientIcon: true },
    );
    expect(chain.imageSrcs).toEqual([]); // catalog/vendor unreachable behind the client-icon node
    expect(chain.emblem).toBe("client-icon");
  });

  it("keeps manifest.logo above the client icon (tier 1 → tier 2 terminal)", () => {
    const chain = resolveCardIconChain(
      card({ manifestLogoUrl: LOGO_DATA_URI, iconUrl: "https://a.example/catalog.png" }),
      { hasClientIcon: true },
    );
    expect(chain.imageSrcs).toEqual([LOGO_DATA_URI]);
    expect(chain.emblem).toBe("client-icon");
  });

  // TIER 3/4: catalog icon → vendor logo (legacy chain), guarded to http(s).
  it("falls to catalog icon then vendor logo, http(s)-guarded, then the kind emblem", () => {
    const chain = resolveCardIconChain(
      card({
        manifestLogoUrl: null,
        iconUrl: "https://a.example/catalog.png",
        vendorLogoUrl: "ftp://nope/vendor.png",
      }),
      { hasClientIcon: false },
    );
    expect(chain.imageSrcs).toEqual(["https://a.example/catalog.png"]); // non-http(s) vendor dropped
    expect(chain.emblem).toBe("kind-emblem");
  });

  // TIER 5: kind emblem — the guaranteed tail when nothing else resolves.
  it("degrades to the kind emblem with no img candidates when every URL tier is empty (AC#4)", () => {
    const chain = resolveCardIconChain(
      card({ manifestLogoUrl: null, iconUrl: null, vendorLogoUrl: null }),
      { hasClientIcon: false },
    );
    expect(chain.imageSrcs).toEqual([]);
    expect(chain.emblem).toBe("kind-emblem");
  });

  it("re-guards manifest.logo inside the resolver (a fixture-supplied bad value is dropped)", () => {
    const chain = resolveCardIconChain(
      { manifestLogoUrl: "data:text/html;base64,PHN2Zy8+", iconUrl: null, vendorLogoUrl: null },
      { hasClientIcon: false },
    );
    expect(chain.imageSrcs).toEqual([]);
  });

  it("DEDUPES a shared URL across tiers so the progressive fallback can't stall on it (codex round-1)", () => {
    // catalog icon_url === vendor_logo_url (a common storefront shape): a naive
    // chain would be [X, X] and the second onError could never fire (same key +
    // src → node reused), stalling on a dead image. The chain must be [X] so the
    // single failure advances straight to the kind emblem.
    const chain = resolveCardIconChain(
      card({
        manifestLogoUrl: null,
        iconUrl: "https://a.example/same.png",
        vendorLogoUrl: "https://a.example/same.png",
      }),
      { hasClientIcon: false },
    );
    expect(chain.imageSrcs).toEqual(["https://a.example/same.png"]);
    expect(chain.emblem).toBe("kind-emblem");
  });
});
