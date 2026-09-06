// cinatra#3214 — the HOST readiness road the Connection status card re-runs.
//
// The ratified drawing (specs/app-connectors.html §II "Connector setup page")
// carries "the status badge with both icon and label plus the Check action
// beneath it" on the setup page of EVERY schema-config connector. A connector
// that declares its own `status-probe` action is checked through that declared
// action; a connector that declares none is checked through this road — the
// host's own `resolveConnectorBadgeState`, the SAME signal that seeds the card
// and paints the connector's /connectors grid badge.
//
// These tests pin the two properties that make that reading TRUE rather than
// fabricated: it re-runs the seeding road for the bound package and returns its
// answer verbatim, and it resolves the CALLER's own actor scope (no actor →
// fail-closed "not connected"; a non-human principal → no user scope borrowed).

import { beforeEach, describe, expect, it, vi } from "vitest";

const getActorContext = vi.fn();
const resolveConnectorBadgeState = vi.fn();
const getConnectorRegistryEntryByPackageId = vi.fn();
const enforceConnectorPolicy = vi.fn();
const resolveRuntimeConnectorCardRecord = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: (...args: unknown[]) => getActorContext(...args),
}));
vi.mock("@/lib/connectors-registry.server", () => ({
  resolveConnectorBadgeState: (...args: unknown[]) => resolveConnectorBadgeState(...args),
  getConnectorRegistryEntryByPackageId: (...args: unknown[]) =>
    getConnectorRegistryEntryByPackageId(...args),
}));
vi.mock("@/lib/connector-policy", () => ({
  enforceConnectorPolicy: (...args: unknown[]) => enforceConnectorPolicy(...args),
}));
vi.mock("@/lib/extension-install-resolution", () => ({
  resolveRuntimeConnectorCardRecord: (...args: unknown[]) =>
    resolveRuntimeConnectorCardRecord(...args),
}));
// Side-effect import in the module under test: registering the built-in probes
// pulls the whole server graph, which a unit test neither has nor needs.
vi.mock("@/lib/connector-readiness.server", () => ({}));

import { recheckConnectorReadiness } from "@/lib/connector-readiness-action";

beforeEach(() => {
  getActorContext.mockReset();
  resolveConnectorBadgeState.mockReset();
  getConnectorRegistryEntryByPackageId.mockReset();
  enforceConnectorPolicy.mockReset();
  resolveRuntimeConnectorCardRecord.mockReset();
  // Default arrangement: a catalog connector this actor may read.
  getConnectorRegistryEntryByPackageId.mockReturnValue({
    packageId: "@cinatra-ai/fixture-connector",
  });
  enforceConnectorPolicy.mockReturnValue({ allowed: true });
});

describe("recheckConnectorReadiness — Check's road for a probe-less connector (#3214)", () => {
  it("re-runs the SAME readiness road that seeds the card, and returns its reading verbatim", async () => {
    getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "user-1" });
    resolveConnectorBadgeState.mockResolvedValue({ connected: true, connectedLabel: "2" });

    const reading = await recheckConnectorReadiness("@cinatra-ai/fixture-connector");

    expect(resolveConnectorBadgeState).toHaveBeenCalledTimes(1);
    expect(resolveConnectorBadgeState).toHaveBeenCalledWith("@cinatra-ai/fixture-connector", {
      userId: "user-1",
    });
    // Verbatim: the card shows what the product knows, not a reworded guess.
    expect(reading).toEqual({ connected: true, connectedLabel: "2" });
  });

  it("passes a not-connected reading straight through", async () => {
    getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "user-1" });
    resolveConnectorBadgeState.mockResolvedValue({ connected: false });

    await expect(recheckConnectorReadiness("@cinatra-ai/fixture-connector")).resolves.toEqual({
      connected: false,
    });
  });

  it("fail-closes to not connected with no actor, and never runs the road", async () => {
    getActorContext.mockResolvedValue(undefined);

    await expect(recheckConnectorReadiness("@cinatra-ai/fixture-connector")).resolves.toEqual({
      connected: false,
    });
    expect(resolveConnectorBadgeState).not.toHaveBeenCalled();
  });

  it("borrows no user scope for a non-human principal", async () => {
    getActorContext.mockResolvedValue({ principalType: "Agent", principalId: "agent-9" });
    resolveConnectorBadgeState.mockResolvedValue({ connected: false });

    await recheckConnectorReadiness("@cinatra-ai/fixture-connector");

    expect(resolveConnectorBadgeState).toHaveBeenCalledWith("@cinatra-ai/fixture-connector", {
      userId: null,
    });
  });

  // cinatra#3214 convergence (codex finding 1): a server action is directly
  // addressable with ANY packageId, so binding it in the page does not make it
  // package-bound. It must re-run the dispatch route's own read gate.
  it("fail-closes when the catalog policy denies the caller a read of this connector", async () => {
    getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "user-1" });
    enforceConnectorPolicy.mockReturnValue({ allowed: false, reason: "admin_only_connector" });

    await expect(recheckConnectorReadiness("@cinatra-ai/admin-only")).resolves.toEqual({
      connected: false,
    });
    expect(enforceConnectorPolicy).toHaveBeenCalledWith(
      "@cinatra-ai/admin-only",
      { principalType: "HumanUser", principalId: "user-1" },
      "read",
    );
    // The denied caller learns nothing: the readiness road never runs.
    expect(resolveConnectorBadgeState).not.toHaveBeenCalled();
  });

  it("fail-closes for a runtime-only connector with no trusted, actor-addressable install", async () => {
    getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "user-1" });
    getConnectorRegistryEntryByPackageId.mockReturnValue(undefined);
    resolveRuntimeConnectorCardRecord.mockResolvedValue(null);

    await expect(recheckConnectorReadiness("@acme/runtime-connector")).resolves.toEqual({
      connected: false,
    });
    expect(enforceConnectorPolicy).not.toHaveBeenCalled();
    expect(resolveConnectorBadgeState).not.toHaveBeenCalled();
  });

  it("reads a runtime-only connector once its trusted install record proves authorization", async () => {
    getActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "user-1" });
    getConnectorRegistryEntryByPackageId.mockReturnValue(undefined);
    resolveRuntimeConnectorCardRecord.mockResolvedValue({ vendor: "acme", slug: "runtime-connector" });
    resolveConnectorBadgeState.mockResolvedValue({ connected: true });

    await expect(recheckConnectorReadiness("@acme/runtime-connector")).resolves.toEqual({
      connected: true,
    });
    expect(resolveRuntimeConnectorCardRecord).toHaveBeenCalledWith("@acme/runtime-connector", {
      principalType: "HumanUser",
      principalId: "user-1",
    });
  });
});
