"use client";

// ---------------------------------------------------------------------------
// OrganizationMembersManager — the member role/remove + invitation
// create/cancel controls of the `/organizations/[id]/settings` management
// section (cinatra#1510). Mirrors the team-members-section idiom: a per-row role
// Select, a confirmed remove via AlertDialog, and a toast on the discriminated
// action result.
//
// All member management maps to `organization.manageMembers` (org_owner); the
// surface renders only for org owners and every server action re-checks the
// VIEWED-org gate. Invitation CREATE reuses the org-id-parameterized
// `InviteMemberDialog` (client `authClient.organization.inviteMember`), which
// Better Auth enforces server-side against the same permission.
//
// Self-row guard: an owner cannot change or remove their OWN membership from
// this console (avoids self-lockout / demoting the last owner by accident);
// Better Auth remains the enforcement authority.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { toast } from "@/lib/cinatra-toast";

import type {
  OrganizationManageMember,
  OrganizationPendingInvitation,
  OrganizationRole,
} from "../screens/organization-detail-model";
import {
  cancelOrganizationInvitationAction,
  removeOrganizationMemberAction,
  updateOrganizationMemberRoleAction,
} from "../screens/organization-manage-actions";

const ROLE_LABEL: Readonly<Record<OrganizationRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** UI role values map 1:1 to Better Auth's org roles. */
const ROLE_TO_WORKSPACE: Readonly<Record<OrganizationRole, "owner" | "admin" | "member">> = {
  owner: "owner",
  admin: "admin",
  member: "member",
};

export function OrganizationMembersManager({
  organizationId,
  currentUserId,
  members,
  invitations,
}: {
  organizationId: string;
  /** The viewing owner — their own row is not self-mutable here. */
  currentUserId: string;
  members: readonly OrganizationManageMember[];
  invitations: readonly OrganizationPendingInvitation[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removalTarget, setRemovalTarget] = useState<OrganizationManageMember | null>(null);

  const handleRoleChange = (member: OrganizationManageMember, nextRole: string) => {
    if (nextRole !== "owner" && nextRole !== "admin" && nextRole !== "member") return;
    if (nextRole === member.role) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("memberId", member.memberId);
      formData.set("role", ROLE_TO_WORKSPACE[nextRole as OrganizationRole]);
      const result = await updateOrganizationMemberRoleAction(formData);
      if (result.ok) {
        toast.success(`${member.displayName} is now ${ROLE_LABEL[nextRole as OrganizationRole]}.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleRemove = (member: OrganizationManageMember) => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("memberId", member.memberId);
      const result = await removeOrganizationMemberAction(formData);
      if (result.ok) {
        toast.success(`Removed ${member.displayName} from the organization.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleCancelInvitation = (invitation: OrganizationPendingInvitation) => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("invitationId", invitation.id);
      const result = await cancelOrganizationInvitationAction(formData);
      if (result.ok) {
        toast.success(`Invitation to ${invitation.email} canceled.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="org-members-manager">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Manage who belongs to this organization and their role.
        </p>
        <InviteMemberDialog organizationId={organizationId} />
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            return (
              <li
                key={member.memberId}
                className="soft-panel flex items-center justify-between gap-3 px-4 py-2"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {member.displayName}
                  {isSelf ? (
                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                  ) : null}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {isSelf ? (
                    <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
                  ) : (
                    <>
                      <Select
                        value={member.role}
                        onValueChange={(value) => handleRoleChange(member, value)}
                        disabled={pending}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-28"
                          aria-label={`Role of ${member.displayName}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="owner">Owner</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setRemovalTarget(member)}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {invitations.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-foreground">Pending invitations</h4>
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="soft-panel flex items-center justify-between gap-3 px-4 py-2"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {invitation.email}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline">{ROLE_LABEL[invitation.role]}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => handleCancelInvitation(invitation)}
                  >
                    Cancel
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AlertDialog
        open={removalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemovalTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from this organization?</AlertDialogTitle>
            <AlertDialogDescription>
              {removalTarget
                ? `${removalTarget.displayName} will lose access to everything scoped to this organization. You can invite them back later.`
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
