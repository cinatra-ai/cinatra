import "server-only";
/**
 * The PERSONAL scope's Dashboards tab body (cinatra#2807 fix leg 3).
 *
 * The ratified drawing's Dashboards-tab section gives this scope the same tab
 * body every other scope gets — "On a personal scope the tab shows the acting
 * user's own dashboards" — drawn as the caption "The dashboards you own." over
 * the same row anatomy (glyph, name, updated time, Open), and the same empty
 * reading. It carries NO Add: "a personal user scope and the whole-workspace
 * scope are not add-to-scope targets — they carry no Add".
 *
 * It replaces the multi-dashboard CANVAS this landing rendered before: an
 * Overview selector, a "+ New dashboard" toolbar band and a rendered dashboard
 * grid inside a page-wide dashed frame. None of those is drawn on this tab, and
 * the section is explicit that the tab POINTS — "Open navigates to the
 * dashboard's canonical surface … the tab points, it never renders a dashboard
 * inline".
 */
import { getPersonalDashboardsTabData } from "@/lib/dashboards/scope-dashboards-service";
import { ScopeDashboardsTab, ScopeDashboardsTabError } from "./scope-dashboards-tab";
import type { ScopeDashboardsTabData } from "./scope-dashboards-contract";

export async function PersonalDashboardsSection({
  orgId,
  userId,
}: {
  readonly orgId: string;
  readonly userId: string;
}) {
  // Contain a store failure in the DESIGNED error frame rather than bubbling an
  // unhandled 500 through the landing — the same containment the shared scopes'
  // section applies.
  let data: ScopeDashboardsTabData;
  try {
    data = await getPersonalDashboardsTabData({ orgId, userId });
  } catch (err) {
    console.error("[scope-dashboards] failed to load the personal scope:", err);
    return <ScopeDashboardsTabError />;
  }
  // No `removal` and no `add`: a personal row is always homed here, so no row
  // can carry Remove, and the scope is not an add-to-scope target.
  return <ScopeDashboardsTab data={data} caption={{ kind: "own" }} />;
}
