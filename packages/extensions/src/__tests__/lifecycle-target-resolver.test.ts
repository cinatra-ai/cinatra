import { describe, it, expect } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";
import {
  pickLifecycleTargetRow,
  actorHasWriteStandingOverRow,
  actorStandingRole,
  isPlatformAdminActor,
  assertActorWriteStandingOverRow,
  resolvedRowIdentity,
  lifecycleTransitionLabel,
  NoAddressableRowError,
  AmbiguousLifecycleTargetError,
  LifecycleStandingError,
} from "../lifecycle-target-resolver";

// ---------------------------------------------------------------------------
// Pure resolver + standing primitives (P5, cinatra#1130). No DB — these pin the
// org-equality resolution + the NULL-org-is-platform-admin-only write rule that
// closes the P3 read-standing leak for destructive writes.
// ---------------------------------------------------------------------------

const PKG = "@acme/thing";

function row(
  id: string,
  organizationId: string | null,
  extra: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    id,
    packageName: PKG,
    ownerLevel: organizationId == null ? "platform" : "organization",
    ownerId: organizationId,
    organizationId,
    kind: "agent",
    status: "active",
    source: { type: "verdaccio", version: "1.0.0" } as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

const platformAdmin = (orgId: string | null = null): Actor => ({
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
  ...(orgId != null ? { orgId } : {}),
});
const orgAdmin = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-org",
  source: "ui",
  orgId,
  orgRole: "org_admin",
});
const orgOwner = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-owner",
  source: "ui",
  orgId,
  orgRole: "org_owner",
});
const member = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-mem",
  source: "ui",
  orgId,
  orgRole: "member",
});

describe("actorHasWriteStandingOverRow", () => {
  it("platform admin has standing over any row incl NULL-org", () => {
    expect(actorHasWriteStandingOverRow(platformAdmin(), null)).toBe(true);
    expect(actorHasWriteStandingOverRow(platformAdmin(), "org-x")).toBe(true);
  });
  it("org admin/owner has standing ONLY over their own org's row", () => {
    expect(actorHasWriteStandingOverRow(orgAdmin("org-x"), "org-x")).toBe(true);
    expect(actorHasWriteStandingOverRow(orgOwner("org-x"), "org-x")).toBe(true);
    expect(actorHasWriteStandingOverRow(orgAdmin("org-x"), "org-y")).toBe(false);
  });
  it("NULL-org row: an org admin NEVER has write standing (P3-read-vs-P5-write)", () => {
    expect(actorHasWriteStandingOverRow(orgAdmin("org-x"), null)).toBe(false);
    expect(actorHasWriteStandingOverRow(orgOwner("org-x"), null)).toBe(false);
  });
  it("plain member has no standing over any row", () => {
    expect(actorHasWriteStandingOverRow(member("org-x"), "org-x")).toBe(false);
    expect(actorHasWriteStandingOverRow(member("org-x"), null)).toBe(false);
  });
});

describe("actorStandingRole", () => {
  it("reports the authorizing role", () => {
    expect(actorStandingRole(platformAdmin(), "org-x")).toBe("platform_admin");
    expect(actorStandingRole(orgOwner("org-x"), "org-x")).toBe("org_owner");
    expect(actorStandingRole(orgAdmin("org-x"), "org-x")).toBe("org_admin");
    expect(actorStandingRole(orgAdmin("org-x"), "org-y")).toBeNull();
    expect(actorStandingRole(orgAdmin("org-x"), null)).toBeNull();
  });
});

describe("isPlatformAdminActor", () => {
  it("keys on platformRole", () => {
    expect(isPlatformAdminActor(platformAdmin())).toBe(true);
    expect(isPlatformAdminActor(orgAdmin("org-x"))).toBe(false);
  });
});

describe("pickLifecycleTargetRow (org-equality only)", () => {
  const rows = [row("iext-p", null), row("iext-x", "org-x"), row("iext-y", "org-y")];

  it("org-X actor resolves ONLY org-X's row (never org-Y, never platform)", () => {
    expect(pickLifecycleTargetRow(rows, orgAdmin("org-x")).id).toBe("iext-x");
    expect(pickLifecycleTargetRow(rows, orgAdmin("org-y")).id).toBe("iext-y");
  });

  it("platform admin with no org context resolves the NULL-org platform row", () => {
    expect(pickLifecycleTargetRow(rows, platformAdmin()).id).toBe("iext-p");
  });

  it("platform admin with an active org context resolves that org's row (targetOrgId=actor.orgId)", () => {
    expect(pickLifecycleTargetRow(rows, platformAdmin("org-y")).id).toBe("iext-y");
  });

  it("F1/F5: an org actor whose org has NO row -> NoAddressableRowError (no fallthrough)", () => {
    const onlyOrgB = [row("iext-b", "org-b")];
    expect(() => pickLifecycleTargetRow(onlyOrgB, orgAdmin("org-a"))).toThrow(
      NoAddressableRowError,
    );
  });

  it("F2: an org actor NEVER selects the NULL-org row even when only a platform row exists", () => {
    const onlyPlatform = [row("iext-p", null)];
    expect(() => pickLifecycleTargetRow(onlyPlatform, orgAdmin("org-a"))).toThrow(
      NoAddressableRowError,
    );
  });

  it("F7: platform admin, no org context, no NULL-org row -> NoAddressableRowError (never picks an org row)", () => {
    const orgsOnly = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    expect(() => pickLifecycleTargetRow(orgsOnly, platformAdmin())).toThrow(
      NoAddressableRowError,
    );
  });

  it("F6: two rows for the same (package, org) scope -> AmbiguousLifecycleTargetError", () => {
    const dup = [row("iext-x1", "org-x"), row("iext-x2", "org-x")];
    expect(() => pickLifecycleTargetRow(dup, orgAdmin("org-x"))).toThrow(
      AmbiguousLifecycleTargetError,
    );
  });
});

describe("assertActorWriteStandingOverRow", () => {
  it("throws for a member over their own org row", () => {
    expect(() =>
      assertActorWriteStandingOverRow(member("org-x"), row("iext-x", "org-x")),
    ).toThrow(LifecycleStandingError);
  });
  it("passes for an org admin over their own org row", () => {
    expect(() =>
      assertActorWriteStandingOverRow(orgAdmin("org-x"), row("iext-x", "org-x")),
    ).not.toThrow();
  });
});

describe("resolvedRowIdentity + lifecycleTransitionLabel", () => {
  it("captures the row identity fields", () => {
    expect(resolvedRowIdentity(row("iext-x", "org-x"))).toEqual({
      id: "iext-x",
      organizationId: "org-x",
      ownerLevel: "organization",
      ownerId: "org-x",
    });
  });
  it("labels carry standing role + scope + row id", () => {
    expect(lifecycleTransitionLabel(orgAdmin("org-x"), "archive", row("iext-x", "org-x"))).toBe(
      "org_admin archive of org org-x row iext-x",
    );
    expect(lifecycleTransitionLabel(platformAdmin(), "uninstall", row("iext-p", null))).toBe(
      "platform_admin uninstall of platform (NULL-org) row iext-p",
    );
  });
});
