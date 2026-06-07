"use client";

import { useNotify } from "@/context/notification-context";
import { saveGitHubRepoFromSkillsAction } from "./actions";

export function SaveGitHubRepoForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveGitHubRepoFromSkillsAction(formData);
      addNotification({
        title: "GitHub repository saved",
        body: "Skill repository selection has been updated.",
        kind: "success",
      });
    } catch (error) {
      addNotification({
        title: "Repository save failed",
        body: error instanceof Error ? error.message : "Unable to save the GitHub repository.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}
