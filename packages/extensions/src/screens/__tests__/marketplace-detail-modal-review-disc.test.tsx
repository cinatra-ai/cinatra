/**
 * The review-author disc of the extension-detail modal on the rose ground
 * (cinatra#2851).
 *
 * The modal's Reviews tab draws each review author as a round disc of
 * initials on the author's stable accent ground
 * (`ACCENT_PALETTE[deriveExtensionAccent(review.author)]`, background and ink
 * together). The rose (clay) ground moved to the 4.5 contrast floor with
 * opaque white ink, and every other surface that draws it already pins that
 * pair and its ratio (src/components/__tests__/extension-card.test.tsx and
 * src/lib/__tests__/extension-accent-guard.test.ts). This file pins the same
 * pair and the same floor on this disc. The initials are 14px extra-bold
 * text, ordinary text by the contrast rule, so the floor is 4.5.
 *
 * This package's vitest environment is `node` and its component tests read
 * server markup (marketplace-installed-anchor-recognition.test.tsx). The
 * dialog and tab primitives draw their content only in a browser (a portal,
 * the active tab), so they are stood in as same-named passthroughs, with the
 * modal's other client-only leaves; every assertion lands on the real modal
 * body, the real review row, the real accent palette and the real initials.
 * The markup is read through jsdom's style declaration, as the card tests do.
 */
import type { ReactNode } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { deriveExtensionAccent } from "@/lib/extension-accent";
import type { MarketplaceDetailView } from "@/lib/marketplace-detail-view";
import { contrastAgainst } from "../../../../../src/lib/color-contrast";
import type { MarketplaceCardData } from "../marketplace-card-model";
import { MarketplaceDetailModal } from "../marketplace-detail-modal";

vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Dialog: Passthrough,
    DialogTrigger: Passthrough,
    DialogClose: Passthrough,
    DialogTitle: Passthrough,
    DialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  };
});
vi.mock("@/components/ui/tabs", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Tabs: Passthrough,
    TabsList: Passthrough,
    TabsTrigger: Passthrough,
    TabsContent: ({ value, children }: { value: string; children?: ReactNode }) => (
      <section data-tab={value}>{children}</section>
    ),
  };
});
vi.mock("@/components/ui/separator", () => ({ Separator: () => <hr /> }));
vi.mock("@/components/marketplace-readme-section", () => ({
  MarketplaceReadmeMarkdownBody: () => null,
  hasRenderableReadmeMarkdown: () => false,
}));
vi.mock("@/components/svg-icons/share-network-icons", () => ({ shareNetworkGlyph: () => null }));
// The default loader is the admin-gated server action; a pinned load never calls it.
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getPublicMarketplaceDetailAction: async () => ({ ok: false, reason: "error" }),
}));

/** A review author whose stable accent is the rose (clay) ground. */
const AUTHOR = "Rose Park";

const CARD: MarketplaceCardData = {
  packageName: "@example-vendor/research-agent",
  packageVersion: "0.1.0",
  displayName: "Research Agent",
  description: null,
  kindSlug: "agent",
  kindLabel: "Agent",
  badge: null,
  freshnessAt: null,
  rating: null,
  detailHref: "/configuration/marketplace/example-vendor/research-agent",
  installCount: null,
  manifestLogoUrl: null,
  iconSlug: null,
  iconUrl: null,
  vendorLogoUrl: null,
  sdkAbiRange: null,
  vendor: { name: "Example Vendor", storeUrl: null },
};

const DETAIL: MarketplaceDetailView = {
  packageName: CARD.packageName,
  displayName: CARD.displayName,
  kindLabel: CARD.kindLabel,
  cost: null,
  license: null,
  latestVersion: "0.1.0",
  freshnessAt: null,
  installCount: null,
  permalink: null,
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description: null,
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: { average: 5, total: 1, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 } },
  reviews: [{ author: AUTHOR, verifiedOwner: false, date: null, rating: 5, text: "Clear, cited answers." }],
  vendor: { name: "Example Vendor", slug: "example-vendor", storeUrl: null },
};

/** The disc that opens the author's review row, read from the modal's server markup. */
function authorDisc(): HTMLElement {
  const html = renderToStaticMarkup(
    <MarketplaceDetailModal card={CARD} defaultOpen initialLoad={{ status: "loaded", detail: DETAIL }} />,
  );
  const doc: Document = new JSDOM(html).window.document;
  const reviews = doc.querySelector<HTMLElement>('[data-tab="reviews"]');
  expect(reviews, "the Reviews tab body is in the markup").not.toBeNull();
  const row = Array.from(reviews!.querySelectorAll<HTMLLIElement>("li")).find((li) =>
    li.textContent?.includes(AUTHOR),
  );
  expect(row, "the review row names its author").toBeDefined();
  const disc = row!.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
  expect(disc, "the row opens with the author's disc").not.toBeNull();
  return disc!;
}

describe("extension-detail modal review-author disc on the rose ground (cinatra#2851)", () => {
  it("the fixture author's stable accent is the rose (clay) ground", () => {
    expect(deriveExtensionAccent(AUTHOR)).toBe("clay");
  });

  it("draws the author's initials in the approved opaque rose/white pair", () => {
    const disc = authorDisc();
    expect(disc.textContent).toBe("RP");
    expect(disc.style.background).toBe("rgb(162, 102, 109)");
    expect(disc.style.color).toBe("rgb(255, 255, 255)");
  });

  it("carries the initials at the 4.5 contrast floor for ordinary text", () => {
    const disc = authorDisc();
    expect(contrastAgainst(disc.style.color, disc.style.background)).toBeGreaterThanOrEqual(4.5);
  });
});
