"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { cn } from "./lib/utils";

interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  title?: string;
  description?: string;
  /** Tailwind max-width class. Defaults to "max-w-lg". */
  maxWidth?: string;
  className?: string;
  /**
   * When false, clicking outside and pressing Escape do nothing.
   * Set to false for modals showing a stop/loading indicator (running process).
   * Defaults to true.
   */
  dismissible?: boolean;
  /** Show the X close button in the top-right corner. Defaults to true. */
  showCloseButton?: boolean;
}

export function AppDialog({
  open,
  onOpenChange,
  children,
  title,
  description,
  maxWidth = "max-w-lg",
  className,
  dismissible = true,
  showCloseButton = true,
}: AppDialogProps) {
  // Manual portal overlay covers only the main content area (below top nav, right of sidebar).
  // modal={false} keeps nav and sidebar interactive. Dismissible via onInteractOutside / onEscapeKeyDown.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);

  return (
    <>
      {mounted && open && createPortal(<div className="fixed top-16 left-0 md:left-64 right-0 bottom-0 z-[145] bg-black/50" />, document.body)}
      <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
        <DialogContent
          showCloseButton={showCloseButton}
          className={cn(maxWidth, className)}
          onInteractOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!dismissible) e.preventDefault();
          }}
        >
          {(title || description) && (
            <DialogHeader>
              {title && <DialogTitle>{title}</DialogTitle>}
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
          )}
          {!title && <DialogTitle className="sr-only">Dialog</DialogTitle>}
          {children}
        </DialogContent>
      </Dialog>
    </>
  );
}
