// ---------------------------------------------------------------------------
// §II "Update plan (dry-run)" — the WIRE shape + pure render derivations
// (cinatra#1041 outcome 2).
//
// The dry-run server action (`planExtensionUpdateFormAction`) returns this DTO;
// the modal-footer flow (`ModalUpdatePlanFlow`) renders it per the design
// drawing: every affected member grouped by what happens to it — Update /
// Install / Side-by-side / Rebound — with displayNames, version transitions
// and the per-group explanatory note. PURE module (no React, no server deps)
// so the note/name derivations are unit-testable and importable from both the
// server action and the client component.
// ---------------------------------------------------------------------------

import type { MarketplaceInstallActionResult } from "./marketplace-failure-copy";

export type UpdatePlanMemberAction = "update" | "install" | "side-by-side" | "rebound";

export type UpdatePlanPreviewMemberDto = {
  packageName: string;
  /** Manifest `cinatra.displayName` when the server could resolve it. */
  displayName: string | null;
  action: UpdatePlanMemberAction;
  fromVersion: string | null;
  toVersion: string | null;
  /** For a rebound member: the shared dependency it is re-pointed to (always
   *  itself a member of the plan). */
  reboundToPackageName: string | null;
  isRoot: boolean;
};

export type UpdatePlanPreviewDto = {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  members: UpdatePlanPreviewMemberDto[];
};

/** What the dry-run server action returns: the plan, or a #685 category. */
export type PlanExtensionUpdateResult =
  | { ok: true; plan: UpdatePlanPreviewDto }
  | MarketplaceInstallActionResult;

/**
 * Rendered name (§II drawing: names are displayNames): the server-resolved
 * manifest displayName, else the card's displayName for the root, else the
 * package name (an honest fallback — never an empty cell).
 */
export function updatePlanMemberName(
  member: Pick<UpdatePlanPreviewMemberDto, "displayName" | "isRoot" | "packageName">,
  rootDisplayName: string,
): string {
  if (member.displayName && member.displayName.trim()) return member.displayName;
  if (member.isRoot && rootDisplayName.trim()) return rootDisplayName;
  return member.packageName;
}

/**
 * The muted explanatory note after the member's version transition, per the
 * §II drawing's four groups. Null for the root update (its row carries only
 * the version transition).
 */
export function updatePlanMemberNote(
  member: UpdatePlanPreviewMemberDto,
  allMembers: UpdatePlanPreviewMemberDto[],
  rootDisplayName: string,
): string | null {
  switch (member.action) {
    case "update":
      return member.isRoot ? null : "shared dependency, upgraded in place (dedupe-upward)";
    case "install":
      return "new dependency";
    case "side-by-side":
      return member.fromVersion
        ? `kept beside v${member.fromVersion} (ranges disjoint)`
        : "kept side by side (ranges disjoint)";
    case "rebound": {
      const target = allMembers.find(
        (m) => m.packageName === member.reboundToPackageName && m.action === "update",
      );
      const targetName = target
        ? updatePlanMemberName(target, rootDisplayName)
        : (member.reboundToPackageName ?? "the upgraded dependency");
      const targetVersion = target?.toVersion ? ` v${target.toVersion}` : "";
      return `re-pointed to ${targetName}${targetVersion}`;
    }
  }
}

/**
 * The mono version transition cell: "v0.1.2 → v0.1.5" for an update,
 * "v2.0.0" for a fresh install / side-by-side member, nothing for a rebound
 * (its own version does not change).
 */
export function updatePlanMemberVersionLabel(
  member: Pick<UpdatePlanPreviewMemberDto, "action" | "fromVersion" | "toVersion">,
): string | null {
  if (member.action === "rebound") return null;
  if (member.action === "update" && member.fromVersion && member.toVersion) {
    return `v${member.fromVersion} → v${member.toVersion}`;
  }
  return member.toVersion ? `v${member.toVersion}` : null;
}
