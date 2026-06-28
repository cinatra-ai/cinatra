"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  linkifyErrorText,
  isOpenAiKeyError,
  LLM_PROVIDER_SETTINGS_HREF,
  isMcpUnreachableError,
  MCP_CONFIG_HREF,
} from "./agent-error-display";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { HitlConversationPanel, type HitlConversationEntry } from "./hitl-conversation-panel";
import type { AgentRunMessageBody } from "./store";
import { fieldRendererRegistry } from "./field-renderer-registry";
import type { FieldRendererContext } from "./field-renderer-registry";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  Clock,
} from "lucide-react";
import { toast } from "@/lib/cinatra-toast";
import { approveReviewTask } from "./hitl-actions";
// Wrap the `userResponse` text with the WayFlow `user_envelope` shape
// when paperclip attachments are pending.
// Mirror of `src/app/api/llm-bridge/user-envelope.ts:envelopeSchema`;
// when there are no attachments the helper returns byte-identical
// text (back-compat invariant).
import { wrapUserResponseWithAttachments } from "./wayflow-user-response-envelope";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { hasMidRunHitlBinding } from "./orchestrator-mid-run-hitl";
import { useRuntimeFieldRendererBindings } from "./use-runtime-field-renderer-bindings";
import { getAgentBuilderTask, type TaskSnapshot } from "./a2a-actions";
import { useAgUiRunStream } from "./use-ag-ui-run-stream";
import { DispatchRenderer, type PresentationHint } from "./result-renderers";
import { agentUIOverrideRegistry } from "./agent-ui-override-registry";
import { getFieldRendererContextForAgentBuilderAction, getSkillsForAgentAction, type SkillForChip } from "./server-actions";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./grouped-setup-form-renderer";
import { HitlSkillChips } from "./hitl-skill-chips";

// Client-safe serialized form of AgentRunMessageRecord — Date becomes ISO string
export type SerializedAgentRunMessage = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  messageType: "text" | "tool_call" | "tool_result" | "final";
  toolCallId: string | null;
  toolName: string | null;
  body: AgentRunMessageBody;
  createdAt: string;
};

type AgenticRunPanelProps = {
  runId: string;
  taskId?: string; // present for runs created via A2A sendMessage
  initialStatus: string;
  initialError: string | null;
  initialMessages: SerializedAgentRunMessage[];
  // From agent_runs.agUiEnabled. When true, the panel opens an SSE stream for
  // live status + presentationHint. When null/false, the pure polling path is used.
  agUiEnabled?: boolean | null;
  // Agent package name (template slug) used to resolve selective overrides from
  // agentUIOverrideRegistry. Optional: when absent, override resolution is skipped
  // and DispatchRenderer is used.
  agentPackageName?: string;
  traceId?: string | null;    // OTel trace ID; when present, show "View trace" link
  // Run inputParams forwarded into allFieldValues so mid-run HITL renderers
  // (e.g. CampaignRecipientsReviewRenderer) can read setup values
  // (senderEmail, offeringCompanyWebsite, etc.) when creating campaigns.
  inputParams?: Record<string, unknown>;
  // Agent template ID for HITL renderers POSTing to
  // /api/agents/builder/[templateId]/hitl-assist. Threaded into the
  // FieldRendererContext below so renderers can read context.templateId
  // (parity with OrchestratorStepperPanel + HitlApprovalCard).
  templateId?: string;
  // DB-hydrated initial text for external-A2A runs that completed before the
  // page opened. Passed through to useAgUiRunStream's options so the
  // "Agent output" block renders on first paint from the DB value, without
  // waiting for SSE reconnect. Empty string or undefined for internal runs.
  initialStreamedText?: string;
  // Chat prompt-window HITL. When this panel is mounted inside the chat thread
  // (via InlineAgentRunCard), the chat needs to know when a HITL gate is open
  // so the user can drive it by typing into the prompt window instead of the
  // embedded form. Fires with a stable descriptor on gate identity/schema
  // change, and with `null` (same runId) when the gate closes. `submit` reuses
  // this panel's exact approval path (single source of truth — buffered values,
  // fieldName wrapping, stale-gate suppression).
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
};

export type ChatGateField = {
  name: string;
  type: string;
  title?: string;
  required: boolean;
};

export type ChatGateDescriptor = {
  runId: string;
  /** Per-mount identity — clear only if the registry still holds THIS instance
   *  to guard remount races for the same runId. */
  instanceId: string;
  reviewTaskId: string;
  xRenderer: string;
  /** Flattened required+optional fields — NOT the full renderer schema. */
  fields: ChatGateField[];
  /** Setup-loop primitive-wrap key; undefined for mid-run renderer gates. */
  fieldName?: string;
  /**
   * Submit the gate from the chat prompt-window path. Reuses AgenticRunPanel's
   * approval logic verbatim. `value` is either an object of field values or a
   * bare primitive (string/number/boolean) for a single-field gate.
   */
  submit: (value: Record<string, unknown> | string | number | boolean) => Promise<void>;
};

type HitlContext = {
  xRenderer: string;
  childRunId: string | null;
  reviewTaskId: string;
  inputSchema: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  /**
   * Schema property name carried on INTERRUPT (5th arg of
   * `AgUiAdapter.onInterrupt`). Set by the setup-loop in execution.ts — tells
   * the workspace panel which key to wrap primitive onChange values into when
   * calling `approveReviewTask({ [fieldName]: value }, fieldName)`.
   * `undefined` for non-setup-loop INTERRUPTs (WayFlow A2A gates, output
   * renderers) — those paths already operate on full schemas. Plumbed through
   * from `streamResult.interruptContext.fieldName` (SSE path).
   */
  fieldName?: string;
};

