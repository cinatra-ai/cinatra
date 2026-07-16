/**
 * OrganizationPermissionsPanel — the read-only "Permissions" tab content for
 * `/organizations/[id]` (cinatra#705).
 *
 * Shows the organization's ACCESS MODEL, not a management console: org
 * membership derives from the Better-Auth `member` table
 * (`SecurityContext.accessibleOrgIds`; `cubes/organizations.ts`), and this tab
 * renders those members (by role) and the org's teams so a viewer can SEE how
 * access is determined. Org-wide membership management (add / remove / invite)
 * lives at `/configuration/workspace`; per the issue there is deliberately NO
 * customer-invite affordance here.
 *
 * Presentational only — the screen does the access-gated reads and hands the
 * normalized `OrganizationAccessModel` in, so this component stays a pure render
 * (unit-testable without a database).
 */
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type {
  OrganizationAccessModel,
  OrganizationRole,
} from "../screens/organization-detail-model";

const ROLE_LABEL: Readonly<Record<OrganizationRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const ROLE_BADGE: Readonly<
  Record<OrganizationRole, "default" | "secondary" | "outline">
> = {
  owner: "default",
  admin: "secondary",
  member: "outline",
};

export type OrganizationPermissionsPanelProps = {
  readonly orgName: string;
  readonly accessModel: OrganizationAccessModel;
};

export function OrganizationPermissionsPanel({
  orgName,
  accessModel,
}: OrganizationPermissionsPanelProps) {
  const { members, teams, memberCount, teamCount } = accessModel;

  return (
    <div
      className="flex flex-col gap-6"
      data-cinatra-org-permissions="true"
    >
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle className="text-base">Access model</CardTitle>
          <CardDescription>
            Who can access {orgName || "this organization"} is derived from its
            membership records — the same source the organizations analytics and
            the app authorization layer read. To add, remove, or invite members,
            use{" "}
            <Link
              href="/configuration/workspace"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Workspace settings
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle className="text-base">
            Members
            <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
              {memberCount}
            </span>
          </CardTitle>
          <CardDescription>
            People with access to this organization, by role.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <span className="truncate text-sm text-foreground">
                    {m.displayName}
                  </span>
                  <Badge variant={ROLE_BADGE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle className="text-base">
            Teams
            <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
              {teamCount}
            </span>
          </CardTitle>
          <CardDescription>
            Teams scope access to a subset of the organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">No teams yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {teams.map((t) => (
                <li
                  key={t.id}
                  className="truncate py-2 text-sm text-foreground first:pt-0 last:pb-0"
                >
                  {t.name}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
