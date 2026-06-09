"use client";

import { useNotify } from "@/context/notification-context";
import { saveSkillAutosaveAction } from "./actions";

export function SaveSkillAutosaveForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

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
    <form action={handleSubmit} className={className}>
      {children}
    </form>
  );
}
