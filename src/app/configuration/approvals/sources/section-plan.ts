import type { ApprovalSource, ApprovalViewer, Direction } from "./types";

// ---------------------------------------------------------------------------
// Pure section planner for one direction tab. Imports ONLY types, so it is unit
// tested with fake sources — no server-only / DB / marketplace-client chain.
//
// It partitions the direction's applicable sources into:
//   • local        — ungrouped sources (always render their own section);
//   • groupReady    — grouped sources whose per-section credential is present
//                     (`sectionConfigured` true/absent) → render a section;
//   • groupHidden   — grouped sources whose per-section credential is absent
//                     (`sectionConfigured` false) → surface ONE footer hint so a
//                     misconfiguration is discoverable, never silently masked;
//   • showGroupEmpty — the group has applicable sources but NOTHING is connected
//                     → collapse the WHOLE group to one "not connected" Empty and
//                     fire zero remote calls.
//
// `group.connected` is a caller-supplied pure predicate (no network); when it is
// false the planner returns `showGroupEmpty` WITHOUT consulting `sectionConfigured`
// (nothing is configured when nothing is connected).
// ---------------------------------------------------------------------------

export interface ApprovalSectionPlan {
  local: ApprovalSource[];
  groupReady: ApprovalSource[];
  groupHidden: ApprovalSource[];
  showGroupEmpty: boolean;
}

export function planApprovalSections(
  applicable: ApprovalSource[],
  viewer: ApprovalViewer,
  direction: Direction,
  group: { tag: string; connected: boolean },
): ApprovalSectionPlan {
  const local = applicable.filter((s) => s.group !== group.tag);
  const grouped = applicable.filter((s) => s.group === group.tag);

  if (grouped.length === 0) {
    return { local, groupReady: [], groupHidden: [], showGroupEmpty: false };
  }
  if (!group.connected) {
    return { local, groupReady: [], groupHidden: [], showGroupEmpty: true };
  }

  const groupReady = grouped.filter((s) => s.sectionConfigured?.(viewer, direction) ?? true);
  const groupHidden = grouped.filter((s) => !(s.sectionConfigured?.(viewer, direction) ?? true));
  return { local, groupReady, groupHidden, showGroupEmpty: false };
}

/** True when a direction has nothing to render at all — no local section, no
 *  ready group section, no hidden-section footer, and no group-empty. Drives the
 *  page's top-level "nothing yet" Empty for the direction. */
export function isEmptyPlan(plan: ApprovalSectionPlan): boolean {
  return (
    plan.local.length === 0 &&
    plan.groupReady.length === 0 &&
    plan.groupHidden.length === 0 &&
    !plan.showGroupEmpty
  );
}
