"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/cinatra-toast";
import { AccessCombobox, type AccessComboboxProps } from "@/components/access-combobox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveSkillVisibility } from "./skill-access-actions";

type Props = {
  skillId: string;
  initialVisibility: string;
  availableScopes: AccessComboboxProps["availableScopes"];
  isAdmin: boolean;
  canEdit: boolean;
};

export function SkillAccessClient({
  skillId,
  initialVisibility,
  availableScopes,
  isAdmin,
  canEdit,
}: Props) {
  const [value, setValue] = useState(initialVisibility);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await saveSkillVisibility(skillId, value as any);
      if (result.ok) {
        toast.success("Skill access saved.");
      } else {
        toast.error("Could not save skill access. Try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="skill-access" className="font-semibold">
          Who has access
        </Label>
        <AccessCombobox
          id="skill-access"
          value={value}
          onValueChange={setValue}
          availableScopes={availableScopes}
          isAdmin={isAdmin}
          disabled={!canEdit || isPending}
        />
        <p className="text-xs text-muted-foreground">
          Controls who can see and use this skill.
        </p>
      </div>
      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving access…" : "Save access"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          You can view this skill&apos;s access administration but cannot edit them.
        </p>
      )}
    </div>
  );
}
