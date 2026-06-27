/**
 * ConnectorsClient — design-system contract test.
 *
 * Like the other component tests in this repo, this is a source-file assertion
 * suite (@testing-library/react isn't available; the root vitest env is "node").
 * It locks the three design-system decisions for the connectors grid:
 *
 *   #604  the Connected/Available toggle uses the design-system toggle-group
 *         spec — single outer hairline border + hairline dividers, no gaps,
 *         7px radius, slate (muted-foreground) rest content — NOT the generic
 *         shadcn `outline` variant (grey accent fill on a grey ground).
 *   #605  connection state renders as a plug icon (green PlugZap when connected,
 *         red Unplug when not) instead of a text StatusPill, keeping the
 *         connectedLabel count alongside the green plug when one is provided.
 *   #606  the Cinatra mark in connector cards renders in brand mustard
 *         (text-brand-mustard) rather than the default ink foreground.
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

    it("renders the connected plug in the success/sea-green token", () => {
      // A wrapping element carries text-success and contains the <PlugZap> icon.
      expect(SRC).toMatch(/text-success"[\s\S]*?<PlugZap\b/);
    });

    it("renders the disconnected plug in the failed/red token", () => {
      // A wrapping element carries text-destructive and contains the <Unplug> icon.
      expect(SRC).toMatch(/text-destructive"[\s\S]*?<Unplug\b/);
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
});
