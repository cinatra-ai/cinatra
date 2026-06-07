/**
 * Multi-org `accessibleOrgIds` widening tests.
 *
 * Verifies:
 *   - `buildSecurityContextFromIdentity` defaults `accessibleOrgIds` to `[organizationId]`.
 *   - `buildSecurityContextWithAccessibleOrgIds` widens via the resolver callback.
 *   - The active org is unioned in even if the resolver omits it.
 *   - Resolver failures fall back to active-org-only (fail-closed).
 *   - Identity-missing inputs return null.
 */
import { describe, it, expect } from "vitest";

import {
  buildSecurityContextFromIdentity,
  buildSecurityContextWithAccessibleOrgIds,
  type AccessibleOrgIdsResolver,
} from "../auth/security-context";

describe("buildSecurityContextFromIdentity default accessibleOrgIds", () => {
  it("returns null when identity is missing or empty", () => {
    expect(buildSecurityContextFromIdentity(null)).toBeNull();
    expect(buildSecurityContextFromIdentity({ userId: "", organizationId: "org-1" })).toBeNull();
    expect(buildSecurityContextFromIdentity({ userId: "user-1", organizationId: "" })).toBeNull();
  });

  it("defaults accessibleOrgIds to [organizationId]", () => {
    const sc = buildSecurityContextFromIdentity({ userId: "user-1", organizationId: "org-1" });
    expect(sc).not.toBeNull();
    expect(sc!.accessibleOrgIds).toEqual(["org-1"]);
  });
});

describe("buildSecurityContextWithAccessibleOrgIds — multi-org widening", () => {
  it("returns null when identity is missing", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => ["org-a", "org-b"];
    expect(await buildSecurityContextWithAccessibleOrgIds(null, resolver)).toBeNull();
  });

  it("widens accessibleOrgIds to the union of activeOrg + resolver result", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => ["org-1", "org-2", "org-3"];
    const sc = await buildSecurityContextWithAccessibleOrgIds(
      { userId: "user-1", organizationId: "org-1" },
      resolver,
    );
    expect(sc).not.toBeNull();
    expect(sc!.accessibleOrgIds.slice().sort()).toEqual(["org-1", "org-2", "org-3"]);
  });

  it("unions the active org in even if resolver omits it", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => ["org-2", "org-3"];
    const sc = await buildSecurityContextWithAccessibleOrgIds(
      { userId: "user-1", organizationId: "org-1" },
      resolver,
    );
    expect(sc!.accessibleOrgIds.slice().sort()).toEqual(["org-1", "org-2", "org-3"]);
  });

  it("deduplicates if the resolver returns duplicates including the active org", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => ["org-1", "org-1", "org-2"];
    const sc = await buildSecurityContextWithAccessibleOrgIds(
      { userId: "user-1", organizationId: "org-1" },
      resolver,
    );
    expect(sc!.accessibleOrgIds.slice().sort()).toEqual(["org-1", "org-2"]);
  });

  it("falls back to [organizationId] when the resolver throws (fail-closed)", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => {
      throw new Error("DB unreachable");
    };
    const sc = await buildSecurityContextWithAccessibleOrgIds(
      { userId: "user-1", organizationId: "org-1" },
      resolver,
    );
    expect(sc).not.toBeNull();
    expect(sc!.accessibleOrgIds).toEqual(["org-1"]);
  });

  it("falls back to [organizationId] when the resolver returns an empty list (defensive)", async () => {
    const resolver: AccessibleOrgIdsResolver = async () => [];
    const sc = await buildSecurityContextWithAccessibleOrgIds(
      { userId: "user-1", organizationId: "org-1" },
      resolver,
    );
    // Resolver returned empty → union with active org → at minimum the
    // active org is preserved.
    expect(sc!.accessibleOrgIds).toEqual(["org-1"]);
  });
});
