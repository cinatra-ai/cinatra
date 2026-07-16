"use client";
/**
 * ProjectDetailTabs — the in-page tablist for `/projects/[projectId]`
 * (cinatra#706). Two tabs under a divider-less PageHeader, styled with the
 * design-system `TabsListRow` (the etched rule runs from the last tab to the
 * page edge — the same treatment the route-based `ProjectSubnav` used, which
 * this replaces on the detail surface):
 *
 *   - "Dashboards" — the editable/persisted entity Dashboards surface (#701)
 *     whose non-removable default "Overview" renders the project's current
 *     metadata + sealed-room counts as portlets (#702).
 *   - "Permissions" — today's project permissions content (ownership, N:M
 *     project-access grants, and — for admins — external guest grants, the
 *     folded-in former project Customers surface).
 *
 * The customers fold plus the /customers and /agents route deletions landed in
 * the #707 cleanup slice; this component renders the two tabs.
 */
import { Tabs, TabsListRow, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AccessVsOwnershipNote } from "@/components/access-vs-ownership-note";

import {
  ProjectPermissionsTabClient,
  type ProjectPermissionsTabClientProps,
} from "./permissions/permissions-tab-client";
import { ProjectDashboardsTab, type ProjectDashboardsTabProps } from "./project-dashboards-tab";

export type ProjectDetailTabsProps = {
  /** Props for the Dashboards tab (bound data source + Overview portlets). */
  readonly dashboards: ProjectDashboardsTabProps;
  /** Props for the Permissions tab (the existing permissions client). */
  readonly permissions: ProjectPermissionsTabClientProps;
};

export function ProjectDetailTabs({ dashboards, permissions }: ProjectDetailTabsProps) {
  return (
    <Tabs defaultValue="dashboards" className="w-full gap-6">
      <TabsListRow>
        <TabsTrigger value="dashboards">Dashboards</TabsTrigger>
        <TabsTrigger value="permissions">Permissions</TabsTrigger>
      </TabsListRow>

      <TabsContent value="dashboards" className="flex flex-col gap-6">
        <ProjectDashboardsTab {...dashboards} />
      </TabsContent>

      <TabsContent value="permissions" className="flex flex-col gap-6">
        <AccessVsOwnershipNote />
        <ProjectPermissionsTabClient {...permissions} />
      </TabsContent>
    </Tabs>
  );
}
