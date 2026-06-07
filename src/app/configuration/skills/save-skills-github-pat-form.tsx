"use client";

import { useNotify } from "@/context/notification-context";
import { saveGitHubPersonalAccessTokenAction } from "./actions";

export function SaveSkillsGitHubPatForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveGitHubPersonalAccessTokenAction(formData);
      addNotification({
        title: "GitHub token saved",
        body: "Your personal access token has been updated.",
        kind: "success",
      });
    } catch (error) {
      addNotification({
        title: "Save failed",
        body: error instanceof Error ? error.message : "Unable to save the GitHub token.",
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
