// @vitest-environment jsdom
/**
 * ExtensionCardIconImage + MarketplaceCardIcon — the runtime half of the §IV
 * card icon fallback chain (cinatra#1003, cinatra#1325).
 *
 * The tile must never go blank: a resolved URL that is present but fails to
 * LOAD (dead asset, network hiccup) has to degrade to the next candidate, and
 * finally the emblem node — never sit as a broken/invisible image. These tests
 * fire real `error` events on the `<img>` (needs jsdom), the half the pure
 * `resolveCardIconChain` unit tests can't exercise (they cover URL PRESENCE +
 * order, not load success).
 *
 * cinatra#1325: `MarketplaceCardIcon` ties the pure order to the two NODE tiers
 * — the client-icon-map brand mark and the kind emblem — resolving the same
 * connector identity `/connectors` does.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionCardIconImage,
  MarketplaceCardIcon,
} from "../extension-card-icon-image";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";

const Emblem = () => <svg data-testid="kind-emblem" />;

const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function failCurrentImage() {
  const img = container.querySelector("img")!;
  act(() => {
    img.dispatchEvent(new Event("error"));
  });
}

/** A minimal card for MarketplaceCardIcon (Pick of the icon-chain fields). */
function iconCard(
  over: Partial<
    Pick<
      MarketplaceCardData,
      "manifestLogoUrl" | "iconUrl" | "vendorLogoUrl" | "iconSlug" | "kindSlug"
    >
  > = {},
) {
  return {
    manifestLogoUrl: null,
    iconUrl: null,
    vendorLogoUrl: null,
    iconSlug: null,
    kindSlug: "connector" as const,
    ...over,
  };
}

describe("ExtensionCardIconImage — single src (legacy callers)", () => {
  it("renders the hosted image by default", () => {
    act(() => {
      root.render(<ExtensionCardIconImage src="https://assets.example/icon.png" emblem={<Emblem />} />);
    });
    const img = container.querySelector("img");
    expect(img!.getAttribute("src")).toBe("https://assets.example/icon.png");
    expect(container.querySelector('[data-testid="kind-emblem"]')).toBeNull();
  });

  it("degrades to the emblem glyph when the image fails to load — never a blank tile", () => {
    act(() => {
      root.render(<ExtensionCardIconImage src="https://assets.example/dead.png" emblem={<Emblem />} />);
    });
    failCurrentImage();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });
});

