"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type DefaultValues } from "react-hook-form";
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
import { HitlConversationPanel } from "./hitl-conversation-panel";
import { useRunWindowConversation } from "./use-run-window-conversation";
import { setRunTrigger } from "./run-actions";
import type { DurationEstimate } from "./trigger-duration-estimate";
// THE SCHEDULE DEFAULT IS THE RUNNER'S, NOT THIS FORM'S (cinatra#2936).
// `scheduleScreenSelection` applies `scheduleDefaultForLaunch` — the decision
// `@cinatra-ai/agents/lifecycle-coordinator` declares and exports — and answers
// the row this form opens on. The form used to hold a second copy of that
// decision in its own `defaultValues`.
import { scheduleScreenSelection } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import {
  buildCron,
  DEFAULT_RECURRING_CONFIG,
  parseCronToRecurring,
  WEEKDAY_LABELS,
  MONTH_LABELS,
  NTH_LABELS,
  type RecurringConfig,
  type RecurringFrequency,
} from "./trigger-recurrence";

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
//
// The selection vocabulary and its cron translation live in `trigger-recurrence`
// (cinatra#2569): the conversational schedule PROPOSAL is minted server-side and
// confirmed later, so the server has to be able to turn exactly these selections
// into exactly the cron this form would have produced. Same functions, one
// module — the form and the proposal cannot drift apart.
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

/**
 * THE FORM'S INITIAL VALUES, FROM THE ROW THE RUNNER'S DECISION NAMED
 * (cinatra#2936).
 *
 * `scheduleScreenSelection` says which row the schedule screen opens on; this
 * turns that row into the fields this particular form holds it in. It decides
 * nothing: an immediate row is the immediate row because the decision said so,
 * and a stated schedule is filled into the same rows the person would have
 * picked — which is what the held schedule's card already does with the schedule
 * its reader stated.
 *
 * NO SELECTION IS A REFUSAL, NOT A ROW. The decision answers "none" for a run
 * nobody is present for, and the screen is not offered for such a run at all; a
 * mount that reached one anyway opens with NO row chosen rather than with an
 * invented one, and its submit cannot validate.
 *
 * Exported so the mapping can be read without a DOM.
 */
