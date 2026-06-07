"use client";

/**
 * HitlAssistField.
 *
 * Minimal prompt input for hitl-assist prefill suggestions. POSTs a prompt
 * to the hitl-assist endpoint and calls onPrefill() with returned suggestions.
 * Rendered inside mid-run HITL review screens above the Approve/Reject buttons.
 */

import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type HitlAssistFieldProps = {
  placeholder?: string;
  /** Async handler — receives the prompt text; resolves when suggestions are applied. */
  onSubmit: (prompt: string) => Promise<void>;
};

export function HitlAssistField({ placeholder, onSubmit }: HitlAssistFieldProps) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder ?? "Describe changes you'd like to suggest…"}
        className="min-h-[60px] text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!value.trim() || loading}
        onClick={async () => {
          setLoading(true);
          try {
            await onSubmit(value);
            setValue("");
          } finally {
            setLoading(false);
          }
        }}
      >
        {loading ? "Thinking…" : "Suggest"}
      </Button>
    </div>
  );
}
