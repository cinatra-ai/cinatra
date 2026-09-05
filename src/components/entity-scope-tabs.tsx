"use client";

/**
 * The entity-page tablist (cinatra#1897 B4; the ratified design spec at
 * design@0ead5d0c5, `specs/app-artifacts.html` §IX). Every entity page —
 * workspace, personal, project, team, organization — opens on a Dashboards tab
 * and carries the same strip:
 *
 *   Dashboards | Assistants | Agents | Artifacts | Skills [ | Settings ]
 *
 * Settings is appended only where the scope HAS a settings pane (project /
 * team / organization). A personal scope has none per #1904, and neither does
 * the workspace scope, so both render the five tabs alone (cinatra#2807).
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

export type EntityScopeTab =
  | "dashboards"
  | "assistants"
  | "agents"
  | "artifacts"
  | "skills"
  | "settings";

export function EntityScopeTabs({
  dashboardsHref,
  assistantsHref,
  agentsHref,
  artifactsHref,
  skillsHref,
  settingsHref,
  active,
}: {
  /** The scope's Dashboards tab route (the first tablist entry). */
  dashboardsHref: string;
  /** The scope's Assistants tab route. */
  assistantsHref: string;
  /** The scope's Agents tab route. */
  agentsHref: string;
  /** The scope's Artifacts tab route. */
  artifactsHref: string;
  /** The scope's Skills tab route. */
  skillsHref: string;
  /** The scope's Settings tab route — the LAST entry on project / team /
   *  organization. Omit (or null) on a personal or workspace scope: those have
   *  no settings pane (#1904), so the strip ends at Skills. */
  settingsHref?: string | null;
  active: EntityScopeTab;
}) {
  return (
    <Tabs value={active}>
      <TabsListRow>
        <TabsTrigger value="dashboards" asChild>
          <Link href={dashboardsHref}>Dashboards</Link>
        </TabsTrigger>
        <TabsTrigger value="assistants" asChild>
          <Link href={assistantsHref}>Assistants</Link>
        </TabsTrigger>
        <TabsTrigger value="agents" asChild>
          <Link href={agentsHref}>Agents</Link>
        </TabsTrigger>
        <TabsTrigger value="artifacts" asChild>
          <Link href={artifactsHref}>Artifacts</Link>
        </TabsTrigger>
        <TabsTrigger value="skills" asChild>
          <Link href={skillsHref}>Skills</Link>
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