export function scheduleFormDefaults(
  selection: ProposedSchedule | null,
  browserTimezone: string,
): DefaultValues<FormValues> {
  const values: Record<string, string> =
    selection === null
      ? { timezone: browserTimezone }
      : selection.kind === "scheduled"
        ? {
            triggerType: "scheduled",
            scheduledAt: selection.runAt,
            timezone: selection.timezone || browserTimezone,
          }
        : selection.kind === "recurring"
          ? {
              triggerType: "recurring",
              cronExpression: buildCron({
                ...DEFAULT_RECURRING_CONFIG,
                ...selection.selection,
              }),
              timezone: selection.timezone || browserTimezone,
            }
          : { triggerType: "immediate", timezone: browserTimezone };
  return values as DefaultValues<FormValues>;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export type TriggerScreenClientProps = {
  agentId: string;
  instanceId: string;
  templateId: string;
  isAdmin?: boolean;
  /** The run this screen's schedule belongs to, when one exists (cinatra#2933). */
  runId?: string | null;
  /**
   * May this person type in the window? Server-derived from the RUN's access
   * (`respondToHitl`), replacing the platform-administrator check the screen
   * used to hide its box behind. Absent ⇒ shown, for the pre-run screen that
   * has no run to ask.
   */
  canRespondInWindow?: boolean;
  /**
   * Is a person present for the run this schedule belongs to (cinatra#2936)?
   * One of the two inputs the runner's schedule default takes, read off the RUN
   * ROW by the screen that mounts this form. Absent ⇒ present, the same reading
   * `canRespondInWindow` above takes for a screen with no run to ask.
   */
  humanPresent?: boolean;
  /**
   * A schedule the person already stated, when the surface knows one — the
   * decision's other input. The conversation's held schedule is the carrier that
   * knows one and its own card fills it into these same rows; the run page's
   * scheduling step is reached only by a run with no trigger row, so it has none
   * to pass.
   */
  statedSchedule?: ProposedSchedule | null;
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
  /**
   * THE READ-ONLY READING (cinatra#2980).
   *
   * design@fe2182547d4a `specs/app-components.html` § "Standard scheduling
   * step", the "Configured schedule step" reading: "Once a *Run right after
   * setup* or *Schedule for later* schedule has fired it cannot be changed any
   * more: the form stays as a **read-only** reading with no controls at all."
   *
   * So the form is still DRAWN — it is the reading of the schedule this run had
   * — and it carries nothing to press: no submit, no assistant panel to fill it
   * in, and every row disabled through one `fieldset` rather than through a flag
   * on each control that a control added later could miss.
   *
   * Set by the run page for a run whose own one-off schedule has already fired
   * (`shouldFreezeFiredOneOffSchedule`); every other mount is unchanged.
   */
  readOnly?: boolean;
};

/**
 * WHERE A CONTINUE LANDS (cinatra#3004).
 *
 * The plan, on the moment after the press: "After Confirm the card stays where
 * it is and stays editable … the same option rows show the schedule as it
 * stands." A press that ARMS A SCHEDULE therefore navigates nowhere — it
 * re-renders the surface it was pressed on, which comes back drawing the armed
 * schedule through the one schedule renderer: the run page's schedule step, the
 * run's own schedule surface, and the setup rail's schedule step all mount THIS
 * component and all read the same row afterwards. Sending the reader to another
 * screen is what put a second drawing of the schedule in front of them.
 *
 * **RUN RIGHT AFTER SETUP** IS NOT A SCHEDULE and keeps the landing it has
 * always had. That press starts the run, and the run page is where a run is
 * watched; staying here would leave the person on a form for a run that is
 * already going.
 *
 * WRITTEN AS AN ALLOW-LIST of the two scheduled kinds, so a kind added later
 * keeps the old landing rather than silently staying on a surface that draws
 * nothing for it — the same reading the card resolver takes.
 *
 * Exported so the unit test can read the rule without a router.
 */
export type ContinueLanding = "in-place" | "run-page";

export function scheduleContinueLanding(triggerType: string): ContinueLanding {
  return triggerType === "scheduled" || triggerType === "recurring"
    ? "in-place"
    : "run-page";
}

export function TriggerScreenClient(props: TriggerScreenClientProps) {
  const readOnly = props.readOnly === true;
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

  // THE ROW THIS FORM OPENS ON (cinatra#2936). Not a default of this form's:
  // the two inputs go to the runner's own decision and the answer comes back as
  // the row to preselect. For the ordinary case — a person present who stated
  // nothing — that answer is the immediate row, which is what this screen has
  // always shown.
  const initialSelection = useMemo(
    () =>
      scheduleScreenSelection({
        humanPresent: props.humanPresent ?? true,
        statedSchedule: props.statedSchedule ?? null,
      }),
    [props.humanPresent, props.statedSchedule],
  );

  // Recurring UI state (drives cron generation). Seeded from the selection when
  // the person stated a recurring schedule, so the row they see IS the schedule
  // they stated; otherwise the vocabulary's own default selections, which this
  // component used to repeat inline.
  const [recurring, setRecurring] = useState<RecurringConfig>(
    initialSelection !== null && initialSelection.kind === "recurring"
      ? { ...DEFAULT_RECURRING_CONFIG, ...initialSelection.selection }
      : DEFAULT_RECURRING_CONFIG,
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: scheduleFormDefaults(initialSelection, browserTz),
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
  // cinatra#2933 (lifecycle-b W5b) — THE PER-RUN CONVERSATION. What is typed
  // here is kept with the run: read on mount, appended server-side per turn,
  // present after a reload. The field-assist call below still fills the form's
  // own fields and is retired by #2934 together with the fill that replaces it.
  const runWindow = useRunWindowConversation({
    runId: props.runId ?? null,
    surface: "schedule",
  });
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
    void runWindow.send(prompt);
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
            // cinatra#2933 - the run the screen belongs to, so the route asks
            // the RUN's access instead of the platform tier.
            ...(props.runId ? { runId: props.runId } : {}),
            currentValue: {
              triggerType: watch("triggerType"),
              scheduledAt: (watch as (n: string) => string)("scheduledAt") ?? null,
              timezone: watch("timezone"),
              cronExpression: (watch as (n: string) => string)("cronExpression") ?? null,
              now: new Date().toISOString(),
            },
            schemaProperties: ["triggerType", "scheduledAt", "timezone", "cronExpression"],
            lastAssistantMessage:
              [...runWindow.entries].reverse().find(m => m.role === "assistant")?.content ?? null,
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
      if (Object.keys(suggestions).length === 0) {
        toast.error("No suggestions generated. Try describing the schedule you want, e.g. \"Every Monday at 9am\".");
      }
    } catch (err) {
      console.warn("[hitl-assist] failed", err instanceof Error ? err.message : String(err));
    } finally {
      setPromptPending(false);
    }
  }, [props.templateId, runWindow, watch, setValue]);

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
    // NOTHING IS SUBMITTED FROM THE READ-ONLY READING (cinatra#2980). The submit
    // CONTROL is gone, but the form element keeps its handler, and a submit
    // event can still reach it (a stray Enter, a programmatic submit). The
    // server refuses this anyway; refusing it here means the reading never even
    // asks.
    if (readOnly) return;
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
      // THE SCHEDULE STAYS WHERE IT WAS ARMED (cinatra#3004) — see
      // `scheduleContinueLanding`. The refresh re-renders the server tree for
      // the surface this form is mounted on, so the step it stood in comes back
      // as the armed form; nothing about the reader's place on the page moves.
      if (scheduleContinueLanding(values.triggerType) === "in-place") {
        router.refresh();
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

              {/* Run right after setup */}
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
              {/* THE ROW IS A DIV, so the read-only reading's disabled fieldset
                  does not reach it (a fieldset disables form controls, not
                  arbitrary click handlers). Its handler and its pointer
                  affordance are withheld explicitly instead — without this the
                  "reading" would still change its own selection under the
                  cursor (cinatra#2980). */}
              <div
                className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors ${
                  readOnly ? "" : "cursor-pointer"
                } ${
                  triggerType === "scheduled"
                    ? "border-primary bg-primary/5"
                    : readOnly
                      ? "border-input"
                      : "border-input hover:bg-muted"
                }`}
                onClick={readOnly ? undefined : () => setValue("triggerType", "scheduled")}
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

              {/* Recurring — a div for the same reason, withheld the same way. */}
              <div
                className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors ${
                  readOnly ? "" : "cursor-pointer"
                } ${
                  triggerType === "recurring"
                    ? "border-primary bg-primary/5"
                    : readOnly
                      ? "border-input"
                      : "border-input hover:bg-muted"
                }`}
                onClick={readOnly ? undefined : () => setValue("triggerType", "recurring")}
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

          {/* Submit — absent entirely in the read-only reading (cinatra#2980):
              "no controls at all". A disabled Continue would still be a control,
              and would still say the schedule is a thing you re-arm here. There
              is no submit, so there is no server error to render either. */}
          {readOnly ? null : (
            <>
              {serverError && <p className="text-sm text-destructive">{serverError}</p>}
              <div className="flex justify-end">
                <Button type="submit" disabled={isPending} className="gap-1.5">
                  {isPending ? "Continuing…" : "Continue"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}

    </>
  );

  // ONE WRAPPER DISABLES THE WHOLE READING (cinatra#2980). A disabled `fieldset`
  // disables every form control inside it, so the rows, the date-time field, the
  // recurrence builder and the timezone selects are all inert without each of
  // them having to know about it — and a control added to this form later is
  // inert too. It carries the form's own layout classes so the reading is drawn
  // exactly as the editable form is, which is what the spec's "the form stays"
  // means.
  const formBody = readOnly ? (
    <fieldset
      disabled
      data-schedule-readonly=""
      className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
    >
      {formContent}
    </fieldset>
  ) : (
    formContent
  );

  return (
    <>
    <form onSubmit={handleSubmit(onSubmit)}>
      {props.embeddedAsRenderer ? (
        <div className="flex flex-col gap-6">{formBody}</div>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-6 p-6">{formBody}</CardContent>
        </Card>
      )}
    </form>
    {/* Always-visible bottom overlay — no toggle (by design).
        resetSignal omitted — trigger form has no renderer transitions.
        NOT in the read-only reading (cinatra#2980): the panel exists to FILL IN
        this form from a sentence, which is a control like any other. */}
    <HitlConversationPanel
      portalTarget={portalTarget}
      // WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
      // `app-artifact-review.html` §X): the mount names its surface and the
      // window reads the drawing's own sentence for it.
      surface="schedule"
      // cinatra#2933 — the schedule screen used to HIDE its box from anyone who
      // was not a platform administrator; the run's own access decides now.
      // The read-only reading (cinatra#2980) still carries no box at all: the
      // box exists to FILL IN this form, and a fired schedule takes no filling.
      visible={
        !readOnly &&
        !props.embeddedAsRenderer &&
        !!props.templateId &&
        !!portalTarget &&
        props.canRespondInWindow !== false
      }
      conversation={runWindow.entries}
      promptPending={promptPending || runWindow.pending}
      storageKey={`cinatra_trigger_assist_${props.templateId}`}
      onSubmit={handlePromptSubmit}
    />
    </>
  );
}
