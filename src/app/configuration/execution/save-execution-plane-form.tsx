"use client";

// Client form wrapper for the execution-plane settings (exec-plane S1b
// activation, cinatra#2138 deliverable 5). Mirrors the established
// `Save*Form` + `useNotify` pattern used by the other configuration screens.

import { useNotify } from "@/context/notification-context";
import { saveExecutionPlaneSettingsAction } from "@/app/configuration/execution/actions";

export function SaveExecutionPlaneForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveExecutionPlaneSettingsAction(formData);
      addNotification({
        title: "Execution settings saved",
        body: "Restart the instance to apply a mode change — the broker is wired at boot.",
        kind: "success",
      });
    } catch (error) {
      if (
        typeof (error as { digest?: unknown })?.digest === "string" &&
        (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw error;
      }
      addNotification({
        title: "Execution settings save failed",
        body: error instanceof Error ? error.message : "Unable to save execution settings.",
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
