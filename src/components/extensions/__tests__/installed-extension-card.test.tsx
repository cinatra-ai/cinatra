/**
 * InstalledExtensionCard — archived §III treatment (cinatra#957) + the
 * §IV "Agent card (All Agents)" derivation (cinatra#1007 / design#25) + the
 * design spec 0.5.0 byline relocation (cinatra#1246).
 *
 * Invariants pinned here:
 *   - An ACTIVE card keeps its category colour: the banner carries the accent
 *     inline background and the icon tile inks the accent.
 *   - 0.5.0 §III: the "{Kind} by {Vendor}" byline lives INSIDE the coloured
 *     banner (beneath the name), NOT in the white middle panel. It reads via
 *     `text-current` so it recolours to match the name — white on an active
 *     card, grey on the archived (muted) banner — and NEVER turns white on an
 *     archived card.
 *   - An ARCHIVED card renders fully greyed: no accent inline background on
 *     the banner (light-grey `muted` token ground instead), muted logo tile,
 *     muted byline text (grey preserved), and muted status/actions zones —
 *     while the actions stay rendered (Restore/Reinstall must remain operable).
 *   - Omitting `version`/`status` (the §IV Agent-card derivation) drops the
 *     whole version/status row from the DOM rather than rendering it empty.
 *   - The description clamps to 2 lines by default (§III, cinatra#1005) and
 *     under an explicit `descriptionLineClamp={2}` (§IV).
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

  it("archived card mutes the status/actions zones", () => {
    const html = render(true);
    expect(html).toContain("opacity-70");
  });

  it("archived card keeps its actions operable (rendered, merely muted)", () => {
    const html = render(true);
    expect(html).toContain(">Restore<");
  });

  // ── 0.5.0 §III byline relocation (cinatra#1246) ──────────────────────────

  it("renders the byline INSIDE the coloured banner, not the white middle panel", () => {
    const html = render(false);
    const bylineAt = html.indexOf('data-slot="installed-extension-byline"');
    const bannerAt = html.indexOf('data-slot="extension-card-banner"');
    // The middle panel is the justify-center white column that follows the banner.
    const middlePanelAt = html.indexOf("flex min-w-0 flex-1 flex-col justify-center");
    expect(bylineAt).toBeGreaterThan(-1);
    // byline sits between the banner opening and the middle panel → it's a
    // banner descendant, not a middle-panel child.
    expect(bylineAt).toBeGreaterThan(bannerAt);
    expect(bylineAt).toBeLessThan(middlePanelAt);
  });

  it("active byline reads white via text-current on the accent ground (never a hard-coded colour)", () => {
    const html = render(false);
    // The active banner container paints the white foreground inline…
    expect(html).toContain(`color:${ACCENT_PALETTE.green.fg}`);
    // …and the byline inherits it (text-current), so it recolours to match the
    // name rather than pinning its own token.
    const byline = html.match(
      /<div data-slot="installed-extension-byline"[^>]*>/,
    )?.[0];
    expect(byline).toContain("text-current");
    expect(byline).not.toContain("text-foreground");
    expect(byline).not.toContain("text-surface-strong");
  });

  it("archived byline stays GREY (no white-on-archived): text-current inherits the muted ground", () => {
    const html = render(true);
    // The archived banner drops the accent for the muted token ground…
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-muted-foreground");
    // …and the byline uses text-current (inherits the muted grey), never the
    // active card's white foreground hex — the known "white byline on the
    // archived card" failure class.
    const byline = html.match(
      /<div data-slot="installed-extension-byline"[^>]*>/,
    )?.[0];
    expect(byline).toContain("text-current");
    expect(byline).not.toContain(ACCENT_PALETTE.green.fg);
    expect(byline).not.toContain("text-surface-strong");
  });
});

describe("InstalledExtensionCard — §IV Agent card (All Agents) derivation", () => {
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
    // (e.g. "Research Assistant") always renders line-clamp-2 regardless of
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
    // always renders its own (unrelated) title clamp.
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
