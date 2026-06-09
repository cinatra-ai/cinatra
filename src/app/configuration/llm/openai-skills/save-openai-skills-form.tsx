"use client";

import { useNotify } from "@/context/notification-context";
import { saveOpenAISkillsSettingsAction } from "@/app/campaigns/actions";

export function SaveOpenAiSkillsForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveOpenAISkillsSettingsAction(formData);
      addNotification({
        title: "OpenAI skills saved",
        body: "Skill configuration has been updated.",
        kind: "success",
      });
    } catch {
      addNotification({
        title: "OpenAI skills save failed",
        body: "Unable to save OpenAI skills.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}
