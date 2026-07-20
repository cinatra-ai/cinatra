"use client";

// ---------------------------------------------------------------------------
// OrganizationSettingsForm — the rename NAME + edit SLUG controls of the
// `/organizations/[id]` Manage tab (cinatra#1510). Mirrors the team-settings
// idiom (team-settings-form.tsx): a single controlled form per field, a Save
// enabled only on a real change, an optimistic "applied" mirror, and a toast on
// the discriminated action result.
//
// Both fields require `organization.update` (org_admin+); the surface renders
// only for such viewers and every server action re-checks the VIEWED-org gate.
// Editing the SLUG relocates on-disk skill content — the DB `org_slug_move_trg`
// trigger enqueues the move — so a slug change asks for explicit confirmation
// first (the ruling's "confirm on slug change").
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";

import { updateOrganizationSettingsAction } from "../screens/organization-manage-actions";

export function OrganizationSettingsForm({
  organizationId,
  currentName,
  currentSlug,
}: {
  organizationId: string;
  currentName: string;
  /** Empty string when the org has no slug yet (nullable column). */
  currentSlug: string;
}) {
  const [name, setName] = useState(currentName);
  const [slug, setSlug] = useState(currentSlug);
  const [appliedName, setAppliedName] = useState(currentName);
  const [appliedSlug, setAppliedSlug] = useState(currentSlug);
  const [pending, startTransition] = useTransition();

  const nameChanged = name.trim().length > 0 && name.trim() !== appliedName;
  const slugChanged = slug.trim() !== appliedSlug.trim();
  const canSubmit = !pending && (nameChanged || slugChanged);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (name.trim().length === 0) {
      toast.error("Organization name is required.");
      return;
    }
    // Confirm on slug change — a slug edit relocates on-disk skill content.
    if (
      slugChanged &&
      appliedSlug.trim().length > 0 &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Change the organization slug from “${appliedSlug}” to “${slug.trim()}”? This relocates its on-disk skill paths.`,
      )
    ) {
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.set("organizationId", organizationId);
      formData.set("name", name.trim());
      // Only submit the slug when it changed to a non-empty value; this surface
      // never nulls an existing slug.
      if (slugChanged && slug.trim().length > 0) {
        formData.set("slug", slug.trim());
      }
      const result = await updateOrganizationSettingsAction(formData);
      if (result.ok) {
        setAppliedName(name.trim());
        setName(name.trim());
        if (slug.trim().length > 0) setAppliedSlug(slug.trim());
        toast.success("Organization settings saved.");
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Acme Inc."
          disabled={pending}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          The human-readable label shown across the app.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="org-slug">Slug</Label>
        <Input
          id="org-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="e.g. acme"
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          The URL-friendly identifier. Changing it relocates the organization&apos;s
          on-disk skill paths — the relocation worker handles the move
          asynchronously.
        </p>
      </div>
      <div>
        <Button type="submit" disabled={!canSubmit}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
