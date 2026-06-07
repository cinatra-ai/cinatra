"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";

import { renameTeamSlugAction } from "./actions";

export function TeamSettingsForm({
  teamId,
  currentSlug,
}: {
  teamId: string;
  currentSlug: string;
}) {
  const [slug, setSlug] = useState(currentSlug);
  const [pending, startTransition] = useTransition();
  const [appliedSlug, setAppliedSlug] = useState(currentSlug);

  const canSubmit =
    !pending && slug.trim().length > 0 && slug.trim().toLowerCase() !== appliedSlug.toLowerCase();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
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
            "forbidden": "You must be a member of this team to rename its slug.",
            "slug-conflict": "Another team in the same organization already uses this slug.",
          };
          toast.error(messages[result.error]);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to rename slug.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md">
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
        <Button type="submit" disabled={!canSubmit}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Lowercase letters, digits, hyphens. Must start and end with alphanumeric. Max 63 chars.
        Renaming triggers an on-disk move of skill content; the relocation worker handles it
        asynchronously.
      </p>
    </form>
  );
}
