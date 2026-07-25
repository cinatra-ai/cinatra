"use client";

/**
 * The entity-page tablist (cinatra#1897 B4; the ratified design spec at
 * design@0ead5d0c5, `specs/app-artifacts.html` §IX). Every entity page —
 * personal, project, team, organization — opens on a Dashboards tab; the
 * project / team / organization pages carry Settings as the second entry (a
 * personal scope has no Settings pane per #1904, so its tablist is Dashboards
 * alone).
 *
 * Uses the app's canonical underline tablist (Application Design — Components ·
 * Tabs) via `Tabs` / `TabsListRow` / `TabsTrigger`, exactly like
 * `AgentInstanceNav`: each tab is a route link, the active tab is driven by the
 * hosting route (not client state), and the etched paired-line rule runs from
 * the last tab to the page edge. Pair with `<PageHeader divider={false}>` so the
 * tablist rule does not stack with the header rule (design-system §Dividers).
 */
import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

export type EntityScopeTab = "dashboards" | "settings";

export function EntityScopeTabs({
  dashboardsHref,
  settingsHref,
  active,
}: {
  /** The scope's Dashboards tab route (the first tablist entry). */
  dashboardsHref: string;
  /** The scope's Settings tab route — the second entry on project / team /
   *  organization. Omit (or null) on a personal scope: Dashboards is the only
   *  tab (#1904 — no personal Settings pane). */
  settingsHref?: string | null;
  active: EntityScopeTab;
}) {
  return (
    <Tabs value={active}>
      <TabsListRow>
        <TabsTrigger value="dashboards" asChild>
          <Link href={dashboardsHref}>Dashboards</Link>
        </TabsTrigger>
        {settingsHref ? (
          <TabsTrigger value="settings" asChild>
            <Link href={settingsHref}>Settings</Link>
          </TabsTrigger>
        ) : null}
      </TabsListRow>
    </Tabs>
  );
}
