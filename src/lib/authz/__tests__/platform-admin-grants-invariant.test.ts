/**
 * platform_admin DIRECT_GRANTS invariant.
 *
 * platform_admin write powers on user-owned resources must flow ONLY through
 * the auditable `withPlatformAdminBypass` helper — never as silent grants in
 * the EFFECTIVE_GRANTS table.
 *
 * This test fails CI if any resource-CRUD permission (matching the verb
 * regex below) is added back to platform_admin outside the explicit
 * 4-entry allow-list.
 */
import { describe, it, expect } from "vitest";
import { EFFECTIVE_GRANTS } from "@/lib/authz";

describe("authz — platform_admin invariant", () => {
  it("platform_admin holds no resource-CRUD grants outside the platform-power allow-list", () => {
    // `create` is intentionally excluded — project.create is deliberate
    // platform scaffolding, not a resource-CRUD bypass. Do not add 'create'
    // to this regex without revalidating that invariant.
    const RESOURCE_CRUD_VERB =
      /\.(update|delete|share|managePermissions|manageMembers|manageVisibility|execute|editOutput|approveHitl|respondToHitl|cancel|resume|promoteScope|assign)$/;

    // Per-scope assignment authority (cinatra#2813 S1, epic #2812) is covered
    // EXPLICITLY. `context.assign` already matches the verb regex above by its
    // suffix; `agent.assignments.manage` does not match any verb in it, so
    // without this list it could be granted silently. Platform admins configure
    // assignments only through withPlatformAdminBypass
    // (workspace_configuration / scope_configuration).
    const NEVER_GRANTABLE_TO_PLATFORM_ADMIN = [
      "agent.assignments.manage",
      "context.assign",
    ];

    // Allow-list — platform-level powers, not resource CRUD on user data:
    //   - registry.{install,update,uninstall} are platform-level powers
    //   - settings.update is platform-level (not user-resource CRUD)
    //   - operations.execute is the platform-level destructive-operator power
    //     (background-job retry/remove/clean/promote/pause). It matches the
    //     `.execute$` verb but is a platform power, not user-resource CRUD.
    const ALLOW_LIST = new Set<string>([
      "registry.install",
      "registry.update",
      "registry.uninstall",
      "settings.update",
      "operations.execute",
    ]);

    const offenders: string[] = [];
    for (const perm of EFFECTIVE_GRANTS.platform_admin) {
      if (RESOURCE_CRUD_VERB.test(perm) && !ALLOW_LIST.has(perm)) {
        offenders.push(perm);
      }
    }

    for (const perm of NEVER_GRANTABLE_TO_PLATFORM_ADMIN) {
      if (EFFECTIVE_GRANTS.platform_admin.includes(perm as never) && !offenders.includes(perm)) {
        offenders.push(perm);
      }
    }

    expect(
      offenders,
      `platform_admin DIRECT_GRANTS regressed. Use withPlatformAdminBypass for moderation, GDPR, ownership transfer, etc. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("neither per-scope assignment permission is granted to platform_admin", () => {
    // The positive statement of the same rule, so a reader of this file sees
    // the two names rather than having to derive them from a regex.
    for (const perm of ["agent.assignments.manage", "context.assign"]) {
      expect(
        EFFECTIVE_GRANTS.platform_admin.includes(perm as never),
        `platform_admin must not hold "${perm}" — it acts through the audited bypass`,
      ).toBe(false);
    }
  });

  it("allow-list members (registry.* and settings.update) are present in platform_admin grants", () => {
    // Positive cases — guarantees the allow-list isn't just compensating for
    // permissions that were silently removed. Each entry must currently be
    // granted to platform_admin via DIRECT_GRANTS.
    const required = [
      "registry.install",
      "registry.update",
      "registry.uninstall",
      "settings.update",
      "operations.execute",
    ];
    for (const perm of required) {
      expect(
        EFFECTIVE_GRANTS.platform_admin.includes(perm as never),
        `platform_admin should grant "${perm}" via the allow-list (platform-level)`,
      ).toBe(true);
    }
  });
});
