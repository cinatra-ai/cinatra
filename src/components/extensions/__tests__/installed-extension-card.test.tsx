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
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
  UpdateAvailableChip,
} from "../installed-extension-card";
import { Button } from "@/components/ui/button";
import { ACCENT_PALETTE } from "@/lib/extension-accent";
import { resolveVendorPresentation, type VendorPresentation } from "@/lib/vendor-presentation";
import type { ExtensionSourceLabel } from "@cinatra-ai/extensions/screens/extension-source-label";

// cinatra#1528: VendorPresentation is BRANDED — only resolveVendorPresentation
// mints one, so these render tests build their `known` fixtures through the
// resolver instead of hand-forging a `{ kind: "known", … }` literal (which no
// longer type-checks). A `known` resolution never logs, so no console spy here.
function knownVendor(displayName: string, storeUrl: string | null = null): VendorPresentation {
  return resolveVendorPresentation(
    { name: displayName, storeUrl },
    { surface: "installed-extension-card-test", ref: displayName },
  );
}

function render(archived: boolean): string {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name="Web Research Agent"
      accentColor="green"
      emblem={<svg data-testid="emblem" />}
      kindIcon={<svg data-testid="kind-icon" />}
      kindLabel="Agent"
      vendor={knownVendor("cinatra-ai")}
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
        vendor={knownVendor("Cinatra")}
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

describe("InstalledExtensionCard — §III/§IV vendor byline contract (cinatra#1528)", () => {
  function renderVendor(vendor: VendorPresentation): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="Web Research Agent"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindIcon={<svg data-testid="kind-icon" />}
        kindLabel="Agent"
        vendor={vendor}
        description="Stateless schema-driven web research enricher."
        actions={<Button type="button">Run</Button>}
      />,
    );
  }

  /** The EXACT visible text inside the byline vendor-label node. */
  function vendorLabel(html: string): string | undefined {
    return html.match(/data-slot="installed-extension-vendor-label"[^>]*>([^<]*)</)?.[1];
  }

  it("renders a known vendor's display name after the localized connective", () => {
    const html = renderVendor(knownVendor("Distinct Vendor Name"));
    expect(vendorLabel(html)).toBe("Distinct Vendor Name");
    expect(html).toContain(" by ");
  });

  it("renders the missing-vendor placeholder (never a silently dropped clause) for the missing state", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = renderVendor(
      resolveVendorPresentation({ name: "" }, { surface: "installed-extension-card-test", ref: "missing" }),
    );
    expect(vendorLabel(html)).toBe("Unknown vendor");
    // The "{Kind} by {Vendor}" clause is ALWAYS present — the pre-1528 silent
    // omission (the byline dropped entirely when the vendor was falsy) is gone.
    expect(html).toContain(" by ");
  });

  it("renders the placeholder when the vendor prop is omitted (defensive default, never a slug)", () => {
    const html = renderToStaticMarkup(
      <InstalledExtensionCard
        name="Web Research Agent"
        accentColor="green"
        emblem={<svg />}
        kindLabel="Agent"
        description="x"
      />,
    );
    expect(vendorLabel(html)).toBe("Unknown vendor");
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
        vendor={knownVendor("Cinatra")}
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

// ---------------------------------------------------------------------------
// §III update affordance (cinatra#1041 outcome 3): the "Update available"
// chip, the ABI-incompatible greyed spec line, and the fail-quiet /
// up-to-date states that add nothing. The chip is the ONLY update information
// the card carries (owner direction 2026-07-12): NO explanatory update text —
// "Newer version needs a newer Cinatra" / "No registry version to compare"
// live on the §V settings page's Maintenance · Update row, and their ABSENCE
// from the card is pinned below.
// ---------------------------------------------------------------------------

function renderWithUpdate(over: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name="Web Research Agent"
      accentColor="green"
      emblem={<svg data-testid="emblem" />}
      kindLabel="Agent"
      description="Stateless schema-driven web research enricher."
      version="0.4.2"
      status={<span data-testid="status-slot">status</span>}
      actions={<Button type="button">More details</Button>}
      {...over}
    />,
  );
}

// ---------------------------------------------------------------------------
// §VI InstalledStatusIndicator — the three lifecycle glyphs (cinatra#1570).
// The reported bug: a LOCKED (system-live) row rendered the SAME green check
// as an Active row, so the two were indistinguishable but for the text label.
// The fix gives locked its own green LOCK glyph (it IS live → still green),
// distinct from the active check; archived keeps its muted cross. These pins
// fail loudly if locked ever silently re-shares the active check again, and
// guard that the active/archived glyphs are untouched.
// ---------------------------------------------------------------------------
describe("InstalledStatusIndicator — §VI lifecycle glyphs (cinatra#1570)", () => {
  const render = (status: "active" | "locked" | "archived") =>
    renderToStaticMarkup(<InstalledStatusIndicator status={status} />);

  it("active → a green check, labelled Active, with no lock and no system tooltip", () => {
    const html = render("active");
    expect(html).toContain('data-status="active"');
    expect(html).toContain("lucide-check");
    expect(html).not.toContain("lucide-lock");
    expect(html).toContain("text-success");
    expect(html).not.toContain("text-muted-foreground");
    expect(html).toContain(">Active<");
    expect(html).not.toContain("title=");
  });

  it("locked → a green LOCK, labelled Locked, distinct from the active check (the #1570 fix)", () => {
    const html = render("locked");
    expect(html).toContain('data-status="locked"');
    // Its own glyph — the lock, NEVER the active row's check.
    expect(html).toContain("lucide-lock");
    expect(html).not.toContain("lucide-check");
    // Still green: a system extension is live.
    expect(html).toContain("text-success");
    expect(html).not.toContain("text-muted-foreground");
    // Label + the system tooltip are retained unchanged.
    expect(html).toContain(">Locked<");
    expect(html).toContain(
      'title="System extension — always active; cannot be archived or uninstalled."',
    );
  });

  it("archived → a muted cross, labelled Archived (untouched by the lock branch)", () => {
    const html = render("archived");
    expect(html).toContain('data-status="archived"');
    expect(html).toContain("lucide-x");
    expect(html).not.toContain("lucide-lock");
    expect(html).not.toContain("lucide-check");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-success");
    expect(html).toContain(">Archived<");
  });

  it("every status keeps the canonical badge kicker treatment (named tokens only)", () => {
    for (const status of ["active", "locked", "archived"] as const) {
      const html = render(status);
      expect(html).toContain("font-mono");
      expect(html).toContain("text-badge-2xs");
      expect(html).toContain("uppercase");
    }
  });
});

describe("UpdateAvailableChip (§III blue action-accent chip)", () => {
  it("renders the status-indicator badge treatment in the --info blue accent with a data-status hook", () => {
    const html = renderToStaticMarkup(<UpdateAvailableChip />);
    expect(html).toContain('data-slot="status-indicator"');
    expect(html).toContain('data-status="update-available"');
    expect(html).toContain("Update available");
    // Blue action accent = --info token, NOT the green success used by Active.
    expect(html).toContain("text-info");
    expect(html).not.toContain("text-success");
    // Reuses the canonical badge kicker (named tokens, no arbitrary utilities).
    expect(html).toContain("text-badge-2xs");
  });
});

describe("InstalledExtensionCard — §III spec-line update states", () => {
  it("update-available: the chip renders on the spec line; the line is NOT greyed", () => {
    const html = renderWithUpdate({ updateChip: <UpdateAvailableChip /> });
    expect(html).toContain('data-slot="installed-extension-spec-line"');
    expect(html).toContain('data-status="update-available"');
    expect(html).not.toContain("opacity-55");
    expect(html).not.toContain('data-slot="installed-update-note"');
  });

  it("incompatible: the spec line greys (opacity-55) with NO chip and NO explanatory text", () => {
    const html = renderWithUpdate({ specLineMuted: true });
    expect(html).toContain("opacity-55");
    expect(html).not.toContain('data-status="update-available"');
    // The wording lives on the §V settings page, never in the card.
    expect(html).not.toContain("Newer version needs a newer Cinatra");
    expect(html).not.toContain('data-slot="installed-update-note"');
  });

  it("non-comparable / up-to-date / fail-quiet: no update props → spec line is byte-unchanged (no chip, no text, no greying)", () => {
    const html = renderWithUpdate({});
    expect(html).toContain('data-slot="installed-extension-spec-line"');
    expect(html).not.toContain('data-status="update-available"');
    expect(html).not.toContain("No registry version to compare");
    expect(html).not.toContain('data-slot="installed-update-note"');
    expect(html).not.toContain("opacity-55");
  });

  it("the card carries at most the Update-available chip — no state renders explanatory update text (§III)", () => {
    for (const over of [
      { updateChip: <UpdateAvailableChip /> },
      { specLineMuted: true },
      {},
    ]) {
      const html = renderWithUpdate(over as Record<string, unknown>);
      expect(html).not.toContain("Newer version needs a newer Cinatra");
      expect(html).not.toContain("No registry version to compare");
      expect(html).not.toContain('data-slot="installed-update-note"');
    }
  });
});

// ---------------------------------------------------------------------------
// §III description-survives-every-update-state (owner review 2026-07-10,
// PR #1310: "Description text missing — as per spec, max 2 lines").
//
// The owner's screenshots came from an ad-hoc gallery seed whose synthetic
// connector rows carried a NULL native description (installed-rows hydrates the
// description from per-kind native descriptors, not the DB seed), so the card's
// `{description && …}` guard correctly rendered nothing. The card + screen code
// was already correct. These invariants pin that contract so the update-chip
// wiring can never DISPLACE or DROP the description element in any chip state:
// the two-line-clamped description paragraph must render alongside the chip,
// the greyed incompatible line, AND the empty state.
// ---------------------------------------------------------------------------
describe("InstalledExtensionCard — §III description survives every update-chip state", () => {
  const DESCRIPTION = "Stateless schema-driven web research enricher.";

  // The description <p> is the ONLY paragraph carrying the description copy —
  // extract it specifically (the banner's italic NAME has its own title clamp).
  function descriptionParagraph(html: string): string | undefined {
    return html.match(/<p class="[^"]*">[^<]*<\/p>/)?.[0];
  }

  const STATES: Array<[string, Record<string, unknown>]> = [
    ["update-available (blue chip)", { updateChip: <UpdateAvailableChip /> }],
    ["incompatible (greyed spec line, no text)", { specLineMuted: true }],
    ["non-comparable / up-to-date / fail-quiet (no chip)", {}],
  ];

  for (const [label, over] of STATES) {
    it(`renders the 2-line-clamped description in the ${label} state`, () => {
      const html = renderWithUpdate(over);
      const paragraph = descriptionParagraph(html);
      // Presence: the description text is actually in the DOM (not dropped by
      // the chip wiring) …
      expect(paragraph).toBeDefined();
      expect(html).toContain(DESCRIPTION);
      // … as the muted description paragraph, clamped to exactly 2 lines (§III).
      expect(paragraph).toContain(DESCRIPTION);
      expect(paragraph).toContain("text-muted-foreground");
      expect(paragraph).toContain("line-clamp-2");
      expect(paragraph).not.toContain("line-clamp-3");
    });
  }
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
        vendor={knownVendor("Cinatra")}
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
        vendor={knownVendor("Cinatra")}
        description="Builds and enriches lead lists."
        actions={<Button type="button">Run</Button>}
      />,
    );
    // Passing an absent/omitted `configurationNeeds` is byte-identical to never
    // passing it — a non-affected card is untouched.
    expect(withProp).toBe(withoutProp);
  });

  // ── main-parity guard (owner review 2026-07-10, cinatra#1234) ─────────────
  // The §III ACTIVE and ARCHIVED cards are already fixed per the design spec
  // (#1273). cinatra#1057 must ADD ONLY the needs-review state — it may NOT
  // restructure the active/archived card. These pins fail loudly if the layout
  // row is ever moved off the card element (a wrapper regression) for those
  // two states.
  const ROW_ON_CARD =
    "flex flex-col overflow-hidden rounded-card border border-line bg-surface-strong shadow-sm md:flex-row md:items-stretch";
  const CARD_AS_COLUMN =
    "flex flex-col overflow-hidden rounded-card border border-line bg-surface-strong shadow-sm\"";
  const INNER_ROW_WRAPPER = "flex flex-col md:flex-row md:items-stretch";

  it("active card carries the flex row on the card element itself — no layout wrapper (main-parity)", () => {
    const html = render(false);
    expect(html).toContain(ROW_ON_CARD);
    expect(html).not.toContain(INNER_ROW_WRAPPER);
    expect(html).not.toContain("data-needs-review");
  });

  it("archived card is likewise a single flex row on the card element (main-parity)", () => {
    const html = render(true);
    expect(html).toContain(ROW_ON_CARD);
    expect(html).not.toContain(INNER_ROW_WRAPPER);
  });

  it("needs-review card (and ONLY it) moves the row into an inner wrapper, card element becomes a column", () => {
    const html = renderNeedsReview(NEEDS);
    // The card element is a column (no row utilities on it)…
    expect(html).toContain(CARD_AS_COLUMN);
    expect(html).not.toContain(ROW_ON_CARD);
    // …with the three panels kept in their own inner row so the strip can span
    // the full width beneath them.
    expect(html).toContain(INNER_ROW_WRAPPER);
  });
});

