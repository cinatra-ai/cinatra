// ---------------------------------------------------------------------------
// Installed-extensions list — RSC payload weight (cinatra#2539, page-size half).
//
// The companion suite measures /configuration/marketplace. This one measures
// the OTHER surface the issue names, /configuration/extensions, so the
// attribution of the residual render cost is grounded on both.
//
// It mirrors RegistryCatalogScreen's `renderCard` composition (the screen is an
// async server component wired to auth + the canonical store, so it cannot be
// rendered here — the same reason the design-conformance fixtures mirror it).
// It is REPORTING-ONLY on purpose: unlike the browse grid, this list has no
// never-shown second face and no card-invariant data repeated per row, so there
// is no duplication to fence. Its weight is the cards themselves, which is a
// function of how many rows the view renders — and that is a DESIGN question
// (the §VI drawing lists every installed extension), not one this lane may
// answer on its own.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";

import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import {
  ExtensionCardIconImage,
  MarketplaceCardIcon,
} from "@/components/extension-card-icon-image";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";

import { flightBytes } from "./flight-payload-model";

const MarketplaceDetailModal = vi.fn();
vi.mock("../marketplace-detail-modal", () => ({ MarketplaceDetailModal }));

const CLIENTS = new Set<unknown>([
  MarketplaceDetailModal,
  ExtensionCardIconImage,
  MarketplaceCardIcon,
]);

const KINDS = ["agent", "skill", "connector", "artifact"] as const;

/** One installed row, composed as the §VI screen composes it. */
function buildRow(i: number) {
  const kind = KINDS[i % KINDS.length];
  const packageName = `@cinatra-ai/${kind}-package-${String(i).padStart(3, "0")}`;
  const displayName = `${kind[0].toUpperCase()}${kind.slice(1)} Package ${i}`;
  return createElement(InstalledExtensionCard as never, {
    key: packageName,
    name: displayName,
    accentColor: deriveExtensionAccent(packageName),
    emblem: extensionKindEmblem(kind),
    kindIcon: extensionKindEmblem(kind, "size-3.5"),
    kindLabel: `${kind[0].toUpperCase()}${kind.slice(1)}`,
    vendor: resolveVendorPresentation(
      { name: "Cinatra" },
      { surface: "payload-weight", ref: packageName },
    ),
    source: "marketplace",
    description:
      "Connects your workspace to the service, keeps records in sync both ways, " +
      "and exposes the operations your agents call during a run.",
    version: "v1.4.2",
    status: createElement(InstalledStatusIndicator as never, { status: "active" }),
    actions: createElement(MarketplaceDetailModal as never, {
      card: {
        packageName,
        packageVersion: "1.4.2",
        displayName,
        description: "Connects your workspace to the service.",
        kindSlug: kind,
        kindLabel: kind,
        badge: null,
        freshnessAt: null,
        rating: null,
        detailHref: `/configuration/marketplace/cinatra-ai/${kind}-package-${i}`,
        installCount: null,
        manifestLogoUrl: null,
        iconSlug: null,
        iconUrl: null,
        vendorLogoUrl: null,
        vendor: null,
        sdkAbiRange: null,
      },
      linkTrigger: { variant: "link", href: `/configuration/marketplace/${packageName}` },
      defaultOpen: false,
    }),
    archived: false,
  } as never);
}

const KB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

describe("installed-extensions list — RSC payload weight (cinatra#2539)", () => {
  it("reports the per-row and whole-list payload", () => {
    for (const count of [49, 88]) {
      const rows = Array.from({ length: count }, (_, i) => buildRow(i));
      const total = rows.reduce((sum, row) => sum + flightBytes(row as never, CLIENTS), 0);
      console.log(
        `[payload] installed rows=${count} → list ${KB(total)} (${Math.round(total / count)} B/row)`,
      );
      expect(rows).toHaveLength(count);
    }
  });

  it("spends nothing on a hidden second face — every byte is a rendered row", () => {
    // The contrast with the browse grid, stated as an assertion: the installed
    // card carries exactly one composition. If a future change starts handing
    // this list a second server-rendered face (or repeats card-invariant data
    // per row), the per-row cost jumps and this fence catches it.
    const row = buildRow(0);
    expect(flightBytes(row as never, CLIENTS)).toBeLessThan(6 * 1024);
  });
});
