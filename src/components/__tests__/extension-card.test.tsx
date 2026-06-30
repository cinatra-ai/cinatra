/**
 * ExtensionCard — marketplace listing-card banner (design spec §IV).
 *
 * Shell mode (the marketplace storefront tile) renders the §IV banner: the
 * 46×46 SQUARE icon tile + the human-readable name INSIDE the coloured banner,
 * with the icon resolving a hosted-URL → kind-emblem fallback chain. Button
 * mode (the §V running-agent chip) is unchanged and keeps its accessible name.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionCard } from "../extension-card";

const SquareEmblem = () => <svg data-testid="kind-emblem" />;

describe("ExtensionCard listing banner (§IV, shell mode, variant=listing)", () => {
  const shellProps = {
    variant: "listing" as const,
    name: "Research Assistant",
    accentColor: "indigo" as const,
    emblem: <SquareEmblem />,
    description: "Gathers sources and cites answers.",
  };

  it("renders the §IV banner: 96px coloured banner, 46×46 square icon tile, name in the banner", () => {
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    // Banner area present with the listing-card slot + min-height.
    expect(html).toContain('data-slot="extension-card-banner"');
    expect(html).toContain("min-h-[96px]");
    // Square icon tile (46×46, 11px radius), NOT the round 42px §V emblem pill.
    expect(html).toContain('data-slot="extension-card-icon"');
    expect(html).toContain("h-[46px]");
    expect(html).toContain("w-[46px]");
    expect(html).toContain("rounded-[11px]");
    // Name lives inside the banner (Archivo italic-800, 18px, line-clamp-3).
    expect(html).toContain('data-slot="extension-card-name"');
    expect(html).toContain("Research Assistant");
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("text-[18px]");
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
        accentColor="indigo"
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
