"use client";

import { type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// CreateServiceAccountForm — the create panel above the table
// ---------------------------------------------------------------------------

type CreateServiceAccountFormProps = {
  formRef: RefObject<HTMLFormElement | null>;
  isPending: boolean;
  onSubmit: (formData: FormData) => void;
};

export function CreateServiceAccountForm({
  formRef,
  isPending,
  onSubmit,
}: CreateServiceAccountFormProps) {
  return (
    <form
      ref={formRef}
      action={onSubmit}
      className="flex flex-col gap-4 rounded-control border border-line bg-surface px-5 py-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-name" className="text-sm text-foreground">
          Name
        </Label>
        <Input
          id="new-name"
          name="name"
          placeholder="e.g. ops-bot, partner-acme-prod"
          className="w-full max-w-md"
          required
          maxLength={120}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-scopes" className="text-sm text-foreground">
          Scopes
        </Label>
        <Textarea
          id="new-scopes"
          name="scopes"
          rows={2}
          placeholder="space-separated, e.g. 'run.read agent.execute object.read'"
          className="w-full max-w-2xl font-mono text-xs"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Permission strings the issued JWT will carry. Unknown values are silently dropped at
          token validation time.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-orgId" className="text-sm text-foreground">
          Organization ID <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="new-orgId"
          name="orgId"
          placeholder="leave blank for cross-org"
          className="w-full max-w-md"
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-gracePeriodSeconds" className="text-sm text-foreground">
          Grace period (seconds)
        </Label>
        <Input
          id="new-gracePeriodSeconds"
          name="gracePeriodSeconds"
          type="number"
          min={0}
          max={86400}
          defaultValue={900}
          className="w-32"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Old credentials remain valid for this window after rotation. Set to 0 for immediate
          cutover.
        </p>
      </div>
      <div className="flex justify-start">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating…" : "Create service account"}
        </Button>
      </div>
    </form>
  );
}
