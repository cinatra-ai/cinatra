// The connector setup-page dispatch route HOST-injects a
// connection-status badge top-right on EVERY render branch, reading the SAME
// readiness signal the /connectors card grid does. Two guarantees:
//   1. `resolveConnectorBadgeState` is the fail-soft probe pipeline (a throwing
//      or absent probe degrades to "not connected", never throws).
//   2. The dispatch route renders the shared host badge into all four
//      host-chromed PageHeader branches AND over the bundled-react branch.

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

describe("dispatch route host-injects the badge on every branch", () => {
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

  it("imports the SHARED ConnectorBadge (host-owned, not extension-owned)", () => {
    expect(ROUTE_SRC).toContain(
      'import { ConnectorBadge } from "@cinatra-ai/connectors/connector-badge"',
    );
  });

  it("resolves the badge state via the card readiness pipeline", () => {
    expect(ROUTE_SRC).toContain("resolveConnectorBadgeState");
    // Registers the built-in probes (side effect) so the badge matches the card.
    expect(ROUTE_SRC).toContain('import "@/lib/connector-readiness.server"');
  });

  it("passes the badge to every host-chromed PageHeader actions slot", () => {
    // All four host-chromed branches (schema-config, invalid-schema-config, and
    // the two requires-rebuild sites) render <PageHeader ... actions={statusBadge} />.
    const actionsMatches = ROUTE_SRC.match(/actions=\{statusBadge\}/g) ?? [];
    expect(actionsMatches.length).toBe(4);
  });

  it("floats the badge top-right over the bundled-react branch, non-interactively", () => {
    // The bundled-react setup page renders its own chrome, so the host overlays
    // the badge with pointer-events-none (cannot steal clicks from the
    // extension's own header controls).
    expect(ROUTE_SRC).toMatch(/pointer-events-none[\s\S]*?statusBadge/);
  });
});
