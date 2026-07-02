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

  it("renders the connected state as a success-variant badge wrapping PlugZap", () => {
    // success → bg-success/10 text-success (state-coloured background, #682).
    expect(SRC).toMatch(/variant="success"[\s\S]*?<PlugZap\b/);
  });

  it("renders the disconnected state as a destructive-variant badge wrapping Unplug", () => {
    expect(SRC).toMatch(/variant="destructive"[\s\S]*?<Unplug\b/);
  });

  it("keeps the connection-count label alongside the connected plug", () => {
    expect(SRC).toMatch(/<PlugZap[\s\S]*?\{label \? <span/);
  });

  it("labels the badge for assistive tech (connected count / not connected)", () => {
    expect(SRC).toMatch(/aria-label=\{label \? `Connected \(\$\{label\}\)` : "Connected"\}/);
    expect(SRC).toContain('aria-label="Not connected"');
  });
});
