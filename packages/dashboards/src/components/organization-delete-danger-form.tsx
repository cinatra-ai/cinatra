"use client";

// ---------------------------------------------------------------------------
// OrganizationDeleteDangerForm — the delete control of the `/organizations/[id]`
// Manage tab's Danger zone card (cinatra#1510 remainder). Renders ONLY for a
// viewer whose capabilities carry `canDelete` (org_owner, non-default org,
// multi-org mode) — the panel hides the card entirely on structural blocks.
//
// Two states, both server-authoritative (the client is UX only):
//   - Referenced records present (pre-counted server-side): the per-kind
//     "what's in the way" list renders and the confirm input stays disabled —
//     nothing with its own lifecycle is deletable from here.
//   - Clear: a type-the-organization-name confirmation arms the delete button;
//     the action re-verifies the name against the live row, re-checks the gate,
//     and re-counts the blockers inside the delete transaction.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";
import type { OrganizationDeleteBlockers } from "@/lib/organization-delete";

import { deleteOrganizationAction } from "../screens/organization-manage-actions";

const BLOCKER_LABELS: ReadonlyArray<{
  key: keyof OrganizationDeleteBlockers;
  label: string;
  hint: string;
}> = [
  { key: "teams", label: "Teams", hint: "delete each team on its own page first" },
  {
    key: "activeProjects",
    label: "Active projects",
    hint: "archive them from their project pages",
  },
  {
    key: "installedExtensions",
    label: "Installed extensions",
    hint: "uninstall them from the extensions surface",
  },
  {
    key: "dashboards",
    label: "Dashboards",
    hint: "delete them from their dashboards pages",
  },
  { key: "agents", label: "Agents", hint: "delete or re-home them first" },
  {
    key: "liveAgentRuns",
    label: "Running agents",
    hint: "wait for them to finish or stop them first",
  },
];

export function OrganizationDeleteDangerForm({
  organizationId,
  orgName,
  initialBlockers,
}: {
  organizationId: string;
  orgName: string;
  /** Server pre-count; advisory (the transaction re-counts under lock). */
  initialBlockers: OrganizationDeleteBlockers;
}) {
  const router = useRouter();
  const [blockers, setBlockers] =
    useState<OrganizationDeleteBlockers>(initialBlockers);
  const [confirmName, setConfirmName] = useState("");
  const [pending, startTransition] = useTransition();

  const blockerEntries = BLOCKER_LABELS.filter(({ key }) => blockers[key] > 0);
  const isBlocked = blockerEntries.length > 0;
  const armed = !pending && !isBlocked && confirmName === orgName;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!armed) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("confirmName", confirmName);
      const result = await deleteOrganizationAction(formData);
      if (result.ok) {
        toast.success(`Organization “${orgName}” was deleted.`);
        router.push(result.redirectTo);
        router.refresh();
        return;
      }
      if (result.blockers) setBlockers(result.blockers);
      toast.error(result.error);
    });
  };

  if (isBlocked) {
    return (
      <div className="flex flex-col gap-3 text-sm" data-cinatra-org-delete="blocked">
        <p className="text-muted-foreground">
          This organization still contains records with their own lifecycle.
          Deleting it will not remove them for you — remove or re-home them
          first:
        </p>
        <ul className="list-disc pl-5 text-muted-foreground">
          {blockerEntries.map(({ key, label, hint }) => (
            <li key={key}>
              <span className="font-medium text-foreground">
                {label}: {blockers[key]}
              </span>{" "}
              — {hint}.
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
      data-cinatra-org-delete="armed"
    >
      <p className="text-sm text-muted-foreground">
        Deleting removes the organization, its memberships, pending invitations,
        and its default Overview dashboard — permanently. This cannot be undone.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-delete-confirm">
          Type <span className="font-semibold">{orgName}</span> to confirm
        </Label>
        <Input
          id="org-delete-confirm"
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          placeholder={orgName}
          autoComplete="off"
          disabled={pending}
        />
      </div>
      <div>
        <Button type="submit" variant="destructive" disabled={!armed}>
          {pending ? "Deleting…" : "Delete organization"}
        </Button>
      </div>
    </form>
  );
}
