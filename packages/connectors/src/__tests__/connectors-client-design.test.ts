/**
 * ConnectorsClient — design-system contract test.
 *
 * Like the other component tests in this repo, this is a source-file assertion
 * suite (@testing-library/react isn't available; the root vitest env is "node").
 * It locks the design-system decisions for the connectors grid:
 *
 *   #604  the Connected/Disconnected toggle uses the design-system toggle-group
 *         spec — single outer hairline border + hairline dividers, no gaps,
 *         7px radius, slate (muted-foreground) rest content — NOT the generic
 *         shadcn `outline` variant (grey accent fill on a grey ground).
 *   #605  connection state renders as a plug icon (green PlugZap when connected,
 *         red Unplug when not) instead of a text StatusPill, keeping the
 *         connectedLabel count alongside the green plug when one is provided.
 *   #606  the Cinatra mark in connector cards renders in brand mustard
 *         (text-brand-mustard) rather than the default ink foreground.
 *   #681  the toolbar carries a trailing "+ Connector" button linking to the
 *         marketplace pre-filtered to connectors (?tab=connector).
 *   #682  the per-card connection-state indicator is a state-coloured BACKGROUND
 *         badge (design-system Badge `success`/`destructive` variants) wrapping
 *         the #605 plug icon (+ count).
 *   #683  the toggle items lead with the card plug glyphs and the second item
 *         reads "Disconnected" (the persisted `available` value is unchanged).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "connectors-client.tsx"),
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

    it("renders rest segments in slate (muted-foreground)", () => {
      expect(SRC).toContain("text-muted-foreground");
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

    it("renders the connected plug in a success-variant badge", () => {
      // The connected branch is a <Badge variant="success"> wrapping <PlugZap>
      // (the success variant carries bg-success/10 text-success; see #682).
      expect(SRC).toMatch(/variant="success"[\s\S]*?<PlugZap\b/);
    });

    it("renders the disconnected plug in a destructive-variant badge", () => {
      // The disconnected branch is a <Badge variant="destructive"> wrapping
      // <Unplug> (bg-destructive/10 text-destructive; see #682).
      expect(SRC).toMatch(/variant="destructive"[\s\S]*?<Unplug\b/);
    });

    it("keeps the connectedLabel count alongside the connected plug", () => {
      // label is rendered inside the connected branch (after the plug icon)
      expect(SRC).toMatch(/<PlugZap[\s\S]*?\{label \? <span/);
    });
  });

  describe("#606 Cinatra mark renders in brand mustard", () => {
    it("applies the text-brand-mustard token to CinatraLogo in the card", () => {
      expect(SRC).toMatch(/<CinatraLogo[^>]*text-brand-mustard/);
    });
  });

  describe("#682 per-card connection state is a coloured-background badge", () => {
    it("uses the design-system Badge component", () => {
      expect(SRC).toContain('from "@/components/ui/badge"');
      expect(SRC).toMatch(/<Badge\b/);
    });

    it("renders the connected state as a green/success-background badge", () => {
      // The success variant resolves to bg-success/10 text-success — a
      // state-coloured background, not a bare text-only indicator.
      expect(SRC).toMatch(/<Badge[^>]*variant="success"/);
    });

    it("renders the disconnected state as a red/destructive-background badge", () => {
      expect(SRC).toMatch(/<Badge[^>]*variant="destructive"/);
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

  describe("#681 toolbar carries a trailing + Connector action", () => {
    it("renders a Button-as-Link to the connector-filtered marketplace", () => {
      expect(SRC).toContain('from "next/link"');
      expect(SRC).toMatch(/<Link href="\/configuration\/marketplace\?tab=connector"/);
    });

    it("labels the action 'Connector' with a leading Plus icon", () => {
      expect(SRC).toMatch(/<Plus[\s\S]*?Connector/);
    });
  });
});
