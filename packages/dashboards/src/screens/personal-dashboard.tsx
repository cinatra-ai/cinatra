/**
 * `/personal` screen — the personal scope's entity page, opening on its
 * Dashboards tab (cinatra#703; the tab body rebuilt to the ratified drawing by
 * cinatra#2807 fix leg 3).
 *
 * WHAT THIS TAB DRAWS. The ratified drawing's Dashboards-tab section fixes it:
 * "On a personal scope the tab shows the acting user's own dashboards", under
 * the caption "The dashboards you own.", with the same row anatomy every scope
 * uses — a leading dashboard glyph, the name, the updated time, and an Open
 * affordance — and with no Add at all, because "a personal user scope and the
 * whole-workspace scope are not add-to-scope targets — they carry no Add".
 *
 * WHAT IT NO LONGER DRAWS, and why. This landing used to mount the reusable
 * multi-dashboard shell: an Overview selector, a "+ New dashboard" toolbar band,
 * and a dashboard rendered INLINE inside a page-wide dashed frame. None of that
 * is drawn on this tab. The section says the tab POINTS — "Open navigates to the
 * dashboard's canonical surface exactly as in §VIII — the tab points, it never
 * renders a dashboard inline" — the Application Design page section forbids the
 * frame in those words ("no bespoke panel, and no page-wide dashed frame"), and
 * the Dashboards-tab section rules out the disabled management control by name
 * ("Suppression, not a disabled control"). Each dashboard is edited on its own
 * canonical surface, which the rows Open.
 */
import "server-only";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { PersonalDashboardsSection } from "@/components/dashboards/personal-dashboards-section";

import { getAuthSession, signInRedirectTarget } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";

export async function PersonalDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect(await signInRedirectTarget());
  }

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Your scope"
        title="Personal"
        description="Your own dashboards."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Personal has no Settings pane (#1904), so its entity-page tablist
            ends at Skills — the five scope tabs without Settings (#2807). */}
        <EntityScopeTabs
          dashboardsHref="/personal"
          assistantsHref="/personal/assistants"
          agentsHref="/personal/agents"
          artifactsHref="/personal/artifacts"
          skillsHref="/personal/skills"
          active="dashboards"
        />
        {/* The Dashboards tab body: the acting user's own dashboards, listed. */}
        <PersonalDashboardsSection
          orgId={ctx.organizationId}
          userId={ctx.userId}
        />
      </PageContent>
    </Main>
  );
}
