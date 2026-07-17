"use client";

// ---------------------------------------------------------------------------
// TeamMembersSection — member list + add/remove + per-team roles
// (cinatra#1567; roles from the #1566 role model).
//
// Mounted ONLY on /teams/[teamId]/settings — THE single team-management
// surface (cinatra#1688: the settings page absorbed the former #704 detail
// Permissions tab, which mounted this same section a second time). Each member
// carries a per-team role (Member / Admin) once the app-owned
// `teamMember.role` column is provisioned; `rolesEnabled=false` (un-migrated
// deployment) renders the roleless surface.
//
// Mount pattern projected from the grant form (permissions-tab-client.tsx):
//   - user search via the shared EntitySearchCombobox fed by a dedicated
//     authority-gated server action bounded by the TEAM's org (never the
//     viewer's own scopes);
//   - pick → selected chip + explicit "Add member" button (no add-on-pick);
//   - remove is confirmed via AlertDialog (destructive, resource-ownership-
//     panel precedent) and blocked server-side for the last member;
//   - role assignment is a per-row Select for `canManage` viewers (plain text
//     otherwise), wired to `updateTeamMemberRoleAction`.
// The controls render only for `canManage` viewers; the server actions
// re-enforce the same authority regardless.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntitySearchCombobox } from "@/components/entity-search-combobox";
import { toast } from "@/lib/cinatra-toast";

import {
  addTeamMemberAction,
  removeTeamMemberAction,
  searchTeamMemberCandidates,
  updateTeamMemberRoleAction,
  type TeamMemberActionResult,
} from "./member-actions";

export type TeamMemberView = {
  userId: string;
  name: string;
  email: string;
  /** Per-team role (cinatra#1566); `null` when the role column is not
   *  provisioned on this deployment (`rolesEnabled=false`). */
  role: "admin" | "member" | null;
};

const REMOVE_ERROR_COPY: Record<
  Extract<TeamMemberActionResult, { ok: false }>["error"],
  string
> = {
  forbidden:
    "Only a team admin, org owner/admin, or platform admin can manage members.",
  invalid_user: "Invalid user.",
  invalid_role: "Invalid role.",
  user_not_in_org: "That user is not a member of this team's organization.",
  already_member: "Already a member of this team.",
  not_a_member: "Not a member of this team.",
  last_member: "A team keeps at least one member — add someone else first.",
  last_admin:
    "A team keeps at least one admin — make someone else an admin first.",
  role_unavailable:
    "Team roles are not provisioned on this deployment yet.",
  unknown_error: "Something went wrong. Try again.",
};

export function TeamMembersSection({
  teamId,
  members,
  canManage,
  rolesEnabled,
}: {
  teamId: string;
  members: TeamMemberView[];
  canManage: boolean;
  /** false on deployments where `teamMember.role` is not provisioned —
   *  renders the roleless surface (no role labels, no role selects). */
  rolesEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedUser, setSelectedUser] = useState<TeamMemberView | null>(null);
  const [removalTarget, setRemovalTarget] = useState<TeamMemberView | null>(null);

  const memberIds = members.map((m) => m.userId);

  const handleAdd = () => {
    const user = selectedUser;
    if (!user) return;
    startTransition(async () => {
      const result = await addTeamMemberAction(teamId, user.userId);
      if (result.ok) {
        toast.success(`Added ${user.name} to the team.`);
        setSelectedUser(null);
        router.refresh();
      } else {
        toast.error(REMOVE_ERROR_COPY[result.error]);
      }
    });
  };

  const handleRemove = (user: TeamMemberView) => {
    startTransition(async () => {
      const result = await removeTeamMemberAction(teamId, user.userId);
      if (result.ok) {
        toast.success(`Removed ${user.name} from the team.`);
        router.refresh();
      } else {
        toast.error(REMOVE_ERROR_COPY[result.error]);
      }
    });
  };

  const handleRoleChange = (user: TeamMemberView, nextRole: string) => {
    if (nextRole !== "admin" && nextRole !== "member") return;
    if (nextRole === user.role) return;
    startTransition(async () => {
      const result = await updateTeamMemberRoleAction(teamId, user.userId, nextRole);
      if (result.ok) {
        toast.success(
          nextRole === "admin"
            ? `${user.name} is now a team admin.`
            : `${user.name} is now a member.`,
        );
        router.refresh();
      } else {
        toast.error(REMOVE_ERROR_COPY[result.error]);
      }
    });
  };

  return (
    <div data-testid="team-members-section" className="flex flex-col gap-4">
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">No members yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <li
              key={member.userId}
              className="soft-panel flex items-center justify-between gap-3 px-4 py-2"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm text-foreground">{member.name}</span>
                {member.email ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {member.email}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {rolesEnabled &&
                  (canManage ? (
                    <Select
                      value={member.role ?? "member"}
                      onValueChange={(value) => handleRoleChange(member, value)}
                      disabled={pending}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-28"
                        aria-label={`Role of ${member.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {member.role === "admin" ? "Admin" : "Member"}
                    </span>
                  ))}
                {canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setRemovalTarget(member)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="flex max-w-md flex-col gap-1">
          <Label htmlFor="team-member-candidate">Add a member</Label>
          {selectedUser ? (
            <div className="flex h-8 items-center justify-between gap-2 rounded-[7px] border border-input bg-surface-strong px-2.5 text-sm">
              <span className="truncate text-foreground">
                {selectedUser.name}
                {selectedUser.email ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {selectedUser.email}
                  </span>
                ) : null}
              </span>
              {/* The interactive element in the selected state carries the
                  field id so the Label stays associated (a11y — the grant
                  form's selected-chip pattern). */}
              <Button
                id="team-member-candidate"
                type="button"
                variant="link"
                size="xs"
                className="shrink-0 px-0 text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedUser(null)}
                disabled={pending}
              >
                Change
              </Button>
            </div>
          ) : (
            <EntitySearchCombobox
              id="team-member-candidate"
              placeholder="Search users by name or email…"
              disabled={pending}
              excludeIds={memberIds}
              onSearch={async (query) => {
                const r = await searchTeamMemberCandidates(teamId, query);
                if (!r.ok) throw new Error(r.error);
                return {
                  results: r.results.map((u) => ({
                    id: u.id,
                    name: u.name,
                    secondary: u.email,
                    email: u.email,
                  })),
                };
              }}
              onPick={(u) =>
                // Candidates have no team role yet — they join as 'member'
                // via the column DEFAULT on add.
                setSelectedUser({ userId: u.id, name: u.name, email: u.email ?? "", role: null })
              }
            />
          )}
          <div>
            <Button
              type="button"
              size="sm"
              disabled={pending || !selectedUser}
              onClick={handleAdd}
            >
              {pending ? "Adding…" : "Add member"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {rolesEnabled
              ? "New members join as Member. Team admins can manage this team's members and roles."
              : "Members are added without a role — run the auth migration to enable per-team roles."}
          </p>
        </div>
      )}

      <AlertDialog
        open={removalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemovalTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from this team?</AlertDialogTitle>
            <AlertDialogDescription>
              {removalTarget
                ? `${removalTarget.name} will lose access to everything shared with this team. You can add them back later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removalTarget;
                if (!target) return;
                setRemovalTarget(null);
                handleRemove(target);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
