/**
 * cinatra#3204 criterion 16 — the chosen scope reaches a kind's NATIVE
 * ownership, not only the canonical row.
 *
 * The mapping lives beside `resolveInstallRowAnchor`, whose decision it defers
 * to, so the native row and the canonical row can never be anchored by two
 * different rules.
 */
import { describe, expect, it } from "vitest";

import { resolveNativeInstallOwnership } from "../canonical-types";

describe("resolveNativeInstallOwnership", () => {
  it("keeps today's behaviour when no anchor is planned", () => {
    expect(resolveNativeInstallOwnership("org_1")).toEqual({ anchorOrgId: "org_1" });
    expect(resolveNativeInstallOwnership(null)).toEqual({ anchorOrgId: null });
  });

  it("carries a workspace-anchored install to the workspace owner tier with no org", () => {
    const ownership = resolveNativeInstallOwnership("org_1", {
      ownerLevel: "workspace",
      ownerId: null,
      organizationId: null,
    });
    expect(ownership.anchorOrgId).toBeNull();
    expect(ownership.ownerLevel).toBe("workspace");
    // The canonical platform sentinel is never leaked into a native owner id.
    expect(ownership.ownerId).toBeUndefined();
  });

  it("carries an organization-anchored install to the organization owner tier", () => {
    expect(
      resolveNativeInstallOwnership("org_1", {
        ownerLevel: "organization",
        ownerId: "org_1",
        organizationId: "org_1",
      }),
    ).toEqual({ anchorOrgId: "org_1", ownerLevel: "organization", ownerId: "org_1" });
  });

  it("drops the owner tier for a platform anchor, which no native store has a tier for", () => {
    expect(
      resolveNativeInstallOwnership(null, {
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
      }),
    ).toEqual({ anchorOrgId: null });
  });

  it("never lets a planned anchor's org be overridden by the actor's org", () => {
    expect(
      resolveNativeInstallOwnership("org_actor", {
        ownerLevel: "organization",
        ownerId: "org_target",
        organizationId: "org_target",
      }).anchorOrgId,
    ).toBe("org_target");
  });
});
