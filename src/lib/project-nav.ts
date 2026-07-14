// Project-local section-nav model (cinatra#1504).
//
// Every `/projects/[projectId]` detail page renders the SAME sibling set
// through <ProjectSubnav> (src/components/project-subnav.tsx) so the local
// navigation cannot drift per page the way the old ad-hoc header-button
// lists did. One shared list drives labels / hrefs / order for all render
// sites; the active section is a per-page prop, mirroring AGENTS_NAV
// (src/lib/agents-nav.ts) and ANALYTICS_NAV (src/lib/section-nav.ts).
export type ProjectSectionValue =
  | "overview"
  | "permissions"
  | "agents"
  | "customers";

export type ProjectNavItem = {
  /** Stable key for the active-section state. */
  value: ProjectSectionValue;
  label: string;
  href: string;
};

/**
 * Sibling sections for one project, in canonical display order. Hrefs
 * interpolate the raw project id, exactly like every existing
 * `/projects/${project.id}` link in the app.
 */
export function projectNav(projectId: string): readonly ProjectNavItem[] {
  const base = `/projects/${projectId}`;
  return [
    { value: "overview", label: "Overview", href: base },
    { value: "permissions", label: "Permissions", href: `${base}/permissions` },
    { value: "agents", label: "Agents", href: `${base}/agents` },
    { value: "customers", label: "Customers", href: `${base}/customers` },
  ];
}
