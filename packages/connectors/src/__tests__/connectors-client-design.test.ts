/**
 * ConnectorsClient — design-system contract test.
 *
 * Like the other component tests in this repo, this is a source-file assertion
 * suite (@testing-library/react isn't available; the root vitest env is "node").
 * It locks the design-system decisions for the connectors grid:
 *
 *   #604  the Connected/Disconnected toggle uses the design-system toggle-group
 *         spec — single outer hairline border + hairline dividers, no gaps,
 *         7px radius — NOT the generic shadcn `outline` variant (grey accent
 *         fill on a grey ground).
 *   #605  connection state renders as a plug icon (green PlugZap when connected,
 *         red Unplug when not) instead of a text StatusPill, keeping the
 *         connectedLabel count alongside the green plug when one is provided.
 *   #606  the Cinatra mark in connector cards renders in brand mustard
 *         (text-brand-mustard) rather than the default ink foreground.
 *   #681  the toolbar carries a "+ Connector" button linking to the
 *         marketplace pre-filtered to connectors (?tab=connector).
 *   #682  the per-card connection-state indicator is a state-coloured BACKGROUND
 *         badge (design-system Badge `success`/`destructive` variants) wrapping
 *         the #605 plug icon (+ count).
 *   #683  the toggle items lead with the card plug glyphs and the second item
 *         reads "Disconnected" (the persisted `available` value is unchanged).
 *   #1014 (design system §VII "Connectors") the toolbar reorders to filter →
 *         search → scope → +Connector (hairline dividers on both sides) →
 *         spacer → sort (far right); the search placeholder renames to
 *         "Search connectors" and gains a ✕ clear button; each segmented-toggle
 *         item carries its OWN semantic status colour at all times (soft tint
 *         idle, solid + white text/icon selected) instead of the previous grey
 *         idle / indigo-primary selected treatment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "connectors-client.tsx"),
  "utf8",
);

// The connection-status badge was EXTRACTED into the shared
// `connector-badge.tsx` (consumed by both the card grid here and the
// host-injected setup-page header). The #605/#682 badge-shape assertions now
// read the shared component source; the toggle / +Connector / mustard
// assertions stay on `connectors-client.tsx` (`SRC`).
const BADGE_SRC = readFileSync(
  join(__dirname, "..", "connector-badge.tsx"),
  "utf8",
);

describe("ConnectorsClient design-system contract", () => {
  it("is a client component", () => {
    expect(SRC.startsWith('"use client"')).toBe(true);
  });

  describe("#604 Connected/Available toggle matches the toggle-group spec", () => {
    it("does not apply the generic shadcn outline toggle variant", () => {
      // The <ToggleGroup …> opening tag must not carry variant="outline" (the
      // grey-accent-on-grey treatment the spec replaces). Scope the check to
      // the ToggleGroup element so the unrelated sort <Button variant="outline">
      // is not mistaken for it.
      const openTag = SRC.match(/<ToggleGroup\b[\s\S]*?>/);
      expect(openTag).not.toBeNull();
      expect(openTag![0]).not.toMatch(/variant\s*=\s*"outline"/);
    });

    it("composes a single outer hairline border with 7px radius and no gaps", () => {
      expect(SRC).toContain("rounded-[7px]");
      expect(SRC).toContain("border border-line");
      // hairline dividers between segments (every item after the first)
      expect(SRC).toContain("[&>*:not(:first-child)]:border-l");
    });

    it("cinatra#1014: no longer renders rest (idle) segments in slate — each keeps its own status colour", () => {
      const groupStart = SRC.indexOf("<ToggleGroup");
      const groupEnd = SRC.indexOf("</ToggleGroup>") + "</ToggleGroup>".length;
      const toggleBlock = SRC.slice(groupStart, groupEnd);
      expect(toggleBlock).not.toContain("text-muted-foreground");
    });
  });

  describe("#605 connection state is a plug icon, not a StatusPill", () => {
    it("no longer imports or renders the StatusPill component", () => {
      // No import of the status-pill module and no <StatusPill …> element.
      expect(SRC).not.toMatch(/from\s+"@\/components\/ui\/status-pill"/);
      expect(SRC).not.toMatch(/<StatusPill\b/);
    });

    it("uses the lucide plug icons", () => {
      expect(SRC).toContain("PlugZap");
      expect(SRC).toContain("Unplug");
    });

    it("renders the connected plug in a SOLID success-variant badge (cinatra#1014)", () => {
      // The connected branch is a <Badge variant="success"> wrapping <PlugZap>,
      // with a className override (bg-success/text-success-foreground) making
      // it a filled solid chip rather than the variant's default soft tint
      // (see #682 / #1014). The badge now lives in the shared connector-badge.tsx.
      expect(BADGE_SRC).toMatch(/variant="success"[\s\S]*?<PlugZap\b/);
      expect(BADGE_SRC).toContain("bg-success text-success-foreground");
    });

    it("renders the disconnected plug in a SOLID destructive-variant badge (cinatra#1014)", () => {
      // The disconnected branch is a <Badge variant="destructive"> wrapping
      // <Unplug>, overridden to a filled bg-destructive + white text chip.
      expect(BADGE_SRC).toMatch(/variant="destructive"[\s\S]*?<Unplug\b/);
      expect(BADGE_SRC).toContain("bg-destructive text-destructive-foreground");
    });

    it("keeps the connectedLabel count alongside the connected plug", () => {
      // label is rendered inside the connected branch (after the plug icon)
      expect(BADGE_SRC).toMatch(/<PlugZap[\s\S]*?\{label \? <span/);
    });
  });

  describe("#606 Cinatra mark renders in brand mustard", () => {
    it("applies the text-brand-mustard token to CinatraLogo in the card", () => {
      expect(SRC).toMatch(/<CinatraLogo[^>]*text-brand-mustard/);
    });
  });

  describe("#682 per-card connection state is a coloured-background badge", () => {
    // The badge component is shared (connector-badge.tsx); the card grid
    // imports it rather than defining the Badge inline.
    it("the card grid consumes the shared ConnectorBadge component", () => {
      expect(SRC).toContain('from "./connector-badge"');
      expect(SRC).toMatch(/<ConnectorBadge\b/);
    });

    it("threads each card's live connection state + count into the badge", () => {
      // Lock the per-card wiring, not just the element: a regression that
      // hardcoded `connected={true}` (or dropped the count) would still import
      // and render <ConnectorBadge> but break the card's real status.
      expect(SRC).toMatch(
        /<ConnectorBadge\s+connected=\{connector\.connected\}\s+label=\{connector\.connectedLabel\}\s*\/>/,
      );
    });

    it("uses the design-system Badge component", () => {
      expect(BADGE_SRC).toContain('from "@/components/ui/badge"');
      expect(BADGE_SRC).toMatch(/<Badge\b/);
    });

    it("renders the connected state as a SOLID green/success-background badge (cinatra#1014)", () => {
      // The className override resolves to a FILLED bg-success + white
      // text-success-foreground — not the variant's default soft bg-success/10
      // tint (the shared badge.tsx primitive itself is untouched — it is
      // vendored into 5 extension repos).
      expect(BADGE_SRC).toMatch(/<Badge[^>]*variant="success"[^>]*bg-success text-success-foreground/);
    });

    it("renders the disconnected state as a SOLID red/destructive-background badge (cinatra#1014)", () => {
      expect(BADGE_SRC).toMatch(/<Badge[^>]*variant="destructive"[^>]*bg-destructive text-destructive-foreground/);
    });
  });

  describe("#683 toggle items carry plug glyphs and the Disconnected label", () => {
    it("renames the second toggle option from Available to Disconnected", () => {
      expect(SRC).not.toContain(">\n              Available\n");
      expect(SRC).toContain("Disconnected");
    });

    it("keeps the persisted filter value 'available' for back-compat", () => {
      // The visible label changed but the stored key / filter semantics did not.
      expect(SRC).toMatch(/value="available"/);
      expect(SRC).toContain('"cinatra:connectors:filter"');
    });

    it("leads each toggle item with the matching card plug glyph", () => {
      // connected item → PlugZap before the label; disconnected → Unplug.
      expect(SRC).toMatch(/value="connected"[\s\S]*?<PlugZap[\s\S]*?Connected/);
      expect(SRC).toMatch(/value="available"[\s\S]*?<Unplug[\s\S]*?Disconnected/);
    });
  });

  describe("#681 toolbar carries a + Connector action", () => {
    it("renders a Button-as-Link to the connector-filtered marketplace", () => {
      expect(SRC).toContain('from "next/link"');
      expect(SRC).toMatch(/<Link href="\/configuration\/marketplace\?tab=connector"/);
    });

    it("labels the action 'Connector' with a leading Plus icon", () => {
      expect(SRC).toMatch(/<Plus[\s\S]*?Connector/);
    });
  });

  describe("cinatra#1014 — toolbar reorder + search rename/clear + segmented-toggle colours (design system §VII)", () => {
    it("orders the toolbar: filter leads → search → scope → +Connector → spacer → sort (far right)", () => {
      const toggleIdx = SRC.indexOf("<ToggleGroup");
      const searchIdx = SRC.indexOf('placeholder="Search connectors"');
      const scopeIdx = SRC.indexOf("<ScopeFilterCombobox");
      const connectorIdx = SRC.indexOf('href="/configuration/marketplace?tab=connector"');
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');
      const sortIdx = SRC.indexOf("<SlidersHorizontal");

      for (const idx of [toggleIdx, searchIdx, scopeIdx, connectorIdx, spacerIdx, sortIdx]) {
        expect(idx).toBeGreaterThan(-1);
      }
      expect(toggleIdx).toBeLessThan(searchIdx);
      expect(searchIdx).toBeLessThan(scopeIdx);
      expect(scopeIdx).toBeLessThan(connectorIdx);
      expect(connectorIdx).toBeLessThan(spacerIdx);
      expect(spacerIdx).toBeLessThan(sortIdx);
    });

    it("flanks the + Connector action with a hairline ToolbarSeparator on both sides", () => {
      const scopeIdx = SRC.indexOf("<ScopeFilterCombobox");
      const sepBeforeIdx = SRC.indexOf("<ToolbarSeparator />", scopeIdx);
      const connectorIdx = SRC.indexOf('href="/configuration/marketplace?tab=connector"');
      const sepAfterIdx = SRC.indexOf("<ToolbarSeparator />", connectorIdx);
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');

      expect(sepBeforeIdx).toBeGreaterThan(scopeIdx);
      expect(sepBeforeIdx).toBeLessThan(connectorIdx);
      expect(sepAfterIdx).toBeGreaterThan(connectorIdx);
      expect(sepAfterIdx).toBeLessThan(spacerIdx);
    });

    it("also flanks the flex-1 spacer with a hairline ToolbarSeparator before the sort control (matches the design repo's §VII reference markup)", () => {
      // design/specs/app.html's §VII example divides EVERY toolbar gap,
      // including both sides of the spacer — not just around +Connector.
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');
      const sortIdx = SRC.indexOf("<SlidersHorizontal");
      const sepAfterSpacerIdx = SRC.indexOf("<ToolbarSeparator />", spacerIdx);

      expect(sepAfterSpacerIdx).toBeGreaterThan(spacerIdx);
      expect(sepAfterSpacerIdx).toBeLessThan(sortIdx);
    });

    it("renames the search placeholder to 'Search connectors'", () => {
      expect(SRC).toContain('placeholder="Search connectors"');
      expect(SRC).not.toContain("Filter connectors...");
    });

    it("shows a ✕ clear button on the toolbar search only while it holds a query", () => {
      expect(SRC).toMatch(/searchTerm \? \(/);
      expect(SRC).toMatch(/onClick=\{\(\) => setSearchTerm\(""\)\}/);
      expect(SRC).toContain('aria-label="Clear search"');
    });

    it("gives each segmented-toggle item its own semantic status colour at idle (soft tint), never grey", () => {
      const groupStart = SRC.indexOf("<ToggleGroup");
      const groupEnd = SRC.indexOf("</ToggleGroup>") + "</ToggleGroup>".length;
      const toggleBlock = SRC.slice(groupStart, groupEnd);
      // `(?!-)` after the token guards against a regression that dropped the
      // idle `text-success`/`text-destructive` class and left only the
      // selected `-foreground` variant — `-` alone satisfies a bare `\b`.
      expect(toggleBlock).toMatch(/value="connected"[\s\S]*?bg-success\/10[\s\S]*?text-success(?!-)\b/);
      expect(toggleBlock).toMatch(/value="available"[\s\S]*?bg-destructive\/10[\s\S]*?text-destructive(?!-)\b/);
    });

    it("uses the SOLID status colour + white text/icon on the selected segment, not primary/indigo", () => {
      expect(SRC).toContain("data-[state=on]:bg-success");
      expect(SRC).toContain("data-[state=on]:text-success-foreground");
      expect(SRC).toContain("data-[state=on]:bg-destructive");
      expect(SRC).toContain("data-[state=on]:text-destructive-foreground");
      expect(SRC).not.toMatch(/data-\[state=on\]:bg-primary\b/);
      expect(SRC).not.toMatch(/data-\[state=on\]:text-primary\b/);
    });
  });
});
