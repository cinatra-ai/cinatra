"use client";

/**
 * OrchestratorStepperPanel.
 *
 * Three-state client component for local-orchestrator Run tabs:
 *   1. Executing — SpinnerCard with Pause button
 *   2. Review ready — HitlApprovalCard with Approve + Reject
 *   3. Cancelled — CancelledCard with Resume + Start fresh
 *
 * State evaluation order (Pitfall 8 — prevent stale interrupt leaking into
 * Cancelled state): stopped > pending_approval > running. DO NOT reorder.
 *
 * Active-step derivation (Pitfalls 1 + 2):
 *   - highestStepNumberRef tracks the max stepNumber seen so the spinner after
 *     approve doesn't regress to Setup.
 *   - status=pending_approval + stepNumber=N → activeStep = N + 1 (approvalPolicy
 *     step N ⇒ UI step N+1 because UI step 1 is always Setup).
 *   - status=running → activeStep = (highestStepNumberRef + 0) + 2 (highest seen +
 *     1 for Setup-shift + 1 for advancing past the approved step).
 *
 * No message thread is rendered in this panel.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/cinatra-toast";
import { AlertCircle, ArrowRight, Check, Info, Loader2, Pause, X } from "lucide-react";

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LoadingSpinner } from "@cinatra-ai/sdk-ui";

import { classifyMidRunHitl } from "./orchestrator-mid-run-hitl";
import { HitlConversationPanel, type HitlConversationEntry } from "./hitl-conversation-panel";
import { useAgUiRunStream } from "./use-ag-ui-run-stream";
import {
  cancelOrchestratorAction,
  resumeStoppedOrchestratorAction,
} from "./orchestrator-actions";
import { startDevChildPreviewRun, buildSubmissionMapByStepIndex, type SubmissionMapEntry, type SubmissionMapEntries } from "./run-actions";
import { ensureOrCheckRunNameAction } from "./run-name-actions";
import { approveReviewTask } from "./hitl-actions";
// Wrap the legacy `userResponse` text with the WayFlow `user_envelope`
// shape when paperclip attachments are pending. Refs persist attachments
// captured at Suggest time; consumed at gate Continue.
import { applyAttachmentEnvelope } from "./attachment-envelope-payload";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { fieldRendererRegistry } from "./field-renderer-registry";
import type { FieldRendererContext } from "./field-renderer-registry";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./grouped-setup-form-renderer";

// Inlined to avoid importing ./orchestrator-execution (server-only chain:
// store → background-jobs → bullmq → worker_threads) into the client bundle.
// Must stay in sync with TERMINAL_STATUSES in orchestrator-execution.ts.
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
// Stable empty map — used as the default prop value to avoid creating a new
// Map() on every render (which would cause the sync useEffect to loop).
const EMPTY_SUBMISSION_MAP = new Map<number, SubmissionMapEntry>();
const EMPTY_SUBMISSION_ENTRIES: SubmissionMapEntries = [];


function statusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "pending_approval") return "outline";
  return "secondary";
}

// `pickLegacyResumeText` / `applyAttachmentEnvelope` live in the leaf module
// `./attachment-envelope-payload` so the precedence rules can be unit-tested
// without dragging this panel's client-only imports.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepperStep = { index: number; stepNumber: number; label: string; description?: string; xRenderer?: string; childAgentPackageName?: string };

export type OrchestratorStepperPanelProps = {
  runId: string;
  initialStatus: string;
  initialError: string | null;
  agUiEnabled?: boolean | null;
  agentPackageName?: string;
  inputParams?: Record<string, unknown>;
  stepperSteps: StepperStep[];
  agentId: string;
  lgThreadId: string | null;
  // Agent template ID forwarded into FieldRendererContext so HITL
  // renderers can POST to /api/agents/builder/[templateId]/hitl-assist.
  templateId: string;
  /** Human-readable template name used as the base for auto-generated run names. */
  templateName?: string;
  /** When true, render only the stage card (no stepper, no surrounding section).
   *  Used by the Dev Stepper View to inline a child agent's stage card inside
   *  the parent panel. */
  embedMode?: boolean;
  // Completed-step replay data, server-rendered first paint.
  // Map<stepperIndex, { submittedValues, stepKey }>; falls back to new Map().
  submissionMap?: SubmissionMapEntries;
  // Raw approvalPolicy.steps shape, threaded so the client refetch
  // effect can call buildSubmissionMapByStepIndex on interrupt-clear without
  // synthesising stub objects from stepperSteps.
  policySteps?: ReadonlyArray<{
    stepNumber: number;
    gateCount?: number;
    hitlOwnedBy?: string;
    xRenderer?: string;
  }>;
};

// ---------------------------------------------------------------------------
// SpinnerCard — Executing state (status ∈ {queued, pending_input, running})
//             — Paused state (status = stopped, user triggered pause)
// ---------------------------------------------------------------------------

