"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/cinatra-toast";

import { format } from "date-fns";
import { HitlConversationPanel, type HitlConversationEntry } from "./hitl-conversation-panel";
import { setRunTrigger } from "./run-actions";
import type { DurationEstimate } from "./trigger-duration-estimate";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const formSchema = z.discriminatedUnion("triggerType", [
  z.object({
    triggerType: z.literal("immediate"),
    timezone: z.string().min(1),
  }),
  z.object({
    triggerType: z.literal("scheduled"),
    scheduledAt: z.string().min(1, "Pick a date/time"),
    timezone: z.string().min(1),
  }),
  z.object({
    triggerType: z.literal("recurring"),
    cronExpression: z.string().min(5, "Schedule is required"),
    timezone: z.string().min(1),
  }),
]);

type FormValues = z.infer<typeof formSchema>;
// Re-exported under a clearer external name so HITL renderers can type the
// onSubmit callback they pass in without depending on the file-local alias.
export type TriggerScreenFormValues = FormValues;

// -----------------------------------------------------------------------------
// Recurring config → cron
// -----------------------------------------------------------------------------

type RecurringFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

type RecurringConfig = {
  frequency: RecurringFrequency;
  interval: number;          // days/weeks/months; always 1 for quarterly/yearly
  weekdays: number[];        // 0=Sun–6=Sat for weekly
  dayOfMonth: number;        // 1–31 when monthlyMode === "date"
  monthlyMode: "date" | "weekday";
  nthWeek: 1 | 2 | 3 | 4;  // for monthlyMode === "weekday"
  monthlyWeekday: number;    // 0=Sun–6=Sat for monthlyMode === "weekday"
  quarterAnchor: "start" | "end"; // quarterly: start=Jan/Apr/Jul/Oct, end=Mar/Jun/Sep/Dec
  yearlyMonth: number;       // 1–12 for yearly
  hour: number;
  minute: number;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const NTH_LABELS = ["1st", "2nd", "3rd", "4th"] as const;
const Q_START_MONTHS = "1,4,7,10";
const Q_END_MONTHS   = "3,6,9,12";

function buildCron(c: RecurringConfig): string {
  const m = c.minute;
  const h = c.hour;

  function nthWeekdayCron(months: string): string {
    const start = (c.nthWeek - 1) * 7 + 1;
    const end   = c.nthWeek * 7;
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
        : (c.interval === 1 ? `${m} ${h} ${c.dayOfMonth} * *` : `${m} ${h} ${c.dayOfMonth} */${c.interval} *`);
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
  const hour   = parseInt(hrStr, 10);
  if (isNaN(minute) || isNaN(hour)) return null;

  const rangeMatch = /^(\d+)-(\d+)$/.exec(domStr);
  const nthWeekFromRange = (start: number): 1|2|3|4 => Math.min(4, Math.ceil(start / 7)) as 1|2|3|4;

  // Quarterly Nth-weekday: "1-7 1,4,7,10 1"
  if (rangeMatch && (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS)) {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return { frequency: "quarterly", quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start", monthlyMode: "weekday", nthWeek, monthlyWeekday: parseInt(dowStr, 10) || 0, hour, minute, weekdays: [], dayOfMonth: 1 };
  }
  // Quarterly date: "1 1,4,7,10 *"
  if (domStr !== "*" && (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS) && dowStr === "*") {
    return { frequency: "quarterly", quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start", monthlyMode: "date", dayOfMonth: parseInt(domStr, 10) || 1, hour, minute, weekdays: [] };
  }
  // Yearly Nth-weekday: "1-7 6 0"
  const singleMonth = /^\d+$/.test(monthStr) ? parseInt(monthStr, 10) : NaN;
  if (rangeMatch && !isNaN(singleMonth) && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return { frequency: "yearly", yearlyMonth: singleMonth, monthlyMode: "weekday", nthWeek, monthlyWeekday: parseInt(dowStr, 10) || 0, hour, minute, weekdays: [], dayOfMonth: 1 };
  }
  // Yearly date: "25 12 *"
  if (domStr !== "*" && !isNaN(singleMonth) && dowStr === "*") {
    return { frequency: "yearly", yearlyMonth: singleMonth, monthlyMode: "date", dayOfMonth: parseInt(domStr, 10) || 1, hour, minute, weekdays: [] };
  }
  // Monthly Nth-weekday: "1-7 * 0"
  if (rangeMatch && monthStr === "*" && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return { frequency: "monthly", monthlyMode: "weekday", nthWeek, monthlyWeekday: parseInt(dowStr, 10) || 0, hour, minute, weekdays: [], dayOfMonth: 1 };
  }
  // Monthly date: "3 * *" or "3 */2 *"
  if (domStr !== "*" && dowStr === "*") {
    const mMatch = /^\*\/(\d+)$/.exec(monthStr);
    return { frequency: "monthly", monthlyMode: "date", interval: mMatch ? parseInt(mMatch[1], 10) : 1, dayOfMonth: parseInt(domStr, 10) || 1, hour, minute, weekdays: [] };
  }
  // Weekly
  if (monthStr === "*" && dowStr !== "*") {
    return { frequency: "weekly", interval: 1, hour, minute, weekdays: dowStr.split(",").map(Number).filter((n) => !isNaN(n)) };
  }
  // Daily
  const dMatch = /^\*\/(\d+)$/.exec(domStr);
  return { frequency: "daily", interval: dMatch ? parseInt(dMatch[1], 10) : 1, hour, minute, weekdays: [] };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRange(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

function durationCopy(d: DurationEstimate | null): string {
  if (!d) return "Unavailable.";
  const min = formatRange(d.prepMinSeconds + d.gatedMinSeconds);
  const max = formatRange(d.prepMaxSeconds + d.gatedMaxSeconds);
  return `${min}–${max}.`;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export type TriggerScreenClientProps = {
  agentId: string;
  instanceId: string;
  templateId: string;
  isAdmin?: boolean;
  durationEstimate?: DurationEstimate | null;
  inputParams?: unknown;
  requiredFields?: unknown;
  properties?: unknown;
  setupComplete?: boolean;
  /** When true, this component is mounted as a HITL field renderer inside
   *  HitlApprovalCard. In that mode it must NOT render its own
   *  HitlConversationPanel (HitlApprovalCard already renders one), and must
   *  consume `aiSuggestions` from the parent to apply suggestions to RHF
   *  fields — the same standard pattern other HITL renderers follow. */
  embeddedAsRenderer?: boolean;
  /** Stable suggestion payload from the parent's HitlConversationPanel. Only
   *  used when `embeddedAsRenderer` is true. */
  aiSuggestions?: Record<string, unknown>;
  /** When provided AND embeddedAsRenderer is true, called with the validated
   *  form values on submit instead of the standalone setRunTrigger + redirect
   *  side-effects. The HITL field renderer wires this so the trigger form
   *  behaves like every other HITL renderer (canonical onChange path). The
   *  WayFlow persist node owns actual storage via trigger_config_set. */
  onSubmit?: (values: FormValues) => void | Promise<void>;
};

export function TriggerScreenClient(props: TriggerScreenClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const browserTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const allTimezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone") as string[];
    } catch {
      return ["UTC"];
    }
  }, []);

  // Recurring UI state (drives cron generation)
  const [recurring, setRecurring] = useState<RecurringConfig>({
    frequency: "weekly",
    interval: 1,
    weekdays: [],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 0,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { triggerType: "immediate", timezone: browserTz },
  });

  const triggerType = watch("triggerType");
  const timezone = watch("timezone");
  const scheduledAtValue = (watch as (n: string) => string)("scheduledAt") ?? "";

  // ---------------------------------------------------------------------------
  // HitlConversationPanel wiring
  // Always-visible bottom prompt that auto-fills RHF fields when the LLM returns
  // structured trigger suggestions. Pattern copied from
  // orchestrator-stepper-panel.tsx — same fetch shape, same error handling.
  // ---------------------------------------------------------------------------
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [promptPending, setPromptPending] = useState(false);
  const [conversation, setConversation] = useState<HitlConversationEntry[]>([]);
  const convIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
    return () => { abortRef.current?.abort(); };
  }, []);

  // When mounted as a HITL field renderer (embeddedAsRenderer === true), the
  // parent's HitlApprovalCard owns the prompt UI and surfaces suggestions via
  // the `aiSuggestions` prop. Apply them to the same RHF fields the standalone
  // handlePromptSubmit path writes to so the standard renderer pattern works
  // here too. Standalone use (props.embeddedAsRenderer not set) ignores this
  // path entirely; the local handlePromptSubmit is the only setValue source.
  const aiSuggestions = props.aiSuggestions;
  useEffect(() => {
    if (!props.embeddedAsRenderer || !aiSuggestions) return;
    const sv = setValue as (field: string, value: string) => void;
    if (typeof aiSuggestions.triggerType === "string") {
      setValue("triggerType", aiSuggestions.triggerType as FormValues["triggerType"]);
    }
    if (typeof aiSuggestions.scheduledAt === "string") {
      const normalized = aiSuggestions.scheduledAt.replace(" ", "T").substring(0, 16);
      sv("scheduledAt", normalized);
    }
    if (typeof aiSuggestions.timezone === "string") {
      sv("timezone", aiSuggestions.timezone);
    }
    if (typeof aiSuggestions.cronExpression === "string") {
      sv("cronExpression", aiSuggestions.cronExpression);
      const parsed = parseCronToRecurring(aiSuggestions.cronExpression);
      if (parsed) setRecurring(prev => ({ ...prev, ...parsed }));
    }
  }, [aiSuggestions, props.embeddedAsRenderer, setValue]);

  // Initialize cronExpression on mount so it's valid before the user touches any recurring field.
  useEffect(() => {
    setValue("cronExpression" as never, buildCron(recurring) as never);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePromptSubmit = useCallback(async (prompt: string) => {
    if (!props.templateId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const userId = ++convIdRef.current;
    setConversation(prev => [...prev, { id: userId, role: "user", content: prompt }]);
    setPromptPending(true);
    try {
      const res = await fetch(
        `/api/agents/builder/${encodeURIComponent(props.templateId)}/hitl-assist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            prompt,
            xRenderer: "trigger-config",
            currentValue: {
              triggerType: watch("triggerType"),
              scheduledAt: (watch as (n: string) => string)("scheduledAt") ?? null,
              timezone: watch("timezone"),
              cronExpression: (watch as (n: string) => string)("cronExpression") ?? null,
              now: new Date().toISOString(),
            },
            schemaProperties: ["triggerType", "scheduledAt", "timezone", "cronExpression"],
            lastAssistantMessage:
              [...conversation].reverse().find(m => m.role === "assistant")?.content ?? null,
          }),
        },
      );
      if (!res.ok) throw new Error(`hitl-assist: ${res.status}`);
      const json = (await res.json()) as {
        suggestions?: Record<string, unknown>;
        message?: string | null;
      };
      const suggestions = json.suggestions ?? {};
      // Immediately call setValue() on RHF fields — no preview step (by design).
      const sv = setValue as (field: string, value: string) => void;
      if (typeof suggestions.triggerType === "string") setValue("triggerType", suggestions.triggerType as FormValues["triggerType"]);
      if (typeof suggestions.scheduledAt === "string") {
        // Normalize to YYYY-MM-DDTHH:mm (strip seconds/timezone that LLM may append).
        const normalized = suggestions.scheduledAt.replace(" ", "T").substring(0, 16);
        sv("scheduledAt", normalized);
      }
      if (typeof suggestions.timezone === "string") sv("timezone", suggestions.timezone);
      if (typeof suggestions.cronExpression === "string") {
        sv("cronExpression", suggestions.cronExpression);
        // Also sync the recurring UI controls so the dropdowns reflect the new schedule.
        const parsed = parseCronToRecurring(suggestions.cronExpression);
        if (parsed) setRecurring((prev) => ({ ...prev, ...parsed }));
      }
      const assistantMsg = (json.message?.trim()) || "Done.";
      if (Object.keys(suggestions).length > 0) {
        setConversation(prev => [
          ...prev,
          { id: ++convIdRef.current, role: "assistant", content: assistantMsg },
        ]);
      } else {
        toast.error("No suggestions generated. Try describing the schedule you want, e.g. \"Every Monday at 9am\".");
      }
    } catch (err) {
      console.warn("[hitl-assist] failed", err instanceof Error ? err.message : String(err));
      setConversation(prev => [
        ...prev,
        { id: ++convIdRef.current, role: "assistant", content: "Could not fetch suggestions — please try again." },
      ]);
    } finally {
      setPromptPending(false);
    }
  }, [props.templateId, conversation, watch, setValue]);

  function updateRecurring(patch: Partial<RecurringConfig>) {
    setValue("triggerType", "recurring");
    setRecurring((prev) => {
      const next = { ...prev, ...patch };
      setValue("cronExpression" as never, buildCron(next) as never);
      return next;
    });
  }

  function toggleWeekday(day: number) {
    const next = recurring.weekdays.includes(day)
      ? recurring.weekdays.filter((d) => d !== day)
      : [...recurring.weekdays, day];
    updateRecurring({ weekdays: next.length > 0 ? next : [day] });
  }

  const onSubmit = (values: FormValues) => {
    setServerError(null);
    // HITL renderer path: defer to the parent's onChange via props.onSubmit.
    // The WayFlow persist node owns storage via trigger_config_set, so we
    // skip the standalone setRunTrigger + redirect side-effects here. This
    // mirrors how every other HITL renderer behaves (call onChange, let the
    // approval pipeline carry the data).
    if (props.embeddedAsRenderer && props.onSubmit) {
      const result = props.onSubmit(values);
      if (result instanceof Promise) {
        startTransition(async () => {
          try {
            await result;
          } catch (err) {
            setServerError(err instanceof Error ? err.message : String(err));
          }
        });
      }
      return;
    }
    // Standalone /trigger page path: persist directly + redirect to the run.
    startTransition(async () => {
      const args = {
        runId: props.instanceId,
        triggerType: values.triggerType,
        timezone: values.timezone,
        ...(values.triggerType === "scheduled" ? { scheduledAt: values.scheduledAt } : {}),
        ...(values.triggerType === "recurring" ? { cronExpression: values.cronExpression } : {}),
      };
      const result = await setRunTrigger(args);
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      router.push(`/agents/${props.agentId}/${encodeURIComponent(props.instanceId)}`);
    });
  };

  const errorBag = errors as Record<string, { message?: string } | undefined>;

  // When mounted as a HITL field renderer (embeddedAsRenderer === true), the
  // parent HitlApprovalCard already wraps in Card + CardContent. Skip our own
  // Card+CardContent so we don't double-card. Standalone /trigger page use
  // (embeddedAsRenderer === false) keeps the Card wrapping — it's the only
  // surface on that page.
  const formContent = (
    <>

          <div className="flex flex-col gap-2">
            <Label>When should this run?</Label>
            <div className="flex flex-col gap-2">

              {/* Run now */}
              <Button
                type="button"
                variant="outline"
                onClick={() => setValue("triggerType", "immediate")}
                className={`flex h-auto items-center justify-start gap-3 rounded-control border px-4 py-3 text-left transition-colors ${
                  triggerType === "immediate" ? "border-primary bg-primary/5" : "border-input hover:bg-muted"
                }`}
              >
                <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${triggerType === "immediate" ? "border-primary" : "border-muted-foreground"}`}>
                  {triggerType === "immediate" && <span className="h-2 w-2 rounded-full bg-primary" />}
                </span>
                <span className="text-sm font-medium">Run right after setup</span>
              </Button>

              {/* Schedule for later */}
              <div
                className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors cursor-pointer ${
                  triggerType === "scheduled" ? "border-primary bg-primary/5" : "border-input hover:bg-muted"
                }`}
                onClick={() => setValue("triggerType", "scheduled")}
              >
                <div className="flex items-center gap-3">
                  <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${triggerType === "scheduled" ? "border-primary" : "border-muted-foreground"}`}>
                    {triggerType === "scheduled" && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <span className="text-sm font-medium">Schedule for later</span>
                </div>
                <div className="ml-7 flex flex-wrap gap-4" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="scheduledAt" className="font-normal">Run at</Label>
                    <Input
                      id="scheduledAt"
                      type="datetime-local"
                      className="w-56"
                      {...register("scheduledAt" as never)}
                      onChange={(e) => {
                        void (register("scheduledAt" as never) as { onChange: (e: unknown) => void }).onChange(e);
                        setValue("triggerType", "scheduled");
                      }}
                    />
                    {scheduledAtValue && (() => {
                      try {
                        return <p className="text-xs text-muted-foreground">{format(new Date(scheduledAtValue), "EEEE")}</p>;
                      } catch { return null; }
                    })()}
                    {errorBag.scheduledAt?.message && (
                      <p className="text-sm text-destructive">{errorBag.scheduledAt.message}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="timezone-scheduled" className="font-normal">Timezone</Label>
                    <Select
                      value={timezone ?? browserTz}
                      onValueChange={(v) => {
                        setValue("timezone", v);
                        setValue("triggerType", "scheduled");
                      }}
                    >
                      <SelectTrigger id="timezone-scheduled" className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allTimezones.map((tz) => (
                          <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Recurring */}
              <div
                className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors cursor-pointer ${
                  triggerType === "recurring" ? "border-primary bg-primary/5" : "border-input hover:bg-muted"
                }`}
                onClick={() => setValue("triggerType", "recurring")}
              >
                <div className="flex items-center gap-3">
                  <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${triggerType === "recurring" ? "border-primary" : "border-muted-foreground"}`}>
                    {triggerType === "recurring" && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <span className="text-sm font-medium">Recurring</span>
                </div>
                <div className="ml-7 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    <Label className="shrink-0 font-normal">Repeat every</Label>
                    {(recurring.frequency === "daily" || recurring.frequency === "weekly" || recurring.frequency === "monthly") && (
                      <Select value={String(recurring.interval)} onValueChange={(v) => updateRecurring({ interval: Number(v) })}>
                        <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Select value={recurring.frequency} onValueChange={(v) => updateRecurring({ frequency: v as RecurringFrequency })}>
                      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">day(s)</SelectItem>
                        <SelectItem value="weekly">week(s)</SelectItem>
                        <SelectItem value="monthly">month(s)</SelectItem>
                        <SelectItem value="quarterly">quarter</SelectItem>
                        <SelectItem value="yearly">year</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {recurring.frequency === "quarterly" && (
                    <div className="flex items-center gap-2">
                      <Label className="shrink-0 font-normal">Quarter</Label>
                      <div className="flex rounded-control border border-input overflow-hidden text-sm">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateRecurring({ quarterAnchor: "start" })}
                          className={`rounded-none border-0 px-3 py-1 transition-colors ${recurring.quarterAnchor === "start" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted"}`}
                        >
                          Start
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateRecurring({ quarterAnchor: "end" })}
                          className={`rounded-none border-0 px-3 py-1 transition-colors ${recurring.quarterAnchor === "end" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted"}`}
                        >
                          End
                        </Button>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {recurring.quarterAnchor === "start" ? "Jan / Apr / Jul / Oct" : "Mar / Jun / Sep / Dec"}
                      </span>
                    </div>
                  )}
                  {recurring.frequency === "yearly" && (
                    <div className="flex items-center gap-2">
                      <Label className="shrink-0 font-normal">Month</Label>
                      <Select value={String(recurring.yearlyMonth)} onValueChange={(v) => updateRecurring({ yearlyMonth: Number(v) })}>
                        <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {MONTH_LABELS.map((label, i) => (
                            <SelectItem key={i + 1} value={String(i + 1)}>{label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {recurring.frequency === "weekly" && (
                    <div className="flex items-center gap-2">
                      <Label className="shrink-0 font-normal">On</Label>
                      <div className="flex gap-1">
                        {WEEKDAY_LABELS.map((label, i) => (
                          <Button
                            key={i}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => toggleWeekday(i)}
                            className={`h-8 w-10 rounded-control text-xs font-medium border transition-colors ${
                              recurring.weekdays.includes(i)
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-background text-muted-foreground border-input hover:bg-muted"
                            }`}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  {(recurring.frequency === "monthly" || recurring.frequency === "quarterly" || recurring.frequency === "yearly") && (
                    <>
                      <div className="flex items-center gap-2">
                        <Label className="shrink-0 font-normal">On</Label>
                        <div className="flex rounded-control border border-input overflow-hidden text-sm">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => updateRecurring({ monthlyMode: "date" })}
                            className={`rounded-none border-0 px-3 py-1 transition-colors ${recurring.monthlyMode === "date" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted"}`}
                          >
                            Day
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => updateRecurring({ monthlyMode: "weekday" })}
                            className={`rounded-none border-0 px-3 py-1 transition-colors ${recurring.monthlyMode === "weekday" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted"}`}
                          >
                            Weekday
                          </Button>
                        </div>
                        {recurring.monthlyMode === "date" && (
                          <Select value={String(recurring.dayOfMonth)} onValueChange={(v) => updateRecurring({ dayOfMonth: Number(v) })}>
                            <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                                <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        {recurring.monthlyMode === "weekday" && (
                          <>
                            <Select value={String(recurring.nthWeek)} onValueChange={(v) => updateRecurring({ nthWeek: Number(v) as 1|2|3|4 })}>
                              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {([1,2,3,4] as const).map((n) => (
                                  <SelectItem key={n} value={String(n)}>{NTH_LABELS[n-1]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={String(recurring.monthlyWeekday)} onValueChange={(v) => updateRecurring({ monthlyWeekday: Number(v) })}>
                              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {WEEKDAY_LABELS.map((label, i) => (
                                  <SelectItem key={i} value={String(i)}>{label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </>
                        )}
                      </div>
                    </>
                  )}
                  <div className="flex items-center gap-2">
                    <Label className="shrink-0 font-normal">At</Label>
                    <Select value={String(recurring.hour)} onValueChange={(v) => updateRecurring({ hour: Number(v) })}>
                      <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-muted-foreground">:</span>
                    <Select value={String(recurring.minute)} onValueChange={(v) => updateRecurring({ minute: Number(v) })}>
                      <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                          <SelectItem key={m} value={String(m)}>{String(m).padStart(2, "0")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="timezone-recurring" className="font-normal">Timezone</Label>
                    <Select
                      value={timezone ?? browserTz}
                      onValueChange={(v) => {
                        setValue("timezone", v);
                        setValue("triggerType", "recurring");
                      }}
                    >
                      <SelectTrigger id="timezone-recurring" className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allTimezones.map((tz) => (
                          <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input type="hidden" {...register("cronExpression" as never)} />
                  {errorBag.cronExpression?.message && (
                    <p className="text-sm text-destructive">{errorBag.cronExpression.message}</p>
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* Estimated run duration */}
          <div className="flex flex-col gap-1">
            <Label>Estimated run duration</Label>
            <p className="text-sm text-muted-foreground">{durationCopy(props.durationEstimate ?? null)}</p>
          </div>

          {/* Submit */}
          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending} className="gap-1.5">
              {isPending ? "Continuing…" : "Continue"}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>

    </>
  );

  return (
    <>
    <form onSubmit={handleSubmit(onSubmit)}>
      {props.embeddedAsRenderer ? (
        <div className="flex flex-col gap-6">{formContent}</div>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-6 p-6">{formContent}</CardContent>
        </Card>
      )}
    </form>
    {/* Always-visible bottom overlay — no toggle (by design).
        resetSignal omitted — trigger form has no renderer transitions. */}
    <HitlConversationPanel
      portalTarget={portalTarget}
      visible={!props.embeddedAsRenderer && !!props.templateId && !!portalTarget && props.isAdmin !== false}
      conversation={conversation}
      promptPending={promptPending}
      storageKey={`cinatra_trigger_assist_${props.templateId}`}
      onSubmit={handlePromptSubmit}
    />
    </>
  );
}
