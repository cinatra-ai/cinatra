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
