// The dispatcher-side half of the target→ownership contract (cinatra#2694,
// S2 #2696) — `install-access-target.ts` (the row-anchor helpers).
//
// S1 (#2695) proved the CONTRACT (`accessTargetToRowOwnership`); this pins the
// RESOLUTION the write path performs with it:
//   - no threaded tuple → the actor-derived anchor, byte-identical to the
//     pre-#2696 dispatcher behavior AND to `defaultRowOwnership(orgId)`;
//   - a threaded tuple → that tuple verbatim, the installer's active
//     organization ignored;
//   - the workspace anchor is recognized as such (the org-NULL discriminator
//     the install action's rollback branches on).
import { describe, it, expect } from "vitest";

import {
  actorDerivedRowAnchor,
  isWorkspaceRowAnchor,
  resolveInstallRowAnchor,
} from "../install-access-target";
import {
  WORKSPACE_ANCHOR_ROW_OWNERSHIP,
  accessTargetToRowOwnership,
} from "../install-access-target";
import { PLATFORM_OWNER_SENTINEL } from "../canonical-types";

describe("cinatra#2696 — resolveInstallRowAnchor", () => {
  it("with NO planned tuple resolves the actor-derived org anchor (unchanged dispatcher behavior)", () => {
    expect(resolveInstallRowAnchor("org-1")).toEqual({
      ownerLevel: "organization",
      ownerId: "org-1",
      organizationId: "org-1",
    });
  });

  it("with NO planned tuple and NO active org resolves the platform anchor", () => {
    expect(resolveInstallRowAnchor(null)).toEqual({
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
    });
    expect(actorDerivedRowAnchor(null)).toEqual(resolveInstallRowAnchor(null));
  });

  it("undefined and null planned tuples both fall back (a caller may pass either)", () => {
    expect(resolveInstallRowAnchor("org-1", undefined)).toEqual(resolveInstallRowAnchor("org-1", null));
  });

  it("resolves S1's WORKSPACE anchor verbatim — the installer's active org is IGNORED", () => {
    const anchor = resolveInstallRowAnchor("org-1", WORKSPACE_ANCHOR_ROW_OWNERSHIP);
    expect(anchor).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
    // Same anchor from a DIFFERENT installing organization — app-wide by
    // construction (the row carries no owning org to be fenced by).
    expect(resolveInstallRowAnchor("org-2", WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toEqual(anchor);
  });

  it("both workspace TARGETS resolve to the same row anchor through the S1 contract", () => {
    for (const level of ["workspace", "admin"] as const) {
      const planned = accessTargetToRowOwnership({ level, id: "org-1" }, "org-1");
      expect(resolveInstallRowAnchor("org-1", planned)).toEqual({
        ownerLevel: "workspace",
        ownerId: PLATFORM_OWNER_SENTINEL,
        organizationId: null,
      });
    }
  });

  it("an organization/team/project target's tuple resolves to the SAME anchor the actor derives", () => {
    for (const level of ["organization", "team", "project"] as const) {
      const planned = accessTargetToRowOwnership({ level, id: "x" }, "org-1");
      expect(resolveInstallRowAnchor("org-1", planned)).toEqual(resolveInstallRowAnchor("org-1"));
    }
  });

  it("normalizes an org-NULL tuple's ownerId to the platform sentinel the DB CHECK names", () => {
    expect(
      resolveInstallRowAnchor("org-1", {
        ownerLevel: "workspace",
        ownerId: null,
        organizationId: null,
      }),
    ).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
  });
});

describe("cinatra#2696 — isWorkspaceRowAnchor", () => {
  it("is true ONLY for the org-NULL workspace tuple", () => {
    expect(isWorkspaceRowAnchor(WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toBe(true);
    expect(isWorkspaceRowAnchor(actorDerivedRowAnchor("org-1"))).toBe(false);
    expect(isWorkspaceRowAnchor(actorDerivedRowAnchor(null))).toBe(false);
    // A (hypothetical) org-BEARING workspace row is NOT the app-wide anchor —
    // the cross-org guard would fence it, so the rollback must not treat it as one.
    expect(
      isWorkspaceRowAnchor({
        ownerLevel: "workspace",
        ownerId: "org-1",
        organizationId: "org-1",
      }),
    ).toBe(false);
  });
});
