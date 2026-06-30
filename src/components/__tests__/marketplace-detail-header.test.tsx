/**
 * MarketplaceDetailHeader — the in-app mirror of the public marketplace
 * single-extension hero. Covers:
 *   - badge decision (SPDX license → "Open source" + license surfaced; else "Free")
 *   - honest freshness resolution from the marketplace versionHistory
 *   - rendered hero structure: H1 name, badge, freshness + version + license
 *     meta line, Back link to /configuration/marketplace
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/configuration/marketplace/acme/widget",
}));

import {
  MarketplaceDetailHeader,
  resolveDetailFreshnessAt,
  resolveMarketplaceDetailBadge,
} from "../marketplace-detail-header";

describe("resolveMarketplaceDetailBadge", () => {
  it("returns Open source with the SPDX id when a license is present", () => {
    expect(resolveMarketplaceDetailBadge("Apache-2.0")).toEqual({
      text: "Open source",
      license: "Apache-2.0",
    });
  });

  it("trims the license before deciding", () => {
    expect(resolveMarketplaceDetailBadge("  MIT  ")).toEqual({
      text: "Open source",
      license: "MIT",
    });
  });

  it.each([null, undefined, "", "   "])(
    "returns Free when license is %j",
    (license) => {
      expect(resolveMarketplaceDetailBadge(license)).toEqual({
        text: "Free",
        license: null,
      });
    },
  );
});

describe("resolveDetailFreshnessAt", () => {
  const history = [
    { version: "0.1.0", releasedAt: "2026-01-01T00:00:00Z" },
    { version: "0.2.0", releasedAt: "2026-03-05T10:00:00Z" },
  ];

  it("returns the release stamp of the currently listed version", () => {
    expect(
      resolveDetailFreshnessAt({ latestVersion: "0.2.0", versionHistory: history }),
    ).toBe("2026-03-05T10:00:00.000Z");
  });

  it("returns null when there is no listed version", () => {
    expect(
      resolveDetailFreshnessAt({ latestVersion: null, versionHistory: history }),
    ).toBeNull();
  });

  it("returns null when the listed version has no history entry", () => {
    expect(
      resolveDetailFreshnessAt({ latestVersion: "9.9.9", versionHistory: history }),
    ).toBeNull();
  });

  it.each(["", "   ", "not-a-date"])(
    "returns null for a missing/unparseable stamp (%j)",
    (releasedAt) => {
      expect(
        resolveDetailFreshnessAt({
          latestVersion: "1.0.0",
          versionHistory: [{ version: "1.0.0", releasedAt }],
        }),
      ).toBeNull();
    },
  );

  it("returns null for a future stamp — never a misleading freshness label", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      resolveDetailFreshnessAt({
        latestVersion: "1.0.0",
        versionHistory: [{ version: "1.0.0", releasedAt: future }],
      }),
    ).toBeNull();
  });
});

describe("MarketplaceDetailHeader", () => {
  const baseProps = {
    packageName: "@acme/widget",
    name: "Acme Widget",
    kind: "skill" as const,
    license: "MIT" as string | null,
    version: "1.2.3" as string | null,
    freshnessAt: "2026-06-01T00:00:00.000Z" as string | null,
  };

  it("renders the hero: H1 name, Open source badge with license title, meta line, Back link", () => {
    const html = renderToStaticMarkup(<MarketplaceDetailHeader {...baseProps} />);

    expect(html).toContain("<h1");
    expect(html).toContain("Acme Widget");
    expect(html).toContain("Open source");
    expect(html).toContain('title="MIT"');
    // License surfaced visibly in the meta line, not only as a title attr.
    expect(html).toContain("MIT license");
    expect(html).toContain("Version 1.2.3");
    expect(html).toContain("Updated ");
    // React static markup preserves the camelCase attribute name (HTML
    // attribute names are case-insensitive).
    expect(html).toContain('dateTime="2026-06-01T00:00:00.000Z"');
    expect(html).toContain('href="/configuration/marketplace"');
    expect(html).toContain('data-slot="marketplace-detail-hero"');
  });

  it("renders Free (no title) when the listing carries no license", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDetailHeader {...baseProps} license={null} />,
    );
    expect(html).toContain("Free");
    expect(html).not.toContain("Open source");
    expect(html).not.toContain("MIT");
  });

  it("omits freshness and version when absent, but still renders the meta row (compat badge)", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDetailHeader
        {...baseProps}
        license={null}
        version={null}
        freshnessAt={null}
      />,
    );
    expect(html).not.toContain("Updated ");
    expect(html).not.toContain("Version ");
    // The meta row now always renders because it carries the 3-state compat
    // badge — with no declared sdkAbiRange the badge reads the neutral "Unknown".
    expect(html).toContain('data-slot="marketplace-detail-meta"');
    expect(html).toContain('data-slot="extension-compat-badge"');
    expect(html).toContain('data-compat-state="unknown"');
    expect(html).toContain("Unknown");
  });

  it("renders the Compatible (green/success) badge for a satisfied declared range", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDetailHeader {...baseProps} sdkAbiRange="^2" />,
    );
    expect(html).toContain('data-compat-state="compatible"');
    expect(html).toContain("Compatible");
    expect(html).toContain('data-variant="success"');
  });

  it("renders the Incompatible (destructive) badge for an unsatisfied declared range", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDetailHeader {...baseProps} sdkAbiRange="^99" />,
    );
    expect(html).toContain('data-compat-state="incompatible"');
    expect(html).toContain("Incompatible");
    expect(html).toContain('data-variant="destructive"');
  });

  it("NEVER renders green (success) for an undeclared range — neutral Unknown only", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDetailHeader {...baseProps} sdkAbiRange={null} />,
    );
    expect(html).toContain('data-compat-state="unknown"');
    expect(html).not.toContain('data-variant="success"');
  });
});
