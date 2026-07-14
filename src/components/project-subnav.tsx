"use client";

import Link from "next/link";
import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { projectNav, type ProjectSectionValue } from "@/lib/project-nav";

type ProjectSubnavProps = {
  projectId: string;
  activeSection: ProjectSectionValue;
};

// Route-based section bar shown on EVERY `/projects/[projectId]` detail page
// (cinatra#1504). Mirrors the established route-tab pattern
// (src/components/agents-tab-nav.tsx, src/components/metric-api-nav.tsx):
// tabs render from the shared projectNav() config, each TabsTrigger wraps a
// real <Link> (a full route navigation, not client-side tab state), and
// TabsListRow's trailing rule replaces the section rule a bare <PageHeader>
// would otherwise draw — pair with `<PageHeader divider={false}>` on every
// project detail page (design-system.html §Dividers). One deviation from the
// sibling navs: `overflow-x-auto` on the wrapper, because this row carries
// four tabs (the siblings carry 2–3) and must stay usable on narrow
// viewports — the non-wrapping triggers scroll instead of compressing.
export function ProjectSubnav({ projectId, activeSection }: ProjectSubnavProps) {
  return (
    <div className="mx-auto mb-4 w-full max-w-7xl overflow-x-auto px-5 sm:px-8 lg:px-0">
      <Tabs value={activeSection}>
        <TabsListRow>
          {projectNav(projectId).map((item) => (
            <TabsTrigger key={item.value} value={item.value} asChild>
              <Link href={item.href}>{item.label}</Link>
            </TabsTrigger>
          ))}
        </TabsListRow>
      </Tabs>
    </div>
  );
}
