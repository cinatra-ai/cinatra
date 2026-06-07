import { describe, expect, it } from "vitest";

import {
  mapVendorStateToRemoteStatus,
  reconcileRemoteFromVendorGet,
  reconcileRemoteOnFailure,
} from "@/lib/marketplace-reconcile";
import type { RemoteRegistryConnection } from "@/lib/instance-identity-store";

describe("mapVendorStateToRemoteStatus", () => {
  it("maps active → connected", () => {
    expect(mapVendorStateToRemoteStatus("active")).toBe("connected");
  });
  it("maps pending and unregistered → not_connected", () => {
    expect(mapVendorStateToRemoteStatus("pending")).toBe("not_connected");
    expect(mapVendorStateToRemoteStatus("unregistered")).toBe("not_connected");
  });
  it("maps suspended and rejected → error", () => {
    expect(mapVendorStateToRemoteStatus("suspended")).toBe("error");
    expect(mapVendorStateToRemoteStatus("rejected")).toBe("error");
  });
  it("maps unknown marketplace state → error (contract drift)", () => {
    expect(mapVendorStateToRemoteStatus("totally_made_up")).toBe("error");
  });
});

describe("reconcileRemoteFromVendorGet", () => {
  const NS = "@acme";
  const baseVendor = {
    vendor_id: 7,
    namespace: NS,
    tier: "free",
    state: "active",
    profile_visibility: "private",
    published_count: 0,
    has_registry_token: true,
    registry_url: "https://registry.cinatra.ai",
  };

  it("builds a connected row from an active vendor when no previous row exists", () => {
    const reconciled = reconcileRemoteFromVendorGet({
      previous: undefined,
      vendor: baseVendor,
      namespace: NS,
      nowIso: "2026-05-26T00:00:00Z",
    });
    expect(reconciled.status).toBe("connected");
    expect(reconciled.namespace).toBe(NS);
    expect(reconciled.url).toBe("https://registry.cinatra.ai");
    expect(reconciled.marketplaceState).toBe("active");
    expect(reconciled.marketplaceVendorId).toBe(7);
    expect(reconciled.marketplaceLastReconciledAt).toBe("2026-05-26T00:00:00Z");
    expect(reconciled.marketplaceLastReconcileError).toBeNull();
  });

  it("clears a prior reconcile error on a successful reconcile", () => {
    const previous: RemoteRegistryConnection = {
      url: "https://registry.cinatra.ai",
      namespace: NS,
      status: "connected",
      marketplaceLastReconcileError: "timeout",
    };
    const reconciled = reconcileRemoteFromVendorGet({
      previous,
      vendor: baseVendor,
      namespace: NS,
    });
    expect(reconciled.marketplaceLastReconcileError).toBeNull();
  });

  it("maps a suspended vendor to status=error", () => {
    const reconciled = reconcileRemoteFromVendorGet({
      previous: undefined,
      vendor: { ...baseVendor, state: "suspended" },
      namespace: NS,
    });
    expect(reconciled.status).toBe("error");
    expect(reconciled.marketplaceState).toBe("suspended");
  });
});

describe("reconcileRemoteOnFailure", () => {
  const NS = "@acme";

  it("returns undefined when there is no previous row (never invents one)", () => {
    expect(
      reconcileRemoteOnFailure({ previous: undefined, error: "boom", namespace: NS }),
    ).toBeUndefined();
  });

  it("preserves status=connected and only records the error", () => {
    const previous: RemoteRegistryConnection = {
      url: "https://registry.cinatra.ai",
      namespace: NS,
      status: "connected",
      marketplaceState: "active",
    };
    const degraded = reconcileRemoteOnFailure({
      previous,
      error: "ETIMEDOUT contacting marketplace",
      namespace: NS,
      nowIso: "2026-05-26T01:00:00Z",
    });
    expect(degraded?.status).toBe("connected"); // never degraded on failure
    expect(degraded?.marketplaceLastReconcileError).toBe("ETIMEDOUT contacting marketplace");
    expect(degraded?.marketplaceLastReconciledAt).toBe("2026-05-26T01:00:00Z");
  });

  it("truncates very long error messages", () => {
    const previous: RemoteRegistryConnection = {
      url: "https://registry.cinatra.ai",
      namespace: NS,
      status: "connected",
    };
    const degraded = reconcileRemoteOnFailure({
      previous,
      error: "x".repeat(2000),
      namespace: NS,
    });
    expect(degraded?.marketplaceLastReconcileError?.length).toBe(500);
  });
});