function SpinnerCard({
  label,
  progressMessage,
  progressError,
  onPause,
  onResume,
  isPaused,
  isPausing,
  isResuming,
  status,
}: {
  label: string;
  progressMessage?: string | null;
  progressError?: string | null;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  isPausing: boolean;
  isResuming: boolean;
  status: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-sm font-semibold text-foreground">
          {isPausing ? (
            <span className="relative inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-current animate-pause-echo"
              />
              <Pause className="relative h-5 w-5" />
            </span>
          ) : !isPaused || isResuming ? (
            <LoadingSpinner className="h-5 w-5 text-foreground" />
          ) : (
            <Pause className="h-5 w-5 text-muted-foreground" />
          )}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-6 pt-0">
        {(() => {
          const effectiveMessage = isPausing
            ? "Stopping the agent…"
            : isResuming
              ? "Resuming the agent…"
              : progressMessage;
          return effectiveMessage ? (
            <p className="text-sm text-muted-foreground">{effectiveMessage}</p>
          ) : null;
        })()}
        {progressError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{progressError}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-2">
          {!isPaused || isResuming ? (
            <Button
              variant="outline"
              size="sm"
              disabled={isPausing}
              onClick={onPause}
            >
              {isPausing ? "Pausing…" : "Pause"}
            </Button>
          ) : (
            <Button size="sm" onClick={onResume}>
              Resume
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// HitlApprovalCard — Review-ready state
// Adapted from agentic-run-panel.tsx:313–410. Key differences:
//   - NO Cancel button inside (UI-SPEC: hidden during HITL).
//   - Approve/Reject errors go through toast.error (sonner) — no window.alert.
//   - Strip "x-renderer" from schema before rendering (prevents recursion).
// ---------------------------------------------------------------------------

type InterruptCtx = NonNullable<
  ReturnType<typeof useAgUiRunStream>["interruptContext"]
>;

function HitlApprovalCard({
  interruptContext,
  runId,
  inputParams,
  isLastStep,
  isFirstStep,
  templateId,
  templateName,
  onApproved,
  onApproveRejected,
  onApprovalSubmitted,
  embedMode = false,
}: {
  interruptContext: InterruptCtx;
  runId: string;
  inputParams: Record<string, unknown> | undefined;
  isLastStep: boolean;
  isFirstStep: boolean;
  templateId: string;
  templateName: string;
  onApproved?: () => void;
  onApproveRejected?: () => void;
  /** Called after the approval API call succeeds. Receives the submitted payload,
   *  the schema, and the xRenderer so the stepper can immediately populate the
   *  replay map without waiting for a DB refetch. */
  onApprovalSubmitted?: (values: Record<string, unknown>, schema: Record<string, unknown> | undefined, xRenderer: string) => void;
  /** When true, render renderer output without the outer Card wrapper.
   *  Used by Dev Stepper View so the inline preview doesn't double-card the
   *  child agent's HITL form. */
  embedMode?: boolean;
}) {
  const [isApproving, setIsApproving] = useState(false);

  // Pending paperclip attachments are captured at Suggest time, persisted
  // across Suggest invocations, and consumed at gate Continue time. The main
  // `approveReviewTask` site below wraps the legacy `userResponse` text with
  // the envelope. Ref (not state) because the submit path reads at click time,
  // not on render; the panel owns its own visible-state copy.
  const pendingAttachmentsRef = useRef<LlmAttachmentRef[]>([]);

  // Hoisted from useRef so onApply merges trigger a re-render.
  const [bufferedHitlValue, setBufferedHitlValue] = useState<Record<string, unknown>>({});
  const justSubmittedXRendererRef = useRef<string | null>(null);
  // Reset the per-gate buffer when a new HITL gate opens (xRenderer changes).
  // Without this, gate N+1's handleContinue sends gate N's accumulated values
  // to approveReviewTask, leaking one gate's `userResponse` into the next gate's
  // resume payload.
  //
  // CRITICAL: only reset on a transition between two DISTINCT NON-NULL
  // xRenderers. `interruptContext` can briefly flicker to null on poll ticks
  // while SSE re-derives state.
  // That null flicker wiped the user's in-progress form data mid-gate
  // (trigger-agent: the configure form's `userResponse` got cleared
  // before handleContinue read it, so the resume sent "[Approved by
  // operator]" → persist node got `runId: ""` → WayFlow task failed).
  // The ref only advances on real renderer→renderer transitions; null
  // is treated as "no change" so a flicker is a no-op.
  const prevBufferKeyRef = useRef<string | null>(null);
  const bufferKey = interruptContext?.xRenderer ?? null;
  if (
    bufferKey !== null &&
    prevBufferKeyRef.current !== null &&
    prevBufferKeyRef.current !== bufferKey
  ) {
    // Real gate→gate transition — clear the previous gate's buffer.
    if (Object.keys(bufferedHitlValue).length > 0) {
      queueMicrotask(() => setBufferedHitlValue({}));
    }
  }
  // Advance the ref only on non-null keys so a transient null doesn't
  // poison the next real comparison.
  if (bufferKey !== null) {
    prevBufferKeyRef.current = bufferKey;
  }

  // Gate-scoped attachment ref lifetime. Clear `pendingAttachmentsRef`
  // whenever the active gate changes (reviewTaskId transition) OR the gate
  // goes away. Covers the failure paths the success-clear misses:
  // already-resolved branch, external (non-panel) gate resolution, panel close.
  const currentReviewTaskId = interruptContext?.reviewTaskId ?? null;
  useEffect(() => {
    pendingAttachmentsRef.current = [];
  }, [currentReviewTaskId]);

  // This panel has three approveReviewTask submit paths: main handleContinue
  // plus two renderer-owned inline submits. Without wrapping all three,
  // attachments captured by the visible paperclip can be silently dropped if
  // the user submits via a renderer-inline button. This helper applies the same
  // envelope rules at each call site: only enter the wrap on non-setup gates
  // AND attachments.length > 0; PRESERVE renderer-authored userResponse;
  // fallback "[Approved by operator]" mirrors the server default. Returns the
  // possibly modified payload; passes through primitive/array payloads unchanged
  // because those paths emit no userResponse.
  const withAttachmentEnvelope = (payload: unknown): unknown => {
    if (pendingAttachmentsRef.current.length === 0) return payload;
    if (!interruptContext) return payload;
    if (interruptContext.reviewTaskId.startsWith("setup-")) return payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      // Primitive / array payloads are renderer-shaped and don't have
      // a userResponse channel here; attachments captured under this path are
      // intentionally not mirrored into the payload.
      return payload;
    }
    return applyAttachmentEnvelope(
      payload as Record<string, unknown>,
      pendingAttachmentsRef.current,
    );
  };

  // The AI-assist prompt lives at the BOTTOM
  // of the page via createPortal into <main>, NOT inside renderers. portalTarget
  // is set in an effect because document.querySelector is browser-only.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // Stable suggestion payload threaded into the renderer so it can sync local
  // state via useEffect([aiSuggestions]). Only changes when the user submits
  // the bottom prompt — not on every poll tick.
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, unknown> | undefined>(undefined);
  // Live data the active renderer publishes via onHitlContextChange. Merged
  // into the hitl-assist fetch body (currentValue) so the LLM sees the current
  // array (e.g. recipients) rather than the empty interrupt payload that would
  // otherwise be sent.
  const [rendererHitlContext, setRendererHitlContext] = useState<Record<string, unknown>>({});
  const handleHitlContextChange = useCallback((ctx: Record<string, unknown>) => {
    setRendererHitlContext(ctx);
  }, []);
  const [promptPending, setPromptPending] = useState(false);
  // Conversation history for the AI-assist portal — user prompts + assistant replies.
  // Conversation overlay open-state, refs, outside-click handler, auto-scroll,
  // and focus handler are owned by HitlConversationPanel.
  const [conversation, setConversation] = useState<HitlConversationEntry[]>([]);
  const convIdRef = useRef(0);

  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
  }, []);

  // Parent-side apply handler merges suggestions into the buffer.
  // prev is spread first so unmentioned keys are preserved;
  // suggestion values override matching user edits intentionally —
  // the user pressed Suggest expecting AI to take priority on the keys it returns.
  const handleApply = useCallback((suggestions: Record<string, unknown>) => {
    setBufferedHitlValue(prev => ({ ...prev, ...suggestions }));
  }, []);

  const fieldSchema: Record<string, unknown> = {
    ...(interruptContext.schema ?? {}),
    "x-renderer": interruptContext.xRenderer,
  };
  const context: FieldRendererContext = {
    connectedApps: [],
    allFieldValues: {
      ...(inputParams ?? {}),
      ...(interruptContext.values ?? {}),
    },
    runId,
    templateId,
    xRenderer: interruptContext.xRenderer,
  };
  const entry = fieldRendererRegistry.resolve("hitl-field", fieldSchema, context);
  const { "x-renderer": _xr, ...renderSchema } = fieldSchema;
  void _xr;

  const isMidRunHitl = classifyMidRunHitl(interruptContext.xRenderer);
  // Narrower classifier than isMidRunHitl: matches output renderers only,
  // excluding input forms. Drives the `data-hitl-output` attribute on the
  // HitlApprovalCard root Card element, which AgentPageLayout's outer wrapper
  // matches via `:has()` to widen the shell symmetrically.
  const isOutputHitl =
    interruptContext.xRenderer.endsWith(":output") ||
    interruptContext.xRenderer.endsWith("-output");
  const isGroupedSetup =
    interruptContext.xRenderer === GROUPED_SETUP_FORM_RENDERER_ID ||
    interruptContext.xRenderer.startsWith(GROUPED_SETUP_FORM_RENDERER_ID + ":") ||
    interruptContext.xRenderer.endsWith(":setup-form");

  // Bottom-of-page prompt handler. Posts to hitl-assist, applies result to the
  // buffer (handleApply), and exposes the suggestion payload to the renderer via
  // aiSuggestions so it can sync local state without using `value` (which
  // re-references on every poll).
  const handlePromptSubmit = async (
    prompt: string,
    attachments?: LlmAttachmentRef[],
  ) => {
    // Capture paperclip attachments into the panel ref so the gate Continue
    // (`handleContinue` below) can wrap the legacy `userResponse` text with the
    // WayFlow envelope.
    if (attachments && attachments.length > 0) {
      pendingAttachmentsRef.current = [
        ...pendingAttachmentsRef.current,
        ...attachments,
      ];
    }
    if (!templateId || !interruptContext.xRenderer) return;
    const userId = ++convIdRef.current;
    setConversation(prev => [...prev, { id: userId, role: "user", content: prompt }]);
    // HitlConversationPanel's internal handleSubmit clears the PromptField and
    // opens the overlay.
    setPromptPending(true);
    try {
      const res = await fetch(
        `/api/agents/builder/${encodeURIComponent(templateId)}/hitl-assist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            xRenderer: interruptContext.xRenderer,
            currentValue: { ...interruptContext.values, ...bufferedHitlValue, ...rendererHitlContext },
            schemaProperties: Object.keys(
              (interruptContext.schema as { properties?: Record<string, unknown> })?.properties ?? {},
            ),
            lastAssistantMessage: [...conversation].reverse().find(m => m.role === "assistant")?.content ?? null,
          }),
        },
      );
      if (!res.ok) throw new Error(`hitl-assist: ${res.status}`);
      const json = (await res.json()) as { suggestions?: Record<string, unknown>; message?: string | null };
      const suggestions = json.suggestions ?? {};
      handleApply(suggestions);          // updates parent buffer
      setAiSuggestions(suggestions);     // notifies renderers to sync local state
      if (Object.keys(suggestions).length > 0) {
        const assistantMsg = json.message?.trim() || "Done.";
        setConversation(prev => [...prev, { id: ++convIdRef.current, role: "assistant", content: assistantMsg }]);
      } else {
        toast.error("No suggestions generated. Try being more specific, e.g. \"Fill in with sample values\".");
      }
    } catch (err) {
      console.warn("[hitl-assist] failed", err instanceof Error ? err.message : String(err));
      setConversation(prev => [...prev, { id: ++convIdRef.current, role: "assistant", content: "Could not fetch suggestions — please try again." }]);
    } finally {
      setPromptPending(false);
    }
  };

  // On the first HITL step: ensure the run has a unique name before proceeding.
  // Returns true if it's safe to continue, false if validation failed.
  const checkRunName = async (): Promise<boolean> => {
    if (!isFirstStep) return true;
    const result = await ensureOrCheckRunNameAction(runId, templateName);
    if (!result.ok) {
      toast.error(
        `A run named "${result.existingName}" already exists. Please choose a different name.`,
      );
      window.dispatchEvent(new CustomEvent("cinatra:agent:edit-name"));
      return false;
    }
    if (result.nameChanged) {
      window.dispatchEvent(
        new CustomEvent("cinatra:agent:name-set", { detail: { name: result.name } }),
      );
    }
    return true;
  };

  const handleContinue = async () => {
    if (!(await checkRunName())) return;
    // Optimistically switch to SpinnerCard right away — before the API call starts.
    // onApproveRejected rolls back if the call fails.
    onApproved?.();
    setIsApproving(true);
    justSubmittedXRendererRef.current = interruptContext.xRenderer;
    // Compute the payload synchronously from current state.
    // Calling approveReviewTask after a setState would risk reading stale `bufferedHitlValue`
    // because React batches updates. handleContinue is terminal (renderer unmounts on success),
    // so no setState is needed here — just capture the merged object as a local.
    let nextBuffered: Record<string, unknown> = {
      ...bufferedHitlValue,
      approved: true,
      approvedAt: new Date().toISOString(),
    };
    if (interruptContext.xRenderer.endsWith(":list-picker")) {
      // Lift the selected list into a structured approval payload so downstream
      // stages can snapshot the list at approval time. The server re-resolves
      // via crm_list_get (provider-agnostic CRM facade); the client-side
      // listName/memberCount fields are advisory, not trusted.
      const { listId, listName, memberCount } = bufferedHitlValue as {
        listId?: string;
        listName?: string;
        memberCount?: number;
      };
      const accountScopeObj = {
        type: "list" as const,
        listId: listId ?? "",
        listName: listName ?? "",
        memberCount: memberCount ?? 0,
        snapshotAt: new Date().toISOString(),
      };
      nextBuffered = { ...nextBuffered, approvalNote: JSON.stringify(accountScopeObj) };
    }
    if (interruptContext.xRenderer.endsWith(":setup-form")) {
      const { offeringCompanyWebsite, callToAction, senderName } = bufferedHitlValue as {
        offeringCompanyWebsite?: string; callToAction?: string; senderName?: string;
      };
      nextBuffered = { ...nextBuffered, approvalNote: JSON.stringify({ offeringCompanyWebsite, callToAction, senderName }) };
    }
    // Gate 1: scrape-schema-review. Lifts the operator-edited
    // instructions + outputSchema + seedUrls into an approvalNote so the
    // LLM continuation in the bridge can snapshot exactly what was approved
    // at this gate.
    if (interruptContext.xRenderer.endsWith(":scrape-schema-review")) {
      const {
        instructions = "",
        outputSchema = { type: "object", properties: {} },
        seedUrls = [],
      } = bufferedHitlValue as {
        instructions?: string;
        outputSchema?: Record<string, unknown>;
        seedUrls?: string[];
      };
      nextBuffered = {
        ...nextBuffered,
        approvalNote: JSON.stringify({
          type: "scrape-schema",
          instructions,
          outputSchema,
          seedUrls,
          snapshotAt: new Date().toISOString(),
        }),
      };
    }
    // Gate 2: final-list-review. Lifts the operator-edited
    // listName + the LLM-built memberRefs into an approvalNote so the
    // continuation can construct the crm_list_create call (+ per-member
    // crm_list_member_add loop) with exactly the approved snapshot.
    // memberRefs is passed through unchanged; the server re-resolves
    // members during crm_list_member_add.
    if (interruptContext.xRenderer.endsWith(":final-list-review")) {
      const {
        listName = "",
        memberRefs = [],
        memberCount = 0,
      } = bufferedHitlValue as {
        listName?: string;
        memberRefs?: Array<{ objectType: string; objectId: string }>;
        memberCount?: number;
      };
      nextBuffered = {
        ...nextBuffered,
        approvalNote: JSON.stringify({
          type: "final-list",
          listName,
          memberRefs,
          memberCount,
          snapshotAt: new Date().toISOString(),
        }),
      };
    }
    // Wrap the legacy `userResponse` text with the WayFlow envelope when
    // paperclip attachments are pending. Skip wrap for setup gates because the
    // server path doesn't read userResponse there; only enter the wrap when
    // attachments.length > 0. PRESERVE any renderer-authored userResponse
    // already on nextBuffered; clobbering it would change WayFlow text.
    // Fallback "[Approved by operator]" mirrors review-task-actions.ts
    // server default when no userResponse text exists.
    const isSetupGate =
      interruptContext.reviewTaskId.startsWith("setup-");
    if (!isSetupGate && pendingAttachmentsRef.current.length > 0) {
      // Share the precedence-and-wrap pure helper with the renderer-inline
      // submits. Server-side precedence userResponse → approvalNote → default
      // is mirrored inside `pickLegacyResumeText`.
      nextBuffered = applyAttachmentEnvelope(
        nextBuffered,
        pendingAttachmentsRef.current,
      );
    }
    let didApprove = false;
    try {
      await approveReviewTask(interruptContext.reviewTaskId, nextBuffered, undefined, interruptContext.schema as Record<string, unknown> | undefined);
      didApprove = true;
      // Clear on successful submit. Transition, already-resolved, and throw
      // paths clear via the gate-transition useEffect below.
      pendingAttachmentsRef.current = [];
      onApprovalSubmitted?.(nextBuffered, interruptContext.schema as Record<string, unknown> | undefined, interruptContext.xRenderer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      if (msg.toLowerCase().includes("already resolved")) {
        didApprove = true;
        onApprovalSubmitted?.(nextBuffered, interruptContext.schema as Record<string, unknown> | undefined, interruptContext.xRenderer);
      } else {
        justSubmittedXRendererRef.current = null;
        onApproveRejected?.();
        toast.error(`Could not continue: ${msg}`);
      }
    } finally {
      setIsApproving(false);
    }
  };

  const RendererComponent = entry?.renderer;
  // Generic step-confirmation interrupts (no custom xRenderer, object schema with only
  // { approved: boolean }) must bypass the schema-field-fallback renderer: its text-input
  // fallback for object types calls onChange(string) → approveReviewTask(taskId, string)
  // which LangGraph rejects (not isinstance(string, dict)). Show Continue instead so
  // handleContinue sends the correct { approved: true, approvedAt } payload.
  // Only applies when xRenderer mapped to schema-field-fallback (no custom renderer).
  const isGenericObjectSchema =
    interruptContext.xRenderer === "@cinatra-ai/agent-builder:schema-field-fallback" &&
    (interruptContext.schema as { type?: string })?.type === "object";
  // Keep the outer Continue button for last-step gates whose renderer doesn't
  // own a button, including the text-envelope branch in ReviewerAgentOutputRenderer
  // and schema-field-fallback when no renderer matches. The outer Continue is
  // always safe: it reads bufferedHitlValue, adds {approved, approvedAt}, and
  // calls approveReviewTask. Renderers that own their own action surface
  // coexist fine; their inner button still works and the outer button is a
  // redundant alternate.
  const showContinueButton = isGenericObjectSchema || (isMidRunHitl && !isGroupedSetup);

  const cardBody = (
    <>
        {RendererComponent && !isGenericObjectSchema ? (
          <RendererComponent
            key={interruptContext.xRenderer}
            fieldName="hitl-field"
            schema={renderSchema}
            value={{
              ...interruptContext.values,
              ...bufferedHitlValue,
            }}
            onChange={
              isMidRunHitl
                ? async (next: unknown) => {
                    // Compute nextBuffered synchronously, pass to
                    // approveReviewTask (if grouped-setup immediate-submit), then setState
                    // for the visual update. Reading `bufferedHitlValue` after `setBufferedHitlValue`
                    // would read stale state because React batches updates.
                    let nextBuffered = bufferedHitlValue;
                    if (next && typeof next === "object" && !Array.isArray(next)) {
                      const newValues = next as Record<string, unknown>;
                      nextBuffered = { ...bufferedHitlValue, ...newValues };
                      setBufferedHitlValue(nextBuffered); // visual update
                    }
                    if (isGroupedSetup) {
                      if (!(await checkRunName())) return;
                      onApproved?.();
                      try {
                        let approvalPayload: Record<string, unknown> = {
                          ...nextBuffered,
                          approved: true,
                          approvedAt: new Date().toISOString(),
                        };
                        if (interruptContext.xRenderer.endsWith(":setup-form")) {
                          const { offeringCompanyWebsite, callToAction, senderName } =
                            nextBuffered as {
                              offeringCompanyWebsite?: string;
                              callToAction?: string;
                              senderName?: string;
                            };
                          approvalPayload = {
                            ...approvalPayload,
                            approvalNote: JSON.stringify({ offeringCompanyWebsite, callToAction, senderName }),
                          };
                        }
                        // Wrap renderer-inline submit with the attachment
                        // envelope. The helper is a no-op on setup-* gates
                        // because the paperclip is hidden there, but guards
                        // against any non-setup grouped-form path where a
                        // chat-prompt attachment could otherwise be dropped.
                        const wrappedApprovalPayload =
                          withAttachmentEnvelope(approvalPayload) as Record<string, unknown>;
                        await approveReviewTask(interruptContext.reviewTaskId, wrappedApprovalPayload, undefined, interruptContext.schema as Record<string, unknown> | undefined);
                        pendingAttachmentsRef.current = [];
                        onApprovalSubmitted?.(wrappedApprovalPayload, interruptContext.schema as Record<string, unknown> | undefined, interruptContext.xRenderer);
                      } catch (err) {
                        const m = err instanceof Error ? err.message : "unknown";
                        if (m.toLowerCase().includes("already resolved")) return;
                        onApproveRejected?.();
                        throw err;
                      }
                    }
                  }
                : async (next: unknown) => {
                    // Setup-loop fallback path. The SchemaFieldRenderer for
                    // primitive types (string, number, array, boolean) emits
                    // onChange(primitive). The approveReviewTask handler's
                    // setup-* branch needs either a property-keyed object plus
                    // fieldName, or an object whose keys match inputSchema.properties
                    // for grouped forms. A bare primitive matches neither and
                    // silently drops the input, causing the same gate to repeat
                    // forever. The interrupt fieldName is surfaced in
                    // interruptContext; when present and the value is primitive,
                    // wrap as { [fieldName]: value } and pass fieldName so the
                    // single-field path in the handler runs.
                    const setupFieldName = (interruptContext as { fieldName?: string }).fieldName;
                    const isPrimitive =
                      next === null ||
                      next === undefined ||
                      typeof next === "string" ||
                      typeof next === "number" ||
                      typeof next === "boolean" ||
                      Array.isArray(next);
                    let payload: unknown = next;
                    let payloadFieldName: string | undefined = undefined;
                    if (setupFieldName && isPrimitive) {
                      payload = { [setupFieldName]: next };
                      payloadFieldName = setupFieldName;
                    }
                    // Wrap setup-loop fallback submit with the attachment envelope.
                    // Setup-* gates short-circuit inside the helper because the
                    // paperclip is hidden there; for any non-setup path that
                    // resolves here we mirror the envelope rather than drop a
                    // pending chat-prompt attachment.
                    const wrappedPayload = withAttachmentEnvelope(payload);
                    try {
                      await approveReviewTask(
                        interruptContext.reviewTaskId,
                        wrappedPayload,
                        payloadFieldName,
                        interruptContext.schema as Record<string, unknown> | undefined,
                      );
                      pendingAttachmentsRef.current = [];
                      if (wrappedPayload && typeof wrappedPayload === "object" && !Array.isArray(wrappedPayload)) {
                        onApprovalSubmitted?.(wrappedPayload as Record<string, unknown>, interruptContext.schema as Record<string, unknown> | undefined, interruptContext.xRenderer);
                      }
                    } catch (err) {
                      const m = err instanceof Error ? err.message : "unknown";
                      if (m.toLowerCase().includes("already resolved")) return;
                      throw err;
                    }
                  }
            }
            context={context}
            mode="edit"
            onApply={handleApply}
            aiSuggestions={aiSuggestions}
            onHitlContextChange={handleHitlContextChange}
          />
        ) : !isGenericObjectSchema ? (
          <p className="text-sm text-muted-foreground">
            Waiting for input — no renderer configured for this step.
          </p>
        ) : null}

        {showContinueButton && (
          <div className="flex justify-end pt-2 border-t border-line">
            <Button size="sm" disabled={isApproving} onClick={handleContinue} className="gap-1.5">
              {isApproving ? "Continuing…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
    </>
  );

  return (
    <>
    <Card data-hitl-output={isOutputHitl ? "true" : undefined}>
      <CardContent className="flex flex-col gap-4 p-6">{cardBody}</CardContent>
    </Card>
    {/* Sticky bottom-of-page AI-assist
        conversation panel. Delegates to the shared HitlConversationPanel.
        resetSignal is intentionally omitted — orchestrator-stepper-panel never
        had a renderer-change reset (no equivalent of agentic-run-panel.tsx:329). */}
    <HitlConversationPanel
      portalTarget={portalTarget}
      visible={!isGenericObjectSchema && !!templateId && !!portalTarget}
      conversation={conversation}
      promptPending={promptPending}
      storageKey={`cinatra_hitl_assist_${templateId}_${interruptContext.xRenderer}`}
      onSubmit={handlePromptSubmit}
      // Opt in to paperclip attachments. Setup gates hide the paperclip because
      // the setup-loop server omits userResponse.
      enableAttachments={!interruptContext.reviewTaskId.startsWith("setup-")}
    />
    </>
  );
}

// ---------------------------------------------------------------------------
// FailedCard — Failed state
// ---------------------------------------------------------------------------

function FailedCard({
  agentId,
  errorMessage,
}: {
  agentId: string;
  errorMessage: string | null;
}) {
  const router = useRouter();
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-foreground">Run failed</span>
          {errorMessage && (
            <p className="text-sm leading-6 text-muted-foreground">{errorMessage}</p>
          )}
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/agents/${agentId}/new`)}
          >
            Start fresh
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CancelledCard — Stopped state (hard cancel, not user-paused)
// ---------------------------------------------------------------------------

function CancelledCard({
  runId,
  agentId,
  lgThreadId,
}: {
  runId: string;
  agentId: string;
  lgThreadId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const canResume = lgThreadId !== null;
  const description = canResume
    ? "You stopped this run during review. You can resume from the last checkpoint or start fresh."
    : "You stopped this run mid-execution. Start a fresh run to continue.";

  const handleResume = () =>
    startTransition(async () => {
      try {
        const r = await resumeStoppedOrchestratorAction(runId);
        if (!r.ok) {
          if (r.error === "no-thread") {
            toast.error(
              "This run can't be resumed. Start a fresh run instead.",
            );
          } else {
            toast.error("Could not resume this run. Try again or start fresh.");
          }
        }
      } catch {
        toast.error("Could not resume this run. Try again or start fresh.");
      }
    });

  const handleStartFresh = () => {
    router.push(`/agents/${agentId}/new`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-foreground">
          Run stopped
        </CardTitle>
        <CardDescription className="text-sm leading-6 text-muted-foreground">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-6 pt-0">
        <div className="flex items-center gap-2">
          {canResume && (
            <Button size="sm" disabled={isPending} onClick={handleResume}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Resuming…
                </>
              ) : (
                "Resume"
              )}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={handleStartFresh}
          >
            Start fresh
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// StepperColumn helper
// ---------------------------------------------------------------------------

function StepperColumn({
  stepperSteps,
  activeStep,
  status,
  isPaused = false,
  isResuming = false,
  devStepperMode = false,
  onDevStepClick,
  onCompletedStepClick,
  onActiveStepClick,
}: {
  stepperSteps: StepperStep[];
  activeStep: number;
  status: string;
  isPaused?: boolean;
  isResuming?: boolean;
  devStepperMode?: boolean;
  onDevStepClick?: (step: StepperStep) => void;
  // Read-only HITL replay — invoked when the user clicks a completed step (s.index < activeStep)
  // so the parent can open the read-only replay surface. Takes precedence over
  // dev preview-run; never both.
  onCompletedStepClick?: (step: StepperStep) => void;
  // Read-only HITL replay — invoked when the user clicks the active step while in replay
  // mode, allowing them to exit replay and return to the live HITL gate.
  onActiveStepClick?: (step: StepperStep) => void;
}) {
  const isLoadingStatus =
    status === "running" || status === "pending_input" || status === "queued";

  return (
    <TooltipProvider>
      <div className="flex shrink-0 flex-col pt-1">
        <Stepper
          value={activeStep}
          orientation="vertical"
          indicators={{ completed: <Check className="h-3 w-3" /> }}
        >
          <StepperNav>
            {stepperSteps.map((s, i) => {
              const isActive = s.index === activeStep;
              const isCompleted = s.index < activeStep;
              const isLoading = isActive && (isLoadingStatus || isResuming);
              const isLast = i === stepperSteps.length - 1;
              const showPauseIcon = isPaused && !isCompleted && !isResuming;
              return (
                <StepperItem
                  key={s.index}
                  step={s.index}
                  completed={isCompleted}
                  loading={isLoading}
                  disabled={devStepperMode ? false : s.index > activeStep}
                  className="items-start !flex-none"
                >
                  <div className="flex items-center gap-1">
                    <StepperTrigger
                      className="gap-2 px-0 py-0.5"
                      // Read-only HITL replay — completed steps open replay; active step exits replay.
                      tabIndex={isCompleted || (isActive && onActiveStepClick) ? 0 : -1}
                      onClick={
                        isCompleted && onCompletedStepClick
                          ? () => onCompletedStepClick(s)
                          : isActive && onActiveStepClick
                            ? () => onActiveStepClick(s)
                            : devStepperMode && onDevStepClick
                              ? () => onDevStepClick(s)
                              : undefined
                      }
                    >
                      <StepperIndicator className="data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background">
                        {showPauseIcon ? <Pause className="h-3 w-3" /> : s.index}
                      </StepperIndicator>
                      <StepperTitle className="data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground">
                        {s.label}
                      </StepperTitle>
                    </StepperTrigger>
                    {s.description && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="button"
                            tabIndex={-1}
                            className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-default"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info className="h-3.5 w-3.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[220px] whitespace-normal text-left">
                          {s.description}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  {!isLast && <StepperSeparator className="ms-3 !h-2 bg-border" />}
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// ReadOnlyHitlReplay — Read-only HITL replay
// Read-only replay surface for completed HITL gates. Four states:
//   - loading: Loader2 spinner + "Loading submission…"
//   - error:   "Couldn't load this submission. Refresh to retry."
//   - empty:   "No captured submission for this step" (submittedValues === null)
//   - loaded:  fieldRendererRegistry rendered with mode="view" inside <fieldset disabled>
// Copy strings are LOCKED — do not edit without design sign-off.
// ---------------------------------------------------------------------------

function ReadOnlyHitlReplay(props: {
  submittedValues: Record<string, unknown> | null;
  xRenderer: string | undefined;
  schema: Record<string, unknown> | undefined;
  isLoading: boolean;
  error: string | null;
  runId: string;
  templateId: string;
}) {
  if (props.isLoading) {
    return (
      <div
        className="soft-panel flex items-center gap-2 py-6 text-sm text-muted-foreground"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading submission…</span>
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="soft-panel py-6 text-sm text-destructive">
        Couldn&rsquo;t load this submission. Refresh to retry.
      </div>
    );
  }
  if (props.submittedValues === null) {
    return (
      <div className="soft-panel py-6 text-sm text-muted-foreground">
        No captured submission for this step
      </div>
    );
  }

  // schema_snapshot is persisted. Use the field-renderer path (mode="view"
  // inside <fieldset disabled>) when both xRenderer and schema are available.
  // Older rows (schema_snapshot IS NULL) fall through to key-value.
  if (props.xRenderer && props.schema) {
    const fieldSchema: Record<string, unknown> = {
      ...props.schema,
      "x-renderer": props.xRenderer,
    };
    const ctx: FieldRendererContext = {
      connectedApps: [],
      allFieldValues: props.submittedValues,
      runId: props.runId,
      templateId: props.templateId,
      xRenderer: props.xRenderer,
    };
    const entry = fieldRendererRegistry.resolve("hitl-field", fieldSchema, ctx);
    const RendererComponent = entry?.renderer;
    if (RendererComponent) {
      const { "x-renderer": _xr, ...renderSchema } = fieldSchema;
      void _xr;
      return (
        <Card>
          <CardContent className="flex flex-col gap-4 p-6">
            <fieldset disabled>
              <RendererComponent
                fieldName="hitl-field"
                schema={renderSchema}
                value={props.submittedValues}
                disabled={true}
                mode="view"
                onChange={() => undefined}
                context={ctx}
              />
            </fieldset>
          </CardContent>
        </Card>
      );
    }
  }

  // Fallback: key-value summary for older submissions (schema_snapshot IS NULL)
  // or when no renderer is registered for this xRenderer.
  const INTERNAL_KEYS = new Set(["approved", "approvedAt", "stepNumber", "approvalNote"]);
  const displayEntries = Object.entries(props.submittedValues).filter(
    ([k]) => !INTERNAL_KEYS.has(k),
  );

  if (displayEntries.length === 0) {
    return (
      <div className="soft-panel py-6 text-sm text-muted-foreground">
        No captured submission for this step
      </div>
    );
  }

  return (
    <div className="soft-panel flex flex-col gap-3 p-4">
      {displayEntries.map(([key, val]) => (
        <div key={key} className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground capitalize">
            {key.replace(/([A-Z])/g, " $1").trim()}
          </span>
          <span className="text-sm text-foreground break-words">
            {typeof val === "string" ? val : JSON.stringify(val)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrchestratorStepperPanel (main component)
// ---------------------------------------------------------------------------

export function OrchestratorStepperPanel(props: OrchestratorStepperPanelProps) {
  const {
    runId,
    initialStatus,
    initialError: _initialError,
    agUiEnabled,
    agentPackageName,
    inputParams,
    stepperSteps,
    agentId,
    lgThreadId,
    templateId,
    templateName = "",
    embedMode = false,
    submissionMap: initialSubmissionEntries = EMPTY_SUBMISSION_ENTRIES,
    policySteps,
  } = props;

  const router = useRouter();

  // Completed-step replay state.
  // initialSubmissionEntries is server-rendered (instance-screens.tsx) so first
  // paint after reload has data without a client fetch. liveSubmissionMap
  // tracks the same data plus refetch results on interrupt-clear transitions.
  // Entries array (not Map) crosses the RSC/server-action boundary reliably.
  const [replayStepIndex, setReplayStepIndex] = useState<number | null>(null);
  const [liveSubmissionMap, setLiveSubmissionMap] =
    useState<Map<number, SubmissionMapEntry>>(() => new Map(initialSubmissionEntries));
  const liveSubmissionMapRef = useRef(liveSubmissionMap);
  liveSubmissionMapRef.current = liveSubmissionMap;
  const [replayLoading, setReplayLoading] = useState<boolean>(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Sync server-rendered prop to state when the prop reference changes
  // (e.g. parent re-renders with a fresh entries array). The first-paint
  // hydration is also handled by the initial useState value above.
  useEffect(() => {
    setLiveSubmissionMap(new Map(initialSubmissionEntries));
  }, [initialSubmissionEntries]);

  // Mount-time pre-fetch: covers the case where the page was
  // loaded before any submissions existed (SSR map is empty) and the user
  // later navigates back to a run that now has completed steps. Without this,
  // clicking a completed step always shows "Loading submission…" for a
  // same-session run because onApprovalSubmitted already populated the map
  // in memory — but if the page is refreshed mid-run, that in-memory state
  // is lost and only the (now empty) SSR map remains.
  // The fetch is gated on: non-queued status (implies ≥1 submission possible),
  // empty SSR map, and at least one xRenderer step in the policy.
  const mountPreFetchFiredRef = useRef(false);
  useEffect(() => {
    if (mountPreFetchFiredRef.current) return;
    mountPreFetchFiredRef.current = true;
    if (!runId || !agentPackageName || !policySteps) return;
    if (initialSubmissionEntries.length > 0) return; // SSR already has data
    if (!(policySteps as ReadonlyArray<{ xRenderer?: string }>).some((s) => Boolean(s.xRenderer))) return;
    buildSubmissionMapByStepIndex(
      runId,
      agentPackageName,
      policySteps,
      stepperSteps.map((s) => ({ index: s.index, stepNumber: s.stepNumber })),
    )
      .then((entries) => { if (entries.length > 0) setLiveSubmissionMap(new Map(entries)); })
      .catch((e) => console.warn("[OrchestratorStepperPanel] mount pre-fetch failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [devStepperMode, setDevStepperMode] = useState(false);

  useEffect(() => {
    setDevStepperMode(localStorage.getItem("__cinatra_dev_bypass_step_gates") === "true");
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "__cinatra_dev_bypass_step_gates") {
        setDevStepperMode(e.newValue === "true");
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Dev-mode inline preview: when user clicks a step in dev stepper view, we
  // spawn a fresh run of that step's child agent and render its stage card
  // inline (replacing the parent's stage card) so the parent's stepper stays
  // visible alongside. The HITL prompt window naturally renders to the parent
  // page's <main> portal target — outside the embedded panel.
  const [devActiveChild, setDevActiveChild] = useState<{
    stepIndex: number;
    label: string;
    runId: string;
    templateId: string;
    agentSlug: string;
    templateName: string;
    packageName: string;
    agUiEnabled: boolean;
  } | null>(null);
  const [devLoading, setDevLoading] = useState(false);

  // Reset the dev preview if the user toggles dev mode off.
  useEffect(() => {
    if (!devStepperMode) {
      setDevActiveChild(null);
      setDevLoading(false);
    }
  }, [devStepperMode]);

  const handleDevStepClick = useCallback(async (step: StepperStep) => {
    // Self-owned HITL steps (e.g. step 0 StartNode "Setup" or InputMessageNode
    // gates with no backing AgentNode) have no childAgentPackageName because
    // the parent agent renders them directly. For dev preview, fall back to
    // spawning a fresh run of the parent itself — its own renderer will draw
    // the form. createAgentRunPendingInput always creates an independent
    // AgentRun row, so the existing parent run is unaffected.
    const previewPackageName = step.childAgentPackageName ?? agentPackageName;
    if (!previewPackageName) {
      toast.info("This step has no preview target (no child agent and no parent package name available).");
      return;
    }
    setDevLoading(true);
    setDevActiveChild(null);
    try {
      const result = await startDevChildPreviewRun(previewPackageName);
      if (result.ok) {
        setDevActiveChild({
          stepIndex: step.index,
          label: step.label,
          runId: result.runId,
          templateId: result.templateId,
          agentSlug: result.agentSlug,
          templateName: result.templateName,
          packageName: result.packageName,
          agUiEnabled: result.agUiEnabled,
        });
      } else {
        toast.error(`Could not start dev preview: ${result.error}`);
      }
    } finally {
      setDevLoading(false);
    }
  }, [agentPackageName]);

  const streamEnabled = agUiEnabled === true;
  const stream = useAgUiRunStream(runId, {
    enabled: streamEnabled,
    initialStatus,
  });
  const status = stream.status;
  const interruptContext = stream.interruptContext;
  const runError = stream.error ?? _initialError;

  // Review consensus #3: belt-and-suspenders against stale SSE interrupt data.
  // When the run is stopped, suppress any lingering interruptContext so the
  // state-machine ordering (stopped > pending_approval) can never be bypassed
  // by a late-arriving SSE frame after Cancel.
  const effectiveInterruptContext =
    status === "stopped" ? null : interruptContext;

  // Close the replay surface only when a genuinely NEW live HITL
  // interrupt arrives (identity change by xRenderer key), so SSE heartbeats that
  // recreate the interruptContext object without changing the gate don't clear
  // a user-selected replay step.
  const prevInterruptKeyForReplayRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const key =
      effectiveInterruptContext != null
        ? ((effectiveInterruptContext as { xRenderer?: string }).xRenderer ?? "__interrupt__")
        : null;
    const prev = prevInterruptKeyForReplayRef.current;
    prevInterruptKeyForReplayRef.current = key;
    // Only clear replay on null→non-null or old-key→new-key transitions.
    if (prev !== undefined && prev !== key && key !== null) {
      setReplayStepIndex(null);
    }
  }, [effectiveInterruptContext]);

  // Fetch-on-click: when the user selects a completed step, refresh
  // the submission map from the DB. Shows a loading spinner when the entry is
  // not already in the in-memory map (e.g. user clicks a step during the brief
  // window between onApproved() and onApprovalSubmitted() firing).
  useEffect(() => {
    if (replayStepIndex === null) return;
    if (!runId || !agentPackageName || !policySteps) return;
    const shouldShowLoading = !liveSubmissionMapRef.current.has(replayStepIndex);
    if (shouldShowLoading) setReplayLoading(true);
    setReplayError(null);
    buildSubmissionMapByStepIndex(
      runId,
      agentPackageName,
      policySteps,
      stepperSteps.map((s) => ({ index: s.index, stepNumber: s.stepNumber })),
    )
      .then((entries) => { if (entries.length > 0) setLiveSubmissionMap(new Map(entries)); })
      .catch((e) => {
        console.warn("[OrchestratorStepperPanel] on-click fetch failed", e);
        if (shouldShowLoading) setReplayError("fetch-failed");
      })
      .finally(() => { if (shouldShowLoading) setReplayLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayStepIndex]);

  // Refetch the submission map on interruptContext non-null → null
  // transitions (i.e. user just submitted a HITL gate; the new row landed in
  // agent_run_hitl_prompts). This keeps same-session UX fresh without an
  // in-memory ref overlay.
  const prevInterruptRef = useRef<unknown>(null);
  useEffect(() => {
    const prev = prevInterruptRef.current;
    prevInterruptRef.current = effectiveInterruptContext;
    if (
      prev !== null &&
      effectiveInterruptContext === null &&
      runId &&
      agentPackageName &&
      policySteps
    ) {
      // Only show the loading spinner if the user is already viewing a completed step —
      // if replayStepIndex is null the refetch is a silent background map refresh.
      if (replayStepIndex !== null) setReplayLoading(true);
      setReplayError(null);
      buildSubmissionMapByStepIndex(
        runId,
        agentPackageName,
        policySteps,
        stepperSteps.map((s) => ({ index: s.index, stepNumber: s.stepNumber })),
      )
        .then((entries) => { if (entries.length > 0) setLiveSubmissionMap(new Map(entries)); })
        .catch((e) => {
          console.warn("[OrchestratorStepperPanel] submission-map refetch failed", e);
          setReplayError("refetch-failed");
        })
        .finally(() => setReplayLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveInterruptContext, runId, agentPackageName]);

  // LIMITATION: highestStepNumberRef is a render-local heuristic that resets on
  // page refresh. This is acceptable because the stepper is visual-only; the
  // authoritative run state lives in the `agent_runs` DB row and the runtime
  // checkpoint. On refresh the stepper briefly shows "Step 1" then advances as
  // soon as the next SSE frame or poll arrives. Future enhancement: persist
  // lastStepNumber in run.metadata so it survives refreshes.
  const highestStepNumberRef = useRef(0);
  const currentStepNumber =
    typeof (effectiveInterruptContext?.values as { stepNumber?: number } | undefined)
      ?.stepNumber === "number"
      ? (effectiveInterruptContext!.values as { stepNumber: number }).stepNumber
      : null;
  if (
    currentStepNumber !== null &&
    currentStepNumber > highestStepNumberRef.current
  ) {
    highestStepNumberRef.current = currentStepNumber;
  }

  // Show SpinnerCard immediately after the user clicks Continue, before the SSE
  // frame with the next interrupt arrives.
  const [awaitingNextStep, setAwaitingNextStep] = useState(false);

  // Reset when a new HITL interrupt arrives (effectiveInterruptContext gets a new value).
  useEffect(() => {
    if (effectiveInterruptContext !== null) setAwaitingNextStep(false);
  }, [effectiveInterruptContext]);

  // Reset when the run leaves pending_approval entirely.
  useEffect(() => {
    if (status !== "pending_approval") setAwaitingNextStep(false);
  }, [status]);

  // Detect unexpected early completion: if the run completed while there were still
  // steps remaining in the stepper (e.g. WayFlow sub-flows ran without HITL pauses).
  useEffect(() => {
    if (status !== "completed") return;
    const lastStep = stepperSteps.length > 0 ? stepperSteps[stepperSteps.length - 1] : null;
    const lastSeen = highestStepNumberRef.current;
    if (lastStep !== null && lastSeen > 0 && lastSeen !== lastStep.stepNumber) {
      toast.error(
        "The agent run finished before all review steps were completed. Some steps may have been skipped — check the run output.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Map policy stepNumber (from SSE) to the sequential display index (1, 2, 3…).
  // Background steps are filtered out so policy step numbers may have gaps.
  // stepNumber 0 = StartNode implied HITL; handled like any other step via find().
  const toDisplayIndex = (policyStepNum: number): number =>
    stepperSteps.find((s) => s.stepNumber === policyStepNum)?.index ?? policyStepNum;

  const activeStep = (() => {
    if (status === "pending_input" || status === "queued") return 1;
    if (status === "pending_approval" && currentStepNumber !== null) {
      if (awaitingNextStep) return toDisplayIndex(currentStepNumber) + 1;
      return toDisplayIndex(currentStepNumber);
    }
    if (status === "running") {
      return toDisplayIndex(highestStepNumberRef.current || 0) + 1;
    }
    if (status === "completed" || status === "stopped") {
      return stepperSteps.length + 1;
    }
    if (status === "failed") {
      // Show the step that was active when the run failed, not "all done".
      return toDisplayIndex(highestStepNumberRef.current) || 1;
    }
    return 1;
  })();

  // ---------------------------------------------------------------------------
  // Spinner label — always shows the step the user is currently waiting for.
  // Step 1 is not always a hardcoded "Setup" placeholder with the first real
  // agent step at index 2. The parent's own InputMessageNode setup gate can be
  // step 1 (e.g. email-outreach "Campaign setup"), so on a fresh
  // queued/pending_input run the spinner must surface step 1, not step 2.
  // ---------------------------------------------------------------------------
  const spinnerStepIndex = (() => {
    // queued/pending_input: agent hasn't started; spinner reflects step 1
    // (the first stepperStep — typically the parent's setup/InputMessageNode).
    if (status === "queued" || status === "pending_input") {
      return 1;
    }
    // pending_approval + null interrupt (transitioning between steps): advance past last seen
    if (status === "pending_approval" && currentStepNumber === null) {
      return toDisplayIndex(highestStepNumberRef.current || 0) + 1;
    }
    // paused (stopped): show the step we paused on
    if (status === "stopped") {
      return toDisplayIndex(highestStepNumberRef.current || 0) + 1;
    }
    // running / pending_approval+interrupt: activeStep already points to next
    return activeStep;
  })();

  const spinnerLabel =
    stepperSteps.find((s) => s.index === spinnerStepIndex)?.label ??
    `Step ${spinnerStepIndex}`;

  // ---------------------------------------------------------------------------
  // Pause / Resume wiring
  // ---------------------------------------------------------------------------
  // isPaused is local — survives only the current session; page refresh
  // shows CancelledCard for a stopped run regardless. Acceptable for v1.
  const [isPaused, setIsPaused] = useState(false);

  // When the user paused mid-run, cap the stepper's active step at the last
  // step actually reached so unexecuted steps don't render as completed.
  const pausedActiveStep =
    isPaused && status === "stopped"
      ? toDisplayIndex(highestStepNumberRef.current) + 1
      : activeStep;

  // Reset isPaused when the run transitions back to running (after resume).
  useEffect(() => {
    if (status === "running") setIsPaused(false);
  }, [status]);

  const [isPausing, startPause] = useTransition();
  const [isResuming, startResume] = useTransition();

  const handlePause = () => {
    startPause(async () => {
      try {
        const r = await cancelOrchestratorAction(runId);
        if (!r.ok) {
          toast.error("Could not pause this run. Try again.");
        } else {
          setIsPaused(true);
        }
      } catch {
        toast.error("Could not pause this run. Try again.");
      }
    });
  };

  const handleResume = () => {
    startResume(async () => {
      try {
        const r = await resumeStoppedOrchestratorAction(runId);
        if (!r.ok) {
          if (r.error === "no-context") {
            toast.error("This run can't be resumed — no checkpoint found.");
          } else {
            toast.error("Could not resume this run. Try again or start fresh.");
          }
        } else {
          setIsPaused(false);
        }
      } catch {
        toast.error("Could not resume this run. Try again or start fresh.");
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Elapsed-time tracker — drives cycling progress messages
  // ---------------------------------------------------------------------------
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const isActive =
      status === "running" ||
      status === "queued" ||
      status === "pending_input" ||
      (status === "pending_approval" && effectiveInterruptContext === null);

    if (!isActive) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(prev => prev + 1), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, effectiveInterruptContext === null]);

  // ---------------------------------------------------------------------------
  // Progress message — shown below spinner label in SpinnerCard
  // ---------------------------------------------------------------------------
  const spinnerStepData = stepperSteps.find(s => s.index === spinnerStepIndex);
  const subAgentRaw = spinnerStepData?.childAgentPackageName?.split("/").pop() ?? null;
  // "email-outreach-agent" → "email outreach agent"
  const subAgentName = subAgentRaw
    ? subAgentRaw.replace(/-agent$/, "").replace(/-/g, " ")
    : null;

  const progressMessage = (() => {
    if (isPaused) return "Agent paused at current step.";
    if (awaitingNextStep) return "Processing response…";
    if (status === "queued" || status === "pending_input") return "Queueing agent…";
    if (status === "pending_approval" && effectiveInterruptContext === null) {
      return "Processing response…";
    }
    if (status === "running") {
      if (elapsed < 5) {
        return subAgentName ? `Spawning ${subAgentName}…` : "Starting agent…";
      }
      if (elapsed < 20) {
        return subAgentName ? `${subAgentName} is running…` : "Agent is running…";
      }
      if (elapsed < 60) {
        return subAgentName ? `${subAgentName} still running…` : "Still running…";
      }
      return "This is taking a while — still running…";
    }
    return null;
  })();

  // ---------------------------------------------------------------------------
  // State-discriminated card — ORDER MATTERS (Pitfall 8): check stopped FIRST.
  // ---------------------------------------------------------------------------
  let stageCard: ReactNode = null;

  if (status === "failed") {
    stageCard = <FailedCard agentId={agentId} errorMessage={runError} />;
  } else if (isPaused && status === "stopped") {
    // User explicitly paused — show SpinnerCard in paused state so they can resume inline.
    stageCard = (
      <SpinnerCard
        label={spinnerLabel}
        progressMessage="Agent paused at current step."
        progressError={null}
        onPause={handlePause}
        onResume={handleResume}
        isPaused={true}
        isPausing={isPausing}
        isResuming={isResuming}
        status={status}
      />
    );
  } else if (status === "stopped") {
    stageCard = (
      <CancelledCard runId={runId} agentId={agentId} lgThreadId={lgThreadId} />
    );
  } else if (status === "pending_approval" && effectiveInterruptContext !== null && !awaitingNextStep) {
    // Go directly to approval card — no SkillsPreviewCard interstitial (req 4).
    const lastStep = stepperSteps.length > 0 ? stepperSteps[stepperSteps.length - 1] : null;
    const isLastHitlStep = lastStep !== null && currentStepNumber === lastStep.stepNumber;
    // The first HITL interrupt fires with stepNumber === 0 (the setup/trigger step).
    const isFirstHitlStep = currentStepNumber === 0;
    stageCard = (
      <HitlApprovalCard
        interruptContext={effectiveInterruptContext}
        runId={runId}
        inputParams={inputParams}
        isLastStep={isLastHitlStep}
        isFirstStep={isFirstHitlStep}
        templateId={templateId}
        templateName={templateName}
        onApproved={() => setAwaitingNextStep(true)}
        onApproveRejected={() => setAwaitingNextStep(false)}
        onApprovalSubmitted={(values, schema, xRenderer) => {
          const entry = stepperSteps.find((s) => (s as { xRenderer?: string }).xRenderer === xRenderer);
          if (entry) {
            setLiveSubmissionMap((prev) => new Map([...prev, [entry.index, {
              submittedValues: values,
              schemaSnapshot: schema ?? null,
              stepKey: "",
            }]]));
          }
        }}
        embedMode={embedMode}
      />
    );
  } else if (
    awaitingNextStep ||
    status === "queued" ||
    status === "pending_input" ||
    status === "running" ||
    (status === "pending_approval" && effectiveInterruptContext === null)
  ) {
    stageCard = (
      <SpinnerCard
        label={spinnerLabel}
        progressMessage={progressMessage}
        progressError={runError ?? null}
        onPause={handlePause}
        onResume={handleResume}
        // Forward the parent's local isPaused state so SpinnerCard can render
        // the pausing-in-progress icon (Pause glyph + echo ring) the moment
        // the user clicks Pause, before the SSE stream flips status to
        // "stopped".
        isPaused={isPaused}
        isPausing={isPausing}
        isResuming={isResuming}
        status={status}
      />
    );
  } else if (TERMINAL_STATUSES.has(status)) {
    stageCard = null;
  }

  // Embed mode: render only the stage card. Used by the parent panel's Dev
  // Stepper View to inline a child agent's stage card without rendering the
  // child's stepper, header, or section chrome. The stage card's own Card
  // (HitlApprovalCard / FailedCard / CancelledCard / SpinnerCard) IS the
  // cream surface we want inside the amber dev-preview wrapper, so render it
  // as-is — no visual-stripping overrides. (Earlier overrides flattened the
  // Card to bg-transparent, which removed the cream `bg-card`
  // surface and left only the inner renderer's panel borders visible.)
  if (embedMode) {
    return <>{stageCard}</>;
  }

  if (stepperSteps.length === 0) {
    return (
      <section className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Agentic Run Progress</h2>
          <Badge variant={statusBadgeVariant(status)}>{status.replace(/_/g, " ")}</Badge>
        </div>
        {status === "pending_approval" && effectiveInterruptContext !== null && (
          <Separator />
        )}
        {stageCard}
      </section>
    );
  }

  let rightColumn: ReactNode;
  if (devActiveChild) {
    rightColumn = (
      <div className="flex flex-col gap-3 rounded-card border border-warning/30 bg-warning/10 p-3 text-warning">
        <div className="flex items-center justify-between text-xs font-medium">
          <span>
            Dev preview · <span className="font-semibold">{devActiveChild.label}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-warning hover:bg-warning/20 hover:text-warning"
            onClick={() => setDevActiveChild(null)}
            aria-label="Close dev preview"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <OrchestratorStepperPanel
          key={devActiveChild.runId}
          embedMode
          runId={devActiveChild.runId}
          initialStatus="queued"
          initialError={null}
          agUiEnabled={devActiveChild.agUiEnabled}
          agentPackageName={devActiveChild.packageName}
          inputParams={{}}
          stepperSteps={[]}
          agentId={devActiveChild.agentSlug}
          lgThreadId={null}
          templateId={devActiveChild.templateId}
          templateName={devActiveChild.templateName}
        />
      </div>
    );
  } else if (devLoading) {
    rightColumn = (
      <div className="flex items-center gap-3 rounded-card border border-warning/30 bg-warning/10 p-6 text-warning">
        <LoadingSpinner className="h-5 w-5" />
        <span className="text-sm">Starting dev preview…</span>
      </div>
    );
  } else if (replayStepIndex !== null) {
    // Read-only HITL replay — read-only replay surface for a completed HITL gate.
    // The effectiveInterruptContext effect clears replayStepIndex when a new
    // interrupt arrives, so replay can coexist with pending_approval status.
    const entry = liveSubmissionMap.get(replayStepIndex);
    const stepperEntry = stepperSteps.find((s) => s.index === replayStepIndex);
    rightColumn = (
      <ReadOnlyHitlReplay
        submittedValues={entry?.submittedValues ?? null}
        xRenderer={stepperEntry?.xRenderer}
        schema={entry?.schemaSnapshot ?? undefined}
        isLoading={replayLoading && !liveSubmissionMap.has(replayStepIndex)}
        error={replayError}
        runId={runId}
        templateId={templateId}
      />
    );
  } else {
    rightColumn = stageCard;
  }

  return (
    <div className="flex items-start gap-6">
      <StepperColumn
        stepperSteps={stepperSteps}
        activeStep={pausedActiveStep}
        status={status}
        isPaused={isPaused}
        isResuming={isResuming}
        devStepperMode={devStepperMode}
        onDevStepClick={handleDevStepClick}
        onCompletedStepClick={(s) => {
          setDevActiveChild(null);
          setDevLoading(false);
          setReplayStepIndex(s.index);
        }}
        onActiveStepClick={replayStepIndex !== null ? () => setReplayStepIndex(null) : undefined}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-6">{rightColumn}</div>
    </div>
  );
}
