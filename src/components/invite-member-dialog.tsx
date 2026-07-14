"use client";

import { useState, useTransition } from "react";
import { Check, Copy, UserPlus } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { toast } from "@/lib/cinatra-toast";
import { buildInvitationAcceptUrl } from "@/lib/org-invitation-email";
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

// Defensively read the invitation id off the inviteMember result so the
// copyable accept link (cinatra#1565) survives loose client return typings.
function readInvitationId(data: unknown): string | null {
  if (data && typeof data === "object" && "id" in data) {
    const id = (data as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

/**
 * Cinatra-owned member-invitation dialog. Calls Better Auth's
 * `authClient.organization.inviteMember` directly (same API the
 * better-auth-ui widget on /configuration/workspace/members uses) rather than
 * routing through that third-party component, so the surface can be re-mounted
 * by a future unifying phase. The caller is responsible for gating visibility
 * on the actor's `invitation:create` permission (fail-closed).
 *
 * cinatra#1565: a successful invite now dispatches an email (the
 * `organization.sendInvitationEmail` callback in auth.ts) AND surfaces a
 * copyable accept link here. The link is the honest, always-available delivery
 * mechanism — the platform mailer is optional (an unconfigured provider sends
 * nothing), so the dialog no longer claims an email definitely went out.
 */
export function InviteMemberDialog({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function reset() {
    setEmail("");
    setRole("member");
    setInviteLink(null);
    setCopied(false);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

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
      const invitationId = readInvitationId(result.data);
      // Build the accept link from the SAME source the emailed link uses so the
      // two cannot drift (buildInvitationAcceptUrl / INVITATION_ACCEPT_PATH).
      const link =
        invitationId && typeof window !== "undefined"
          ? buildInvitationAcceptUrl(window.location.origin, invitationId)
          : null;
      setInviteLink(link);
      toast.success(`Invitation created for ${trimmed}.`);
      if (!link) {
        // No id to build a shareable link (older server) — close as before.
        onOpenChange(false);
      }
    });
  }

  async function copyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      toast.success("Accept link copied.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy the link. Select and copy it manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus data-icon="inline-start" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation created</DialogTitle>
              <DialogDescription>
                We&apos;ve emailed an accept link if a platform mailer is configured. You can
                also copy the link below and share it directly.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-member-link">Accept link</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input id="invite-member-link" readOnly value={inviteLink} />
                  <Button type="button" variant="outline" onClick={copyLink} aria-label="Copy accept link">
                    {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <FieldDescription>
                  The recipient opens this link and signs in to accept the invitation.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                Invite someone to join this organization. They accept via a link — we email it
                if a mailer is configured, and you can also copy it here to share directly.
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
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={invite} disabled={pending || !email.trim()}>
                Send invitation
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
