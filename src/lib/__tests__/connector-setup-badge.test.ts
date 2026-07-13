// Per the owner ruling (wordpress-assistant-connector#36 ask-6) and
// design/specs/app-connectors.html §II, the connection-status BADGE no longer
// sits top-right of any connector setup page — it moved into the right-column
// "Connection status" card. This file pins two things:
//   1. `resolveConnectorBadgeState` is the fail-soft probe pipeline (a throwing
//      or absent probe degrades to "not connected", never throws) — it now SEEDS
//      the status cards instead of a header badge.
//   2. The dispatch route renders NO top-right badge on any branch, and gives
//      the wp-assistant bundled-react branch the host-owned Connection status
//      card in a right column (the ask-6 companion to the frozen extension).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerConnectorReadinessProbe,
  resolveConnectorBadgeState,
} from "@/lib/connectors-registry.server";

describe("resolveConnectorBadgeState (host badge data)", () => {
  it("returns the registered probe's {connected,label}", async () => {
    const pkg = "@test/badge-connected-connector";
    registerConnectorReadinessProbe(pkg, async () => ({
      connected: true,
      connectedLabel: "3",
    }));
    const state = await resolveConnectorBadgeState(pkg, { userId: "u-1" });
    expect(state).toEqual({ connected: true, connectedLabel: "3" });
  });

  it("falls back to not-connected for a connector with no probe", async () => {
    const state = await resolveConnectorBadgeState(
      "@test/badge-no-probe-connector",
      { userId: "u-1" },
    );
    expect(state.connected).toBe(false);
  });

  it("is fail-soft: a THROWING probe degrades to not-connected (never 500s)", async () => {
    const pkg = "@test/badge-throwing-connector";
    registerConnectorReadinessProbe(pkg, async () => {
      throw new Error("status read blew up");
    });
    const state = await resolveConnectorBadgeState(pkg, { userId: "u-1" });
    expect(state).toEqual({ connected: false });
  });

  it("threads the readiness context (userId) through to the probe", async () => {
    const pkg = "@test/badge-ctx-connector";
    let seenUserId: string | null | undefined;
    registerConnectorReadinessProbe(pkg, async (ctx) => {
      seenUserId = ctx.userId;
      return { connected: false };
    });
    await resolveConnectorBadgeState(pkg, { userId: "u-42" });
    expect(seenUserId).toBe("u-42");
  });
});

describe("dispatch route: no top-right badge; wp-assistant Setup-tab status card", () => {
  const ROUTE_SRC = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "app",
      "connectors",
      "[vendor]",
      "[slug]",
      "[subroute]",
      "page.tsx",
    ),
    "utf8",
  );

  it("no longer imports or renders the top-right ConnectorBadge", () => {
    // Owner ruling (wordpress-assistant-connector#36 ask-6) + app-connectors.html
    // §II: the status badge that once sat top-right is gone from every setup page.
    // (`resolveConnectorBadgeState` survives to SEED the cards — assert the badge
    // COMPONENT import + JSX + the `statusBadge` element are gone, precisely.)
    expect(ROUTE_SRC).not.toContain("@cinatra-ai/connectors/connector-badge");
    expect(ROUTE_SRC).not.toMatch(/<ConnectorBadge\b/);
    expect(ROUTE_SRC).not.toMatch(/\bstatusBadge\b/);
  });

  it("removes the pointer-events-none overlay from the bundled-react branch", () => {
    expect(ROUTE_SRC).not.toContain("pointer-events-none");
  });

  it("carries no header actions on any host-chromed PageHeader branch", () => {
    // Every fallback branch (probe-less schema-config, invalid-schema-config, the
    // two requires-rebuild sites) renders a bare <PageHeader> — no actions slot.
    expect(ROUTE_SRC).not.toMatch(/actions=\{statusBadge\}/);
  });

  it("still resolves the readiness state to SEED the connection status cards", () => {
    // badgeState survives only to seed the right-column Connection status card
    // (Model-A schema-config path + the bundled-react host card below), from the
    // SAME probe that feeds the /connectors grid badge.
    expect(ROUTE_SRC).toContain("resolveConnectorBadgeState");
    expect(ROUTE_SRC).toContain('import "@/lib/connector-readiness.server"');
  });

  it("gives the wp-assistant bundled-react branch the host Connection status card", () => {
    // ask-6 half two: gated to wordpress-assistant-connector, the host wraps the
    // self-chromed extension page in the shared two-column grid and renders the
    // host-owned ConnectorStatusProbeCard in the right column (seeded from the
    // widget-credentials readiness probe). initialConnected comes from badgeState.
    expect(ROUTE_SRC).toContain('=== "wordpress-assistant-connector"');
    expect(ROUTE_SRC).toMatch(
      /ConnectorSetupColumns[\s\S]*?ConnectorStatusProbeCard[\s\S]*?initialConnected=\{badgeState\.connected\}/,
    );
  });
});
