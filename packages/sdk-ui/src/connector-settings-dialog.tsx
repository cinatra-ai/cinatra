"use client";

import { useRouter } from "next/navigation";
import { AppDialog } from "./app-dialog";

type ConnectorSettingsDialogProps = {
  children: React.ReactNode;
  closeHref: string;
};

export function ConnectorSettingsDialog({ children, closeHref }: ConnectorSettingsDialogProps) {
  const router = useRouter();
  return (
    <AppDialog
      open={true}
      onOpenChange={(open) => { if (!open) router.push(closeHref); }}
      maxWidth="max-w-5xl"
      className="max-h-[calc(100vh-4rem)] overflow-y-auto"
    >
      {children}
    </AppDialog>
  );
}
