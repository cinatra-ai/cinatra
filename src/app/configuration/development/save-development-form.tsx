"use client";

import { useNotify } from "@/context/notification-context";
import {
  saveDevelopmentLoggingAction,
  saveEmailSystemDevelopmentSettingsAction,
  saveDevExtensionsSettingsAction,
} from "@/app/campaigns/actions";

export function SaveDevelopmentLoggingForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
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
        title: "Development logging save failed",
        body: "Unable to save development logging settings.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}

export function SaveEmailSafetyForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveEmailSystemDevelopmentSettingsAction(formData);
      addNotification({
        title: "Email safety administration saved",
        body: "Email system development administration have been updated.",
        kind: "success",
      });
    } catch (error) {
      if (typeof (error as { digest?: unknown })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
        throw error;
      }
      addNotification({
        title: "Email safety save failed",
        body: "Unable to save email safety settings.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}

export function SaveDevExtensionsForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveDevExtensionsSettingsAction(formData);
      addNotification({
        title: "Publish scope override saved",
        body: "Extension publish scope override has been updated.",
        kind: "success",
      });
    } catch (error) {
      if (typeof (error as { digest?: unknown })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
        throw error;
      }
      addNotification({
        title: "Publish scope save failed",
        body: "Unable to save publish scope override.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}