// ── §VI byline source indicator (cinatra#1572) ──────────────────────────────
// The source indicator renders as its OWN byline element, INDEPENDENT of the
// #1528 vendor presentation: it sits alongside the resolved vendor (a
// missing-vendor placeholder never suppresses it) and is omitted entirely for
// non-§VI callers. `vendor` is the branded VendorPresentation contract (#1528),
// so these fixtures build a `known` vendor through `knownVendor` and OMIT it to
// exercise the missing-vendor placeholder path (the card reads the discriminated
// prop directly, so an omitted vendor logs nothing).
describe("InstalledExtensionCard — byline source indicator (cinatra#1572)", () => {
  const marketplaceSource: ExtensionSourceLabel = {
    kind: "marketplace",
    label: "from marketplace",
    tooltip: "Origin classified from the configured marketplace registry identity.",
  };
  const unknownSource: ExtensionSourceLabel = {
    kind: "unknown",
    label: "source unknown",
    tooltip: "This extension's origin could not be determined.",
  };

  function renderCard(props: {
    vendor?: VendorPresentation;
    source?: ExtensionSourceLabel;
  }): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="Web Research Agent"
        accentColor="green"
        emblem={<svg data-testid="emblem" />}
        kindLabel="Agent"
        vendor={props.vendor}
        source={props.source}
      />,
    );
  }

  it("renders the source as its OWN byline element carrying the semantic label + kind", () => {
    const html = renderCard({ vendor: knownVendor("Acme"), source: marketplaceSource });
    expect(html).toContain('data-slot="installed-extension-source-label"');
    expect(html).toContain('data-source-kind="marketplace"');
    expect(html).toContain("from marketplace");
    // The kind + vendor each remain their own element too (AC5).
    expect(html).toContain('data-slot="installed-extension-kind-label"');
    expect(html).toContain('data-slot="installed-extension-vendor-label"');
  });

  it("renders the source indicator independently of the vendor byline — a missing-vendor placeholder never suppresses it (AC2/AC5)", () => {
    // With the #1528 contract an absent vendor renders the localized placeholder
    // (not an omitted element); the source indicator must still render alongside
    // it, proving the source lane is independent of the vendor state.
    const html = renderCard({ source: marketplaceSource });
    expect(html).toContain('data-slot="installed-extension-vendor-label"');
    expect(html).toContain("Unknown vendor");
    expect(html).toContain('data-slot="installed-extension-source-label"');
    expect(html).toContain("from marketplace");
  });

  it("renders the neutral unknown state as its own element", () => {
    const html = renderCard({ source: unknownSource });
    expect(html).toContain('data-source-kind="unknown"');
    expect(html).toContain("source unknown");
  });

  it("omits the source element entirely when no source is provided (non-§VI callers unchanged)", () => {
    const html = renderCard({ vendor: knownVendor("Acme") });
    expect(html).not.toContain('data-slot="installed-extension-source-label"');
    expect(html).not.toContain("data-source-kind");
  });

  it("never renders a raw registryUrl — only the semantic label (AC5b)", () => {
    const html = renderCard({
      source: {
        kind: "instance",
        label: "from your instance",
        // A realistic tooltip; deliberately carries no host so the assertion
        // below isolates the URL-leak surface.
        tooltip: "Published to this instance's own local registry.",
      },
    });
    // The card is handed a semantic label object, never a URL — assert nothing
    // URL-shaped (a scheme, or a private host) leaked into the rendered byline.
    expect(html).toContain("from your instance");
    expect(html).not.toContain("://");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain(".invalid");
  });
});
