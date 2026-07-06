/**
 * ConnectorBadge — shared connection-status badge contract.
 *
 * The badge was extracted from `connectors-client.tsx` into a SHARED component
 * so both the `/connectors` card grid AND the host-injected connector
 * setup-page header (the dispatch route `page.tsx`) render the SAME badge —
 * visual parity is structural, not copy-paste. Like the other connectors-package
 * tests this is a source-text assertion suite (the root vitest env is "node";
 * no DOM render), locking the design-system decisions the badge carries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(join(__dirname, "..", "connector-badge.tsx"), "utf8");
const BADGE_UI_SRC = readFileSync(
  join(__dirname, "..", "..", "..", "..", "src", "components", "ui", "badge.tsx"),
  "utf8",
);

describe("ConnectorBadge shared component", () => {
  it("is a client component", () => {
    expect(SRC.startsWith('"use client"')).toBe(true);
  });

  it("exports ConnectorBadge with the {connected,label} contract", () => {
    expect(SRC).toMatch(
      /export function ConnectorBadge\(\{ connected, label \}: \{ connected: boolean; label\?: string \}\)/,
    );
  });

  it("uses the design-system Badge with the lucide plug icons", () => {
    expect(SRC).toContain('from "@/components/ui/badge"');
    expect(SRC).toContain("PlugZap");
    expect(SRC).toContain("Unplug");
  });

  it("renders the connected state as a SOLID success-variant badge wrapping PlugZap (cinatra#1014)", () => {
    // Still `variant="success"` (the shared ui/badge.tsx primitive is
    // vendored verbatim into 5 extension repos and stays untouched — see the
    // #1014 describe block below), but with a `className` override that
    // replaces the variant's default soft bg-success/10 tint with a SOLID
    // bg-success + white text-success-foreground chip.
    expect(SRC).toMatch(/variant="success"[\s\S]*?<PlugZap\b/);
  });

  it("renders the disconnected state as a SOLID destructive-variant badge wrapping Unplug (cinatra#1014)", () => {
    expect(SRC).toMatch(/variant="destructive"[\s\S]*?<Unplug\b/);
  });

  it("keeps the connection-count label alongside the connected plug", () => {
    expect(SRC).toMatch(/<PlugZap[\s\S]*?\{label \? <span/);
  });

  it("labels the badge for assistive tech (connected count / not connected)", () => {
    expect(SRC).toMatch(/aria-label=\{label \? `Connected \(\$\{label\}\)` : "Connected"\}/);
    expect(SRC).toContain('aria-label="Not connected"');
  });

  describe("cinatra#1014 — the badge is SOLID via a className override, not a shared-primitive edit", () => {
    it("overrides the connected badge to a filled bg-success + white text-success-foreground chip", () => {
      const openTag = SRC.match(/<Badge\s+variant="success"[\s\S]*?>/);
      expect(openTag).not.toBeNull();
      expect(openTag![0]).toMatch(/className="[^"]*\bbg-success\b[^"]*"/);
      expect(openTag![0]).toMatch(/className="[^"]*\btext-success-foreground\b[^"]*"/);
      expect(openTag![0]).toMatch(/className="[^"]*\bdark:bg-success\b[^"]*"/);
    });

    it("overrides the disconnected badge to a filled bg-destructive + white text-destructive-foreground chip", () => {
      const openTag = SRC.match(/<Badge\s+variant="destructive"[\s\S]*?>/);
      expect(openTag).not.toBeNull();
      expect(openTag![0]).toMatch(/className="[^"]*\bbg-destructive\b[^"]*"/);
      expect(openTag![0]).toMatch(/className="[^"]*\btext-destructive-foreground\b[^"]*"/);
      expect(openTag![0]).toMatch(/className="[^"]*\bdark:bg-destructive\b[^"]*"/);
    });

    it("does NOT modify the shared ui/badge.tsx primitive (vendored verbatim into 5 extension repos)", () => {
      // scripts/extensions/vendor-extension-primitives.mjs copies this file
      // byte-for-byte (modulo import rewriting) into drupal-assistant-connector,
      // tailscale-connector, wordpress-mcp-connector, drupal-mcp-connector, and
      // wordpress-assistant-connector. Editing it here would drift every one of
      // those pinned vendored copies — so #1014 achieves the solid look via a
      // `className` override at the connector-badge.tsx call site instead.
      expect(BADGE_UI_SRC).toContain(
        "bg-success/10 text-success focus-visible:ring-success/20 dark:bg-success/20 dark:focus-visible:ring-success/40 [a]:hover:bg-success/20",
      );
      expect(BADGE_UI_SRC).toContain(
        "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
      );
      expect(BADGE_UI_SRC).not.toContain("success-solid");
      expect(BADGE_UI_SRC).not.toContain("destructive-solid");
    });
  });
});
