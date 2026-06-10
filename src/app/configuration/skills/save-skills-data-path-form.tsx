"use client";

import { useNotify } from "@/context/notification-context";
import { saveSkillsDataPathAction } from "./actions";

export function SaveSkillsDataPathForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveSkillsDataPathAction(formData);
      addNotification({
        title: "Skills storage saved",
        body: "The skills data path has been updated.",
        kind: "success",
      });
    } catch {
      addNotification({
        title: "Skills storage save failed",
        body: "Unable to save the skills data path.",
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
