"use client";

// ---------------------------------------------------------------------------
// OrganizationArchiveDangerForm — the archive/unarchive control of the
// `/organizations/[id]/settings` management surface (cinatra#1942 V5, archive
// program S6). Renders ONLY for a viewer whose capabilities carry `canArchive`
// (org_owner, non-default org, multi-org mode); the panel additionally hides
// the ARCHIVE direction until the `org_archive_activation` gate is on (no dead
// button pre-flip), while the UNARCHIVE direction always renders for an
// archived org — recovery must never be gated (Decision 2 asymmetry).
//
// Two modes, both server-authoritative (the client is UX only):
//   - "archive": a type-the-organization-name confirmation arms the button
//     (the delete form's arming pattern). Archive has NO blocker list —
//     org.lifecycle is always-allow — so the form is simpler than delete.
//     The copy states plainly that in-flight/parked runs pause until
//     unarchive (owner-ruled total freeze — nothing is killed,
//     no work is lost).
//   - "unarchive": a single button; recovery should be easy. The server
//     action re-verifies capability + ownership either way.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";

import {
  archiveOrganizationAction,
  unarchiveOrganizationAction,
} from "../screens/organization-manage-actions";

export function OrganizationArchiveDangerForm({
  organizationId,
  orgName,
  mode,
}: {
  organizationId: string;
  orgName: string;
  /** "archive" for an active org (gate-on only); "unarchive" for an archived one. */
  mode: "archive" | "unarchive";
}) {
  const router = useRouter();
  const [confirmName, setConfirmName] = useState("");
  const [pending, startTransition] = useTransition();

  if (mode === "unarchive") {
    const handleUnarchive = () => {
      if (pending) return;
      startTransition(async () => {
        const formData = new FormData();
        formData.set("organizationId", organizationId);
        const result = await unarchiveOrganizationAction(formData);
        if (result.ok) {
          toast.success(`Organization “${orgName}” was unarchived.`);
          router.refresh();
          return;
        }
        toast.error(result.error);
      });
    };
    return (
      <div className="flex flex-col gap-3" data-cinatra-org-archive="unarchive">
        <p className="text-sm text-muted-foreground">
          Unarchiving makes this organization active again: it reappears in
          pickers, members can select it, and paused agent runs can be resumed
          or stopped.
        </p>
        <div>
          <Button type="button" onClick={handleUnarchive} disabled={pending}>
            {pending ? "Unarchiving…" : "Unarchive organization"}
          </Button>
        </div>
      </div>
    );
  }

  // orgName can be "" (settings screen falls back to `org.name ?? ""`);
  // without the length guard, confirmName === orgName === "" arms the
  // destructive button before the operator types anything.
  const armed = !pending && orgName.length > 0 && confirmName === orgName;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!armed) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("confirmName", confirmName);
      const result = await archiveOrganizationAction(formData);
      if (result.ok) {
        toast.success(`Organization “${orgName}” was archived.`);
        router.refresh();
        return;
      }
      toast.error(result.error);
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
      data-cinatra-org-archive="armed"
    >
      <p className="text-sm text-muted-foreground">
        Archiving makes this organization read-only: it disappears from
        pickers, members can no longer select or change it, and agent runs
        that haven&apos;t finished pause until you unarchive — nothing is
        killed and no work is lost. You can unarchive at any time.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-archive-confirm">
          Type <span className="font-semibold">{orgName}</span> to confirm
        </Label>
        <Input
          id="org-archive-confirm"
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          placeholder={orgName}
          autoComplete="off"
          disabled={pending}
        />
      </div>
      <div>
        <Button type="submit" variant="destructive" disabled={!armed}>
          {pending ? "Archiving…" : "Archive organization"}
        </Button>
      </div>
    </form>
  );
}