describe("ExtensionCardIconImage — ordered srcs (cinatra#1325 progressive fallback)", () => {
  it("walks the chain first→last on each load failure, then renders the emblem", () => {
    act(() => {
      root.render(
        <ExtensionCardIconImage
          srcs={["https://a/1.png", "https://a/2.png", "https://a/3.png"]}
          emblem={<Emblem />}
        />,
      );
    });
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/1.png");
    failCurrentImage();
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/2.png");
    failCurrentImage();
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/3.png");
    failCurrentImage();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });

  it("renders the emblem directly for an empty chain (no candidates)", () => {
    act(() => {
      root.render(<ExtensionCardIconImage srcs={[]} emblem={<Emblem />} />);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });

  it("restarts at the first candidate when the chain CONTENTS change (index reset)", () => {
    act(() => {
      root.render(<ExtensionCardIconImage srcs={["https://a/1.png", "https://a/2.png"]} emblem={<Emblem />} />);
    });
    failCurrentImage(); // now on 2.png
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/2.png");
    // A different card re-resolves to a different chain → restart at index 0.
    act(() => {
      root.render(<ExtensionCardIconImage srcs={["https://b/9.png", "https://b/8.png"]} emblem={<Emblem />} />);
    });
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://b/9.png");
  });
});

describe("MarketplaceCardIcon — the /connectors-aligned chain (cinatra#1325)", () => {
  it("TIER 2: a connector with a client-icon-map slug renders the brand mark, not the kind emblem", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({ kindSlug: "connector", iconSlug: "youtube-connector" })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    // No <img> (no manifest.logo), a brand SVG rendered, and NOT the kind emblem.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).toBeNull();
  });

  it("TIER 1→2: manifest.logo renders first; on load-failure it degrades to the brand mark (never catalog/emblem)", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({
            kindSlug: "connector",
            iconSlug: "youtube-connector",
            manifestLogoUrl: LOGO_DATA_URI,
            iconUrl: "https://a/catalog.png",
          })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    expect(container.querySelector("img")!.getAttribute("src")).toBe(LOGO_DATA_URI);
    failCurrentImage();
    // Falls to the brand mark — NOT the catalog img, NOT the kind emblem.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("TIER 3→4→5: a connector with NO mapped brand walks catalog → vendor → kind emblem", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({
            kindSlug: "connector",
            iconSlug: "unmapped-connector",
            iconUrl: "https://a/catalog.png",
            vendorLogoUrl: "https://a/vendor.png",
          })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/catalog.png");
    failCurrentImage();
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://a/vendor.png");
    failCurrentImage();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });

  it("gates the brand mark to kind==connector: a NON-connector sharing a slug never borrows a brand", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          // A skill that happens to share the youtube-connector slug basename.
          card={iconCard({ kindSlug: "skill", iconSlug: "youtube-connector" })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // cinatra#1482 — glyph vs. product artwork inside the 46×46 tile.
  //
  // A self-declared `cinatra.logo` is a bare brand GLYPH (the same mark
  // `/connectors` insets in its tile), while the catalog `icon_url` / vendor
  // logo are square product ARTWORK authored to fill. Rendering the glyph with
  // the artwork's full-bleed `object-cover` would blow a 20px brand mark up to
  // an edge-to-edge 46px image and deviate from design `specs/app-extensions.html`
  // §I (a 46×46 `place-items-center` tile carrying a 24×24 mark) on every card
  // the rollout touches.
  // -------------------------------------------------------------------------
  it("presents manifest.logo as an INSET GLYPH (24px, object-contain), not full-bleed artwork", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({
            kindSlug: "connector",
            iconSlug: "unmapped-connector",
            manifestLogoUrl: LOGO_DATA_URI,
          })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(LOGO_DATA_URI);
    expect(img.className).toContain("object-contain");
    expect(img.className).toContain("size-6");
    expect(img.className).not.toContain("object-cover");
  });

  it("keeps the catalog / vendor tiers FULL-BLEED (object-cover) — only the own-logo tier is inset", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({
            kindSlug: "connector",
            iconSlug: "unmapped-connector",
            manifestLogoUrl: LOGO_DATA_URI,
            iconUrl: "https://a/catalog.png",
            vendorLogoUrl: "https://a/vendor.png",
          })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    // Tier 1 — inset glyph.
    expect(container.querySelector("img")!.className).toContain("object-contain");
    failCurrentImage();
    // Tier 3 — marketplace artwork, unchanged full-bleed presentation.
    let img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://a/catalog.png");
    expect(img.className).toContain("h-full w-full object-cover");
    failCurrentImage();
    // Tier 4 — same.
    img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://a/vendor.png");
    expect(img.className).toContain("h-full w-full object-cover");
  });

  it("the legacy single-src callers (§V installed card) keep full-bleed presentation — no glyphSrc, no change", () => {
    act(() => {
      root.render(
        <ExtensionCardIconImage src="https://a/catalog.png" emblem={<Emblem />} />,
      );
    });
    expect(container.querySelector("img")!.className).toContain("h-full w-full object-cover");
  });

  it("AC#4: a connector with no logo, no brand, no catalog/vendor still degrades to the kind emblem — never blank", () => {
    act(() => {
      root.render(
        <MarketplaceCardIcon
          card={iconCard({ kindSlug: "connector", iconSlug: "unmapped-connector" })}
          kindEmblem={<Emblem />}
        />,
      );
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });
});
