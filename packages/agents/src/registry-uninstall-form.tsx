"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { uninstallConfirmMessage } from "./uninstall-confirm-message";

type ButtonVariant = ComponentProps<typeof Button>["variant"];
type ButtonSize = ComponentProps<typeof Button>["size"];

type RegistryUninstallFormProps = {
  action: (formData?: FormData) => void | Promise<void>;
  packageTitle: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

export function RegistryUninstallForm({
  action,
  packageTitle,
  variant = "destructive",
  size,
  className = "ml-auto",
}: RegistryUninstallFormProps) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(event) => {
        if (!window.confirm(uninstallConfirmMessage(packageTitle))) {
          event.preventDefault();
        }
      }}
    >
      <Button type="submit" variant={variant} size={size}>Uninstall</Button>
    </form>
  );
}
