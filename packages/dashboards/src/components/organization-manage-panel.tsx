/**
 * OrganizationManagePanel — the "Manage" tab content for `/organizations/[id]`
 * (cinatra#1510). Composes the cleanly-permitted, hazard-free management subset
 * in the app's settings-card idiom:
 *
 *   - Settings (rename name + edit slug) — `organization.update`, org_admin+.
 *   - Members (role change/remove + invite) and Invitations (cancel) —
 *     `organization.manageMembers`, org_owner ONLY. The Members card renders
 *     only when `canManageMembers`, so an org_admin sees settings but not the
 *     members console (catalog truth: admins update, owners manage members).
 *   - Teams & projects — LINK-OUT to their existing management surfaces (the
 *     converged recommendation; no new org-scoped team/project CRUD here).
 *
 *   - Danger zone (delete) — `organization.delete`, org_owner ONLY, and only
 *     when structurally deletable (never the default org, never in single-org
 *     mode — the gate folds those in, so the card is entirely absent then).
 *     Referenced records (teams, active projects, connectors, dashboards,
 *     agents) block inside the card with per-kind counts.
 *
 * Presentational only — the screen resolves the VIEWED-org capabilities + reads
 * and hands them in, so this stays a pure render (unit-testable without a DB).
 * ARCHIVE has no schema/catalog basis yet and stays DEFERRED (owner proposal
 * pending on #1510).
 */
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OrganizationDeleteBlockers } from "@/lib/organization-delete";

import type {
  OrganizationManageMember,
  OrganizationPendingInvitation,
} from "../screens/organization-detail-model";
import { OrganizationSettingsForm } from "./organization-settings-form";
import { OrganizationMembersManager } from "./organization-members-manager";
import { OrganizationDeleteDangerForm } from "./organization-delete-danger-form";

export type OrganizationManagePanelProps = {
  readonly organizationId: string;
  readonly orgName: string;
  readonly currentSlug: string;
  readonly currentUserId: string;
  /** `organization.update` — org_admin+; renders the Settings card. */
  readonly canManageSettings: boolean;
  /** `organization.manageMembers` — org_owner; renders the Members/Invitations card. */
  readonly canManageMembers: boolean;
  /** `organization.delete` + structurally deletable; renders the Danger zone. */
  readonly canDelete: boolean;
  /** Server pre-count of delete blockers; required when `canDelete`. */
  readonly deleteBlockers?: OrganizationDeleteBlockers;
  readonly members: readonly OrganizationManageMember[];
  readonly invitations: readonly OrganizationPendingInvitation[];
};

export function OrganizationManagePanel({
  organizationId,
  orgName,
  currentSlug,
  currentUserId,
  canManageSettings,
  canManageMembers,
  canDelete,
  deleteBlockers,
  members,
  invitations,
}: OrganizationManagePanelProps) {
  return (
    <div className="flex flex-col gap-6" data-cinatra-org-manage="true">
      {canManageSettings ? (
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
            <CardDescription>
              Rename {orgName || "this organization"} or change its slug.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationSettingsForm
              organizationId={organizationId}
              currentName={orgName}
              currentSlug={currentSlug}
            />
          </CardContent>
        </Card>
      ) : null}

      {canManageMembers ? (
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle className="text-base">Members &amp; invitations</CardTitle>
            <CardDescription>
              Change roles, remove members, and manage pending invitations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationMembersManager
              organizationId={organizationId}
              currentUserId={currentUserId}
              members={members}
              invitations={invitations}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle className="text-base">Teams &amp; projects</CardTitle>
          <CardDescription>
            Teams and projects are managed on their own surfaces.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link
              href="/teams"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Manage teams
            </Link>
            <Link
              href="/projects"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Manage projects
            </Link>
          </div>
        </CardContent>
      </Card>

      {canDelete && deleteBlockers ? (
        <Card className="border-destructive/40 bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle className="text-base">Danger zone</CardTitle>
            <CardDescription>
              Delete {orgName || "this organization"} permanently.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationDeleteDangerForm
              organizationId={organizationId}
              orgName={orgName}
              initialBlockers={deleteBlockers}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
