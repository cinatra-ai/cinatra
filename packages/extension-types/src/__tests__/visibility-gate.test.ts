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
    orgRole: over.orgRole,
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

describe("manifestVisibleToScope — admin standing (P3)", () => {
  it("platform_admin sees every row (cross-org, non-member team, non-owner user)", () => {
    const pa = scope({ organizationId: "org-1", userId: "user-x", platformRole: "platform_admin" });
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "organization", organizationId: "org-2" }),
        pa,
      ),
    ).toBe(true);
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "team", organizationId: "org-2", ownerId: "team-z" }),
        pa,
      ),
    ).toBe(true);
    expect(
      manifestVisibleToScope(manifest({ ownerLevel: "user", ownerId: "user-y" }), pa),
    ).toBe(true);
  });

  it("org_admin sees team + user rows of their OWN org without membership/ownership", () => {
    const admin = scope({ organizationId: "org-1", userId: "user-1", orgRole: "org_admin" });
    // team row of the org, admin not on the team
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "team", organizationId: "org-1", ownerId: "team-a" }),
        admin,
      ),
    ).toBe(true);
    // user row of the org owned by someone else
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "user", organizationId: "org-1", ownerId: "user-2" }),
        admin,
      ),
    ).toBe(true);
  });

  it("org_owner has the same standing as org_admin", () => {
    const owner = scope({ organizationId: "org-1", userId: "user-1", orgRole: "org_owner" });
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "user", organizationId: "org-1", ownerId: "user-2" }),
        owner,
      ),
    ).toBe(true);
  });

  it("org_admin does NOT reach across orgs (cross-org safety)", () => {
    const admin = scope({ organizationId: "org-1", userId: "user-1", orgRole: "org_admin" });
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "user", organizationId: "org-2", ownerId: "user-2" }),
        admin,
      ),
    ).toBe(false);
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "team", organizationId: "org-2", ownerId: "team-a" }),
        admin,
      ),
    ).toBe(false);
  });

  it("org_admin does NOT admit an unknown owner level (stays fail-closed)", () => {
    const admin = scope({ organizationId: "org-1", orgRole: "org_admin" });
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "galaxy", organizationId: "org-1" }),
        admin,
      ),
    ).toBe(false);
  });

  it("a plain member gains no admin standing (owner/member rules unchanged)", () => {
    const member = scope({ organizationId: "org-1", userId: "user-1", orgRole: "member" });
    // user row of a different user in the same org: still invisible to a member
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "user", organizationId: "org-1", ownerId: "user-2" }),
        member,
      ),
    ).toBe(false);
    // team row where the member is not on the team: invisible
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "team", organizationId: "org-1", ownerId: "team-a" }),
        member,
      ),
    ).toBe(false);
  });

  it("an org-less user row is admin-invisible except to platform_admin", () => {
    const orgAdmin = scope({ organizationId: "org-1", orgRole: "org_admin" });
    const m = manifest({ ownerLevel: "user", organizationId: null, ownerId: "user-2" });
    // no org to be an admin of ⇒ org_admin has no standing
    expect(manifestVisibleToScope(m, orgAdmin)).toBe(false);
    // platform_admin still sees it
    expect(
      manifestVisibleToScope(m, scope({ platformRole: "platform_admin" })),
    ).toBe(true);
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
