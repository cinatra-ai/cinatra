/**
 * InstalledExtensionCard — archived §VI treatment (cinatra#957) + the
 * §VII "Agent card (All Agents)" derivation (cinatra#1007 / design#25).
 *
 * Invariants pinned here:
 *   - An ACTIVE card keeps its category colour: the banner carries the accent
 *     inline background and the icon tile inks the accent.
 *   - An ARCHIVED card renders fully greyed: no accent inline background on
 *     the banner (light-grey `muted` token ground instead), muted logo tile,
 *     muted byline text, and muted status/actions zones — while the actions
 *     stay rendered (Restore/Reinstall must remain operable).
 *   - Omitting `version`/`status` (the §VII Agent-card derivation) drops the
 *     whole version/status row from the DOM rather than rendering it empty.
 *   - The description clamps to 2 lines by default (§VI, cinatra#1005) and
 *     under an explicit `descriptionLineClamp={2}` (§VII).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InstalledExtensionCard } from "../installed-extension-card";
import { Button } from "@/components/ui/button";
import { ACCENT_PALETTE } from "@/lib/extension-accent";

function render(archived: boolean): string {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name="Web Research Agent"
      accentColor="green"
      emblem={<svg data-testid="emblem" />}
      kindIcon={<svg data-testid="kind-icon" />}
      kindLabel="Agent"
      vendor="cinatra-ai"
      description="Stateless schema-driven web research enricher."
      version="dev / abc1234"
      status={<span data-testid="status-slot">status</span>}
      actions={<Button type="button">Restore</Button>}
      archived={archived}
    />,
  );
}

describe("InstalledExtensionCard — §VI archived treatment", () => {
  it("active card keeps the category colour (accent inline ground, no data-archived)", () => {
    const html = render(false);
    expect(html).toContain(ACCENT_PALETTE.green.bg);
    expect(html).not.toContain("data-archived");
    expect(html).not.toContain('data-muted');
  });

  it("archived card is marked and drops the accent ground for the muted token", () => {
    const html = render(true);
    expect(html).toContain("data-archived");
    expect(html).toContain("data-muted");
    // The accent hex must not paint the archived banner or tile.
    expect(html).not.toContain(ACCENT_PALETTE.green.bg);
    expect(html).toContain("bg-muted");
  });

  it("archived card mutes byline text and status/actions zones", () => {
    const html = render(true);
    // kind label + vendor render muted, never foreground-strong.
    expect(html).not.toContain("text-foreground");
    expect(html).toContain("opacity-70");
  });

  it("archived card keeps its actions operable (rendered, merely muted)", () => {
    const html = render(true);
    expect(html).toContain(">Restore<");
  });

  it("active card renders byline in foreground and unmuted zones", () => {
    const html = render(false);
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("opacity-70");
  });
});

describe("InstalledExtensionCard — §VII Agent card (All Agents) derivation", () => {
  function renderAgentCard(): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="Research Assistant"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindIcon={<svg data-testid="kind-icon" />}
        kindLabel="Agent"
        vendor="Cinatra"
        description="Gathers sources, summarises, and cites answers grounded in your team's own documents."
        descriptionLineClamp={2}
        actions={<Button type="button">Run</Button>}
      />,
    );
  }

  it("omits the version/status row entirely when neither is passed", () => {
    const html = renderAgentCard();
    expect(html).not.toContain("font-mono text-xs text-muted-foreground");
    expect(html).not.toContain("data-testid=\"status-slot\"");
  });

  it("clamps the description to 2 lines under the explicit §VII prop", () => {
    const html = renderAgentCard();
    // The description <p> carries line-clamp-2. The banner's ITALIC NAME
    // (e.g. "Research Assistant") always renders line-clamp-3 regardless of
    // descriptionLineClamp — that's ExtensionCardListingBanner's own
    // (unrelated) title clamp, so assert on the description paragraph
    // specifically rather than the whole card's markup.
    const descriptionParagraph = html.match(/<p class="[^"]*">[^<]*<\/p>/)?.[0];
    expect(descriptionParagraph).toContain("line-clamp-2");
    expect(descriptionParagraph).not.toContain("line-clamp-3");
  });

  it("defaults to the 2-line clamp when descriptionLineClamp is not passed (§VI, cinatra#1005)", () => {
    const html = renderToStaticMarkup(
      <InstalledExtensionCard
        name="Web Research Agent"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindLabel="Agent"
        description="Stateless schema-driven web research enricher."
      />,
    );
    // Assert on the description <p> specifically — the banner's italic NAME
    // always renders its own (unrelated) line-clamp-3 title clamp.
    const descriptionParagraph = html.match(/<p class="[^"]*">[^<]*<\/p>/)?.[0];
    expect(descriptionParagraph).toContain("line-clamp-2");
    expect(descriptionParagraph).not.toContain("line-clamp-3");
  });

  it("still renders the Run action", () => {
    const html = renderAgentCard();
    expect(html).toContain(">Run<");
  });
});

describe("InstalledExtensionCard — accent-panel detail hotspot (cinatra#1121)", () => {
  function renderAccent(props: {
    accentDetailHref?: string;
    onAccentActivate?: () => void;
    accentLabel?: string;
    accentInert?: boolean;
  }): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="Research Assistant"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindLabel="Agent"
        vendor="Cinatra"
        description="Gathers sources, summarises, and cites answers."
        actions={<Button type="button">Run</Button>}
        {...props}
      />,
    );
  }

  // Extract just the accent panel's OPENING tag so tag/attr assertions target
  // the banner, not the whole card.
  function bannerTag(html: string): string {
    return (
      html.match(/<(a|div)\b[^>]*data-slot="extension-card-banner"[^>]*>/)?.[0] ??
      ""
    );
  }

  it("interactive accent renders the panel as a pointer-cursor detail anchor", () => {
    const html = renderAccent({
      accentDetailHref: "/configuration/marketplace/@scope/name",
      onAccentActivate: () => {},
      accentLabel: "View details for Research Assistant",
    });
    const banner = bannerTag(html);
    // A real anchor (keyboard-focusable; its href is the no-JS fallback).
    expect(banner.startsWith("<a")).toBe(true);
    expect(banner).toContain('href="/configuration/marketplace/@scope/name"');
    expect(banner).toContain('aria-haspopup="dialog"');
    expect(banner).toContain('aria-label="View details for Research Assistant"');
    expect(banner).toContain("data-accent-detail");
    // The reported bug was a text (I-beam) cursor; the fix is a pointer.
    expect(banner).toContain("cursor-pointer");
    // Focus ring painted INSIDE the panel (the card clips overflow).
    expect(banner).toContain("focus-visible:ring-inset");
    // The hover wash overlay renders only for the interactive accent.
    expect(html).toContain('data-slot="extension-card-accent-hover"');
  });

  it("inert accent (no listing) renders a non-anchor panel with a default cursor", () => {
    const html = renderAccent({ accentInert: true });
    const banner = bannerTag(html);
    expect(banner.startsWith("<div")).toBe(true);
    expect(banner).toContain("cursor-default");
    expect(banner).not.toContain("cursor-pointer");
    expect(banner).not.toContain("data-accent-detail");
    expect(banner).not.toContain("aria-haspopup");
    expect(html).not.toContain('data-slot="extension-card-accent-hover"');
  });

  it("default caller (no accent props) leaves the panel untouched — no cursor override, not an anchor", () => {
    const html = renderAccent({});
    const banner = bannerTag(html);
    // §VI installed-extensions + marketplace callers are byte-identical: a plain
    // presentational <div> with no cursor override added.
    expect(banner.startsWith("<div")).toBe(true);
    expect(banner).not.toContain("cursor-pointer");
    expect(banner).not.toContain("cursor-default");
    expect(banner).not.toContain("data-accent-detail");
  });
});

// cinatra#1057 — post-install "needs configuration" treatment. An active AGENT
// with unconfigured required connectors wears the greyed archived treatment and
// a needs-review status strip listing each connector's displayName, deep-linked
// to its setup page. The strip disappears + the card returns to active colours
// the moment all required connectors are configured (the caller stops passing
// `configurationNeeds`).
describe("InstalledExtensionCard — post-install needs-review strip", () => {
  const NEEDS = [
    {
      packageName: "@cinatra-ai/linkedin-oauth-connector",
      displayName: "LinkedIn",
      slug: "linkedin-oauth-connector",
      settingsHref: "/connectors/cinatra-ai/linkedin-oauth-connector/setup",
    },
    {
      packageName: "@cinatra-ai/apollo-connector",
      displayName: "Apollo",
      slug: "apollo-connector",
      settingsHref: "/connectors/cinatra-ai/apollo-connector/setup",
    },
  ];

  function renderNeedsReview(
    configurationNeeds: typeof NEEDS | undefined,
    accentColor: "green" = "green",
  ): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="List Curator Agent"
        accentColor={accentColor}
        emblem={<svg data-testid="emblem" />}
        kindIcon={<svg data-testid="kind-icon" />}
        kindLabel="Agent"
        vendor="Cinatra"
        description="Builds and enriches lead lists."
        actions={<Button type="button">Run</Button>}
        configurationNeeds={configurationNeeds}
      />,
    );
  }

  it("renders the strip listing each unconfigured connector's displayName + deep-link", () => {
    const html = renderNeedsReview(NEEDS);
    // The strip's conformance id + copy.
    expect(html).toContain('data-conformance="install-config-needs-callout"');
    expect(html).toContain("Set up connections first:");
    // Each connector's HUMAN-READABLE displayName is the label…
    expect(html).toContain(">LinkedIn<");
    expect(html).toContain(">Apollo<");
    // …deep-linked to its own setup page, tagged as the manifest.displayName field.
    expect(html).toContain('href="/connectors/cinatra-ai/linkedin-oauth-connector/setup"');
    expect(html).toContain('href="/connectors/cinatra-ai/apollo-connector/setup"');
    expect(html).toContain('data-field="manifest.displayName"');
  });

  it("flips the card into the greyed archived treatment (marks needs-review, mutes zones)", () => {
    const html = renderNeedsReview(NEEDS);
    // Distinct cannot-run marker — NOT the archived lifecycle marker.
    expect(html).toContain("data-needs-review");
    expect(html).not.toContain("data-archived");
    // Greyed treatment reused: muted mark + muted zones (opacity-70), and the
    // accent hex must not paint the greyed banner/tile.
    expect(html).toContain("data-muted");
    expect(html).toContain("opacity-70");
    expect(html).not.toContain(ACCENT_PALETTE.green.bg);
  });

  it("omits the strip and keeps the active treatment when nothing is unconfigured", () => {
    const html = renderNeedsReview(undefined);
    expect(html).not.toContain("install-config-needs-callout");
    expect(html).not.toContain("Set up connections first:");
    expect(html).not.toContain("data-needs-review");
    // Active card keeps its category colour and unmuted zones.
    expect(html).toContain(ACCENT_PALETTE.green.bg);
    expect(html).not.toContain("opacity-70");
  });

  it("treats an empty configurationNeeds array as nothing-to-configure (active card)", () => {
    const html = renderNeedsReview([]);
    expect(html).not.toContain("install-config-needs-callout");
    expect(html).not.toContain("data-needs-review");
    expect(html).toContain(ACCENT_PALETTE.green.bg);
  });

  it("leaves a non-affected extension's active card byte-identical (no strip, no greying)", () => {
    const withProp = renderNeedsReview(undefined);
    const withoutProp = renderToStaticMarkup(
      <InstalledExtensionCard
        name="List Curator Agent"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindIcon={<svg data-testid="kind-icon" />}
        kindLabel="Agent"
        vendor="Cinatra"
        description="Builds and enriches lead lists."
        actions={<Button type="button">Run</Button>}
      />,
    );
    // Passing an absent/omitted `configurationNeeds` is byte-identical to never
    // passing it — a non-affected card is untouched.
    expect(withProp).toBe(withoutProp);
  });
});
