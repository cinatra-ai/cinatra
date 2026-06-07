"use client";

import { useNotify } from "@/context/notification-context";
import { saveWordPressInstanceAction } from "@/app/agents/campaigns/actions";

export function SaveWordPressForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveWordPressInstanceAction(formData);
      addNotification({
        title: "WordPress connection saved",
        body: "WordPress instance has been saved.",
        kind: "success",
      });
    } catch (error) {
      addNotification({
        title: "WordPress save failed",
        body: error instanceof Error ? error.message : "Unable to save WordPress connection.",
        kind: "error",
      });
    }
  }

  return <form action={handleSubmit} className={className}>{children}</form>;
}
