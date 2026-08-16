/**
 * The §V RE-ANCHOR rules (cinatra#2694 / S5 #2802) — the PURE half.
 *
 * Owner ruling 2026-08-16 (entry 350): "§V re-anchors". Saving the settings
 * page's access picker MOVES the canonical row's anchor. Two decisions carry
 * that move, and both are arithmetic:
 *
 *   1. WHERE does the saved audience anchor the row? (`resolveReanchorDestination`)
 *   2. Is the destination identity/default slot FREE? (`findReanchorConflict`)
 *
 * plus the installed-connector ceiling that can veto the audience before either
 * runs. This suite pins all three without a database; the DB tier
 * (install-semantics-reanchor.integration.test.ts) proves the same rules against
 * the real partial unique indexes.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  findReanchorConflict,
  installedAudienceWithinDeclaredCeiling,
  organizationRowAnchor,
  policyWidensToWorkspaceAnchor,
  sameRowAnchor,
  PLATFORM_OWNER_SENTINEL,
  WORKSPACE_ANCHOR_ROW_OWNERSHIP,
  type ReanchorRowView,
} from "../canonical-types";

const PKG = "@cinatra-ai/reanchor-rules-2802";
const ORG_A = "org-a-2802";
const ORG_B = "org-b-2802";

function row(over: Partial<ReanchorRowView> & { id: string }): ReanchorRowView {
  return {
    packageName: PKG,
    ownerLevel: "organization",
    ownerId: ORG_A,
    organizationId: ORG_A,
    version: "1.0.0",
    isDefault: true,
    ...over,
  };
}

const WORKSPACE_ROW = {
  ownerLevel: "workspace",
  ownerId: PLATFORM_OWNER_SENTINEL,
  organizationId: null,
} as const;
const PLATFORM_ROW = {
  ownerLevel: "platform",
  ownerId: PLATFORM_OWNER_SENTINEL,
  organizationId: null,
} as const;

// ---------------------------------------------------------------------------
describe("cinatra#2802 — which audience widens", () => {
  it("treats workspace and admin as the widening audiences", () => {
    expect(policyWidensToWorkspaceAnchor(["workspace"])).toBe(true);
    expect(policyWidensToWorkspaceAnchor(["admin"])).toBe(true);
    // Mixed selections still widen: an organization-anchored row cannot deliver
    // either audience, so the anchor has to move.
    expect(policyWidensToWorkspaceAnchor([`team:t1`, "admin"])).toBe(true);
  });

  it("treats every concrete locus and owner-only as narrowing", () => {
    expect(policyWidensToWorkspaceAnchor(["owner"])).toBe(false);
    expect(policyWidensToWorkspaceAnchor([`org:${ORG_A}`])).toBe(false);
    expect(policyWidensToWorkspaceAnchor([`team:t1`, `project:p1`])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — anchor equality", () => {
  it("reads a null owner id at an org-NULL tier as the platform sentinel", () => {
    expect(
      sameRowAnchor(
        { ownerLevel: "workspace", ownerId: null, organizationId: null },
        WORKSPACE_ANCHOR_ROW_OWNERSHIP,
      ),
    ).toBe(true);
  });

  it("separates the workspace anchor from the bundled platform anchor", () => {
    expect(sameRowAnchor(WORKSPACE_ROW, PLATFORM_ROW)).toBe(false);
  });

  it("separates two organizations", () => {
    expect(sameRowAnchor(organizationRowAnchor(ORG_A), organizationRowAnchor(ORG_B))).toBe(
      false,
    );
    expect(sameRowAnchor(organizationRowAnchor(ORG_A), organizationRowAnchor(ORG_A))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — the destination identity/default slot", () => {
  const moved = row({ id: "moved" });

  it("admits a free workspace destination beside a bundled platform row", () => {
    const rows = [moved, row({ id: "bundled", ...PLATFORM_ROW })];
    expect(findReanchorConflict(rows, moved, WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toBeNull();
  });

  it("refuses when a workspace row of the same version already exists", () => {
    const rows = [moved, row({ id: "ws", ...WORKSPACE_ROW })];
    expect(findReanchorConflict(rows, moved, WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toEqual({
      rowId: "ws",
      reason: "identity",
    });
  });

  it("refuses an ARCHIVED occupant exactly as it refuses a live one", () => {
    // Status is absent from the row view ON PURPOSE: none of the four partial
    // unique indexes filters on it, so an archived row occupies its slot.
    const rows = [moved, row({ id: "archived-ws", ...WORKSPACE_ROW })];
    expect(findReanchorConflict(rows, moved, WORKSPACE_ANCHOR_ROW_OWNERSHIP)?.rowId).toBe(
      "archived-ws",
    );
  });

  it("refuses the one-default slot when a DIFFERENT version already holds it", () => {
    const rows = [moved, row({ id: "ws-other-v", ...WORKSPACE_ROW, version: "2.0.0" })];
    expect(findReanchorConflict(rows, moved, WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toEqual({
      rowId: "ws-other-v",
      reason: "default",
    });
  });

  it("admits a non-default move beside a different default version", () => {
    const sideBySide = row({ id: "moved", isDefault: false });
    const rows = [sideBySide, row({ id: "ws-other-v", ...WORKSPACE_ROW, version: "2.0.0" })];
    expect(findReanchorConflict(rows, sideBySide, WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toBeNull();
  });

  it("refuses narrowing into an organization that already holds a row", () => {
    const workspaceMoved = row({ id: "moved", ...WORKSPACE_ROW });
    const rows = [workspaceMoved, row({ id: "org-b", ownerLevel: "organization", ownerId: ORG_B, organizationId: ORG_B })];
    expect(findReanchorConflict(rows, workspaceMoved, organizationRowAnchor(ORG_B))).toEqual({
      rowId: "org-b",
      reason: "identity",
    });
  });

  it("ignores the moved row itself and other packages", () => {
    const workspaceMoved = row({ id: "moved", ...WORKSPACE_ROW });
    const rows = [
      workspaceMoved,
      row({ id: "other-pkg", packageName: "@cinatra-ai/other", ...WORKSPACE_ROW }),
    ];
    expect(findReanchorConflict(rows, workspaceMoved, WORKSPACE_ANCHOR_ROW_OWNERSHIP)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — the installed-connector ceiling", () => {
  it("admits owner under every ceiling", () => {
    for (const scope of ["user", "project", "team", "organization", "workspace", "admin"] as const) {
      expect(installedAudienceWithinDeclaredCeiling("owner", scope, ORG_A)).toBe(true);
    }
  });

  it("admits admin-only under a workspace ceiling (a strictly narrower audience)", () => {
    expect(installedAudienceWithinDeclaredCeiling("admin", "workspace", null)).toBe(true);
    expect(installedAudienceWithinDeclaredCeiling("workspace", "workspace", null)).toBe(true);
  });

  it("refuses a workspace audience under an organization ceiling", () => {
    expect(installedAudienceWithinDeclaredCeiling("workspace", "organization", ORG_A)).toBe(
      false,
    );
    expect(installedAudienceWithinDeclaredCeiling("admin", "organization", ORG_A)).toBe(false);
  });

  it("measures an org token against the DESTINATION organization", () => {
    expect(installedAudienceWithinDeclaredCeiling(`org:${ORG_A}`, "organization", ORG_A)).toBe(
      true,
    );
    expect(installedAudienceWithinDeclaredCeiling(`org:${ORG_A}`, "organization", ORG_B)).toBe(
      false,
    );
  });

  it("locks a user-scoped connector to owner-only", () => {
    expect(installedAudienceWithinDeclaredCeiling(`org:${ORG_A}`, "user", ORG_A)).toBe(false);
    expect(installedAudienceWithinDeclaredCeiling("workspace", "user", null)).toBe(false);
  });

  it("admits only admin under an admin ceiling", () => {
    expect(installedAudienceWithinDeclaredCeiling("admin", "admin", null)).toBe(true);
    expect(installedAudienceWithinDeclaredCeiling("workspace", "admin", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("cinatra#2802 — the destination the saved audience resolves to", () => {
  const TEAM_A = "team-a-2802";
  const PROJECT_A = "project-a-2802";
  const PROJECT_B = "project-b-2802";

  const lookups = {
    teamOrganization: async (teamId: string) => (teamId === TEAM_A ? ORG_A : null),
    projectOrganization: async (projectId: string) =>
      projectId === PROJECT_A ? ORG_A : projectId === PROJECT_B ? ORG_B : null,
  };

  async function resolve(tokens: string[], over?: { held?: string[]; active?: string | null }) {
    const { resolveReanchorDestination } = await import("../lifecycle-target-resolver");
    return resolveReanchorDestination(tokens, {
      actorOrganizationIds: over?.held ?? [ORG_A, ORG_B],
      actorActiveOrganizationId: over?.active === undefined ? ORG_A : over.active,
      lookups,
    });
  }

  it("widens to the workspace anchor for workspace and admin", async () => {
    await expect(resolve(["workspace"])).resolves.toEqual({
      ok: true,
      anchor: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });
    await expect(resolve(["admin"])).resolves.toEqual({
      ok: true,
      anchor: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });
  });

  it("narrows to the named organization", async () => {
    await expect(resolve([`org:${ORG_B}`])).resolves.toEqual({
      ok: true,
      anchor: organizationRowAnchor(ORG_B),
    });
  });

  it("walks a team and a project up to their organization", async () => {
    await expect(resolve([`team:${TEAM_A}`])).resolves.toEqual({
      ok: true,
      anchor: organizationRowAnchor(ORG_A),
    });
    await expect(resolve([`project:${PROJECT_B}`])).resolves.toEqual({
      ok: true,
      anchor: organizationRowAnchor(ORG_B),
    });
  });

  it("uses the actor's ACTIVE organization for an owner-only selection", async () => {
    await expect(resolve(["owner"])).resolves.toEqual({
      ok: true,
      anchor: organizationRowAnchor(ORG_A),
    });
  });

  it("refuses a selection that spans two organizations", async () => {
    await expect(resolve([`org:${ORG_A}`, `project:${PROJECT_B}`])).resolves.toEqual({
      ok: false,
      code: "invalid_locus",
    });
  });

  it("refuses a FOREIGN locus the actor does not hold", async () => {
    await expect(resolve([`org:${ORG_B}`, ], { held: [ORG_A] })).resolves.toEqual({
      ok: false,
      code: "invalid_locus",
    });
    await expect(resolve([`project:unknown-project`])).resolves.toEqual({
      ok: false,
      code: "invalid_locus",
    });
  });

  it("refuses the bare legacy org token and any unknown token shape", async () => {
    await expect(resolve(["org"])).resolves.toEqual({ ok: false, code: "invalid_locus" });
    await expect(resolve(["something-else"])).resolves.toEqual({
      ok: false,
      code: "invalid_locus",
    });
  });

  it("refuses an owner-only selection with no active organization", async () => {
    await expect(resolve(["owner"], { active: null })).resolves.toEqual({
      ok: false,
      code: "invalid_locus",
    });
  });
});