type RunPollResponse = {
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  messages: SerializedAgentRunMessage[];
  hitlContext?: HitlContext | null;
};

function statusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "pending_approval") return "outline";
  // Trigger-related run states.
  // pending_trigger: form is open, awaiting submit (neutral / outline).
  // armed:           trigger configured, waiting for the gate to fire (calm accent / secondary).
  if (status === "pending_trigger") return "outline";
  if (status === "armed") return "secondary";
  return "secondary";
}

// Render an inline lucide icon next to the status word for trigger-related
// and failure states. Icons are aria-hidden; the badge retains its visible
// text label for accessibility.
function statusIcon(status: string): ReactNode {
  if (status === "pending_trigger")
    return <Clock aria-hidden="true" size={12} />;
  if (status === "armed")
    return <CalendarClock aria-hidden="true" size={12} />;
  if (status === "failed")
    return <AlertCircle aria-hidden="true" size={12} />;
  return null;
}

function buildLabelAndContent(body: AgentRunMessageBody): {
  label: string;
  content: string;
} {
  switch (body.messageType) {
    case "text":
      return {
        label: body.role === "user" ? "Input" : body.role === "system" ? "System" : "Assistant",
        content: body.text,
      };
    case "tool_call":
      return {
        label: `Tool call: ${body.toolName}`,
        content: JSON.stringify(body.args, null, 2),
      };
    case "tool_result":
      return {
        label: `Tool result: ${body.toolName}${body.isError ? " (error)" : ""}`,
        content:
          typeof body.result === "string"
            ? body.result
            : JSON.stringify(body.result, null, 2),
      };
    case "final":
      return { label: "Final response", content: body.text };
  }
}

function ThreadRow({ message }: { message: SerializedAgentRunMessage }) {
  const { label, content } = buildLabelAndContent(message.body);
  const isTool =
    message.messageType === "tool_call" || message.messageType === "tool_result";
  const containerClass = isTool
    ? "rounded-control border border-line bg-surface-muted px-4 py-3"
    : "rounded-control border border-line bg-surface px-4 py-3";

  return (
    <div className={containerClass}>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <pre className="text-xs text-foreground whitespace-pre-wrap break-all max-h-40 overflow-y-auto font-mono">
        {content}
      </pre>
    </div>
  );
}

