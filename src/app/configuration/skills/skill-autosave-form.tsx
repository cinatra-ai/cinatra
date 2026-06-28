"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { saveSkillAutosaveAction } from "./actions";
import { useNotify } from "@/context/notification-context";
import type { SkillAutosaveConfig } from "@/lib/skill-autosave";

type SkillAutosaveFormProps = {
  initialConfig: SkillAutosaveConfig;
};

export function SkillAutosaveForm({ initialConfig }: SkillAutosaveFormProps) {
  const { addNotification } = useNotify();
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [userCanConfigure, setUserCanConfigure] = useState(initialConfig.userCanConfigure);
  const [userCanSeeIndicator, setUserCanSeeIndicator] = useState(initialConfig.userCanSeeIndicator);

  const handleSeeIndicatorChange = (checked: boolean | "indeterminate") => {
    const value = checked === true;
    setUserCanSeeIndicator(value);
    // Dependency rule: if indicator is hidden, users cannot toggle either
    if (!value) {
      setUserCanConfigure(false);
    }
  };

  async function handleSubmit(formData: FormData) {
    try {
      await saveSkillAutosaveAction(formData);
      addNotification({
        title: "Skill autosave administration saved",
        body: "Autosave configuration has been updated.",
        kind: "success",
      });
    } catch {
      addNotification({
        title: "Autosave settings save failed",
        body: "Unable to save autosave settings.",
        kind: "error",
      });
    }
  }

  return (
    <form action={handleSubmit} className="mt-5 grid gap-4">
      {/* Hidden inputs carry the state values for form submission */}
      <Input type="hidden" name="enabled" value={enabled ? "on" : ""} />
      <Input type="hidden" name="userCanConfigure" value={userCanConfigure ? "on" : ""} />
      <Input type="hidden" name="userCanSeeIndicator" value={userCanSeeIndicator ? "on" : ""} />

      <div className="flex items-center gap-3">
        <Checkbox
          id="autosave-enabled"
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
        <Label htmlFor="autosave-enabled" className="text-sm text-foreground cursor-pointer">
          <strong className="font-medium text-foreground">Enable autosave</strong>
          <span className="ml-1 text-muted-foreground">— automatically create personal skills from draft update prompts</span>
        </Label>
      </div>

      <div className={cn("flex items-center gap-3", !userCanSeeIndicator && "opacity-50")}>
        <Checkbox
          id="autosave-user-can-configure"
          checked={userCanConfigure}
          disabled={!userCanSeeIndicator}
          onCheckedChange={(checked) => {
            if (!userCanSeeIndicator) return;
            setUserCanConfigure(checked === true);
          }}
        />
        <Label
          htmlFor="autosave-user-can-configure"
          className={cn("text-sm text-foreground", userCanSeeIndicator ? "cursor-pointer" : "cursor-not-allowed")}
        >
          <strong className="font-medium text-foreground">Users can toggle</strong>
          <span className="ml-1 text-muted-foreground">— non-admin users can enable/disable autosave per prompt field</span>
        </Label>
      </div>

      <div className="flex items-center gap-3">
        <Checkbox
          id="autosave-user-can-see-indicator"
          checked={userCanSeeIndicator}
          onCheckedChange={handleSeeIndicatorChange}
        />
        <Label htmlFor="autosave-user-can-see-indicator" className="text-sm text-foreground cursor-pointer">
          <strong className="font-medium text-foreground">Show indicator to users</strong>
          <span className="ml-1 text-muted-foreground">— non-admin users can see whether autosave is active</span>
        </Label>
      </div>

      <div>
        <Button type="submit" variant="outline">
          Save
        </Button>
      </div>
    </form>
  );
}
