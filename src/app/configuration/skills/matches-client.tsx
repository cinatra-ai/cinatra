"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useNotify } from "@/context/notification-context";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addAgentSkillMatchAction, removeAgentSkillMatchAction } from "./actions";

export type AddMatchSkillOption = {
  id: string;
  name: string;
  packageName: string;
};

/**
 * Uses the shared Select primitive for MatchesTabContent skill assignment.
 * Drives the same addAgentSkillMatchAction as the form-based flow.
 */
export function AddMatchSkillSelector({
  agentId,
  skills,
}: {
  agentId: string;
  skills: AddMatchSkillOption[];
}) {
  const router = useRouter();
  const { addNotification } = useNotify();
  const [skillId, setSkillId] = useState<string>("");
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!skillId) {
      addNotification({
        title: "Select a skill",
        body: "Choose a skill from the dropdown before adding it.",
        kind: "error",
      });
      return;
    }
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("agentId", agentId);
        fd.set("skillId", skillId);
        await addAgentSkillMatchAction(fd);
        addNotification({
          title: "Skill assignment saved",
          body: "The agent-skill match has been added.",
          kind: "success",
        });
        setSkillId("");
        router.refresh();
      } catch {
        addNotification({
          title: "Unable to save assignment",
          body: "The assignment could not be saved.",
          kind: "error",
        });
      }
    });
  }

  return (
    <div className="flex min-w-[280px] flex-wrap items-center gap-3">
      <Select value={skillId} onValueChange={setSkillId} disabled={pending || skills.length === 0}>
        <SelectTrigger className="min-w-[240px] flex-1">
          <SelectValue placeholder={skills.length === 0 ? "No skills available" : "Add a skill…"} />
        </SelectTrigger>
        <SelectContent>
          {skills.map((skill) => (
            <SelectItem key={skill.id} value={skill.id}>
              {skill.name} • {skill.packageName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" onClick={submit} disabled={pending || !skillId}>
        {pending ? "Adding…" : "Add skill"}
      </Button>
    </div>
  );
}

export function AddMatchForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await addAgentSkillMatchAction(formData);
      addNotification({
        title: "Skill assignment saved",
        body: "The agent-skill match has been added.",
        kind: "success",
      });
    } catch {
      addNotification({
        title: "Unable to save assignment",
        body: "The assignment could not be saved.",
        kind: "error",
      });
    }
  }

  return (
    <form action={handleSubmit} className={className}>
      {children}
    </form>
  );
}

export function RemoveMatchForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await removeAgentSkillMatchAction(formData);
      addNotification({
        title: "Skill assignment removed",
        body: "The agent-skill match has been removed.",
        kind: "success",
      });
    } catch {
      addNotification({
        title: "Unable to remove assignment",
        body: "The assignment could not be removed.",
        kind: "error",
      });
    }
  }

  return (
    <form action={handleSubmit} className={className}>
      {children}
    </form>
  );
}
