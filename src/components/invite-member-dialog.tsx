"use client";

import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { toast } from "@/lib/cinatra-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Invitable organization roles — the full Better Auth `invitation:create`
// enum, so this surface matches the API semantics of the workspace-members
// widget. The server enforces who may actually assign each role: inviting
// someone straight to `owner` requires the inviter to already be an owner
// (createInvitation throws YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE
// otherwise), and that rejection surfaces below as an error toast.
const INVITE_ROLES = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
] as const;

type InviteRole = (typeof INVITE_ROLES)[number]["value"];

/**
 * Cinatra-owned member-invitation dialog. Calls Better Auth's
 * `authClient.organization.inviteMember` directly (same API the
 * better-auth-ui widget on /configuration/workspace/members uses) rather than
 * routing through that third-party component, so the surface can be re-mounted
 * by a future unifying phase. The caller is responsible for gating visibility
 * on the actor's `invitation:create` permission (fail-closed).
 */
export function InviteMemberDialog({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [pending, startTransition] = useTransition();

  function invite() {
    const trimmed = email.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await authClient.organization.inviteMember({
        organizationId,
        email: trimmed,
        role,
      });
      if (result.error) {
        toast.error(result.error.message || "Could not send the invitation.");
        return;
      }
      toast.success(`Invitation sent to ${trimmed}.`);
      setOpen(false);
      setEmail("");
      setRole("member");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus data-icon="inline-start" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            Send an email invitation to join this organization. The recipient accepts the
            invite to gain access at the role you choose.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="invite-member-email">Email</FieldLabel>
            <Input
              id="invite-member-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
            />
            <FieldDescription>The invitation is sent to this address.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="invite-member-role">Role</FieldLabel>
            <Select value={role} onValueChange={(value) => setRole(value as InviteRole)}>
              <SelectTrigger id="invite-member-role" className="max-w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Members collaborate; admins manage the organization; owners have full control.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={invite} disabled={pending || !email.trim()}>
            Send invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
