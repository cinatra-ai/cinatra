// cinatra #1057 — post-install "needs configuration" derivation + the ratified
// readiness-chaining semantics. PURE: drives `summarizeConfigurationNeeds` with
// per-connector readiness rows; no DB, no probes, no React.
//
// The linkedin/linkedin-oauth case pins the RATIFIED decision (per-connector
// probes are authoritative; a required connector-dependency's readiness is
// surfaced as its OWN row, never folded into the facade's readiness).
import { describe, expect, it } from "vitest";

import {
  summarizeConfigurationNeeds,
  type ConnectorReadinessRow,
} from "@/lib/extension-dependency-ux";

function row(over: Partial<ConnectorReadinessRow> & { packageName: string }): ConnectorReadinessRow {
  const slug = over.slug ?? over.packageName.slice(over.packageName.lastIndexOf("/") + 1);
  return {
    slug,
    displayName: slug,
    connected: false,
    settingsHref: `/connectors/cinatra-ai/${slug}/setup`,
    isRoot: false,
    ...over,
  };
}

describe("summarizeConfigurationNeeds", () => {
  it("surfaces only the connectors whose OWN probe reports not-connected", () => {
    const summary = summarizeConfigurationNeeds([
      row({ packageName: "@cinatra-ai/openai-connector", connected: true }),
      row({ packageName: "@cinatra-ai/apollo-connector", connected: false }),
    ]);

    expect(summary.hasConnectors).toBe(true);
    expect(summary.allConfigured).toBe(false);
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/apollo-connector"]);
    expect(summary.needs[0].settingsHref).toBe("/connectors/cinatra-ai/apollo-connector/setup");
  });

  it("reports allConfigured with no needs when every connector's own probe is connected", () => {
    const summary = summarizeConfigurationNeeds([
      row({ packageName: "@cinatra-ai/openai-connector", connected: true }),
      row({ packageName: "@cinatra-ai/apollo-connector", connected: true }),
    ]);

    expect(summary.hasConnectors).toBe(true);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });

  it("reports hasConnectors=false for an install that touched no connectors", () => {
    const summary = summarizeConfigurationNeeds([]);
    expect(summary.hasConnectors).toBe(false);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });

  it("orders the root first, then dependencies lexicographically", () => {
    const summary = summarizeConfigurationNeeds([
      row({ packageName: "@cinatra-ai/social-media-connector" }),
      row({ packageName: "@cinatra-ai/linkedin-oauth-connector" }),
      row({ packageName: "@cinatra-ai/linkedin-connector", isRoot: true }),
    ]);

    expect(summary.needs.map((n) => n.packageName)).toEqual([
      "@cinatra-ai/linkedin-connector", // root first
      "@cinatra-ai/linkedin-oauth-connector", // then deps A→Z
      "@cinatra-ai/social-media-connector",
    ]);
    expect(summary.needs[0].isRoot).toBe(true);
  });

  // RATIFIED READINESS-CHAINING SEMANTICS (cinatra #1057): per-connector probes
  // are AUTHORITATIVE; a required connector-dependency's readiness is surfaced
  // SEPARATELY, never folded into the facade's readiness boolean.
  it("does NOT fold a dependency's readiness into the facade (linkedin ↔ linkedin-oauth)", () => {
    const summary = summarizeConfigurationNeeds([
      // linkedin-connector's OWN probe reports connected (a saved LinkedIn
      // connection, which cannot exist unless its oauth base is satisfied)...
      row({ packageName: "@cinatra-ai/linkedin-connector", connected: true }),
      // ...while its required base connectors register no probe and default to
      // not-connected.
      row({ packageName: "@cinatra-ai/linkedin-oauth-connector", connected: false }),
      row({ packageName: "@cinatra-ai/social-media-connector", connected: false }),
    ]);

    // The facade is NOT re-surfaced just because a dependency is unconfigured —
    // its own probe is authoritative.
    expect(summary.needs.map((n) => n.packageName)).not.toContain(
      "@cinatra-ai/linkedin-connector",
    );
    // The dependencies appear as their OWN independent rows (shown separately),
    // each deep-linked to its own setup surface.
    expect(summary.needs.map((n) => n.packageName)).toEqual([
      "@cinatra-ai/linkedin-oauth-connector",
      "@cinatra-ai/social-media-connector",
    ]);
    expect(summary.needs[0].settingsHref).toBe(
      "/connectors/cinatra-ai/linkedin-oauth-connector/setup",
    );
  });

  it("carries a null settingsHref through unchanged (unresolved deep-link)", () => {
    const summary = summarizeConfigurationNeeds([
      row({ packageName: "@cinatra-ai/mystery-connector", settingsHref: null }),
    ]);
    expect(summary.needs[0].settingsHref).toBeNull();
  });
});
