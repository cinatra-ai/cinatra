"use client";

// Duplicated from packages/agents/src/trigger-screen-client.tsx (lines 58-162)
// and packages/agents/src/trigger-service.ts (lines 91-127).
// The schedule picker lives inside the matches tab, not the agent-trigger
// surface, because feature locality and current reuse do not justify extraction.
// Extract `RecurringSchedulePicker` to @cinatra-ai/sdk-ui once a third caller appears.

import { useState, useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { setScheduleAction } from "./actions";

// === DUPLICATED FROM packages/agents/src/trigger-screen-client.tsx ============

type RecurringFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

type RecurringConfig = {
  frequency: RecurringFrequency;
  interval: number;          // days/weeks/months; always 1 for quarterly/yearly
  weekdays: number[];        // 0=Sun–6=Sat for weekly
  dayOfMonth: number;        // 1–31 when monthlyMode === "date"
  monthlyMode: "date" | "weekday";
  nthWeek: 1 | 2 | 3 | 4;
  monthlyWeekday: number;
  quarterAnchor: "start" | "end";
  yearlyMonth: number;
  hour: number;
  minute: number;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NTH_LABELS = ["1st", "2nd", "3rd", "4th"] as const;
const Q_START_MONTHS = "1,4,7,10";
const Q_END_MONTHS = "3,6,9,12";

// Inline function bodies are kept aligned with packages/agents/src/trigger-screen-client.tsx.
function buildCron(c: RecurringConfig): string {
  const m = c.minute;
  const h = c.hour;

  function nthWeekdayCron(months: string): string {
    const start = (c.nthWeek - 1) * 7 + 1;
    const end = c.nthWeek * 7;
    return `${m} ${h} ${start}-${end} ${months} ${c.monthlyWeekday}`;
  }
  function dateCron(months: string): string {
    return `${m} ${h} ${c.dayOfMonth} ${months} *`;
  }

  switch (c.frequency) {
    case "daily":
      return c.interval === 1 ? `${m} ${h} * * *` : `${m} ${h} */${c.interval} * *`;
    case "weekly": {
      const days = c.weekdays.length > 0 ? [...c.weekdays].sort((a, b) => a - b).join(",") : "1";
      return `${m} ${h} * * ${days}`;
    }
    case "monthly":
      return c.monthlyMode === "weekday"
        ? nthWeekdayCron("*")
        : c.interval === 1
          ? `${m} ${h} ${c.dayOfMonth} * *`
          : `${m} ${h} ${c.dayOfMonth} */${c.interval} *`;
    case "quarterly": {
      const months = c.quarterAnchor === "end" ? Q_END_MONTHS : Q_START_MONTHS;
      return c.monthlyMode === "weekday" ? nthWeekdayCron(months) : dateCron(months);
    }
    case "yearly": {
      const mo = c.yearlyMonth;
      return c.monthlyMode === "weekday" ? nthWeekdayCron(String(mo)) : dateCron(String(mo));
    }
  }
}

function parseCronToRecurring(cron: string): Partial<RecurringConfig> | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hrStr, domStr, monthStr, dowStr] = parts;
  const minute = parseInt(minStr, 10);
  const hour = parseInt(hrStr, 10);
  if (isNaN(minute) || isNaN(hour)) return null;

  const rangeMatch = /^(\d+)-(\d+)$/.exec(domStr);
  const nthWeekFromRange = (start: number): 1 | 2 | 3 | 4 =>
    Math.min(4, Math.ceil(start / 7)) as 1 | 2 | 3 | 4;

  // Quarterly Nth-weekday: "1-7 1,4,7,10 1"
  if (rangeMatch && (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS)) {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "quarterly",
      quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start",
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Quarterly date: "1 1,4,7,10 *"
  if (domStr !== "*" && (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS) && dowStr === "*") {
    return {
      frequency: "quarterly",
      quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start",
      monthlyMode: "date",
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Yearly Nth-weekday: "1-7 6 0"
  const singleMonth = /^\d+$/.test(monthStr) ? parseInt(monthStr, 10) : NaN;
  if (rangeMatch && !isNaN(singleMonth) && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "yearly",
      yearlyMonth: singleMonth,
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Yearly date: "25 12 *"
  if (domStr !== "*" && !isNaN(singleMonth) && dowStr === "*") {
    return {
      frequency: "yearly",
      yearlyMonth: singleMonth,
      monthlyMode: "date",
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Monthly Nth-weekday: "1-7 * 0"
  if (rangeMatch && monthStr === "*" && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "monthly",
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Monthly date: "3 * *" or "3 */2 *"
  if (domStr !== "*" && dowStr === "*") {
    const mMatch = /^\*\/(\d+)$/.exec(monthStr);
    return {
      frequency: "monthly",
      monthlyMode: "date",
      interval: mMatch ? parseInt(mMatch[1], 10) : 1,
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Weekly
  if (monthStr === "*" && dowStr !== "*") {
    return {
      frequency: "weekly",
      interval: 1,
      hour,
      minute,
      weekdays: dowStr.split(",").map(Number).filter((n) => !isNaN(n)),
    };
  }
  // Daily
  const dMatch = /^\*\/(\d+)$/.exec(domStr);
  return {
    frequency: "daily",
    interval: dMatch ? parseInt(dMatch[1], 10) : 1,
    hour,
    minute,
    weekdays: [],
  };
}

// === END DUPLICATION =========================================================

export type ScheduleSnapshot = {
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
};

const DEFAULT_RECURRING: RecurringConfig = {
  frequency: "daily",
  interval: 1,
  weekdays: [1],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 2,
  minute: 0,
};

function fromSnapshot(snapshot: ScheduleSnapshot): RecurringConfig {
  if (!snapshot.cronExpression) return DEFAULT_RECURRING;
  const parsed = parseCronToRecurring(snapshot.cronExpression);
  if (!parsed) return DEFAULT_RECURRING;
  return {
    ...DEFAULT_RECURRING,
    ...parsed,
    weekdays: parsed.weekdays ?? DEFAULT_RECURRING.weekdays,
  };
}

function describeCron(c: RecurringConfig): string {
  const time = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  switch (c.frequency) {
    case "daily":
      return c.interval === 1 ? `daily at ${time}` : `every ${c.interval} days at ${time}`;
    case "weekly": {
      if (c.weekdays.length === 0) return `weekly at ${time}`;
      const labels = [...c.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join(", ");
      return `weekly on ${labels} at ${time}`;
    }
    case "monthly":
      return c.monthlyMode === "date"
        ? `monthly on day ${c.dayOfMonth} at ${time}`
        : `monthly on the ${NTH_LABELS[c.nthWeek - 1]} ${WEEKDAY_LABELS[c.monthlyWeekday]} at ${time}`;
    case "quarterly":
      return `quarterly (${c.quarterAnchor}) at ${time}`;
    case "yearly":
      return c.monthlyMode === "date"
        ? `yearly on ${MONTH_LABELS[c.yearlyMonth - 1]} ${c.dayOfMonth} at ${time}`
        : `yearly on the ${NTH_LABELS[c.nthWeek - 1]} ${WEEKDAY_LABELS[c.monthlyWeekday]} of ${MONTH_LABELS[c.yearlyMonth - 1]} at ${time}`;
  }
}

export function MatchesCronPicker({ initial }: { initial: ScheduleSnapshot }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [recurring, setRecurring] = useState<RecurringConfig>(() => fromSnapshot(initial));
  const [timezone, setTimezone] = useState(initial.timezone || "UTC");
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = enabled ? `Schedule (${describeCron(recurring)} ${timezone})` : "Schedule (off)";

  function handleSave() {
    setError(null);
    const cronExpression = enabled ? buildCron(recurring) : null;
    const fd = new FormData();
    if (enabled) fd.set("enabled", "on");
    if (cronExpression) fd.set("cronExpression", cronExpression);
    fd.set("timezone", timezone);
    startTransition(async () => {
      try {
        await setScheduleAction(fd);
        setSavedAt(new Date().toLocaleTimeString());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to save schedule.");
      }
    });
  }

  function toggleWeekday(day: number) {
    setRecurring((prev) => {
      const has = prev.weekdays.includes(day);
      return {
        ...prev,
        weekdays: has ? prev.weekdays.filter((d) => d !== day) : [...prev.weekdays, day],
      };
    });
  }

  return (
    <details className="rounded-card border border-line bg-surface px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        {summary}
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Switch id="schedule-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="schedule-enabled">Enabled</Label>
        </div>

        {enabled ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Label className="w-24">Frequency</Label>
              <Select
                value={recurring.frequency}
                onValueChange={(v) => setRecurring({ ...recurring, frequency: v as RecurringFrequency })}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Label className="w-24">Time</Label>
              <Input
                type="number"
                min={0}
                max={23}
                value={recurring.hour}
                onChange={(e) =>
                  setRecurring({ ...recurring, hour: Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)) })
                }
                className="w-20"
                aria-label="Hour"
              />
              <span className="text-muted-foreground">:</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={recurring.minute}
                onChange={(e) =>
                  setRecurring({ ...recurring, minute: Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)) })
                }
                className="w-20"
                aria-label="Minute"
              />
            </div>

            {recurring.frequency === "weekly" ? (
              <div className="flex flex-wrap items-center gap-3">
                <Label className="w-24">Days</Label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_LABELS.map((label, idx) => (
                    <Button
                      key={label}
                      type="button"
                      size="sm"
                      variant={recurring.weekdays.includes(idx) ? "default" : "outline"}
                      onClick={() => toggleWeekday(idx)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {recurring.frequency === "monthly" ? (
              <div className="flex flex-wrap items-center gap-3">
                <Label className="w-24">Day of month</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={recurring.dayOfMonth}
                  onChange={(e) =>
                    setRecurring({ ...recurring, dayOfMonth: Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 1)) })
                  }
                  className="w-24"
                />
              </div>
            ) : null}

            {recurring.frequency === "yearly" ? (
              <div className="flex flex-wrap items-center gap-3">
                <Label className="w-24">Month</Label>
                <Select
                  value={String(recurring.yearlyMonth)}
                  onValueChange={(v) => setRecurring({ ...recurring, yearlyMonth: parseInt(v, 10) })}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_LABELS.map((label, idx) => (
                      <SelectItem key={label} value={String(idx + 1)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Label>Day</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={recurring.dayOfMonth}
                  onChange={(e) =>
                    setRecurring({ ...recurring, dayOfMonth: Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 1)) })
                  }
                  className="w-24"
                />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Label className="w-24">Timezone</Label>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="UTC"
                className="w-40"
              />
            </div>

            <div className="text-xs text-muted-foreground">
              Cron: <code className="font-mono">{buildCron(recurring)}</code>
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSave} disabled={pending}>
            {pending ? "Saving…" : "Save schedule"}
          </Button>
          {savedAt ? <span className="text-xs text-muted-foreground">Saved at {savedAt}</span> : null}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
