// cinatra#2694 / S3 #2697 — the workspace-anchor recognition rule.
//
// Four seams key on this predicate (the install chokepoint, the two canonical
// connector-access resolvers, and the runtime card record's anchor/discovery
// path). These pin the rule itself so a drift shows up here rather than as one
// surface silently fencing out a "Workspace: All" install.

import { describe, it, expect } from "vitest";
import {
  isWorkspaceAnchoredRow,
  workspaceAnchorIdentity,
} from "../canonical-types";
import { WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "../install-access-target";
import { PLATFORM_OWNER_SENTINEL } from "../canonical-types";

describe("isWorkspaceAnchoredRow — the S1 contract tuple, and nothing else", () => {
  it("ACCEPTS the exact contract tuple S1 resolves for the two workspace targets", () => {
    expect(isWorkspaceAnchoredRow(WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toBe(true);
  });

  it("ACCEPTS a null owner_id (the canonical store platformizes it to the sentinel on write)", () => {
    expect(
      isWorkspaceAnchoredRow({ ownerLevel: "workspace", ownerId: null, organizationId: null }),
    ).toBe(true);
  });

  it("REJECTS a workspace row that carries an owning organization", () => {
    expect(
      isWorkspaceAnchoredRow({
        ownerLevel: "workspace",
        ownerId: PLATFORM_OWNER_SENTINEL,
        organizationId: "org-1",
      }),
    ).toBe(false);
  });

  it("REJECTS a workspace row owned by anything but the platform sentinel", () => {
    expect(
      isWorkspaceAnchoredRow({ ownerLevel: "workspace", ownerId: "org-1", organizationId: null }),
    ).toBe(false);
  });

  it("REJECTS the PLATFORM tier — bundled/system rows are not this anchor", () => {
    expect(
      isWorkspaceAnchoredRow({
        ownerLevel: "platform",
        ownerId: PLATFORM_OWNER_SENTINEL,
        organizationId: null,
      }),
    ).toBe(false);
  });

  it("REJECTS the organization / team / user tiers", () => {
    for (const ownerLevel of ["organization", "team", "user"]) {
      expect(
        isWorkspaceAnchoredRow({ ownerLevel, ownerId: "x", organizationId: null }),
        ownerLevel,
      ).toBe(false);
    }
  });
});

describe("workspaceAnchorIdentity — the fallback read key", () => {
  it("is the S1 contract tuple plus the package name", () => {
    expect(workspaceAnchorIdentity("@acme/thing")).toEqual({
      organizationId: null,
      ownerLevel: WORKSPACE_ANCHOR_ROW_OWNERSHIP.ownerLevel,
      ownerId: WORKSPACE_ANCHOR_ROW_OWNERSHIP.ownerId,
      packageName: "@acme/thing",
    });
  });

  it("the identity it produces is itself a workspace-anchored row shape", () => {
    expect(isWorkspaceAnchoredRow(workspaceAnchorIdentity("@acme/thing"))).toBe(true);
  });
});
