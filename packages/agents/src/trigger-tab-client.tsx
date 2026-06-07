"use client";

// ---------------------------------------------------------------------------
// Persistent Trigger tab.
//
// Renders for runs whose agent_run_triggers row has triggerType IN
// ('scheduled', 'recurring'). Sections:
//
//   1. Status banner — "armed" / "released" / "disabled" + human-readable detail
//   2. Configuration summary — type, schedule, timezone
//   3. Gated-step tree — nested agentPath traces with "└─" glyphs
//   4. Trigger controls — Cancel (owner) + Release-now (admin only)
//
// All shadcn/ui components only — no raw HTML controls. Both destructive
// actions wrap in AlertDialog; do not use window.confirm.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { HitlConversationPanel, type HitlConversationEntry } from "./hitl-conversation-panel";
import { deleteRunTrigger, releaseTriggerNow } from "./run-actions";
import type { GatedStep } from "./trigger-infer-side-effects";

// ---------------------------------------------------------------------------
// GatedStepTree
// ---------------------------------------------------------------------------

export function GatedStepTree({ gatedSteps }: { gatedSteps: GatedStep[] }) {
  if (gatedSteps.length === 0) {
    return (
      <div
        className="flex flex-col gap-3"
        data-testid="gated-step-tree-empty"
      >
        <h2 className="text-base font-semibold text-foreground">
          Steps held until trigger fires
        </h2>
        <p className="text-sm text-muted-foreground italic">
          No side-effect steps detected. Trigger acts as a start gate only —
          the run begins when the trigger fires and runs to completion.
        </p>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="gated-step-tree"
    >
      <h2 className="text-base font-semibold text-foreground">
        Steps held until trigger fires
      </h2>
      <ul className="flex flex-col gap-2">
        {gatedSteps.map((s) => (
          <li
            key={s.stepId}
            className="flex items-baseline gap-2 text-sm"
            data-testid="gated-step-item"
          >
            <span className="text-muted-foreground" aria-hidden="true">
              └─
            </span>
            <span className="text-foreground">
              {s.agentPath.join(" → ")}
            </span>
            <span className="text-muted-foreground">({s.toolName})</span>
            {s.inferredOrManual === "manual" ? (
              <span className="text-xs text-muted-foreground italic">
                manual
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TriggerTabClient — full layout
// ---------------------------------------------------------------------------

export type TriggerTabClientProps = {
  agentId: string;
  runId: string;
  templateId: string;
  isAdmin: boolean;
  trigger: {
    triggerType: "scheduled" | "recurring";
    scheduledAt: string | null; // ISO
    cronExpression: string | null;
    timezone: string;
    enabled: boolean;
    releasedAt: string | null; // ISO
    cronPreview?: string | null; // server-rendered cronstrue output
  };
  gatedSteps: GatedStep[];
};

export function TriggerTabClient(props: TriggerTabClientProps) {
  const router = useRouter();
  const [isCancelling, startCancelTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const isReleased = !!props.trigger.releasedAt;

  // ---------------------------------------------------------------------------
  // HitlConversationPanel wiring
  // Always-visible bottom overlay. NL replies inline only:
  // reschedule → LLM fills form (no direct DB write);
  // cancel → AI asks confirmation in overlay (no AlertDialog from NL path).
  // The existing AlertDialog cancel/release UI flows are preserved unchanged.
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
            xRenderer: "trigger-tab",
            currentValue: {
              triggerType: props.trigger.triggerType,
              scheduledAt: props.trigger.scheduledAt,
              cronExpression: props.trigger.cronExpression,
              timezone: props.trigger.timezone,
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
      // Cancel intent: AI replies in overlay; never call deleteRunTrigger here.
      // Reschedule intent: LLM fills trigger form inline; no direct DB write.
      const assistantMsg = json.message?.trim() || "Done.";
      setConversation(prev => [
        ...prev,
        { id: ++convIdRef.current, role: "assistant", content: assistantMsg },
      ]);
    } catch (err) {
      console.warn("[hitl-assist] failed", err instanceof Error ? err.message : String(err));
      setConversation(prev => [
        ...prev,
        { id: ++convIdRef.current, role: "assistant", content: "Could not fetch suggestions — please try again." },
      ]);
    } finally {
      setPromptPending(false);
    }
  }, [props.templateId, props.trigger, conversation]);

  const onCancel = () => {
    setActionError(null);
    startCancelTransition(async () => {
      const result = await deleteRunTrigger({ runId: props.runId });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Configuration summary */}
      <div className="soft-panel rounded-card p-6 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">
          Trigger configuration
        </h2>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Type</span>
          <span className="text-foreground">{props.trigger.triggerType}</span>
        </div>
        <Separator />
        {props.trigger.triggerType === "scheduled" &&
        props.trigger.scheduledAt ? (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Scheduled at</span>
            <span className="text-foreground">
              {format(new Date(props.trigger.scheduledAt), "PPpp")}
            </span>
          </div>
        ) : null}
        {props.trigger.triggerType === "recurring" &&
        props.trigger.cronExpression ? (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Schedule</span>
            <span className="text-foreground">
              {props.trigger.cronPreview ?? props.trigger.cronExpression}
            </span>
          </div>
        ) : null}
        <Separator />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Timezone</span>
          <span className="text-foreground">{props.trigger.timezone}</span>
        </div>
      </div>

      {/* Gated-step tree */}
      <GatedStepTree gatedSteps={props.gatedSteps} />

      {/* Trigger controls (cancel + release-now for admin) */}
      <div className="flex justify-end gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="secondary" disabled={isCancelling || isReleased}>
              {isCancelling ? "Cancelling…" : "Cancel trigger"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel scheduled trigger?</AlertDialogTitle>
              <AlertDialogDescription>
                The run will stay paused. You can re-arm a new trigger from
                this tab. Already-completed setup steps are preserved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep trigger</AlertDialogCancel>
              <AlertDialogAction onClick={onCancel}>
                Cancel trigger
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {props.isAdmin && !isReleased ? (
          <ReleaseNowButton runId={props.runId} />
        ) : null}
      </div>

      {actionError ? (
        <p className="text-sm text-destructive">{actionError}</p>
      ) : null}

      {/* Always-visible bottom overlay — no toggle.
          resetSignal omitted — no renderer transitions on the trigger tab. */}
      <HitlConversationPanel
        portalTarget={portalTarget}
        visible={!!props.templateId && !!portalTarget}
        conversation={conversation}
        promptPending={promptPending}
        storageKey={`cinatra_trigger_assist_${props.templateId}_tab`}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReleaseNowButton — admin-only override
// ---------------------------------------------------------------------------

function ReleaseNowButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [isReleasing, startReleaseTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onRelease = () => {
    setError(null);
    startReleaseTransition(async () => {
      const result = await releaseTriggerNow({ runId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="secondary" disabled={isReleasing}>
            {isReleasing ? "Releasing…" : "Release now"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release trigger now?</AlertDialogTitle>
            <AlertDialogDescription>
              All side-effect steps will become eligible immediately,
              including any irreversible sends or publishes. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRelease}>
              Release now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error ? (
        <p className="text-sm text-destructive mt-1">{error}</p>
      ) : null}
    </>
  );
}
