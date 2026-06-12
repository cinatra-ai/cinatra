"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FieldRendererProps } from "./field-renderer-registry";
import { fetchAppointmentSchedules } from "./cta-actions";

// ---------------------------------------------------------------------------
// Condition — matches any field with x-renderer: "cta"
// ---------------------------------------------------------------------------

// Condition: registered from the manifest binding (kind "cta") with strict
// ID + bare-alias matching — see register-default-renderers.ts.

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type AppointmentSchedule = { title: string; bookingPageUrl: string };

export function CtaRenderer({ fieldName, schema, value, onChange, disabled, required }: FieldRendererProps) {
  const label = (schema as Record<string, unknown>).title as string | undefined ?? fieldName;
  const description = (schema as Record<string, unknown>).description as string | undefined;
  const placeholder = (schema as Record<string, unknown>)["x-placeholder"] as string | undefined;

  const [schedules, setSchedules] = useState<AppointmentSchedule[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchAppointmentSchedules()
      .then(setSchedules)
      .catch(() => setSchedules([]))
      .finally(() => setLoaded(true));
  }, []);

  const currentValue = typeof value === "string" ? value : "";

  // When schedules are available, derive the selected booking URL from the stored CTA value.
  const selectedUrl = schedules.find((s) => currentValue.includes(s.bookingPageUrl))?.bookingPageUrl ?? "";

  function handleScheduleChange(url: string) {
    const schedule = schedules.find((s) => s.bookingPageUrl === url);
    onChange(schedule ? `Book a meeting: ${schedule.bookingPageUrl}` : "");
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldName} className="text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}

      {schedules.length > 0 ? (
        <Select value={selectedUrl} onValueChange={handleScheduleChange} disabled={disabled}>
          <SelectTrigger id={fieldName} className="border-line">
            <SelectValue placeholder="Select an appointment schedule" />
          </SelectTrigger>
          <SelectContent>
            {schedules.map((s) => (
              <SelectItem key={s.bookingPageUrl} value={s.bookingPageUrl}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Textarea
          id={fieldName}
          value={currentValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder ?? "What should the email ask recipients to do?"}
          rows={3}
          className="border-line"
        />
      )}
    </div>
  );
}