export function AgenticRunPanel({
  runId,
  taskId,
  initialStatus,
  initialError,
  initialMessages,
  agUiEnabled,
  agentPackageName,
  traceId,
  inputParams,
  templateId,
  initialStreamedText,
  onActiveGateChange,
}: AgenticRunPanelProps) {
  // SOURCE B binding registration (cinatra#151 Stage 5): fetch + register the
  // bindings of RUNTIME-installed agent packages; re-renders on arrival so
  // resolution below picks them up.
  useRuntimeFieldRendererBindings();
  // Poll-derived state — always maintained; source of truth for messages + HITL context.
  // When streamEnabled=true, pollStatus/pollError are NOT updated by the poll tick
  // (SSE owns status/error); they retain their initial values and serve as the
  // independent guard for the polling useEffect firing condition.
  const [pollStatus, setPollStatus] = useState(initialStatus);
  const [pollError, setPollError] = useState<string | null>(initialError);
  const [messages, setMessages] = useState<SerializedAgentRunMessage[]>(initialMessages);
  const [hitlContext, setHitlContext] = useState<HitlContext | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  // Pending paperclip attachments captured at Suggest time
  // (HitlConversationPanel passes them via the 2nd onSubmit arg), persisted
  // across Suggest invocations, and consumed at gate Continue time (both the
  // active-gate submit and the visible Continue button wrap `userResponse`
  // text with the envelope). A ref (not state) because `submitActiveGate` has
  // dep array `[]` and reads at submit time, not on render — the panel owns
  // its own visible-state copy.
  const pendingAttachmentsRef = useRef<LlmAttachmentRef[]>([]);
  // State-backed so onApply merges trigger re-render, matching HitlApprovalCard.
  // Accumulates renderer-produced values (e.g. campaignId from recipients renderer)
  // so the Continue button can include them in the resume payload.
  const [bufferedHitlValue, setBufferedHitlValue] = useState<Record<string, unknown>>({});
  // Sticky bottom-of-page AI-assist prompt state.
  // portalTarget is set in an effect because document.querySelector is browser-only.
  // aiSuggestions is the stable suggestion payload threaded into renderers — it
  // changes only when the user submits a prompt, NOT on every poll tick (unlike
  // `value` which is rebuilt as an inline literal on each render).
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, unknown> | undefined>(undefined);
  const [promptPending, setPromptPending] = useState(false);
  // Conversation history for the AI-assist portal — user prompts + assistant replies.
  // HitlConversationPanel owns overlay open-state, refs, outside-click handler,
  // auto-scroll, and focus handling.
  const [conversation, setConversation] = useState<HitlConversationEntry[]>([]);
  const convIdRef = useRef(0);
  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
  }, []);
  // Parent-side apply handler — merges suggestions into the buffer.
  // prev is spread first so unmentioned keys are preserved;
  // suggestion values override matching user edits intentionally —
  // the user pressed Suggest expecting AI to take priority on the keys it returns.
  const handleApply = useCallback((suggestions: Record<string, unknown>) => {
    setBufferedHitlValue(prev => ({ ...prev, ...suggestions }));
  }, []);
  // After clicking Approve/Reject, suppress re-showing the same HITL screen while the
  // server processes the resume. Prevents "Loading recipients" loop caused by the poll
  // returning pending_approval with the old context before the server advances the graph.
  const justSubmittedXRendererRef = useRef<string | null>(null);

  // Load connectedApps + gmailAliases once on mount so the HITL field renderer
  // registry can evaluate conditions like `context.connectedApps.includes("gmail")`.
  // Without this, the gmail-sender renderer falls through to the plain-input fallback
  // because its guard condition never holds. Kept in @cinatra-ai/agents to avoid a
  // reverse @cinatra-ai/agents -> @cinatra-ai/chat dependency.
  const [fieldRendererContext, setFieldRendererContext] = useState<FieldRendererContext>({
    connectedApps: [],
    runId,
  });
  useEffect(() => {
    getFieldRendererContextForAgentBuilderAction()
      .then((data) => {
        setFieldRendererContext({
          connectedApps: data.connectedApps,
          gmailAliases: data.gmailAliases,
          runId,
        });
      })
      .catch((err) => {
        if (err?.message !== "Unauthorized") {
          console.error(
            "[AgenticRunPanel] Failed to load field renderer context:",
            err,
          );
        }
      });
  }, []);

  // HITL skill chips — fetch assigned skills once per pending_approval gate.
  // Only fires when isPendingApproval to avoid unnecessary fetch cost.
  // isPendingApproval is derived below from status; we compute a local guard from
  // initialStatus here so the effect dependency is stable across re-renders.
  const [hitlSkills, setHitlSkills] = useState<SkillForChip[]>([]);
  const isPendingApprovalForEffect = pollStatus === "pending_approval" || initialStatus === "pending_approval";
  useEffect(() => {
    if (!isPendingApprovalForEffect || !agentPackageName) return;
    getSkillsForAgentAction(agentPackageName)
      .then(setHitlSkills)
      .catch(() => setHitlSkills([]));
  }, [isPendingApprovalForEffect, agentPackageName]);

  // Audit visibility is driven by
  // the auditor-agent flow gate; renderer is mounted via field-renderer registry.

  // AG-UI SSE hook — provides live status + presentationHint when agUiEnabled=true.
  // When disabled (agUiEnabled != true), hook opens no EventSource — zero network overhead.
  const streamEnabled = agUiEnabled === true;
  const streamResult = useAgUiRunStream(runId, {
    enabled: streamEnabled,
    initialStatus,
    initialStreamedText, // hydrate from DB on page load for external runs
  });

  // Effective status and error:
  // SSE wins when stream is enabled and has delivered a value; otherwise fall back to poll.
  const status =
    streamEnabled && streamResult.status !== null ? streamResult.status : pollStatus;
  const error =
    streamEnabled && streamResult.error !== null ? streamResult.error : pollError;
  const presentationHint = streamResult.presentationHint; // null when !streamEnabled
  // External A2A runs (helloworld-style peers) emit
  // TEXT_MESSAGE_CONTENT deltas accumulated by useAgUiRunStream. Internal
  // LangGraph runs never emit these so streamedText stays "".
  const streamedText = streamResult.streamedText; // "" when !streamEnabled
  // Structured JSON frames from AG-UI DATA_PART events.
  // Empty array when the hook has not seen any DATA_PART yet (including
  // internal runs, which never emit them).
  const dataPartFrames = streamResult.dataPartFrames ?? [];

  // Rendering guards use the SSE-merged status (drives badge + HITL bubble visibility).
  const isLive = status === "running" || status === "queued";
  const isPendingApproval = status === "pending_approval";

  // Polling firing guards use pollStatus — independent of SSE-derived status.
  // This keeps the poll loop alive while SSE drives the status badge, ensuring
  // messages + hitlContext continue to be fetched even when SSE has advanced status.
  const isPollLive = pollStatus === "running" || pollStatus === "queued";
  const isPollPendingApproval = pollStatus === "pending_approval";

  // Prefer SSE-delivered interruptContext when the stream is enabled;
  // fall back to polling-derived hitlContext otherwise. childRunId is not carried
  // in the INTERRUPT event — the renderer does not read it, so null is safe here.
  const rawEffectiveHitlContext: HitlContext | null = (() => {
    if (streamEnabled && streamResult.interruptContext) {
      return {
        xRenderer: streamResult.interruptContext.xRenderer,
        childRunId: null,
        reviewTaskId: streamResult.interruptContext.reviewTaskId,
        inputSchema: streamResult.interruptContext.schema,
        currentValues: streamResult.interruptContext.values,
        // Propagate fieldName from the AG-UI INTERRUPT event so the non-midRunHitl
        // onChange branch can wrap primitive values into `{[fieldName]: value}`
        // before approveReviewTask. Without this the setup-loop infinite-bounces
        // because the server merge path drops primitives.
        fieldName: streamResult.interruptContext.fieldName,
      };
    }
    return hitlContext;
  })();

  // Suppress re-showing the same HITL screen after Approve/Reject while the server
  // processes the resume. Prevents "Loading recipients" flash caused by the poll
  // returning pending_approval with the stale context before the graph advances.
  // Clear suppression when a different xRenderer arrives (next step's HITL).
  const effectiveHitlContext: HitlContext | null = (() => {
    if (
      rawEffectiveHitlContext !== null &&
      justSubmittedXRendererRef.current !== null &&
      rawEffectiveHitlContext.xRenderer === justSubmittedXRendererRef.current
    ) {
      return null;
    }
    if (rawEffectiveHitlContext !== null && justSubmittedXRendererRef.current !== null) {
      // Different step arrived — clear the suppression
      justSubmittedXRendererRef.current = null;
    }
    return rawEffectiveHitlContext;
  })();

  // -------------------------------------------------------------------------
  // Chat prompt-window HITL state lift.
  //
  // AgenticRunPanel stays the single owner of gate submit logic. We publish a
  // stable descriptor up to ChatPage (via InlineAgentRunCard) ONLY when the
  // gate identity/schema changes (signature-gated effect — never on poll
  // ticks), and expose a stable `submit` that reads the LATEST context+buffer
  // from refs so prompt-driven submits behave identically to the form.
  // -------------------------------------------------------------------------
  const latestHitlContextRef = useRef<HitlContext | null>(null);
  const bufferedHitlValueRef = useRef<Record<string, unknown>>({});
  latestHitlContextRef.current = effectiveHitlContext;
  bufferedHitlValueRef.current = bufferedHitlValue;

  const gateFields: ChatGateField[] = useMemo(() => {
    if (!effectiveHitlContext) return [];
    const schema = effectiveHitlContext.inputSchema as {
      properties?: Record<string, { type?: string; title?: string }>;
      required?: string[];
    } | null;
    const props = schema?.properties ?? {};
    const req = new Set(schema?.required ?? []);
    return Object.entries(props).map(([name, p]) => ({
      name,
      type: typeof p?.type === "string" ? p.type : "string",
      title: typeof p?.title === "string" ? p.title : undefined,
      required: req.has(name),
    }));
  }, [effectiveHitlContext]);

  // Stable submit — empty deps, reads refs. Mirrors the form's three paths:
  //   setup-loop primitive  → { [fieldName]: value }, fieldName arg set
  //   mid-run / WayFlow gate → { ...buffer, ...obj, approved, approvedAt,
  //                              userResponse } (WayFlow resume-text contract:
  //                              review-task-actions picks values.userResponse
  //                              → approvalNote → fallback)
  const submitActiveGate = useCallback(
    async (value: Record<string, unknown> | string | number | boolean) => {
      const ctx = latestHitlContextRef.current;
      if (!ctx) return;
      const buffered = bufferedHitlValueRef.current;
      setIsApproving(true);
      justSubmittedXRendererRef.current = ctx.xRenderer;
      // Discriminate by reviewTaskId, not xRenderer.
      // Setup gates use `setup-<runId>` reviewTaskIds. Two setup shapes:
      //  - single-field setup-loop: ctx.fieldName set → wrap under that key
      //    ONLY (no WayFlow approve/userResponse metadata; the server-side
      //    setup merge keys off fieldName and would reject extra keys).
      //  - grouped setup form: setup- prefix, NO fieldName → pass the field
      //    object verbatim, also WITHOUT WayFlow metadata (review-task-
      //    actions validates grouped keys against inputSchema.properties).
      // Everything else is a mid-run / WayFlow gate → needs approved +
      // userResponse (resume-text contract).
      const isSetupGate = ctx.reviewTaskId.startsWith("setup-");
      let payload: Record<string, unknown>;
      let payloadFieldName: string | undefined;
      if (isSetupGate && ctx.fieldName) {
        const raw =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          ctx.fieldName in (value as Record<string, unknown>)
            ? (value as Record<string, unknown>)[ctx.fieldName]
            : value;
        payload = { ...buffered, [ctx.fieldName]: raw };
        payloadFieldName = ctx.fieldName;
      } else if (isSetupGate) {
        // Grouped setup form — field object, no WayFlow metadata.
        const obj =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        payload = { ...buffered, ...obj };
        payloadFieldName = undefined;
      } else {
        const obj =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        // Compute the `userResponse` text first, then wrap with the WayFlow
        // envelope when paperclip attachments are pending. No attachments means
        // the wrapper returns the text verbatim (back-compat invariant).
        const legacyUserResponseText = JSON.stringify(
          Object.keys(obj).length > 0
            ? obj
            : typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ? value
              : { approved: true },
        );
        const wrapped = wrapUserResponseWithAttachments(
          legacyUserResponseText,
          pendingAttachmentsRef.current,
        );
        payload = {
          ...buffered,
          ...obj,
          approved: true,
          approvedAt: new Date().toISOString(),
          // WayFlow resume-text contract — without userResponse the server
          // forwards only "[Approved by operator]" to the flow.
          userResponse: wrapped.userResponse,
        };
      }
      try {
        await approveReviewTask(ctx.reviewTaskId, payload, payloadFieldName);
        // Clear pending attachments only on successful submit. A throwing
        // approveReviewTask leaves them so the user can retry without re-attaching.
        pendingAttachmentsRef.current = [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        if (!msg.toLowerCase().includes("already resolved")) {
          justSubmittedXRendererRef.current = null;
          throw err;
        }
      } finally {
        setIsApproving(false);
      }
    },
    [],
  );

  // Signature-gated publish: fire onActiveGateChange ONLY when gate identity
  // or field-shape changes (never on poll-tick re-renders). On gate close
  // (effectiveHitlContext === null) publish null for THIS runId so ChatPage
  // clears only this run's controller entry.
  const instanceIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `inst-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  );
  const gateSignature = effectiveHitlContext
    ? `${runId}:${effectiveHitlContext.reviewTaskId}:${effectiveHitlContext.xRenderer}:${effectiveHitlContext.fieldName ?? ""}:${gateFields.map((f) => `${f.name}:${f.type}:${f.required ? 1 : 0}`).join(",")}`
    : `${runId}:null`;
  const onActiveGateChangeRef = useRef(onActiveGateChange);
  onActiveGateChangeRef.current = onActiveGateChange;
  const gateFieldsRef = useRef(gateFields);
  gateFieldsRef.current = gateFields;
  useEffect(() => {
    const cb = onActiveGateChangeRef.current;
    if (!cb) return;
    const ctx = latestHitlContextRef.current;
    const instanceId = instanceIdRef.current;
    if (ctx) {
      cb(
        runId,
        {
          runId,
          instanceId,
          reviewTaskId: ctx.reviewTaskId,
          xRenderer: ctx.xRenderer,
          fields: gateFieldsRef.current,
          fieldName: ctx.fieldName,
          submit: submitActiveGate,
        },
        instanceId,
      );
    } else {
      cb(runId, null, instanceId);
    }
    // Cleanup on unmount: clear ONLY if the registry still holds THIS instance
    // so a remounted card for the same runId is not clobbered by an older
    // instance's unmount.
    return () => {
      onActiveGateChangeRef.current?.(runId, null, instanceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateSignature, runId, submitActiveGate]);

  const currentXRenderer = effectiveHitlContext?.xRenderer ?? null;

  // Gate-scoped attachment ref lifetime. Clear `pendingAttachmentsRef` whenever
  // the active gate changes (xRenderer transition) or the gate goes away
  // (effectiveHitlContext === null). This covers failure paths the success-clear
  // in `submitActiveGate` + the visible-Continue handler miss: "already resolved"
  // branch, external (non-panel) gate resolution, renderer/gate transition.
  // Without this clear, files attached on one gate would silently ride along
  // into the next.
  const currentReviewTaskId = effectiveHitlContext?.reviewTaskId ?? null;
  useEffect(() => {
    pendingAttachmentsRef.current = [];
  }, [currentReviewTaskId]);
  // React-idiomatic "derived state reset" pattern: when the tracked xRenderer
  // string changes, reset the buffer DURING render (no extra render cycle).
  // React guarantees that calling a setState during render with a DIFFERENT
  // value reuses the same render — it is the documented way to mirror prop-
  // change resets without a useEffect re-render race. See React docs:
  // "Storing information from previous renders".
  const [prevXRenderer, setPrevXRenderer] = useState<string | null>(null);
  if (
    currentXRenderer !== null &&
    currentXRenderer !== prevXRenderer
  ) {
    setPrevXRenderer(currentXRenderer);
    setBufferedHitlValue({});
    setConversation([]);
    // The conversation overlay close on renderer transition is driven by
    // HitlConversationPanel via its `resetSignal={currentXRenderer}` prop.
  }

  useEffect(() => {
    if (!isPollLive && !isPollPendingApproval) return;
    const intervalMs = isPollLive ? 2000 : 5000;

    const tick = async () => {
      try {
        if (taskId) {
          // A2A transport path
          const snapshot = await getAgentBuilderTask(taskId);
          if (!("cinatraStatus" in snapshot)) return;
          const s = snapshot as TaskSnapshot;
          // When stream is enabled: poll updates messages + HITL only; SSE owns status/error.
          // When stream is disabled: poll updates everything.
          if (!streamEnabled) {
            setPollStatus(s.cinatraStatus);
            setPollError(s.error);
          }
          // Single setHitlContext call avoids double React render per tick.
          setMessages(s.messages);
          setHitlContext(
            s.cinatraStatus === "pending_approval" ? (s.hitlContext ?? null) : null,
          );
          return;
        }
        // Fallback path for runs with no a2a_task_id.
        const response = await fetch(
          `/api/agents/runs/${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as RunPollResponse;
        if (!streamEnabled) {
          if (data?.status) {
            setPollStatus(data.status);
            if (data.status !== "pending_approval") setHitlContext(null);
          }
          if (data?.error !== undefined) setPollError(data.error);
        }
        if (Array.isArray(data?.messages)) setMessages(data.messages);
        if (data?.hitlContext !== undefined) setHitlContext(data.hitlContext ?? null);
      } catch {
        // Ignore polling errors — next tick will retry
      }
    };

    const interval = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(interval);
  }, [runId, taskId, isPollLive, isPollPendingApproval, streamEnabled]);

  // Resolve the STATE_SNAPSHOT override before falling through to DispatchRenderer.
  // Gated only on presentationHint — passing agentPackageName (possibly undefined)
  // allows global overrides (no agentPackageName set) to resolve too.
  // NOTE: Other event types are supported by agentUIOverrideRegistry but not yet
  // consulted at render time.
  const stateSnapshotOverride = presentationHint
    ? agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", agentPackageName)
    : null;

  // Resolve renderer entry for inline HITL bubble.
  const hitlRendererEntry = (() => {
    if (!isPendingApproval || !effectiveHitlContext?.xRenderer) return null;
    const fieldSchema: Record<string, unknown> = {
      ...(effectiveHitlContext.inputSchema ?? {}),
      "x-renderer": effectiveHitlContext.xRenderer,
    };
    const context: FieldRendererContext = {
      ...fieldRendererContext,
      runId,  // lets HITL renderers resolve campaignId via DB lookup when absent from interrupt payload
      // inputParams (run setup values) come first so currentValues can override if needed.
      allFieldValues: { ...(inputParams ?? {}), ...(effectiveHitlContext.currentValues ?? {}) },
      templateId,
      xRenderer: effectiveHitlContext.xRenderer,
    };
    const entry = fieldRendererRegistry.resolve("hitl-field", fieldSchema, context);
    // Strip "x-renderer" before passing to the renderer so renderers that
    // internally call fieldRendererRegistry.resolve (e.g. SchemaFieldRenderer)
    // don't re-match themselves and enter an infinite recursion loop.
    const { "x-renderer": _xr, ...renderSchema } = fieldSchema;
    void _xr;
    return { entry, fieldSchema: renderSchema, context };
  })();

  // Mirror the presentation hint out of currentValues so
  // the HITL render block can choose DispatchRenderer over the registry path.
  // Guard also rejects arrays and shape-less objects — mirrors the A2UiAdapter
  // guard.
  const hitlPresentationHint: PresentationHint | null = (() => {
    if (!effectiveHitlContext) return null;
    const cv = effectiveHitlContext.currentValues;
    if (typeof cv !== "object" || cv === null) return null;
    const candidate = (cv as { presentation?: unknown }).presentation;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      typeof (candidate as { type?: unknown }).type === "string"
    ) {
      return candidate as PresentationHint;
    }
    return null;
  })();

  // Bottom-of-page prompt handler. Posts to hitl-assist, applies the result to
  // the buffer (handleApply), and exposes the suggestion payload to the renderer
  // via aiSuggestions so it can sync local state without using `value` (which
  // re-references on every poll).
  const handlePromptSubmit = async (
    prompt: string,
    // HitlConversationPanel passes paperclip-uploaded refs as the 2nd arg.
    // Persist them in the panel-level ref so the gate Continue
    // (`submitActiveGate`) can wrap its `userResponse` with the WayFlow envelope.
    attachments?: LlmAttachmentRef[],
  ) => {
    if (attachments && attachments.length > 0) {
      pendingAttachmentsRef.current = [
        ...pendingAttachmentsRef.current,
        ...attachments,
      ];
    }
    const xRenderer = effectiveHitlContext?.xRenderer;
    if (!templateId || !xRenderer) return;
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
            xRenderer,
            currentValue: { ...effectiveHitlContext.currentValues, ...bufferedHitlValue },
            schemaProperties: Object.keys(
              (effectiveHitlContext.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
            ),
            // Last assistant reply so LLM can resolve references like "insert it"
            lastAssistantMessage: [...conversation].reverse().find(m => m.role === "assistant")?.content ?? null,
          }),
        },
      );
      if (!res.ok) throw new Error(`hitl-assist: ${res.status}`);
      const json = (await res.json()) as { suggestions?: Record<string, unknown> };
      const suggestions = json.suggestions ?? {};
      handleApply(suggestions);          // updates parent buffer
      setAiSuggestions(suggestions);     // notifies renderers to sync local state
      const schemaProps = ((effectiveHitlContext.inputSchema as { properties?: Record<string, { title?: string }> })?.properties) ?? {};
      const entries = Object.entries(suggestions);
      if (entries.length > 0) {
        const assistantMsg = entries.map(([k, v]) => {
          const label = schemaProps[k]?.title ?? k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
          return `${label}: "${String(v)}"`;
        }).join("\n");
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

  const approvalActionsRow: ReactNode = effectiveHitlContext && (
    <div className="flex justify-end items-center pt-2 border-t border-line">
      <Button
        size="sm"
        disabled={isApproving}
        className="gap-1.5"
        onClick={async () => {
          setIsApproving(true);
          justSubmittedXRendererRef.current = effectiveHitlContext.xRenderer;
          // The visible Continue may need to wrap the WayFlow `userResponse`
          // with the envelope when paperclip attachments are pending, but must
          // preserve any renderer-authored `userResponse` already on
          // `bufferedHitlValue` (the renderer writes it via
          // `onChange({userResponse: ...})` — see auditor / campaign /
          // email-drafts renderers). Three cases:
          //   1. setup gate => no userResponse at all;
          //   2. non-setup, no attachments => keep whatever the renderer wrote
          //      (or omit if it wrote none; review-task-actions falls back to
          //      "[Approved by operator]");
          //   3. non-setup, attachments present => wrap the renderer's text (or
          //      the server's default text) with the envelope.
          const isSetupGateBtn =
            effectiveHitlContext.reviewTaskId.startsWith("setup-");
          // Compute payload synchronously from current state to avoid a setState read race.
          const nextBuffered: Record<string, unknown> = {
            ...bufferedHitlValue,
            approved: true,
            approvedAt: new Date().toISOString(),
          };
          if (!isSetupGateBtn && pendingAttachmentsRef.current.length > 0) {
            // Only enter the wrap path when there are attachments; otherwise
            // leave `nextBuffered.userResponse` exactly as the renderer left it
            // (or absent).
            const existing =
              typeof bufferedHitlValue.userResponse === "string"
                ? (bufferedHitlValue.userResponse as string)
                : "[Approved by operator]"; // server default — mirrors
                                              // review-task-actions.ts:294
            const wrapped = wrapUserResponseWithAttachments(
              existing,
              pendingAttachmentsRef.current,
            );
            nextBuffered.userResponse = wrapped.userResponse;
          }
          try {
            await approveReviewTask(
              effectiveHitlContext.reviewTaskId,
              nextBuffered,
            );
            // Clear on successful submit. Transition, already-resolved, and
            // throw paths clear elsewhere via the gate-transition useEffect.
            pendingAttachmentsRef.current = [];
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            if (!msg.toLowerCase().includes("already resolved")) {
              justSubmittedXRendererRef.current = null;
              toast.error("Could not continue this run.");
            }
          } finally {
            setIsApproving(false);
          }
        }}
      >
        {isApproving ? "Continuing…" : "Continue"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <>
    <section className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Agentic Run Progress</h2>
        <Badge variant={statusBadgeVariant(status)} className="inline-flex items-center gap-1">
          {statusIcon(status)}
          <span>{status.replace(/_/g, " ")}</span>
        </Badge>
      </div>

      {isPendingApproval && effectiveHitlContext?.xRenderer ? (
        // Inline HITL bubble.
        <>
          <Separator />
          {/* Skill chip row — xRenderer HITL surface */}
          <HitlSkillChips skills={hitlSkills} />
          {hitlRendererEntry?.entry || hitlPresentationHint ? (
            <div className="soft-panel rounded-panel p-4 bg-surface-muted flex flex-col gap-4">
              {(() => {
                // Presentation-first branch. When the gate embedded a
                // PresentationHint in currentValues.presentation, short-circuit
                // through the generic DispatchRenderer instead of resolving a
                // per-xRenderer renderer. Both branches render the same shared
                // {approvalActionsRow} fragment.
                if (hitlPresentationHint) {
                  // PresentationHint is only injected by orchestrator mid-run gates,
                  // so approvalActionsRow is always relevant here.
                  return (
                    <>
                      <DispatchRenderer hint={hitlPresentationHint} mode="edit" />
                      {approvalActionsRow}
                    </>
                  );
                }
                if (!hitlRendererEntry?.entry) {
                  // Unreachable under the outer gate (hitlRendererEntry?.entry ||
                  // hitlPresentationHint), but keep an explicit fallback to satisfy
                  // the type narrowing — matches the outer "no renderer configured"
                  // message below.
                  return (
                    <p className="text-sm text-muted-foreground">
                      Waiting for input — no renderer configured for this step.
                    </p>
                  );
                }
                const RendererComponent = hitlRendererEntry.entry.renderer;
                // Mid-run HITL screens (`:output` suffix) buffer values into
                // bufferedHitlValue and show a Continue button below. The
                // context-selector renderer also buffers selections for an outer
                // Continue; route it through the same mid-run path. Mirrors the
                // orchestrator-stepper-panel's classifyMidRunHitl entry.
                const isMidRunHitl =
                  effectiveHitlContext.xRenderer.endsWith(":output") ||
                  // Manifest-flagged mid-run gates (cinatra#151 Stage 5): a
                  // binding declaring `midRunHitl: true` (e.g. the
                  // context-selector) buffers into the outer Continue here
                  // too — strict ID match via the live registry, covering
                  // runtime-installed agents as well.
                  hasMidRunHitlBinding(effectiveHitlContext.xRenderer);
                // Grouped-setup forms (x-renderer === GROUPED_SETUP_FORM_RENDERER_ID or
                // its :output variant) have their own submit button — auto-approve after
                // the form submits so the user sees exactly ONE Continue button.
                const isGroupedSetup =
                  effectiveHitlContext.xRenderer === GROUPED_SETUP_FORM_RENDERER_ID ||
                  effectiveHitlContext.xRenderer.startsWith(`${GROUPED_SETUP_FORM_RENDERER_ID}:`);
                return (
                  <>
                    <RendererComponent
                      key={effectiveHitlContext.xRenderer}
                      fieldName="hitl-field"
                      schema={hitlRendererEntry.fieldSchema}
                      value={{ ...effectiveHitlContext.currentValues, ...bufferedHitlValue }}
                      onChange={isMidRunHitl ? async (next: unknown) => {
                        // Compute nextBuffered synchronously, pass to approveReviewTask
                        // for grouped-setup immediate-submit, then setState for the visual update.
                        let nextBuffered = bufferedHitlValue;
                        if (next && typeof next === "object" && !Array.isArray(next)) {
                          const newValues = next as Record<string, unknown>;
                          nextBuffered = { ...bufferedHitlValue, ...newValues };
                          setBufferedHitlValue(nextBuffered); // visual update
                        }
                        // Grouped-setup forms: approve immediately on form submit so the
                        // user only ever sees one Continue button (no separate row below).
                        if (isGroupedSetup) {
                          setIsApproving(true);
                          justSubmittedXRendererRef.current = effectiveHitlContext.xRenderer;
                          try {
                            await approveReviewTask(
                              effectiveHitlContext.reviewTaskId,
                              { ...nextBuffered, approved: true, approvedAt: new Date().toISOString() },
                            );
                          } catch (err) {
                            const msg = err instanceof Error ? err.message : "unknown";
                            if (!msg.toLowerCase().includes("already resolved")) {
                              justSubmittedXRendererRef.current = null;
                              toast.error("Could not continue this run.");
                            }
                          } finally {
                            setIsApproving(false);
                          }
                        }
                      } : async (next: unknown) => {
                        // Primitive onChange (setup-loop fallback) must be wrapped
                        // to `{ [fieldName]: value }` before resume.
                        // The server-side merge path keys off `fieldName` to
                        // know which inputParams slot to fill; passing a raw
                        // primitive with fieldName=undefined silently no-ops
                        // and re-emits the same gate forever.
                        const setupFieldName = effectiveHitlContext.fieldName;
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
                        try {
                          await approveReviewTask(
                            effectiveHitlContext.reviewTaskId,
                            payload,
                            payloadFieldName,
                          );
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : "unknown";
                          if (msg.toLowerCase().includes("already resolved")) return;
                          throw err;
                        }
                      }}
                      context={hitlRendererEntry.context}
                      mode="edit"
                      onApply={handleApply}
                      aiSuggestions={aiSuggestions}
                    />
                    {/* Show the external Continue button only for non-grouped-setup midrun renderers. */}
                    {isMidRunHitl && !isGroupedSetup && approvalActionsRow}
                  </>
                );
              })()}
            </div>
          ) : (
            // Fallback: renderer not found in registry.
            <div className="soft-panel rounded-panel p-4 bg-surface-muted">
              <p className="text-sm text-muted-foreground">
                Waiting for input — no renderer configured for this step.
              </p>
            </div>
          )}
        </>
      ) : isPendingApproval ? (
        // Standard HITL approval banner (tool-call gate without x-renderer)
        <>
          {/* Skill chip row — tool-call gate HITL surface */}
          <HitlSkillChips skills={hitlSkills} />
          <div className="rounded-control border border-line bg-surface-muted px-4 py-3 flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              Run paused — awaiting human approval before continuing.
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href={`/configuration/agents/approvals?runId=${encodeURIComponent(runId)}`}>
                Review approval
              </Link>
            </Button>
          </div>
        </>
      ) : null}

      {traceId ? (
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/analytics/api?runId=${encodeURIComponent(runId)}`}
              target="_blank"
              rel="noreferrer"
            >
              View trace
            </Link>
          </Button>
        </div>
      ) : null}

      {error && status === "failed" && (
        <div className="rounded-control border border-line bg-surface-muted px-4 py-3 max-w-full overflow-hidden">
          <div className="text-xs font-medium text-muted-foreground mb-1">Error</div>
          {/* Long unbreakable tokens (e.g. masked sk-proj-… keys) overflowed the
              panel; constrain the container (max-w-full overflow-hidden) and keep
              break-all wrapping. Linkify provider URLs in the message so they are
              actionable, and link to the in-app key settings. (#498) */}
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
            {linkifyErrorText(error).map((seg, i) =>
              seg.kind === "link" ? (
                <Link
                  key={i}
                  href={seg.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {seg.value}
                </Link>
              ) : (
                <span key={i}>{seg.value}</span>
              ),
            )}
          </pre>
          {isOpenAiKeyError(error) && (
            <Link
              href={LLM_PROVIDER_SETTINGS_HREF}
              className="mt-2 inline-flex text-xs font-medium text-primary underline underline-offset-2"
            >
              Update your OpenAI API key →
            </Link>
          )}
          {/* Hosted-MCP 424: the provider could not reach this instance's public
              MCP URL to load the cinatra toolbox. Link to the MCP config so the
              user can fix the public URL / tunnel. (#500) */}
          {isMcpUnreachableError(error) && !isOpenAiKeyError(error) && (
            <Link
              href={MCP_CONFIG_HREF}
              className="mt-2 inline-flex text-xs font-medium text-primary underline underline-offset-2"
            >
              Check your MCP server configuration →
            </Link>
          )}
        </div>
      )}

      {/* AG-UI STATE_SNAPSHOT rendering.
          Checks agentUIOverrideRegistry first for a selective override.
          Falls through to DispatchRenderer when no override is registered.
          DispatchRenderer returns null for tool_call_summary and unknown hint types. */}
      {presentationHint && (
        <div className="soft-panel rounded-panel p-4">
          {stateSnapshotOverride ? (
            (() => {
              const OverrideRenderer = stateSnapshotOverride.renderer;
              return (
                <OverrideRenderer
                  eventType="STATE_SNAPSHOT"
                  payload={presentationHint}
                  agentPackageName={agentPackageName ?? ""}
                  runId={runId}
                />
              );
            })()
          ) : (
            <DispatchRenderer hint={presentationHint} mode="view" />
          )}
        </div>
      )}

      {/* External A2A agents surface output through
          TEXT_MESSAGE_CONTENT deltas accumulated in streamedText. When non-empty,
          render inline. React's default JSX escaping sanitises the text node —
          no dangerouslySetInnerHTML. Internal LangGraph runs never populate this field. */}
      {streamedText && (
        <div className="soft-panel rounded-panel p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Agent output</h3>
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all font-mono">
            {streamedText}
          </pre>
        </div>
      )}

      {/* Structured output frames emitted via AG-UI DATA_PART.
          Payload rendered via React JSX text-node escaping only — no raw-HTML
          injection prop is used. Block is conditional on non-empty frames so
          internal-LangGraph runs (which never emit DATA_PART) never see it. */}
      {dataPartFrames.length > 0 && (
        <div className="soft-panel rounded-panel p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Structured output</h3>
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all font-mono">
            {JSON.stringify(dataPartFrames, null, 2)}
          </pre>
        </div>
      )}

      {messages.length > 0 ? (
        <div className="flex flex-col gap-2 max-h-[480px] overflow-y-auto">
          {messages.map((msg) => (
            <ThreadRow key={msg.id} message={msg} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {status === "queued" ? "Waiting to start..." : "No messages yet."}
        </p>
      )}
    </section>
    {/* Sticky bottom-of-page AI-assist
        conversation panel. Rendered via createPortal into <main> by the shared
        component HitlConversationPanel. resetSignal={currentXRenderer}
        preserves the renderer-change reset. */}
    <HitlConversationPanel
      portalTarget={portalTarget}
      visible={isPendingApproval && !!effectiveHitlContext?.xRenderer && !!templateId && !!portalTarget}
      conversation={conversation}
      promptPending={promptPending}
      storageKey={`cinatra_hitl_assist_${templateId}_${effectiveHitlContext?.xRenderer ?? ""}`}
      onSubmit={handlePromptSubmit}
      resetSignal={currentXRenderer}
      // Opt in to paperclip uploads. The panel captures uploads, calls our
      // onSubmit with the 2nd arg, we persist into pendingAttachmentsRef, and
      // the active-gate submit paths wrap the `userResponse` text with the
      // WayFlow envelope at Continue time. Setup gates intentionally omit
      // `userResponse` because the setup-loop server path doesn't read it, so
      // the paperclip is hidden for those gates to prevent attaching files that
      // would never reach the flow.
      enableAttachments={
        !!effectiveHitlContext &&
        !effectiveHitlContext.reviewTaskId.startsWith("setup-")
      }
    />
    </>
  );
}
