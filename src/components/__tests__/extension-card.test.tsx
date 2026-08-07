/**
 * ExtensionCard — marketplace listing-card banner (design spec §IV).
 *
 * Shell mode (the marketplace storefront tile) renders the §IV banner: the
 * 46×46 SQUARE icon tile + the human-readable name INSIDE the coloured banner,
 * with the icon resolving a hosted-URL → kind-emblem fallback chain. Button
 * mode (the §V running-agent chip) is unchanged and keeps its accessible name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionCard } from "../extension-card";

const SquareEmblem = () => <svg data-testid="kind-emblem" />;

describe("ExtensionCard listing banner (§IV, shell mode, variant=listing)", () => {
  const shellProps = {
    variant: "listing" as const,
    name: "Research Assistant",
    accentColor: "plum" as const,
    emblem: <SquareEmblem />,
    description: "Gathers sources and cites answers.",
  };

  it("renders the 0.5.0 §I banner: 88px coloured banner, 46×46 square icon tile, name in the banner", () => {
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    // Banner area present with the listing-card slot + min-height (0.5.0: 88px,
    // reduced from 96 now the byline shares the banner).
    expect(html).toContain('data-slot="extension-card-banner"');
    expect(html).toContain("min-h-[88px]");
    expect(html).not.toContain("min-h-[96px]");
    // Square icon tile (46×46, 11px radius), NOT the round 42px running-agent pill.
    expect(html).toContain('data-slot="extension-card-icon"');
    expect(html).toContain("h-[46px]");
    expect(html).toContain("w-[46px]");
    expect(html).toContain("rounded-[11px]");
    // Name lives inside the banner (Archivo italic-800, listing-title token =
    // 18px), clamped at 2 lines (0.5.0: was 3; the byline takes the 3rd line).
    expect(html).toContain('data-slot="extension-card-name"');
    expect(html).toContain("Research Assistant");
    expect(html).toContain("line-clamp-2");
    expect(html).not.toContain("line-clamp-3");
    expect(html).toContain("text-listing-title");
  });

  it("carries a native always-on title= on the name, matching the FULL text on both a short AND a truncated (clamped) name (cinatra#2363)", () => {
    // Short name: the always-on contract means title= is present regardless
    // of whether the name actually overflows the clamp.
    const shortHtml = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    const shortNameDiv = shortHtml.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
    expect(shortNameDiv).toContain(`title="${shellProps.name}"`);

    // Long name: title= carries the FULL, un-clamped string.
    const longName =
      "A Very Long Extension Display Name That Would Overflow The Two-Line Clamp In A Narrow Card";
    const longHtml = renderToStaticMarkup(<ExtensionCard {...shellProps} name={longName} />);
    const longNameDiv = longHtml.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
    expect(longNameDiv).toContain(`title="${longName}"`);
  });

  it("renders the byline slot beneath the name inside the banner (0.5.0 §I)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} byline={<span data-testid="byline-slot">Agent by Cinatra</span>} />,
    );
    // The byline slot is a banner descendant, placed after the name…
    const bannerAt = html.indexOf('data-slot="extension-card-banner"');
    const nameAt = html.indexOf('data-slot="extension-card-name"');
    const bylineAt = html.indexOf('data-testid="byline-slot"');
    const bodyAt = html.indexOf("bg-surface p-4");
    expect(bylineAt).toBeGreaterThan(nameAt);
    expect(bylineAt).toBeGreaterThan(bannerAt);
    // …not in the body block below the banner.
    expect(bylineAt).toBeLessThan(bodyAt);
  });

  it("uses the kind emblem when no icon URL is supplied (fallback chain tail)", () => {
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    expect(html).toContain('data-testid="kind-emblem"');
    expect(html).not.toContain("<img");
  });

  it("renders the hosted icon image when an icon URL is supplied (fallback chain head)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} iconUrl="https://assets.example/icon.png" />,
    );
    expect(html).toContain('src="https://assets.example/icon.png"');
    expect(html).toContain("object-cover");
    // Decorative alt (the visible name carries the accessible label).
    expect(html).toContain('alt=""');
    // The emblem is NOT rendered when an icon image is present.
    expect(html).not.toContain('data-testid="kind-emblem"');
  });

  it("overlays badges in the banner top-right and reserves name padding so a long name never runs under them", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} badges={<span>Skill</span>} />,
    );
    expect(html).toContain("Skill");
    expect(html).toContain("absolute right-[14px] top-[14px]");
    // The name reserves right padding when badges are present.
    expect(html).toContain("pr-20");
  });
});

describe("ExtensionCard shell mode default (variant=chip) — non-marketplace lists unchanged", () => {
  it("keeps the §V chip (NOT the §IV listing banner) when no variant is passed (e.g. the agent-run grid)", () => {
    // The agent-run grid renders a shell-mode card with no variant. It MUST
    // keep the §V chip (min-h-150 emblem-above-name) and the indicator, never
    // the marketplace listing banner.
    const html = renderToStaticMarkup(
      <ExtensionCard
        name="Outbound Agent"
        accentColor="plum"
        emblem={<SquareEmblem />}
        description="Runs outbound email."
        indicator={{ label: "Daily 9am" }}
      />,
    );
    expect(html).not.toContain('data-slot="extension-card-banner"');
    expect(html).toContain("min-h-[150px]");
    expect(html).toContain("Daily 9am");
    expect(html).toContain("Outbound Agent");
  });
});

describe("ExtensionCard button mode (§V) — unchanged accessible name", () => {
  it("keeps the explicit aria-label so the font-display name is machine-readable", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard
        name="Email Outreach Agent"
        accentColor="green"
        emblem={<SquareEmblem />}
        indicator={{ label: "Daily 9am" }}
      />,
    );
    expect(html).toContain('aria-label="Email Outreach Agent"');
    // Button mode does NOT use the §IV listing banner.
    expect(html).not.toContain('data-slot="extension-card-banner"');
  });
});

describe("italic overhang safe-area (cinatra#2409)", () => {
  const shellProps = {
    variant: "listing" as const,
    name: "Auditor Agent",
    accentColor: "plum" as const,
    emblem: <SquareEmblem />,
    description: "Audits agent runs.",
  };

  const nameDiv = (html: string) =>
    html.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0] ?? "";

  it("guards the badge-less clamped italic name with the safe-area utility", () => {
    // `line-clamp-2` is an `overflow: hidden` box; without the safe-area the
    // final right-leaning italic glyph ("Auditor Agen*t*") is clipped.
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    expect(nameDiv(html)).toContain("italic-overhang-safe");
    expect(nameDiv(html)).not.toContain("pr-20");
  });

  it("lets the badge reservation (a superset safe-area) supersede the utility", () => {
    // With badges the name reserves `pr-20` for the overlay — 80px of trailing
    // padding already keeps every line's last glyph clear of the clip edge, so
    // exactly one of the two paddings applies (no specificity race).
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} badges={<span data-testid="badge" />} />,
    );
    expect(nameDiv(html)).toContain("pr-20");
    expect(nameDiv(html)).not.toContain("italic-overhang-safe");
  });

  it("defines the utility as a zero-layout-shift pad/margin pair, mirrored app <-> design package", () => {
    const globals = readFileSync(
      join(__dirname, "..", "..", "app", "globals.css"),
      "utf8",
    );
    const designUtilities = readFileSync(
      join(__dirname, "..", "..", "..", "packages", "design", "src", "utilities.css"),
      "utf8",
    );

    const appUtility = globals.match(
      /@utility italic-overhang-safe \{[\s\S]*?\n\}/,
    )?.[0];
    const designClass = designUtilities.match(
      /\.italic-overhang-safe \{[\s\S]*?\n\}/,
    )?.[0];
    expect(appUtility).toBeTruthy();
    expect(designClass).toBeTruthy();

    // The pad reserves clip room; the EQUAL negative margin hands the space
    // back to the layout, so alignment and wrap points cannot shift. Read the
    // two values instead of restating them — they are ONE decision.
    const readPair = (css: string) => {
      const pad = css.match(/padding-inline-end:\s*([0-9.]+em)/)?.[1];
      const margin = css.match(/margin-inline-end:\s*-([0-9.]+em)/)?.[1];
      return { pad, margin };
    };
    const app = readPair(appUtility!);
    const design = readPair(designClass!);
    expect(app.pad).toBeTruthy();
    expect(app.pad).toBe(app.margin);
    // The design-package mirror carries the identical pair (SDK consumers get
    // the same treatment the app compiles via Tailwind).
    expect(design).toEqual(app);
  });

  it("pins the sdk-ui card's line-clamp-3 variant to the same treatment", () => {
    const sdkUiSrc = readFileSync(
      join(__dirname, "..", "..", "..", "packages", "sdk-ui", "src", "extension-card.tsx"),
      "utf8",
    );
    expect(sdkUiSrc).toMatch(
      /badges \? "pr-20" : "italic-overhang-safe"/,
    );
  });
});
