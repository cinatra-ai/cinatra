// Unit tests for reconcileFirstPublishedAt (pure helper signature) covering
// freeze behavior, scope filtering, and one-way semantics.
//
// The pure helper signature `(identity, packagesUnderCurrentScope) →
// Promise<InstanceIdentity>` is also exercised by the page.test.tsx suite,
// but that file frames the assertions around the page-level reconciliation
// contract. This file isolates the helper itself with crisp scope-filter
// cases (mixed-scope inputs, both polarities) so the reconciliation rules
// are covered directly.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@example.com" },
  })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { reconcileFirstPublishedAt } from "@/app/configuration/instance/actions";
import type { InstanceIdentity } from "@/lib/instance-identity-store";

const PRE_PUBLISH: InstanceIdentity = {
  instanceNamespace: "vendora",
  instanceDisplayName: "Vendor A",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: null,
  createdAt: "2026-05-07T12:00:00.000Z",
};

const POST_PUBLISH: InstanceIdentity = {
  ...PRE_PUBLISH,
  firstPublishedAt: "2026-05-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileFirstPublishedAt — freeze behavior", () => {
  it("freezes when firstPublishedAt is null AND scoped packages exist", async () => {
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [{ packageName: "@vendora/foo" }],
    );
    expect(result.firstPublishedAt).not.toBeNull();
    expect(typeof result.firstPublishedAt).toBe("string");
    expect(() => new Date(result.firstPublishedAt as string)).not.toThrow();
  });

  it("does NOT freeze when firstPublishedAt is null but registry has zero packages under our scope", async () => {
    const result = await reconcileFirstPublishedAt(PRE_PUBLISH, []);
    expect(result.firstPublishedAt).toBeNull();
  });
});

describe("reconcileFirstPublishedAt — scope filter", () => {
  it("freezes only on packages prefixed @${instanceNamespace}/ — mixed list with no @vendora packages does NOT freeze", async () => {
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [
        { packageName: "@vendorb/bar" },
        { packageName: "@vendorc/baz" },
      ],
    );
    expect(result.firstPublishedAt).toBeNull();
  });

  it("freezes when at least one package in a mixed list is under @${instanceNamespace}/", async () => {
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [
        { packageName: "@vendorb/bar" },
        { packageName: "@vendora/foo" },
      ],
    );
    expect(result.firstPublishedAt).not.toBeNull();
  });

  it("does NOT match a different scope that happens to contain the vendor name as a substring (e.g. @vendora-fork/foo when scope is vendora)", async () => {
    // @vendora-fork/foo does NOT start with @vendora/, so the filter
    // rejects it. Only exact-scope prefix counts.
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [{ packageName: "@vendora-fork/foo" }],
    );
    expect(result.firstPublishedAt).toBeNull();
  });
});

describe("reconcileFirstPublishedAt — one-way semantics", () => {
  it("never resets firstPublishedAt to null when registry shows zero packages but local already frozen", async () => {
    const result = await reconcileFirstPublishedAt(POST_PUBLISH, []);
    expect(result.firstPublishedAt).toBe(POST_PUBLISH.firstPublishedAt);
    expect(result.firstPublishedAt).not.toBeNull();
  });

  it("returns the same identity unchanged when already frozen even with packages present", async () => {
    const result = await reconcileFirstPublishedAt(
      POST_PUBLISH,
      [{ packageName: "@vendora/foo" }],
    );
    expect(result.firstPublishedAt).toBe(POST_PUBLISH.firstPublishedAt);
  });
});
