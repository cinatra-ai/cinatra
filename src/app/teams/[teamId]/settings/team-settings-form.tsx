"use client";

// ---------------------------------------------------------------------------
// Team details form (mounted on /teams/[teamId]/settings — the single
// team-management surface since #1688):
// name rename (cinatra#1687), slug rename, and the owning organization
// displayed read-only — the org is a component of team-scoped skill paths
// and members are org-scoped, so moving a team between orgs is deliberately
// not offered here (see renameTeamNameAction's docblock).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";

import { renameTeamNameAction, renameTeamSlugAction } from "./actions";

export function TeamSettingsForm({
  teamId,
  currentSlug,
  currentName,
  orgName,
  orgSlug,
}: {
  teamId: string;
  currentSlug: string;
  currentName: string;
  orgName: string;
  orgSlug: string;
}) {
  const [slug, setSlug] = useState(currentSlug);
  const [name, setName] = useState(currentName);
  const [pending, startTransition] = useTransition();
  const [appliedSlug, setAppliedSlug] = useState(currentSlug);
  const [appliedName, setAppliedName] = useState(currentName);

  const canSubmitSlug =
    !pending && slug.trim().length > 0 && slug.trim().toLowerCase() !== appliedSlug.toLowerCase();
  const canSubmitName =
    !pending && name.trim().length > 0 && name.trim() !== appliedName;

  const handleSlugSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitSlug) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("teamId", teamId);
      formData.set("newSlug", slug.trim());
      try {
        const result = await renameTeamSlugAction(formData);
        if (result.ok) {
          setAppliedSlug(result.newSlug);
          toast.success(
            result.oldSlug
              ? `Slug renamed: ${result.oldSlug} → ${result.newSlug}`
              : `Slug set to ${result.newSlug}`,
          );
        } else {
          const messages: Record<typeof result.error, string> = {
            "invalid-slug": "Slug must be lowercase letters, digits, and hyphens (1–63 chars).",
            "not-found": "Team not found.",
            "forbidden":
              "Only an organization owner/admin who is on this team can rename its slug.",
            "slug-conflict": "Another team in the same organization already uses this slug.",
          };
          toast.error(messages[result.error]);
        }
      } catch {
        toast.error("Could not rename the team slug.");
      }
    });
  };

  const handleNameSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitName) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("teamId", teamId);
      formData.set("name", name.trim());
      try {
        const result = await renameTeamNameAction(formData);
        if (result.ok) {
          setAppliedName(result.name);
          setName(result.name);
          toast.success(`Team renamed to “${result.name}”.`);
        } else {
          const messages: Record<typeof result.error, string> = {
            "invalid-name": "Team name must be 1–200 characters.",
            "not-found": "Team not found.",
            "forbidden":
              "Only a team admin, org owner/admin, or platform admin can rename the team.",
          };
          toast.error(messages[result.error]);
        }
      } catch {
        toast.error("Could not rename the team.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6 max-w-md">
      <form onSubmit={handleNameSubmit} className="flex flex-col gap-3">
        <Label htmlFor="team-name">Team name</Label>
        <div className="flex items-center gap-2">
          <Input
            id="team-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Growth Team"
            disabled={pending}
            autoComplete="off"
          />
          <Button type="submit" disabled={!canSubmitName}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The human-readable label shown across the app. Renaming it has no
          side effects.
        </p>
      </form>
      <form onSubmit={handleSlugSubmit} className="flex flex-col gap-3">
        <Label htmlFor="team-slug">Current slug</Label>
        <div className="flex items-center gap-2">
          <Input
            id="team-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="e.g. growth-team"
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={!canSubmitSlug}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Lowercase letters, digits, hyphens. Must start and end with alphanumeric. Max 63 chars.
          Renaming triggers an on-disk move of skill content; the relocation worker handles it
          asynchronously.
        </p>
      </form>
      <div className="flex flex-col gap-1" data-testid="team-org-readonly">
        <Label>Organization</Label>
        <p className="text-sm">
          {orgName} <span className="text-muted-foreground">({orgSlug})</span>
        </p>
        <p className="text-xs text-muted-foreground">
          A team belongs to its organization permanently — members and
          team-scoped skills are organization-bound, so teams can&apos;t be
          moved between organizations.
        </p>
      </div>
    </div>
  );
}
