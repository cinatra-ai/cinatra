// cinatra #1057 — post-install "needs configuration" derivation, narrowed
// (owner ruling (a)) to AGENT roots with REQUIRED connector dependencies, plus
// the ratified per-connector-authoritative readiness-chaining semantics. PURE:
// drives `summarizeConfigurationNeeds` with per-connector readiness rows; no DB,
// no probes, no React.
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
    required: true,
    ...over,
  };
}

describe("summarizeConfigurationNeeds — scope narrowing (agent + required connectors)", () => {
  it("agent with 2 required connectors, 0 configured → both surface", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/apollo-connector", connected: false }),
        row({ packageName: "@cinatra-ai/gmail-connector", connected: false }),
      ],
    });

    expect(summary.hasConnectors).toBe(true);
    expect(summary.allConfigured).toBe(false);
    expect(summary.needs.map((n) => n.packageName)).toEqual([
      "@cinatra-ai/apollo-connector",
      "@cinatra-ai/gmail-connector",
    ]);
  });

  it("agent with 2 required connectors, 1 configured → only the unconfigured surfaces", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/apollo-connector", connected: true }),
        row({ packageName: "@cinatra-ai/gmail-connector", connected: false }),
      ],
    });

    expect(summary.hasConnectors).toBe(true);
    expect(summary.allConfigured).toBe(false);
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/gmail-connector"]);
  });

  it("agent with 2 required connectors, 2 configured → nothing to surface (allConfigured)", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/apollo-connector", connected: true }),
        row({ packageName: "@cinatra-ai/gmail-connector", connected: true }),
      ],
    });

    expect(summary.hasConnectors).toBe(true);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });

  it("non-agent kinds produce nothing even with unconfigured required connectors", () => {
    for (const rootKind of ["connector", "skill", "artifact", "workflow"] as const) {
      const summary = summarizeConfigurationNeeds({
        rootKind,
        connectors: [row({ packageName: "@cinatra-ai/apollo-connector", connected: false })],
      });
      expect(summary.hasConnectors).toBe(false);
      expect(summary.allConfigured).toBe(true);
      expect(summary.needs).toEqual([]);
    }
  });

  it("an undefined root kind produces nothing", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: undefined,
      connectors: [row({ packageName: "@cinatra-ai/apollo-connector", connected: false })],
    });
    expect(summary.hasConnectors).toBe(false);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });

  it("optional connector dependencies produce nothing (never gate an agent)", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/apollo-connector", connected: false, required: false }),
        row({ packageName: "@cinatra-ai/gmail-connector", connected: false, required: false }),
      ],
    });
    // No REQUIRED connector at all → out of scope entirely.
    expect(summary.hasConnectors).toBe(false);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });

  it("mixes required + optional → only unconfigured REQUIRED connectors surface", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/apollo-connector", connected: false, required: true }),
        row({ packageName: "@cinatra-ai/gmail-connector", connected: false, required: false }),
      ],
    });
    expect(summary.hasConnectors).toBe(true);
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/apollo-connector"]);
  });

  it("an agent that touched no connectors reports hasConnectors=false", () => {
    const summary = summarizeConfigurationNeeds({ rootKind: "agent", connectors: [] });
    expect(summary.hasConnectors).toBe(false);
    expect(summary.allConfigured).toBe(true);
    expect(summary.needs).toEqual([]);
  });
});

describe("summarizeConfigurationNeeds — ordering + shape", () => {
  it("orders needs lexicographically by package name", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({ packageName: "@cinatra-ai/social-media-connector" }),
        row({ packageName: "@cinatra-ai/linkedin-oauth-connector" }),
        row({ packageName: "@cinatra-ai/apollo-connector" }),
      ],
    });
    expect(summary.needs.map((n) => n.packageName)).toEqual([
      "@cinatra-ai/apollo-connector",
      "@cinatra-ai/linkedin-oauth-connector",
      "@cinatra-ai/social-media-connector",
    ]);
  });

  it("surfaces the human-readable displayName + deep-link on each need", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        row({
          packageName: "@cinatra-ai/linkedin-oauth-connector",
          displayName: "LinkedIn",
          connected: false,
        }),
      ],
    });
    expect(summary.needs[0].displayName).toBe("LinkedIn");
    expect(summary.needs[0].settingsHref).toBe(
      "/connectors/cinatra-ai/linkedin-oauth-connector/setup",
    );
  });

  it("carries a null settingsHref through unchanged (unresolved deep-link)", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [row({ packageName: "@cinatra-ai/mystery-connector", settingsHref: null })],
    });
    expect(summary.needs[0].settingsHref).toBeNull();
  });
});

// RATIFIED READINESS-CHAINING SEMANTICS (cinatra #1057): per-connector probes
// are AUTHORITATIVE. This pure derivation reads each row's OWN `connected` and
// never cross-references rows — a connected connector is never re-surfaced just
// because a SIBLING required connector is unconfigured (no folding).
describe("summarizeConfigurationNeeds — per-connector-authoritative (no folding)", () => {
  it("uses each connector's OWN readiness; a connected connector is not folded in by a sibling's state", () => {
    const summary = summarizeConfigurationNeeds({
      rootKind: "agent",
      connectors: [
        // linkedin-connector's OWN probe reports connected (its probe reflects
        // the real chained end-state) — it must NOT be surfaced...
        row({ packageName: "@cinatra-ai/linkedin-connector", connected: true }),
        // ...while a sibling required connector is unconfigured.
        row({ packageName: "@cinatra-ai/apollo-connector", connected: false }),
      ],
    });

    // The connected connector is NOT re-surfaced because a sibling is
    // unconfigured — its own probe is authoritative.
    expect(summary.needs.map((n) => n.packageName)).not.toContain(
      "@cinatra-ai/linkedin-connector",
    );
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/apollo-connector"]);
    expect(summary.needs[0].settingsHref).toBe(
      "/connectors/cinatra-ai/apollo-connector/setup",
    );
  });
});
