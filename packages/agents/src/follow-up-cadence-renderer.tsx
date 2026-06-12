"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  FieldRendererProps,
} from "./field-renderer-registry";

// Condition: registered from the manifest bindings (kind "follow-up-cadence"
// — the follow-up agent's canonical ID, the older email-drafting compat ID,
// and the bare alias) with strict matching — see register-default-renderers.ts.

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th"];

export function FollowUpCadenceFieldRenderer({
  fieldName,
  value,
  onChange,
  disabled,
  required,
  error,
  label,
  description,
  hideSubmit,
  registerFlush,
}: FieldRendererProps) {
  const [days, setDays] = useState<number[]>(() =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === "number" ? v : 0))
      : [4, 11, 25],
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Refs so flush callback always reads latest value without re-registering
  const daysRef = useRef(days);
  useEffect(() => { daysRef.current = days; }, [days]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => { onChangeRef.current(daysRef.current); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]);

  // Sync `days` whenever the parent rewrites `value` (AI suggestions via
  // form.setValue, or external reset). The structural-equality guard below
  // prevents a feedback cycle with the hideSubmit=true keystroke path: when
  // the user types, the renderer calls onChangeRef.current(next), which
  // causes the parent to setValue, which sends a new `value` prop in. Without
  // the guard, this would re-seed `days` from the just-pushed array on every
  // keystroke (a wasted re-render but not an infinite loop because the values
  // match). The guard makes it a no-op in the common case. When value is not
  // an array (first mount or post-reset) and hideSubmit is on, still push the
  // current `days` up to seed the parent form.
  useEffect(() => {
    if (Array.isArray(value)) {
      const incoming = (value as unknown[])
        .map((v) => (typeof v === "number" ? v : Number(v)))
        .filter((n) => !Number.isNaN(n));
      const current = daysRef.current;
      const isStructurallyEqual =
        current.length === incoming.length &&
        current.every((d, i) => d === incoming[i]);
      if (!isStructurallyEqual) {
        setDays(incoming);
      }
    } else if (hideSubmit) {
      // Preserve original behavior: when hideSubmit is on and value is undefined,
      // push current days to parent so the buffered form has them.
      void onChangeRef.current(daysRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, hideSubmit]);

  const handleChange = (index: number, raw: string) => {
    const parsed = parseInt(raw, 10);
    const next = [...days];
    next[index] = isNaN(parsed) ? 0 : Math.max(1, Math.min(30, parsed));
    setDays(next);
    if (hideSubmit) void onChange(next);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(days);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Label className="text-foreground">
        {label}{required ? " *" : ""}
      </Label>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      <div className="soft-panel flex flex-col gap-3 p-4">
        {days.map((day, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="w-8 text-xs text-muted-foreground text-right shrink-0">
              {ORDINALS[i] ?? `${i + 1}th`}
            </span>
            <Input
              id={`${fieldName}-day-${i}`}
              type="number"
              min={1}
              max={30}
              value={day}
              disabled={disabled || submitting}
              onChange={(e) => handleChange(i, e.target.value)}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">days after initial</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground mt-1">
          Each follow-up is sent this many days after the initial email. Range: 1–30.
        </p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
      {!hideSubmit && (
        <div>
          <Button size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit()}>
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      )}
    </div>
  );
}
