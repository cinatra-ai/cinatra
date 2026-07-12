import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Unit tests for the PM work-store SELECTION policy (cinatra#1032
// deliverable 3): the pure four-branch once-at-instantiation policy
// (configured wins; auto iff exactly one connected; fail-closed on
// none/several) plus its edge rules (blank configured id; deduped connected
// set), and the persisted-provider read seam (resolve the persisted id only —
// fail closed when disconnected, never re-select).

import {
  registerPmWorkStore,
  _resetPmWorkStoreRegistry,
  type PmWorkStore,
} from "@cinatra-ai/sdk-extensions";
import {
  selectPmWorkStoreProvider,
  connectedPmWorkStoreProviderIds,
  resolvePersistedPmWorkStore,
} from "@/lib/pm-work-store-selection";

describe("selectPmWorkStoreProvider — the four policy branches", () => {
  it("configured wins (even when several are connected)", () => {
    expect(
      selectPmWorkStoreProvider({
        configuredProviderId: "plane",
        connectedProviderIds: ["github", "plane", "linear"],
      }),
    ).toEqual({ kind: "selected", providerId: "plane", mode: "configured" });
  });

  it("auto-selects iff EXACTLY ONE provider is connected", () => {
    expect(
      selectPmWorkStoreProvider({ configuredProviderId: null, connectedProviderIds: ["plane"] }),
    ).toEqual({ kind: "selected", providerId: "plane", mode: "auto" });
  });

  it("fails closed when NO provider is connected", () => {
    expect(
      selectPmWorkStoreProvider({ configuredProviderId: null, connectedProviderIds: [] }),
    ).toEqual({ kind: "rejected", reason: "none_connected", connectedProviderIds: [] });
  });

  it("fails closed (never guesses) when SEVERAL providers are connected", () => {
    expect(
      selectPmWorkStoreProvider({
        connectedProviderIds: ["plane", "github"],
      }),
    ).toEqual({
      kind: "rejected",
      reason: "ambiguous",
      connectedProviderIds: ["plane", "github"],
    });
  });

  it("fails closed when the configured provider is not connected", () => {
    expect(
      selectPmWorkStoreProvider({
        configuredProviderId: "jira",
        connectedProviderIds: ["plane"],
      }),
    ).toEqual({
      kind: "rejected",
      reason: "configured_not_connected",
      connectedProviderIds: ["plane"],
    });
  });

  it("rejects a blank configured id as invalid (never treated as 'unconfigured')", () => {
    expect(
      selectPmWorkStoreProvider({ configuredProviderId: "   ", connectedProviderIds: ["plane"] }),
    ).toMatchObject({ kind: "rejected", reason: "invalid_configured" });
  });

  it("trims the configured id before matching", () => {
    expect(
      selectPmWorkStoreProvider({
        configuredProviderId: " plane ",
        connectedProviderIds: ["plane"],
      }),
    ).toEqual({ kind: "selected", providerId: "plane", mode: "configured" });
  });

  it("dedupes the connected set before the exactly-one test (a double registration is ONE tool)", () => {
    expect(
      selectPmWorkStoreProvider({
        connectedProviderIds: ["plane", "plane"],
      }),
    ).toEqual({ kind: "selected", providerId: "plane", mode: "auto" });
  });
});

describe("persisted-provider resolution (sticky — never re-selects)", () => {
  const fakeStore = (providerId: string): PmWorkStore =>
    ({ providerId }) as unknown as PmWorkStore;

  beforeEach(() => _resetPmWorkStoreRegistry());
  afterEach(() => _resetPmWorkStoreRegistry());

  it("resolves the persisted provider id to the live registered store", () => {
    registerPmWorkStore(fakeStore("plane"));
    expect(resolvePersistedPmWorkStore({ providerId: "plane" })).toMatchObject({
      ok: true,
      store: { providerId: "plane" },
    });
  });

  it("fails CLOSED when the persisted provider is disconnected — even when another provider is available", () => {
    registerPmWorkStore(fakeStore("github"));
    expect(resolvePersistedPmWorkStore({ providerId: "plane" })).toEqual({
      ok: false,
      reason: "provider_disconnected",
      providerId: "plane",
    });
  });

  it("connectedPmWorkStoreProviderIds reflects the live registry, deduped", () => {
    registerPmWorkStore(fakeStore("plane"));
    registerPmWorkStore(fakeStore("plane")); // idempotent re-registration
    registerPmWorkStore(fakeStore("github"));
    expect(connectedPmWorkStoreProviderIds().sort()).toEqual(["github", "plane"]);
  });
});
