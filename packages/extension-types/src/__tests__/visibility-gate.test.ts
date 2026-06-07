import { describe, it, expect } from "vitest";
import {
  manifestVisibleToScope,
  visibleManifestPackageNames,
  type ActiveExtensionManifest,
  type ExtensionDiscoveryScope,
} from "../index";

function manifest(
  over: Partial<ActiveExtensionManifest> = {},
): ActiveExtensionManifest {
  return {
    id: over.id ?? "row-1",
    packageName: over.packageName ?? "@x/pkg",
    kind: over.kind ?? "connector",
    ownerLevel: over.ownerLevel ?? "platform",
    ownerId: over.ownerId ?? null,
    organizationId: over.organizationId ?? null,
    status: over.status ?? "active",
  };
}

function scope(over: Partial<ExtensionDiscoveryScope> = {}): ExtensionDiscoveryScope {
  return {
    userId: over.userId ?? null,
    organizationId: over.organizationId ?? null,
    teamIds: over.teamIds ?? [],
    projectIds: over.projectIds,
    vendorScope: over.vendorScope,
    platformRole: over.platformRole,
  };
}

describe("manifestVisibleToScope", () => {
  it("platform rows are visible to everyone (even an empty scope)", () => {
    expect(manifestVisibleToScope(manifest({ ownerLevel: "platform" }), scope())).toBe(true);
  });

  it("workspace rows are visible to everyone", () => {
    expect(manifestVisibleToScope(manifest({ ownerLevel: "workspace" }), scope())).toBe(true);
  });

  it("organization rows require a matching active org", () => {
    const m = manifest({ ownerLevel: "organization", organizationId: "org-1" });
    expect(manifestVisibleToScope(m, scope({ organizationId: "org-1" }))).toBe(true);
    expect(manifestVisibleToScope(m, scope({ organizationId: "org-2" }))).toBe(false);
    expect(manifestVisibleToScope(m, scope({ organizationId: null }))).toBe(false);
  });

  it("team rows require matching org AND team membership", () => {
    const m = manifest({ ownerLevel: "team", organizationId: "org-1", ownerId: "team-a" });
    expect(
      manifestVisibleToScope(m, scope({ organizationId: "org-1", teamIds: ["team-a"] })),
    ).toBe(true);
    // right org, wrong team
    expect(
      manifestVisibleToScope(m, scope({ organizationId: "org-1", teamIds: ["team-b"] })),
    ).toBe(false);
    // right team id, wrong org
    expect(
      manifestVisibleToScope(m, scope({ organizationId: "org-2", teamIds: ["team-a"] })),
    ).toBe(false);
  });

  it("user rows require the owning user", () => {
    const m = manifest({ ownerLevel: "user", ownerId: "user-1" });
    expect(manifestVisibleToScope(m, scope({ userId: "user-1" }))).toBe(true);
    expect(manifestVisibleToScope(m, scope({ userId: "user-2" }))).toBe(false);
    expect(manifestVisibleToScope(m, scope({ userId: null }))).toBe(false);
  });

  it("fails closed on an unknown owner level", () => {
    expect(manifestVisibleToScope(manifest({ ownerLevel: "galaxy" }), scope())).toBe(false);
  });

  it("never matches null owner/org ids by coincidence", () => {
    // org manifest with null org must not match a null-org scope.
    const m = manifest({ ownerLevel: "organization", organizationId: null });
    expect(manifestVisibleToScope(m, scope({ organizationId: null }))).toBe(false);
  });
});

describe("visibleManifestPackageNames", () => {
  it("returns only the visible package names, deduped", () => {
    const manifests = [
      manifest({ packageName: "@x/platform", ownerLevel: "platform" }),
      manifest({ packageName: "@x/org-mine", ownerLevel: "organization", organizationId: "org-1" }),
      manifest({ packageName: "@x/org-other", ownerLevel: "organization", organizationId: "org-2" }),
      manifest({ packageName: "@x/platform", ownerLevel: "platform" }), // dup name
    ];
    const names = visibleManifestPackageNames(manifests, scope({ organizationId: "org-1" }));
    expect([...names].sort()).toEqual(["@x/org-mine", "@x/platform"]);
  });
});
