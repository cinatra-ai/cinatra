// Unit tests for the cinatra-side reconcile deps factory:
//   - getStuckApplications excludes an application the marketplace has
//     confirmed terminally stuck (vendorApplicationRepairStuckAt set).
//   - getStuckApplications clears a stale stuck flag when the application is
//     no longer the open one (state moved off "applied").
//   - onStuck writes the durable stuck flag for the matching application_id
//     and is a no-op when the current application_id has changed.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceIdentity } from "@/lib/instance-identity-store";

// Stateful in-memory identity row so writes are observable.
let identityRow: InstanceIdentity | null = null;

const readInstanceIdentity = vi.fn((): InstanceIdentity | null => identityRow);
const writeInstanceIdentity = vi.fn((next: InstanceIdentity) => {
  identityRow = next;
});
const invalidateInstanceIdentityCache = vi.fn();

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: (...args: unknown[]) =>
    (readInstanceIdentity as (...a: unknown[]) => InstanceIdentity | null)(...args),
  writeInstanceIdentity: (...args: unknown[]) =>
    (writeInstanceIdentity as (...a: unknown[]) => void)(...(args as [InstanceIdentity])),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: () => invalidateInstanceIdentityCache(),
}));
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveMarketplaceSyncWorkerToken: vi.fn(() => "sync-worker-token"),
  VendorCredentialsMissingError: class VendorCredentialsMissingError extends Error {},
}));

import { buildVendorApplicationReconcileDeps } from "@/lib/marketplace-application-reconcile-deps";

const BASE: InstanceIdentity = {
  instanceNamespace: "acme",
  instanceDisplayName: "Acme",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: null,
  createdAt: "2026-05-27T00:00:00.000Z",
};

beforeEach(() => {
  identityRow = null;
  vi.clearAllMocks();
});

describe("getStuckApplications", () => {
  it("returns the open application when applied + id set + no stuck flag", async () => {
    identityRow = { ...BASE, vendorState: "applied", vendorApplicationId: "app-1" };
    const deps = await buildVendorApplicationReconcileDeps();
    const candidates = await deps!.getStuckApplications();
    expect(candidates).toEqual([{ application_id: "app-1" }]);
  });

  it("excludes an application the marketplace confirmed terminally stuck", async () => {
    identityRow = {
      ...BASE,
      vendorState: "applied",
      vendorApplicationId: "app-1",
      vendorApplicationRepairStuckAt: "2026-05-27T01:00:00Z",
    };
    const deps = await buildVendorApplicationReconcileDeps();
    const candidates = await deps!.getStuckApplications();
    expect(candidates).toEqual([]);
    // Flag stays set while it is still the open application.
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
  });

  it("clears a stale stuck flag when state moved off applied", async () => {
    identityRow = {
      ...BASE,
      vendorState: "approved",
      vendorApplicationId: "app-1",
      vendorApplicationRepairStuckAt: "2026-05-27T01:00:00Z",
    };
    const deps = await buildVendorApplicationReconcileDeps();
    const candidates = await deps!.getStuckApplications();
    expect(candidates).toEqual([]);
    expect(writeInstanceIdentity).toHaveBeenCalledOnce();
    expect(identityRow!.vendorApplicationRepairStuckAt).toBeNull();
  });

  it("returns empty (and no clear write) when nothing is configured", async () => {
    identityRow = { ...BASE };
    const deps = await buildVendorApplicationReconcileDeps();
    const candidates = await deps!.getStuckApplications();
    expect(candidates).toEqual([]);
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
  });
});

describe("onStuck", () => {
  it("writes the durable stuck flag for the matching application_id", async () => {
    identityRow = { ...BASE, vendorState: "applied", vendorApplicationId: "app-1" };
    const deps = await buildVendorApplicationReconcileDeps();
    await deps!.onStuck!("app-1", "2026-05-27T02:00:00Z");
    expect(identityRow!.vendorApplicationRepairStuckAt).toBe("2026-05-27T02:00:00Z");
    expect(invalidateInstanceIdentityCache).toHaveBeenCalled();
  });

  it("is a no-op when the current application_id no longer matches", async () => {
    identityRow = { ...BASE, vendorState: "applied", vendorApplicationId: "app-2" };
    const deps = await buildVendorApplicationReconcileDeps();
    await deps!.onStuck!("app-1", "2026-05-27T02:00:00Z");
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
    expect(identityRow!.vendorApplicationRepairStuckAt).toBeUndefined();
  });

  it("is idempotent when the flag is already set to the same value", async () => {
    identityRow = {
      ...BASE,
      vendorState: "applied",
      vendorApplicationId: "app-1",
      vendorApplicationRepairStuckAt: "2026-05-27T02:00:00Z",
    };
    const deps = await buildVendorApplicationReconcileDeps();
    await deps!.onStuck!("app-1", "2026-05-27T02:00:00Z");
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
  });
});
