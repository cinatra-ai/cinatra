"use client";

import * as React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// PublishDestinationPicker
// Shared client component for per-extension publish destination selection.
// Behavioral invariants:
//   - Default selection: Private (when configured)
//   - When privateDestinationConfigured: false -> hide Private entirely, show notice
//   - Hint text rendered below radio group when value is "private" and configured
// ---------------------------------------------------------------------------

export type PublishDestination = "private" | "public";

export type PublishDestinationPickerProps = {
  value: PublishDestination;
  onValueChange: (v: PublishDestination) => void;
  privateDestinationConfigured: boolean;
  /** Prefix for element ids - ensures aria uniqueness when multiple pickers render. */
  idPrefix?: string;
  className?: string;
};

const HINT_TEXT_PRIVATE = "Switch to public to share with all Cinatra instances.";
const NOT_CONFIGURED_NOTICE = "Private publish destination not yet configured — contact your admin.";

export function PublishDestinationPicker({
  value,
  onValueChange,
  privateDestinationConfigured,
  idPrefix = "publish-destination",
  className,
}: PublishDestinationPickerProps) {
  const labelId = `${idPrefix}-label`;
  const privateId = `${idPrefix}-private`;
  const publicId = `${idPrefix}-public`;

  // Hide the Private option entirely when not configured.
  // Do NOT render a disabled radio - show the inline notice instead.
  if (!privateDestinationConfigured) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <Label id={labelId} className="text-sm font-semibold text-foreground">
          Publish destination
        </Label>
        <p
          role="status"
          className="text-sm text-muted-foreground rounded-control border border-line px-3 py-2 bg-surface-muted"
        >
          {NOT_CONFIGURED_NOTICE}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label id={labelId} className="text-sm font-semibold text-foreground">
        Publish destination
      </Label>
      <RadioGroup
        value={value}
        onValueChange={(v) => onValueChange(v as PublishDestination)}
        aria-label="Publish destination"
        aria-labelledby={labelId}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem id={privateId} value="private" />
          <Label htmlFor={privateId} className="text-sm text-foreground cursor-pointer">
            Private
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={publicId} value="public" />
          <Label htmlFor={publicId} className="text-sm text-foreground cursor-pointer">
            Public
          </Label>
        </div>
      </RadioGroup>
      {value === "private" && (
        <p className="text-xs text-muted-foreground mt-1">{HINT_TEXT_PRIVATE}</p>
      )}
    </div>
  );
}
