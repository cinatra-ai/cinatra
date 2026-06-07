"use client";

import { useNotify } from "@/context/notification-context";
import { saveDevelopmentLoggingAction, clearDevelopmentLogEntriesAction } from "@/app/campaigns/actions";
import { DevelopmentLoggingSettingsPanel } from "@/components/development-logging-settings-panel";

type DevelopmentLoggingFormProps = {
  providers: Array<{
    id: "openai" | "anthropic" | "apollo" | "gemini" | "wordpress" | "linkedin" | "mcpServer" | "mcpClient";
    label: string;
    description: string;
    enabled: boolean;
    directory: string;
  }>;
};

export function DevelopmentLoggingForm({ providers }: DevelopmentLoggingFormProps) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveDevelopmentLoggingAction(formData);
      addNotification({
        title: "Development logging saved",
        body: "Logging administration have been updated.",
        kind: "success",
      });
    } catch (error) {
      if (typeof (error as { digest?: unknown })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
        throw error;
      }
      addNotification({
        title: "Save failed",
        body: error instanceof Error ? error.message : "Unable to save development logging settings.",
        kind: "error",
      });
    }
  }

  return (
    <DevelopmentLoggingSettingsPanel
      providers={providers}
      action={handleSubmit}
      clearAction={clearDevelopmentLogEntriesAction}
    />
  );
}
