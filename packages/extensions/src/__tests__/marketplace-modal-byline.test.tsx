/**
 * MarketplaceModalByline — the §II detail-modal "{Type} by {Vendor}" byline
 * (cinatra#1528). Fed a raw detail vendor block `{ name, slug, storeUrl }` with
 * distinct sentinels, it must render the human name (slug ignored) or the
 * localized placeholder — NEVER the vendor slug, and NEVER a silently dropped
 * "by" clause.
 *
 * `packages/extensions` vitest runs `environment: "node"` — renderToStaticMarkup
 * needs no DOM (see marketplace-listing-card.test.tsx).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { MarketplaceDetailView } from "@/lib/marketplace-detail-view";
import { MarketplaceModalByline } from "../screens/marketplace-modal-byline";

function render(vendor: MarketplaceDetailView["vendor"]): string {
  return renderToStaticMarkup(
    <MarketplaceModalByline
      kindSlug="skill"
      kindLabel="Skill"
      vendor={vendor}
      accentColor="#123456"
      packageName="@scope-sentinel/pkg"
    />,
  );
}

/** The EXACT visible text inside the vendor-label node (a link or a span). */
function vendorLabel(html: string): string | undefined {
  return html.match(/data-slot="marketplace-modal-vendor-label"[^>]*>([^<]*)</)?.[1];
}

describe("MarketplaceModalByline — §II never substitutes the vendor slug (cinatra#1528)", () => {
  it("renders the human name and links out when a real name + store URL are present", () => {
    const html = render({
      name: "Distinct Vendor Name",
      slug: "machine-slug-sentinel",
      storeUrl: "https://marketplace.cinatra.ai/store/distinct",
    });
    expect(vendorLabel(html)).toBe("Distinct Vendor Name");
    expect(html).toContain('href="https://marketplace.cinatra.ai/store/distinct"');
    expect(html).toContain('data-vendor-state="known"');
    expect(vendorLabel(html)).not.toContain("machine-slug-sentinel");
  });

  it("renders the human name as PLAIN text (no link) when the store URL is absent", () => {
    const html = render({ name: "Plain Vendor", slug: "machine-slug-sentinel", storeUrl: null });
    expect(vendorLabel(html)).toBe("Plain Vendor");
    expect(html).not.toContain("<a ");
    expect(html).toContain('data-vendor-state="known"');
  });

  it("renders the placeholder — never the slug — when the name is blank (retired name||slug)", () => {
    const html = render({ name: "  ", slug: "machine-slug-sentinel", storeUrl: "https://marketplace.cinatra.ai/store/x" });
    expect(vendorLabel(html)).toBe("Unknown vendor");
    expect(vendorLabel(html)).not.toContain("machine-slug-sentinel");
    // Missing → plain text, never linked (not even via a surviving store URL).
    expect(html).toContain('data-vendor-state="missing"');
    expect(html).not.toContain("<a ");
  });

  it("renders the placeholder and STILL shows the 'by' clause when the vendor block is null (no silent omission)", () => {
    const html = render(null);
    expect(vendorLabel(html)).toBe("Unknown vendor");
    expect(html).toContain(" by ");
    expect(html).toContain('data-vendor-state="missing"');
  });

  it("drops a non-http(s) store URL to plain text even for a known vendor", () => {
    const html = render({ name: "Known Vendor", slug: "s", storeUrl: "javascript:alert(1)" });
    expect(vendorLabel(html)).toBe("Known Vendor");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<a ");
  });
});
