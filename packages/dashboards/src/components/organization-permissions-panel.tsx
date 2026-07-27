/**
 * OrganizationPermissionsPanel — the read-only ACCESS MODEL section of
 * `/organizations/[id]/settings` (cinatra#705, relocated to the settings
 * surface by cinatra#1734).
 *
 * Shows how access to the organization is determined, not a management
 * console: org membership derives from the Better-Auth `member` table
 * (`SecurityContext.accessibleOrgIds`; `cubes/organizations.ts`), and this
 * section renders those members (by role) and the org's teams so EVERY org
 * member can see how access works. Membership MANAGEMENT (add / remove /
 * invite) lives in the Members & invitations card of the manage panel
 * rendered directly below this section for viewers holding
 * `organization.manageMembers` (cinatra#1903/cinatra#1510) — the description
 * points managers at that card and tells everyone else which role manages
 * membership (`viewerCanManageMembers` selects the branch).
 *
 * Presentational only — the screen does the access-gated reads and hands the
 * normalized `OrganizationAccessModel` in, so this component stays a pure render
 * (unit-testable without a database).
 */
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
  /**
   * Whether THIS viewer holds `organization.manageMembers` for the viewed org
   * (resolved by the single-source viewed-org gate) — i.e. whether the
   * Members & invitations management card renders below this panel. Selects
   * the audience-truthful description: managers are pointed at that card,
   * everyone else is told the organization's owners manage membership.
   * Deliberately REQUIRED (no default): a new call site must decide, never
   * silently inherit the non-manager copy.
   */
  readonly viewerCanManageMembers: boolean;
};

export function OrganizationPermissionsPanel({
  orgName,
  accessModel,
  viewerCanManageMembers,
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
            the app authorization layer read.{" "}
            {viewerCanManageMembers ? (
              <>
                Manage members and invitations in the{" "}
                <span className="font-medium text-foreground">
                  {"Members & invitations"}
                </span>{" "}
                card below.
              </>
            ) : (
              "Members and invitations are managed by this organization's owners."
            )}
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
