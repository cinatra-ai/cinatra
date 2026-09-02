"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useViewerIsAdmin } from "@/components/crumb-epoch-context";
import {
  linkifyErrorText,
  isOpenAiKeyError,
  LLM_PROVIDER_SETTINGS_HREF,
  isMcpUnreachableError,
  MCP_CONFIG_HREF,
  isGenericWayflowFailure,
} from "./agent-error-display";
import {
  formatRunFailureFloorLine,
  runFailureFloorForDisplay,
} from "./run-failure-floor";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StartNewRunButton, RunCompletionCard } from "./run-completion-affordances";
import { resetAgentRun } from "./run-actions";
import { HitlConversationPanel } from "./hitl-conversation-panel";
import { useRunWindowConversation } from "./use-run-window-conversation";
// THE ONE renderer of `agent_hitl_screen` (cinatra#2930, lifecycle-b W3).
// This panel's pause screen is the drawing; the card is its identity root,
// so the same screen the run page has always shown is now a lifecycle card
// with a kind, a host and a state a capture can read.
import {
  AgentHitlScreenCard,
  HITL_FIELDS_REGION_CLASS,
  hitlFieldPresentationFor,
} from "./agent-hitl-screen-card";
import type { AgentRunMessageBody } from "./store";
import { fieldRendererRegistry } from "./field-renderer-registry";
import type { FieldRendererContext } from "./field-renderer-registry";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  Clock,
} from "lucide-react";
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "./agent-builder-ids";
import {
  LifecycleCardSurfaceProvider,
  runCardOwnsLifecycleCopy,
  defaultRunReviewSlotReader,
  useComposerFocusStore,
  useComposerTarget,
  useLifecycleCardHost,
  useRunReviewSlot,
  type RunReviewSlot,
  type RunReviewSlotReader,
} from "./lifecycle-card-runtime";
import { LIFECYCLE_VIEW_SCHEMA_VERSION, ReviewGateCard } from "./review-gate-card";
// The review screen's PLACEHOLDER (cinatra#2997) — one of the review screen's
// own states, so it lives with them rather than in this panel.
import { ReviewGatePlaceholder } from "./review-gate-states";
import { toast } from "@/lib/cinatra-toast";
import { approveReviewTask } from "./hitl-actions";
// Shared gate-submit payload builders (cinatra#853) — the WayFlow
// user_envelope attachment wrap, the setup/grouped/mid-run resume-payload
// discrimination, and the #817 context-selector envelope synthesis all
// live in the pure module so this panel and the orchestrator stepper
// submit byte-identical payloads.
import {
  applyAttachmentEnvelopeUserResponseOnly,
  buildChatGateSubmitPayload,
  hitlRendererFieldName,
  isAlreadyResolvedError,
  isGroupedSetupRenderer,
  isSetupGateTaskId,
  setupFieldRendererValue,
  withContextSelectorEnvelope,
  wrapPrimitiveSetupPayload,
} from "./hitl-gate-submit";
import {
  applyJustSubmittedSuppression,
  mapInterruptToHitlContext,
  resolveStreamFirst,
  runStatusBadgeLabel,
  statusBadgeVariant,
  type HitlGateContext as HitlContext,
  type RunWaitInterruptDescriptor,
} from "./run-surface-status";
// Pending-approval recovery book-keeping — pure classification
// of each derived-context hydration attempt, plus the BOUNDED predicates that
// gate the recovery state and its telemetry.
import {
  classifyHitlDerivation,
  describeHitlInvariantViolation,
  hitlRecoveryReason,
  isHitlRecoveryVisible,
  reduceHitlDerivation,
  INITIAL_HITL_DERIVATION_STATE,
  type HitlDerivationOutcome,
  type HitlDerivationState,
} from "./hitl-recovery-state";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { hasMidRunHitlBinding } from "./orchestrator-mid-run-hitl";
import { useRuntimeFieldRendererBindings } from "./use-runtime-field-renderer-bindings";
import { getAgentBuilderTask, type TaskSnapshot } from "./a2a-actions";
import { useAgUiRunStream } from "./use-ag-ui-run-stream";
import { DispatchRenderer, type PresentationHint } from "./result-renderers";
import { agentUIOverrideRegistry } from "./agent-ui-override-registry";
import { getFieldRendererContextForAgentBuilderAction, getSkillsForAgentAction, type SkillForChip } from "./server-actions";
import { HitlSkillChips } from "./hitl-skill-chips";
import {
  RECOMMENDATION_UNRESOLVED,
  RecommendationHoldCard,
  recommendationWasDecided,
  type RunRecommendationHoldResolution,
} from "./run-recommendation-chip-row";
import { HITL_PLACEHOLDER_FIELD_NAME, resolveFieldLabel } from "./humanize-field-name";

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
  // Template slug ("<vendor>/<packageName>") used to route the failed-state
  // "Start new run" affordance (cinatra#2412). Optional: callers that don't
  // have the slug handy (e.g. chat surfaces) still get the Retry action,
  // which only needs runId; they just don't get Start new run.
  agentId?: string;
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
  // Render surface discriminator. The sticky bottom-of-page field-assist
  // conversation (HitlConversationPanel) belongs to the /agents/* run-detail
  // UI only. In chat (InlineAgentRunCard) the panel is mounted inline and the
  // user drives an open HITL gate through the normal chat composer via
  // onActiveGateChange — the field-assist prompt there only duplicates the
  // composer and, because each inline card portals its OWN PromptField into the
  // shared <main>, N concurrent pending HITLs stack N prompts (cinatra#767).
  // Default "agent-detail" keeps the prompt under /agents/*; "chat" suppresses
  // the whole HitlConversationPanel.
  surface?: "chat" | "agent-detail";
  /**
   * May this person type in the run's prompt window? SERVER-DERIVED from the
   * RUN's own access (`respondToHitl`) — cinatra#2933, lifecycle-b W5b: "no
   * window shown to a person whose message it would refuse." Absent ⇒ shown,
   * which keeps every host that does not yet resolve it byte-identical.
   */
  canRespondInWindow?: boolean;

  /**
   * SERVER-DERIVED gate context for the very first paint.
   *
   * The panel used to start every mount with a null gate context and fill it
   * only from an SSE INTERRUPT frame or a poll tick. A run that is ALREADY
   * paused when the page is served therefore rendered the formless "awaiting
   * human approval" banner until one of those arrived — a different screen for
   * the same run depending on which entry path the reader took, and a full poll
   * interval of it on the surfaces with no live stream.
   *
   * The seed removes the gap: every entry path renders the run's own actionable
   * form on first paint. It is an INITIAL value only — the poll and the stream
   * still own every later value, so a gate that moves on is never pinned here.
   */
  initialHitlContext?: HitlContext | null;
  /**
   * THIS RUN'S SKILLS WERE DECIDED ON THE RECOMMENDATION CARD
   * (cinatra#2790, epic #2784 S9f).
   *
   * The plan: "The agentic run progress card appears once the skills are
   * decided; no skill inside it can be selected." So a run that came through the
   * recommendation card draws NO skill picker inside this panel — the settled
   * chips above it already say what was chosen, and a second, pressable list of
   * every assigned skill reads as a live choice that disagrees with the one that
   * was taken.
   *
   * IT IS A PROP because of WHERE the panel is. Inside a conversation the
   * transcript owns the recommendation card and this panel mounts none, so the
   * conversation's single resolve is passed down. On the run page there is no
   * conversation host, the panel mounts the card itself, and it reads the answer
   * off that mount instead — same authority, resolved once either way.
   */
  recommendationDecided?: boolean;
  /**
   * THE RUN'S REVIEW SLOT, AS THE SERVER ALREADY KNOWS IT (cinatra#2997).
   *
   * `ref` is the server-minted ticket for this run's own review gate, and
   * `awaiting` says a produced output's review question is still open in the
   * outbox. Both are read from the run's own rows by whoever mounts this panel —
   * the run screen reads them server-side, the chat card gets them on its seed —
   * so the FIRST paint of a run that already has a review draws that review,
   * with no tick of placeholder in front of it.
   *
   * INITIAL ONLY, exactly like `initialHitlContext`: the panel's own read owns
   * every later value, so a gate that opens after the mount still lands here and
   * a resolved one is never pinned.
   */
  initialReviewGate?: RunReviewSlot | null;
  /**
   * HOW THIS SURFACE READS THE SLOT, when the run finishes while the card is on
   * screen. A first-party, same-origin surface (the run page) passes none and
   * the panel uses the default reader. The embedded widget passes its own: it
   * holds a broker credential, `credentials: "omit"`, and must never send an
   * ambient cookie — a run is somebody's work, and this same-origin route would
   * otherwise answer as whoever else is signed in on that browser.
   */
  readReviewSlot?: RunReviewSlotReader;
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
   * WHAT THE COMPOSER IS HOLDING (cinatra#2566's composer-focus deliverable).
   *
   * - `field` (the default, and the absent value) — a HITL gate the run is
   *   blocked on. `submit` resumes it through this panel's approval path.
   * - `review_comment` — a MARKED artifact-review gate the reader focused. Its
   *   `submit` takes free TEXT and posts it as a `comment` disposition through
   *   the card's own decision path; there is no resume path on it at all, which
   *   is how cinatra#1796's single-resume guard survives the composer binding.
   *
   * A consumer that has never heard of this field sees `undefined` and treats
   * the descriptor as a field gate, which is exactly what every pre-#2566
   * descriptor was — so the field is additive rather than a fork.
   */
  kind?: "field" | "review_comment";
  /** The focused review card's server-minted opaque ref. `review_comment` only;
   *  it is how the composer names the gate it is bound to. */
  cardRef?: string;
  /**
   * Submit the gate from the chat prompt-window path. For a `field` gate this
   * reuses AgenticRunPanel's approval logic verbatim and `value` is either an
   * object of field values or a bare primitive for a single-field gate. For a
   * `review_comment` gate `value` MUST be the reader's text; anything else is
   * refused rather than serialized into a review rationale.
   *
   * Rejects (rather than returning) on failure, so a caller that only knows the
   * pre-#2566 contract still surfaces the reason instead of reporting success.
   */
  submit: (value: Record<string, unknown> | string | number | boolean) => Promise<void>;
};

// HitlContext (the panel-side gate shape) is the shared HitlGateContext
// from ./run-surface-status — the poll endpoint already returns it and
// SSE INTERRUPT frames are mapped into it via mapInterruptToHitlContext.

type RunPollResponse = {
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  messages: SerializedAgentRunMessage[];
  hitlContext?: HitlContext | null;
  /** cinatra#2997 — the run's own review slot, as the seed route answers it.
   *  Read by `useRunReviewSlot`'s reader rather than by this tick, so the two
   *  panels share one answer; declared here because it is part of the shape
   *  this response really has. */
  reviewGate?: RunReviewSlot | null;
  /** The run's own recorded lifecycle moment (cinatra#2930). */
  lifecycleMoment?: string | null;
};


// statusBadgeVariant is shared with the orchestrator stepper — see
// ./run-surface-status.

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

/**
 * Strip the lifecycle card ref out of a gate's values before they travel
 * anywhere an LLM can read (cinatra#2566, epic #2564 S2). The ref is an opaque
 * ticket the server minted for a card to address its gate with; it is never a
 * field, never content, and never something a model should see.
 */
function withoutLifecycleCardRef(
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (!("lifecycleCardRef" in values)) return values;
  const { lifecycleCardRef: _ref, ...rest } = values;
  void _ref;
  return rest;
}

export function AgenticRunPanel({
  runId,
  taskId,
  initialStatus,
  initialError,
  initialMessages,
  agUiEnabled,
  agentId,
  agentPackageName,
  traceId,
  inputParams,
  templateId,
  initialStreamedText,
  onActiveGateChange,
  surface = "agent-detail",
  canRespondInWindow,
  initialHitlContext,
  recommendationDecided,
  initialReviewGate,
  readReviewSlot,
}: AgenticRunPanelProps) {
  // May this viewer reach `/configuration`? Drives the two config CTAs in the
  // error block below (cinatra#2701, epic #2699 S2).
  const viewerIsAdmin = useViewerIsAdmin();
  // SOURCE B binding registration (cinatra#151 Stage 5): fetch + register the
  // bindings of RUNTIME-installed agent packages; re-renders on arrival so
  // resolution below picks them up.
  useRuntimeFieldRendererBindings();
  // THE AMBIENT HOST, read BEFORE this panel declares its own. When an outer
  // conversation provider (`chat_thread` or `site_widget`) is already in scope,
  // this panel is being drawn INSIDE a conversation transcript that mounts the
  // recommendation card itself — see the mount below for what that decides.
  const ambientLifecycleHost = useLifecycleCardHost();
  // Poll-derived state — always maintained; source of truth for messages + HITL context.
  // When streamEnabled=true, pollStatus/pollError are NOT updated by the poll tick
  // (SSE owns status/error); they retain their initial values and serve as the
  // independent guard for the polling useEffect firing condition.
  const [pollStatus, setPollStatus] = useState(initialStatus);
  const [pollError, setPollError] = useState<string | null>(initialError);
  const [messages, setMessages] = useState<SerializedAgentRunMessage[]>(initialMessages);
  // Seeded from the server when the caller already derived the gate (see
  // `initialHitlContext`), so a run that is paused before the page is served
  // paints its form immediately instead of the formless banner.
  const [hitlContext, setHitlContext] = useState<HitlContext | null>(
    initialHitlContext ?? null,
  );
  // THE MOMENT THE RUN STATES (cinatra#2930, epic #2926 W3), read off the row
  // through the poll rather than derived from the shape of the pause. `null`
  // until a poll answers, and for every run created before the column existed —
  // which is why the card treats an absent moment as "draw", keeping the screen
  // this panel has always shown.
  const [runLifecycleMoment, setRunLifecycleMoment] = useState<string | null>(null);
  // What the LAST derived-context hydration attempt did.
  // `hitlContext` alone cannot tell "not yet" from "never": both are null. This
  // carries the attempt count and the last failure so a paused run without a
  // context can offer a real recovery state instead of a dead-end banner.
  const [derivation, setDerivation] = useState<HitlDerivationState>(
    INITIAL_HITL_DERIVATION_STATE,
  );
  const [isRechecking, setIsRechecking] = useState(false);

  const [isApproving, setIsApproving] = useState(false);
  // cinatra#2444 — bare-gate inline Reject. Tracks WHICH decision is in
  // flight so the Approve button doesn't flip to its pending label while a
  // Reject submit (which also drives isApproving via trackApproving) runs.
  const [isRejecting, setIsRejecting] = useState(false);
  // Failed-run retry (cinatra#2412). resetAgentRun transitions the run
  // failed -> pending_input WITHOUT touching inputParams, then a full reload
  // re-reads it so the Setup screen's existing pending_input gating shows the
  // Run button again with the original inputs still filled in. A soft
  // router.refresh() is not enough here: this panel's status is local state
  // seeded once from initialStatus, so it would not pick up the server's new
  // value without a fresh mount.
  const [isRetrying, setIsRetrying] = useState(false);
  const handleRetryFailedRun = useCallback(async () => {
    setIsRetrying(true);
    try {
      const result = await resetAgentRun({ runId });
      if (result.ok) {
        window.location.reload();
        return;
      }
      toast.error(result.error ?? "Could not reset this run for retry.");
    } catch {
      toast.error("Could not reset this run for retry.");
    } finally {
      setIsRetrying(false);
    }
  }, [runId]);
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
  // cinatra#2933 (lifecycle-b W5b) — THE PER-RUN CONVERSATION.
  //
  // What is typed here is a conversation with the assistant about THIS RUN, and
  // it is kept with the run: read on mount, appended server-side per turn, so it
  // is there after a reload and can be read later beside the run. The exchange
  // shown above the field is therefore the STORE's, never local state.
  //
  // The field-assist call below is untouched and still fills the form's own
  // fields; retiring it — and the second model with it — belongs to #2934,
  // which ships the fill mechanism that replaces it. Removing it here would
  // take the fill away before its replacement exists.
  const runWindow = useRunWindowConversation({ runId, surface: "run-page" });
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
  // THE RUN'S RECOMMENDATION, as this panel's own card resolved it. Read only on
  // the run page, where this panel mounts the card (see the mount below); inside
  // a conversation the transcript owns that card and tells this panel through
  // `recommendationDecided` instead. Either way ONE resolve answers it.
  const [ownRecommendation, setOwnRecommendation] =
    useState<RunRecommendationHoldResolution>(RECOMMENDATION_UNRESOLVED);
  // Does this panel mount the recommendation card itself? The same condition the
  // mount below uses, read once so the skill-picker rule can ask whether an
  // answer is even coming.
  const panelMountsRecommendationCard = runCardOwnsLifecycleCopy(ambientLifecycleHost);
  // ONE HITL SCREEN CARD PER RUN PER TURN (cinatra#2930, lifecycle-b W3).
  //
  // The same rule the recommendation card is held to, for the same reason:
  // inside a conversation this panel is a SIBLING of the conversation's own
  // mount of the SAME card for the SAME run, so an unconditional mount here
  // would show the person two screens for one question. The conversation's
  // card owns it inside `chat_thread` and `site_widget`; the run page keeps
  // its own because no conversation host is in scope there.
  const panelMountsHitlScreenCard = runCardOwnsLifecycleCopy(ambientLifecycleHost);
  // Was this run's skill set settled on the recommendation card? If it was,
  // nothing inside this card offers a skill to press. While the panel's own read
  // is still in flight the picker also stays away — it is a run's OWN skills
  // being offered, and offering them and then withdrawing them is the flicker
  // the ruling exists to prevent. A read that gives up (or a host that never
  // reads) leaves the picker exactly as it was.
  const skillsDecidedOnCard =
    recommendationDecided === true || recommendationWasDecided(ownRecommendation);
  const recommendationStillResolving =
    panelMountsRecommendationCard && ownRecommendation.phase === "resolving";
  const drawSkillPicker = !skillsDecidedOnCard && !recommendationStillResolving;
  const isPendingApprovalForEffect = pollStatus === "pending_approval" || initialStatus === "pending_approval";
  useEffect(() => {
    if (!isPendingApprovalForEffect || !agentPackageName) return;
    getSkillsForAgentAction(agentPackageName)
      .then(setHitlSkills)
      .catch(() => setHitlSkills([]));
  }, [isPendingApprovalForEffect, agentPackageName]);

  // Run-start recommendation hold: THE POLL IS GONE (cinatra#2568 AC-1).
  //
  // This panel used to own a 4-second timer over the hold-state server action
  // plus a hand-rolled stop condition, and S4 layered a wire-driven refetch on
  // top of it because the timer alone missed a hold that appeared after its
  // first tick. Both are replaced by `RecommendationHoldCard` (mounted below),
  // which resolves the SAME authoritative action on mount, on a change in the
  // typed hold interrupt, on focus, and on its own decision — and never on a
  // schedule. The issue ordered the retirement "LAST, after replay + routing
  // exist": the reconnect-authoritative snapshot (the SSE route synthesizes the
  // run's CURRENT hold, or an explicit retirement, on every connect) and the
  // confirm/skip routing both landed with S4, so a late joiner and a re-parked
  // run are covered by the wire rather than by re-asking every four seconds.

  // No audit affordance is mounted here, and there is no auditor-agent flow gate
  // driving one any more: the auditor agent is retired, and audit output now
  // surfaces as the §VIII suggestion chips on the review card. The absence is
  // held by `agentic-run-panel.no-audit-button.test.tsx`.

  // AG-UI SSE hook — provides live status + presentationHint when agUiEnabled=true.
  // When disabled (agUiEnabled != true), hook opens no EventSource — zero network overhead.
  const streamEnabled = agUiEnabled === true;
  const streamResult = useAgUiRunStream(runId, {
    enabled: streamEnabled,
    initialStatus,
    initialStreamedText, // hydrate from DB on page load for external runs
  });

  // THE HOLD ON THE WIRE DRIVES THE CARD (cinatra#2568). The typed hold
  // interrupt and its paired RESUME are exactly the events that change the
  // answer, so the card takes this ref as its CHANGE SIGNAL and re-reads the
  // authoritative, actor-scoped state when it moves. Nothing is read OUT of the
  // ref here — the wire only ever says "something changed"; what this viewer may
  // see is the server action's call, on every resolve.
  //
  // Guarded by `kind` rather than by "there is an interrupt": the slot is typed
  // for every lifecycle interrupt kind, and only `recommendation_hold` addresses
  // this card. A future kind landing in the slot must not move this card's ref.
  //
  // A RUN THAT CAN BE HELD ALWAYS HAS THE WIRE, so retiring the timer does not
  // strand a streamless surface. `agUiEnabled` is the SSE-vs-legacy-poll
  // discriminator, and every path that inserts a run sets it TRUE — the two
  // `createAgentRun` inserts and the pending-input insert alike (the last one
  // says so in its own comment: without it "a setup → run transition would
  // appear as legacy to the panel"). `null` marks rows that predate the
  // discriminator, and those cannot acquire a NEW hold: a hold is minted at
  // trigger time by the same current code that sets the flag. So the case
  // "a hold appears after mount on a run with no stream" is unreachable, and the
  // card's mount/focus resolves cover a legacy row that was already parked.
  const holdWireRef =
    streamResult.lifecycleInterrupt?.kind === "recommendation_hold"
      ? streamResult.lifecycleInterrupt.ref
      : null;

  // Effective status and error:
  // SSE wins when stream is enabled and has delivered a value; otherwise fall back to poll.
  const status = resolveStreamFirst(streamEnabled, streamResult.status, pollStatus);
  const error = resolveStreamFirst(streamEnabled, streamResult.error, pollError);
  // Issue 3033 — the drawn floor for a run that failed at artifact
  // materialization. The ratified run-surface drawing gives ONE reading for a
  // target that did not resolve: "a sanitized, telemetry-safe one-line
  // diagnostic (package - slot - reason, never a raw error or manifest value)",
  // and where there is nothing left to show it "renders the diagnostic alone".
  // The server now persists exactly that line; this also reduces a row written
  // BEFORE the change, so an old run never draws its raw sentence either.
  // `null` means "not a materialization failure" — every other failure class
  // keeps the reading it already had below.
  const runFailureFloor = useMemo(
    () => (status === "failed" ? runFailureFloorForDisplay(error) : null),
    [error, status],
  );
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
  // fall back to polling-derived hitlContext otherwise (the poll endpoint
  // already returns the HitlContext shape).
  const rawEffectiveHitlContext: HitlContext | null =
    streamEnabled && streamResult.interruptContext
      ? mapInterruptToHitlContext(streamResult.interruptContext)
      : hitlContext;

  // Suppress re-showing the same HITL screen after Approve/Reject while the server
  // processes the resume. Prevents "Loading recipients" flash caused by the poll
  // returning pending_approval with the stale context before the graph advances.
  // Clear suppression when a different xRenderer arrives (next step's HITL).
  const suppression = applyJustSubmittedSuppression(
    rawEffectiveHitlContext,
    justSubmittedXRendererRef.current,
  );
  if (suppression.clearSuppression) {
    justSubmittedXRendererRef.current = null;
  }
  const effectiveHitlContext: HitlContext | null = suppression.context;

  // THE BADGE READS THE RUN'S OWN MOMENT (cinatra#2930, epic #2926 W3).
  //
  // The plan: "No screen re-derives a moment from a task id or from the shape of
  // a pause; a wait for a setup field and a wait for a review are two different
  // recorded facts, not one status a screen has to tell apart."
  // `classifyRunWaitInterrupt` was made a READER of the row by W2a, and the
  // reader has been reading nothing here: this panel passed the gate context
  // alone, which carries no moment, so the badge always fell through to the two
  // heuristics beneath it. Carrying the stated moment beside the context is what
  // finally hands the reader the recorded fact — and it changes no copy for any
  // run whose moment and heuristic already agreed.
  const statedWaitDescriptor: RunWaitInterruptDescriptor | null =
    effectiveHitlContext === null && runLifecycleMoment === null
      ? null
      : { ...(effectiveHitlContext ?? {}), lifecycleMoment: runLifecycleMoment };

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

  // ---------------------------------------------------------------------------
  // THE single gate-submit path (cinatra#853). Previously the panel had three
  // near-duplicate approveReviewTask call clusters (submitActiveGate, the
  // visible Continue button, the per-field onChange handlers) each owning its
  // own isApproving/suppression/attachment/error plumbing. All of them now
  // route through performGateSubmit; only the PAYLOAD construction differs per
  // path (shared pure builders in ./hitl-gate-submit). The flags preserve each
  // path's historical behavior exactly:
  //   - trackApproving: drive the isApproving spinner state
  //   - suppressGate: arm justSubmittedXRendererRef (stale-gate re-show guard)
  //   - clearAttachmentsOnSuccess: consume pendingAttachmentsRef ONLY on a
  //     true success (an "already resolved" race or a throw leaves them so
  //     the user can retry without re-attaching)
  //   - errorMode: "rethrow" (caller surfaces the error, e.g. the chat
  //     composer / SchemaFieldRenderer.submitError) or "toast" (inline
  //     Continue-style surfaces)
  // An "already resolved" rejection is always swallowed and KEEPS the
  // suppression armed — the gate really is gone.
  // ---------------------------------------------------------------------------
  const performGateSubmit = useCallback(
    async (args: {
      reviewTaskId: string;
      xRenderer: string;
      payload: unknown;
      payloadFieldName?: string;
      trackApproving: boolean;
      suppressGate: boolean;
      clearAttachmentsOnSuccess: boolean;
      errorMode: "rethrow" | "toast";
    }) => {
      if (args.trackApproving) setIsApproving(true);
      if (args.suppressGate) justSubmittedXRendererRef.current = args.xRenderer;
      try {
        await approveReviewTask(args.reviewTaskId, args.payload, args.payloadFieldName);
        if (args.clearAttachmentsOnSuccess) pendingAttachmentsRef.current = [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        if (!isAlreadyResolvedError(msg)) {
          if (args.suppressGate) justSubmittedXRendererRef.current = null;
          if (args.errorMode === "rethrow") throw err;
          toast.error("Could not continue this run.");
        }
      } finally {
        if (args.trackApproving) setIsApproving(false);
      }
    },
    [],
  );

  // Stable submit — empty deps, reads refs. The payload discrimination
  // (setup single-field / grouped setup / mid-run WayFlow) lives in
  // buildChatGateSubmitPayload (./hitl-gate-submit).
  const submitActiveGate = useCallback(
    async (value: Record<string, unknown> | string | number | boolean) => {
      const ctx = latestHitlContextRef.current;
      if (!ctx) return;
      const { payload, payloadFieldName } = buildChatGateSubmitPayload({
        reviewTaskId: ctx.reviewTaskId,
        fieldName: ctx.fieldName,
        value,
        buffered: bufferedHitlValueRef.current,
        pendingAttachments: pendingAttachmentsRef.current,
      });
      await performGateSubmit({
        reviewTaskId: ctx.reviewTaskId,
        xRenderer: ctx.xRenderer,
        payload,
        payloadFieldName,
        trackApproving: true,
        suppressGate: true,
        clearAttachmentsOnSuccess: true,
        errorMode: "rethrow",
      });
    },
    [performGateSubmit],
  );

  // cinatra#2566 — the SERVER-MINTED opaque ref a marked review gate carries.
  // It is the only handle the run card has on the gate: the run panel never
  // assembles one from ids it happens to hold, because a card ref is minted (and
  // authenticated-encrypted) at gate emission and every surface that draws a
  // card must be addressing the same server-issued ticket.
  const reviewGateCardRef =
    typeof effectiveHitlContext?.currentValues?.lifecycleCardRef === "string" &&
    effectiveHitlContext.currentValues.lifecycleCardRef.length > 0
      ? (effectiveHitlContext.currentValues.lifecycleCardRef as string)
      : null;

  // cinatra#2566's COMPOSER FOCUS. The store is the surface's, not the panel's:
  // the review CARD registers the gate (only the card knows the server's
  // `canComment` answer) and offers the affordance, and the reader's choice
  // resolves to at most ONE bound gate across every card on screen. The panel
  // reads that resolution to decide whether ITS gate is the bound one.
  //
  // No provider (the run-detail page, which has no chat composer) ⇒ no store ⇒
  // `none`, and this panel publishes exactly the null it always published.
  const composerFocusStore = useComposerFocusStore();
  const composerTarget = useComposerTarget();
  const composerBoundRef =
    reviewGateCardRef !== null &&
    composerTarget.kind === "target" &&
    composerTarget.ref === reviewGateCardRef
      ? reviewGateCardRef
      : null;

  // The FOCUSED review gate's comment submit, for the chat composer.
  //
  // cinatra#1796 IS INTACT, and this is the line that keeps it: the descriptor
  // published below carries NO resume path. It never calls `approveReviewTask`
  // and never touches `performGateSubmit`; it calls the CARD's own comment
  // action, which posts a `comment` disposition to the gate-scoped decision
  // module with the same validation order and the same CAS the review surface
  // uses. The composer therefore cannot become a second way to resume the run —
  // it is a second way to reach the ONE decision module, which is what #2566
  // ratified ("single-decision safety = the CAS, not route binding").
  //
  // The action is LOOKED UP at call time, never captured: the card owns the
  // comment path and re-registers it on every re-resolve, so a closure captured
  // when the gate opened could outlive the transport it names.
  const submitFocusedReviewComment = useCallback(
    async (value: Record<string, unknown> | string | number | boolean): Promise<void> => {
      const action = composerBoundRef
        ? composerFocusStore?.getCommentAction(composerBoundRef)
        : undefined;
      // A comment is TEXT. A caller that treated this like a field gate and sent
      // an object or an approval primitive is refused rather than serialized into
      // a rationale — belt-and-braces behind the `kind` discriminant, so even a
      // consumer that ignores it cannot turn "approve" into a comment (and still
      // cannot resume the run: there is no resume path here to reach).
      if (typeof value !== "string") {
        throw new Error("A review comment must be text.");
      }
      if (!action) {
        throw new Error("This review is no longer taking comments here.");
      }
      const result = await action(value);
      if (!result.ok) throw new Error(result.message);
    },
    [composerFocusStore, composerBoundRef],
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
    ? // The composer binding is PART of the signature: focusing (or releasing) a
      // review card changes what this panel publishes, and the publish is
      // otherwise gated on gate identity alone.
      `${runId}:${effectiveHitlContext.reviewTaskId}:${effectiveHitlContext.xRenderer}:${effectiveHitlContext.fieldName ?? ""}:${gateFields.map((f) => `${f.name}:${f.type}:${f.required ? 1 : 0}`).join(",")}:${composerBoundRef ?? ""}`
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
    const boundCardRef = composerBoundRef;
    // cinatra#1796: a MARKED artifact-review gate is NOT a submittable chat gate.
    // Publishing THIS panel's field descriptor for it would hand the chat composer
    // a `submit` that calls approveReviewTask on the paused run — a SECOND resume
    // path that bypasses the review surface (and could double-resume the gate the
    // worker also resumes). That descriptor is still never published for a marked
    // gate; the branch below publishes a COMMENT-ONLY one instead.
    if (ctx && ctx.xRenderer !== ARTIFACT_REVIEW_REDIRECT_RENDERER_ID) {
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
    } else if (ctx && boundCardRef !== null) {
      // cinatra#2566's composer-focus deliverable. The marked gate publishes a
      // descriptor again — but ONLY while the composer is bound to THIS card, and
      // it is a comment descriptor, not a gate submit.
      //
      // WHY THE BINDING GATES THE PUBLISH. With two marked gates open, the chat
      // registry answers "the latest open gate"; publishing unconditionally would
      // make the composer route a real decision-module call by registration order.
      // Publishing only for the bound card means the registry can only ever hold
      // the gate the resolver picked — explicitly, or because it is the only one.
      cb(
        runId,
        {
          runId,
          instanceId,
          reviewTaskId: ctx.reviewTaskId,
          xRenderer: ctx.xRenderer,
          // A review comment has no field shape; it is free text. An empty list
          // also keeps the classifier from ever finding a field to wrap, on the
          // path where a consumer ignores `kind`.
          fields: [],
          kind: "review_comment",
          cardRef: boundCardRef,
          submit: submitFocusedReviewComment,
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
  }, [gateSignature, runId, submitActiveGate, submitFocusedReviewComment]);

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
  // string changes, reset conversation state DURING render (no extra render
  // cycle). React guarantees that calling a setState during render with a
  // DIFFERENT value reuses the same render — it is the documented way to
  // mirror prop-change resets without a useEffect re-render race. See React
  // docs: "Storing information from previous renders".
  const [prevXRenderer, setPrevXRenderer] = useState<string | null>(null);
  if (
    currentXRenderer !== null &&
    currentXRenderer !== prevXRenderer
  ) {
    setPrevXRenderer(currentXRenderer);
    // cinatra#2933 (lifecycle-b W5b): the exchange is NO LONGER cleared here.
    // It is the RUN's conversation now — "kept per agent run" — so a run moving
    // from one gate renderer to the next keeps what was said about it. Only the
    // overlay closes, which HitlConversationPanel still does through its
    // `resetSignal={currentXRenderer}` prop.
  }

  // The HITL suggestion buffer (`bufferedHitlValue`) is keyed by BOTH
  // xRenderer AND fieldName (cinatra#2557), matching the orchestrator
  // stepper's fieldName-inclusive `bufferKey` (orchestrator-stepper-panel.tsx).
  //
  // An xRenderer-only reset (the previous behavior) never fired on a
  // field-to-field advance within the SAME renderer type: sequential per-field
  // setup gates all reuse one xRenderer (e.g. schema-field-fallback), so a
  // SUGGESTION applied via `onApply` (handleApply) for field 1 survived into
  // field 2's `value` prop (currentValues + bufferedHitlValue merge) — a
  // suggestion buffered for "brief" silently rode along under field 2's
  // ("audience") gate. Typed-input carryover through the renderer's own local
  // state was already fixed by the composite React `key` (cinatra#2541/#2556);
  // this is the analogous fix for the panel-level buffer.
  //
  // The key collapses to `${xRenderer}::` for mid-run gates (no fieldName),
  // so those keep resetting on xRenderer change alone — unchanged from today.
  const bufferedHitlValueKey =
    currentXRenderer !== null
      ? `${currentXRenderer}::${effectiveHitlContext?.fieldName ?? ""}`
      : null;
  const [prevBufferedHitlValueKey, setPrevBufferedHitlValueKey] = useState<string | null>(null);
  if (
    bufferedHitlValueKey !== null &&
    bufferedHitlValueKey !== prevBufferedHitlValueKey
  ) {
    setPrevBufferedHitlValueKey(bufferedHitlValueKey);
    setBufferedHitlValue({});
  }

  // THE derived-context refetch. Lifted out of the interval so
  // the 5s tick and the recovery state's explicit "Re-check" run the SAME path
  // — same transports, same state writes, same classification. The only thing
  // that changed inside it is that each attempt now produces an OUTCOME: the
  // early returns that used to swallow a dead transport ("not found" snapshot,
  // non-ok response, rejected fetch) still leave the run state untouched, but
  // they no longer leave the reader with nothing to act on.
  const refetchDerivedContext = useCallback(async () => {
    let outcome: HitlDerivationOutcome;
    try {
      if (taskId) {
        // A2A transport path
        const snapshot = await getAgentBuilderTask(taskId);
        if (!snapshot || !("cinatraStatus" in snapshot)) {
          // The action answered with `{ error }` (unauthorized / not found —
          // its ownership check is STRICTER than the run page's own read, so a
          // run whose page renders can still be invisible here) or with
          // nothing. Never a status, never a context.
          const reason =
            snapshot && typeof (snapshot as { error?: unknown }).error === "string"
              ? `the run snapshot could not be read (${(snapshot as { error: string }).error})`
              : "the run snapshot could not be read";
          outcome = { kind: "transport_failed", reason };
        } else {
          const s = snapshot as TaskSnapshot;
          // When stream is enabled: poll updates messages + HITL only; SSE owns status/error.
          // When stream is disabled: poll updates everything.
          if (!streamEnabled) {
            setPollStatus(s.cinatraStatus);
            setPollError(s.error);
          }
          // Single setHitlContext call avoids double React render per tick.
          setMessages(s.messages);
          const next =
            s.cinatraStatus === "pending_approval" ? (s.hitlContext ?? null) : null;
          setHitlContext(next);
          outcome = classifyHitlDerivation(s.cinatraStatus, next);
        }
      } else {
        // Fallback path for runs with no a2a_task_id.
        const response = await fetch(
          `/api/agents/runs/${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          outcome = {
            kind: "transport_failed",
            reason: `the run could not be read (HTTP ${response.status})`,
          };
        } else {
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
          if (data?.lifecycleMoment !== undefined) {
            setRunLifecycleMoment(data.lifecycleMoment ?? null);
          }
          outcome = classifyHitlDerivation(
            typeof data?.status === "string" ? data.status : null,
            data?.hitlContext ?? null,
          );
        }
      }
    } catch (err) {
      // The tick keeps its retry semantics; the reader keeps the reason.
      outcome = {
        kind: "transport_failed",
        reason: `the run could not be reached (${err instanceof Error ? err.message : "unknown error"})`,
      };
    }
    setDerivation((prev) => reduceHitlDerivation(prev, outcome));
  }, [runId, taskId, streamEnabled]);

  useEffect(() => {
    if (!isPollLive && !isPollPendingApproval) return;
    const intervalMs = isPollLive ? 2000 : 5000;
    // NO leading tick on purpose. A run that is already paused when its surface
    // mounts is handed its gate as a seed (`initialHitlContext`), so the first
    // paint needs nothing from this loop; and asking immediately would spend the
    // recovery state's "has it even tried yet?" tolerance on the very first
    // frame, which is the one moment a paused run must not be called degraded.
    const interval = window.setInterval(() => {
      void refetchDerivedContext();
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [isPollLive, isPollPendingApproval, refetchDerivedContext]);

  // -------------------------------------------------------------------------
  // THE REVIEW SLOT (cinatra#2997) — kept current by the ONE shared reader both
  // run panels use (`useRunReviewSlot`), so the run page's two panels cannot
  // drift into two answers about the same run.
  //
  // WHICH CREDENTIAL IT ASKS WITH is the caller's to say. The run page is
  // first-party and same-origin, so it takes the default reader. A surface that
  // asks with something else — the embedded widget, which holds a broker
  // credential and must never send an ambient cookie — passes its own, exactly
  // as it already does for the seed.
  // -------------------------------------------------------------------------
  const fallbackSlotReader = useMemo(
    () => defaultRunReviewSlotReader(runId),
    [runId],
  );
  const {
    slot: reviewSlot,
    mayStillOpen: reviewMayStillOpen,
  } = useRunReviewSlot({
    status,
    initial: initialReviewGate,
    read: readReviewSlot ?? fallbackSlotReader,
  });
  // KNOWN COST, stated rather than hidden: for a run with no A2A task id this
  // panel's own tick reads the SAME seed route on its own 2s schedule, so during
  // the settle window the run is read on two schedules. The window is the
  // seconds between `completed` and the gate row, the hook's cadence backs off
  // and its belt ends it, and folding the slot into the tick would only cover
  // ONE of the two transports (the A2A snapshot cannot carry it without putting
  // the gate store on every route that reaches the A2A actions).

  // The recovery state's explicit re-check. Runs the same refetch the tick
  // runs, and additionally DROPS the just-submitted suppression: that guard
  // exists only to stop a stale gate flashing back for a moment after a submit,
  // and a reader who is asking for a fresh read has already outlived its
  // purpose. Sequential setup fields share one xRenderer, so the guard cannot
  // clear itself on the next gate in that flow.
  const handleRecheckDerivedContext = useCallback(async () => {
    setIsRechecking(true);
    justSubmittedXRendererRef.current = null;
    try {
      await refetchDerivedContext();
    } finally {
      setIsRechecking(false);
    }
  }, [refetchDerivedContext]);

  // Is this paused run degraded (no usable gate context) rather than merely
  // hydrating? Bounded — see hitl-recovery-state.ts.
  const hitlRecoveryVisible = isHitlRecoveryVisible({
    isPendingApproval,
    hasContext: effectiveHitlContext !== null,
    state: derivation,
  });

  // BOUNDED telemetry. `hitlContext` is null on every healthy
  // first paint, so logging "no context" on sight would report normal
  // hydration. This fires on the same bound the recovery state uses — after a
  // server-side derivation failure, a dead transport, or enough silent
  // attempts — and at most once per mount.
  const hitlInvariantLoggedRef = useRef(false);
  useEffect(() => {
    if (hitlInvariantLoggedRef.current) return;
    const violation = describeHitlInvariantViolation({
      isPendingApproval,
      hasContext: effectiveHitlContext !== null,
      state: derivation,
    });
    if (!violation) return;
    hitlInvariantLoggedRef.current = true;
    console.warn(
      "[hitl-invariant] pending_approval run has no actionable gate context",
      { runId, taskId: taskId ?? null, ...violation },
    );
  }, [isPendingApproval, effectiveHitlContext, derivation, runId, taskId]);

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
    // RENDERER SELECTION stays on the placeholder key (cinatra#2541) — which
    // component renders a gate is decided by its `x-renderer` id, never by the
    // interrupt's field name. Only the rendered field IDENTITY below carries
    // the real name.
    const entry = fieldRendererRegistry.resolve(
      HITL_PLACEHOLDER_FIELD_NAME,
      fieldSchema,
      context,
    );
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
    // Defence in depth for the same rule (cinatra#2566): even if some future
    // caller reaches this handler for a marked review gate, the assist request
    // never leaves. The panel above is already hidden for that gate; this is the
    // guard that does not depend on a visibility prop staying correct.
    if (xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID) return;
    // The one road: the message goes to the run's own conversation with the
    // assistant. Not awaited — the field-assist fill below runs on the same
    // press, and neither waits on the other.
    void runWindow.send(prompt);
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
            // cinatra#2933 - the run the screen belongs to, so the route asks
            // the RUN's access instead of the platform tier.
            runId,
            // The gate's LIFECYCLE CARD REF is stripped before anything is sent
            // (cinatra#2566). It is an opaque server-minted ticket, it is not a
            // field a human edits, and the assist route serializes this object
            // into an LLM prompt — so it has no business here even for a gate
            // kind that is otherwise assistable.
            currentValue: withoutLifecycleCardRef({
              ...effectiveHitlContext.currentValues,
              ...bufferedHitlValue,
            }),
            schemaProperties: Object.keys(
              (effectiveHitlContext.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
            ),
            // Last assistant reply so LLM can resolve references like "insert it"
            lastAssistantMessage: [...runWindow.entries].reverse().find(m => m.role === "assistant")?.content ?? null,
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
      if (entries.length === 0) {
        toast.error("No suggestions generated. Try being more specific, e.g. \"Fill in with sample values\".");
      }
      // The fill's own line is GONE, deliberately: the window's answer is the
      // assistant's, and a second synthesized "Field: value" line beside it
      // would be the page talking over the conversation.
      void schemaProps;
    } catch (err) {
      console.warn("[hitl-assist] failed", err instanceof Error ? err.message : String(err));
    } finally {
      setPromptPending(false);
    }
  };

  // cinatra#2444 — the shared decision row, parameterized so the bare
  // tool-call-gate fallback branch can render the SAME approve machinery
  // (identical envelope: {approved, approvedAt}, attachment wrap,
  // context-selector synthesis, performGateSubmit plumbing) with an
  // additional inline Reject and gate-appropriate labels. Every existing
  // call site keeps the zero-arg `approvalActionsRow` below — byte-identical
  // behavior (single Continue button, no Reject).
  const renderApprovalActionsRow = (opts?: {
    withReject?: boolean;
    approveLabel?: string;
    approvingLabel?: string;
  }): ReactNode => effectiveHitlContext && (
    <div className="flex justify-end items-center gap-2 pt-2 border-t border-line">
      {opts?.withReject ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isApproving}
          onClick={async () => {
            // Bare-gate Reject rides the SAME resume wire as Approve
            // (performGateSubmit → approveReviewTask): the decision is
            // delivered in place and the run resumes without leaving the run
            // surface. The envelope mirrors the Approve payload with
            // approved:false; the "[Rejected by operator]" userResponse is the
            // reject analog of the server-side "[Approved by operator]"
            // fallback (review-task-actions resumeText precedence), so the
            // paused WayFlow gate receives an explicit operator decline. A
            // renderer/composer-authored userResponse (if any) is preserved —
            // the marker only fills when absent.
            setIsRejecting(true);
            try {
              let nextBuffered: Record<string, unknown> = {
                ...bufferedHitlValue,
                approved: false,
                approvedAt: new Date().toISOString(),
              };
              if (
                typeof nextBuffered.userResponse !== "string" ||
                (nextBuffered.userResponse as string).trim().length === 0
              ) {
                nextBuffered.userResponse = "[Rejected by operator]";
              }
              if (!isSetupGateTaskId(effectiveHitlContext.reviewTaskId)) {
                nextBuffered = applyAttachmentEnvelopeUserResponseOnly(
                  nextBuffered,
                  pendingAttachmentsRef.current,
                );
              }
              await performGateSubmit({
                reviewTaskId: effectiveHitlContext.reviewTaskId,
                xRenderer: effectiveHitlContext.xRenderer,
                payload: nextBuffered,
                trackApproving: true,
                suppressGate: true,
                clearAttachmentsOnSuccess: true,
                errorMode: "toast",
              });
            } finally {
              setIsRejecting(false);
            }
          }}
        >
          {isRejecting ? "Rejecting…" : "Reject"}
        </Button>
      ) : null}
      <Button
        size="sm"
        disabled={isApproving}
        className="gap-1.5"
        // THE HITL SCREEN'S ONE DECISION (cinatra#2930). Named on the row this
        // panel draws INSIDE the screen card, and deliberately not on the
        // bare-gate row: that row is the tool-call approval banner, which is a
        // different gate with a Reject beside it, and a capture that found this
        // anchor there would be reading a control the screen does not offer.
        {...(opts?.withReject ? {} : { "data-action": "submit-hitl-screen" })}
        onClick={async () => {
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
          //      the server's default text) with the envelope
          //      (applyAttachmentEnvelopeUserResponseOnly).
          // Compute payload synchronously from current state to avoid a setState read race.
          let nextBuffered: Record<string, unknown> = {
            ...bufferedHitlValue,
            approved: true,
            approvedAt: new Date().toISOString(),
          };
          if (!isSetupGateTaskId(effectiveHitlContext.reviewTaskId)) {
            nextBuffered = applyAttachmentEnvelopeUserResponseOnly(
              nextBuffered,
              pendingAttachmentsRef.current,
            );
          }
          // #817: context-selector gate — synthesize the selection envelope
          // when the renderer emitted none (zero-candidate slot). A real
          // toggle already set bufferedHitlValue.userResponse — the helper
          // PRESERVES it (only fills when absent).
          nextBuffered = withContextSelectorEnvelope(
            effectiveHitlContext.xRenderer,
            effectiveHitlContext.currentValues,
            nextBuffered,
          );
          await performGateSubmit({
            reviewTaskId: effectiveHitlContext.reviewTaskId,
            xRenderer: effectiveHitlContext.xRenderer,
            payload: nextBuffered,
            trackApproving: true,
            suppressGate: true,
            clearAttachmentsOnSuccess: true,
            errorMode: "toast",
          });
        }}
      >
        {isApproving && !isRejecting
          ? (opts?.approvingLabel ?? "Continuing…")
          : (opts?.approveLabel ?? "Continue")}
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
  const approvalActionsRow: ReactNode = renderApprovalActionsRow();

  // cinatra#2482 — the terminal `completed` rendering, now on BOTH surfaces.
  //
  // The chat mount used to suppress it, so a run that finished in a
  // conversation ended with nothing: no output, no artifact, no next step. The
  // owner ruled the finished work renders as a reviewable artifact INSIDE the
  // conversation, which is exactly what this card carries — each produced
  // output linked to its artifact page, or a plain statement that the run
  // produced none.
  //
  // What stays surface-bound is "Start new run": it navigates out of the
  // conversation, so the chat mount withholds the template slug the button
  // needs and the card leaves it out (its documented behaviour for callers
  // without a slug). The rest of the card is identical on both surfaces.
  const showCompletionCard = status === "completed";
  const completionAgentId = surface === "chat" ? undefined : agentId;

  // The sticky field-assist panel is the SAME mount on every reading of this
  // card, so it is built once here and rendered by whichever return runs. Its
  // own `visible` rule is untouched: it is off in a conversation, off for a
  // marked review gate, and off unless a gate with fields is open — which is
  // why the two readings above render it without ever showing it.
  const hitlConversationPanelNode: ReactNode = (
    <>
    {/* Sticky bottom-of-page AI-assist
        conversation panel. Rendered via createPortal into <main> by the shared
        component HitlConversationPanel. resetSignal={currentXRenderer}
        preserves the renderer-change reset. */}
    <HitlConversationPanel
      portalTarget={portalTarget}
      // WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
      // `app-artifact-review.html` §X): the mount names its surface and the
      // window reads the drawing's own sentence for it.
      surface="run-page"
      // cinatra#2566 (epic #2564 S2): a MARKED review gate is excluded. The
      // field-assist panel exists to help a human fill a gate's FIELDS; a review
      // gate has none — it has a target to read and one decision to take, and the
      // card owns both. Leaving it visible also fed the gate's interrupt values,
      // including its opaque card ref, into an LLM prompt (the assist route
      // serializes `currentValue`), which is exactly the "a ref never reaches an
      // LLM-visible payload" rule the wire slice established.
      visible={
        surface !== "chat" &&
        // cinatra#2933 — the run's access decides, not the platform tier: "no
        // window shown to a person whose message it would refuse."
        canRespondInWindow !== false &&
        isPendingApproval &&
        !!effectiveHitlContext?.xRenderer &&
        effectiveHitlContext.xRenderer !== ARTIFACT_REVIEW_REDIRECT_RENDERER_ID &&
        !!templateId &&
        !!portalTarget
      }
      conversation={runWindow.entries}
      promptPending={promptPending || runWindow.pending}
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
        !isSetupGateTaskId(effectiveHitlContext.reviewTaskId)
      }
    />
    </>
  );

  // -------------------------------------------------------------------------
  // THE SLOT (cinatra#2997) — the maintainer's reading of this card, verbatim:
  //
  //   "The 'Agentic Run Progress' card should basically just be a card (maybe
  //    even an empty review screen) with a spinning icon which is a temporary
  //    placeholder for the review screen. Once the agent is done and the output
  //    generated, that 'Agentic Run Progress' card is being automatically
  //    replaced with the 'Review requested' screen. On the run page, the same is
  //    true."
  //
  // So this card has THREE readings and the run's own state picks between them:
  //
  //   WORKING     — the agent is doing the work and nothing is waiting on the
  //                 reader. The card is the placeholder: the frame, the spinner,
  //                 the empty review screen. No heading, no status word, no
  //                 progress list, no transcript — the words describe a card
  //                 that says nothing, and everything it used to say is a claim
  //                 about progress the reader did not ask for.
  //
  //   REVIEW      — the work opened a review. The SAME box now holds the
  //                 'Review requested' screen — the shipped `ReviewGateCard`,
  //                 with its Comment / Reject / Approve floor — resolved from
  //                 the run's own ref. No new turn, and nobody had to ask.
  //
  //   EVERYTHING  — anything else the run can be: paused on a gate that needs
  //   ELSE          input (the setup form, the skills question), failed, waiting
  //                 on a trigger, or finished with nothing to review. Those keep
  //                 the section exactly as it was, heading included, because the
  //                 request is about the review screen's placeholder and says
  //                 nothing about them.
  //
  // THE ONE READING THE WORDS DO NOT COVER, stated rather than invented: a run
  // that finishes and produced NOTHING REVIEWABLE. There is no review screen for
  // the placeholder to be a placeholder FOR, so the completion notice stays —
  // that is the third reading above, unchanged from what shipped.
  //
  // WHICH REF THE SCREEN IS ADDRESSED BY. A gate the run is PARKED on carries
  // its own server-minted ref in the interrupt (`reviewGateCardRef`), and that
  // one wins: it is the gate the run is actually blocked on. Otherwise the ref
  // is the one the run's own rows answered with (`reviewSlot`), which is how a
  // COMPLETED run — the async effects-gated shape, where the run never pauses
  // and the sweeper opens the review after the fact — reaches its own review
  // screen. Both are minted by the server from (runId, reviewTaskId) and the
  // card re-authorizes itself against whichever it is handed.
  //
  // A GATE THAT NEEDS INPUT IS NOT A REVIEW, and it wins over both: a run parked
  // on a setup field must draw that field, even if a review from an earlier step
  // is on file.
  const markedReviewGate =
    isPendingApproval &&
    effectiveHitlContext?.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID;
  const blockedOnInputGate = isPendingApproval && !markedReviewGate;
  //
  // AND IT IS THE RUN'S CURRENT READING OR IT IS NOTHING. The slot's ref is
  // deliberately NOT enough on its own: a run carries its gate for ever, so a
  // run that was reviewed and then went back to work — a retry, a re-trigger, a
  // failure, a schedule — would keep showing the settled review in place of the
  // spinner, the error block with its Retry, or the scheduling step. The slot's
  // ref draws only for a run that has FINISHED, which is the state the request
  // is about ("once the agent is done and the output generated"); a parked
  // marked gate draws from its own ref, whatever the rest of the run is doing.
  //
  // AND THE SLOT'S REVIEW IS WITHHELD ON THE SITE WIDGET, which is a containment
  // rather than a rule about the widget. The card's host declaration here is
  // `run_card`, a COOKIE-session host: the runtime refuses a broker credential
  // on it, so a card mounted inside a widget frame resolves and decides with the
  // frame's ambient cookie instead of the reader's own credential. That is a
  // PRE-EXISTING property of the marked-gate mount at the base of this branch,
  // and it is left exactly as it was; what this change must not do is carry the
  // COMPLETED-run review down the same wrong wall for the first time. The widget
  // keeps the terminal rendering it has today, and this branch's own evidence
  // already records the widget's run panel as blocked pending that work.
  const widgetHostedPanel = ambientLifecycleHost === "site_widget";
  const inPlaceReviewRef = blockedOnInputGate
    ? null
    : markedReviewGate
      ? reviewGateCardRef
      : status === "completed" && !widgetHostedPanel
        ? reviewSlot.ref
        : null;
  const runIsWorking =
    inPlaceReviewRef === null &&
    !blockedOnInputGate &&
    (status === "queued" ||
      status === "running" ||
      (reviewMayStillOpen && !widgetHostedPanel));

  // The recommendation card's ONE mount, lifted to a value so the slot's three
  // readings share it instead of each carrying a copy (the one-card rule is
  // about instances, and this is how there stays exactly one).
  const recommendationCardNode: ReactNode = panelMountsRecommendationCard ? (
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard
        runId={runId}
        agentPackageName={agentPackageName ?? ""}
        wireRef={holdWireRef}
        onStateChange={setOwnRecommendation}
      />
    </LifecycleCardSurfaceProvider>
  ) : null;

  // The review screen's ONE mount, for the same reason. cinatra#2566's account
  // of it is unchanged and still applies: the display-only REDIRECT card that
  // used to sit here is deleted, this is the SAME `ReviewGateCard` the chat
  // thread and the review page's gate region mount, and the reviewer decides in
  // place. The composer descriptor for a marked gate is still comment-only
  // (see the publish effect above), so this mount adds no second resume path.
  const reviewScreenNode: ReactNode = inPlaceReviewRef ? (
    <LifecycleCardSurfaceProvider host="run_card">
      <ReviewGateCard
        view={{
          viewType: "artifact_review_gate",
          schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
          ref: inPlaceReviewRef,
        }}
      />
    </LifecycleCardSurfaceProvider>
  ) : null;

  if (reviewScreenNode !== null || runIsWorking) {
    return (
      <>
        <section
          className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
          // Which of the two readings this box is drawing. Passive — it draws
          // nothing and drives nothing — and it exists because the SWAP is the
          // ruled property: a proof has to be able to see the placeholder go and
          // the review screen arrive in the same slot.
          data-run-review-slot={reviewScreenNode !== null ? "review" : "working"}
        >
          {recommendationCardNode}
          {reviewScreenNode ?? <ReviewGatePlaceholder />}
        </section>
        {hitlConversationPanelNode}
      </>
    );
  }

  return (
    <>
    <section className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Agentic Run Progress</h2>
        <Badge variant={statusBadgeVariant(status)} className="inline-flex items-center gap-1">
          {statusIcon(status)}
          {/* A setup-field INPUT pause must not read as "pending approval" —
              the discriminator is the interrupt itself, never the status. */}
          <span>{runStatusBadgeLabel(status, statedWaitDescriptor)}</span>
        </Badge>
      </div>

      {/* The run-start recommendation hold, through the ONE card (cinatra#2568
          AC-5). The panel's DIRECT chip-row mount — and the local hold state it
          needed — are gone: the interaction is a lifecycle card like the review
          gate beside it, declared on the same `run_card` host, drawn by the one
          renderer of `recommendation_hold`. No parallel chip-row mount remains
          on this host, and there is nothing here for a later edit to poll.

          ONE CARD PER TURN, IN EVERY STATE. Inside a chat transcript this panel
          is a SIBLING of the conversation's own recommendation card, and both
          resolve the same run — so an unconditional mount here draws the card
          twice in one turn. It went unnoticed because only the SETTLED states
          render on both: the held state self-gates to the chat card's turn,
          which made the duplication look like a settled-only quirk rather than
          what it is.

          The contract is the one the ruling names: inside a CONVERSATION host
          — `chat_thread` or the widget's `site_widget`, both served by the one
          shared column — the conversation's card owns this run's
          recommendation, in every state, and the panel draws none. The run page
          keeps its copy untouched — there is no outer conversation host there,
          so `ambientLifecycleHost` is null and the mount renders exactly as
          before. Gating on the ambient host rather than on
          the `surface` prop keeps the rule true for any future embedder of this
          panel inside a transcript, without that embedder having to remember a
          prop. The condition itself lives in `runCardOwnsLifecycleCopy` so this
          mount and the transcript's own test cannot drift into two copies of
          the same rule. */}
      {recommendationCardNode}

      {isPendingApproval &&
      effectiveHitlContext?.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID ? (
        // A MARKED artifact-review gate NEVER draws here any more (cinatra#2997).
        // The review screen is the whole card now — it is mounted by the slot
        // above, in the box the placeholder was standing in, which is what "that
        // card is being automatically replaced with the 'Review requested'
        // screen" means. Reaching this arm therefore means one thing only: a
        // marked gate with NO server-minted ref to address (a gate emitted
        // before the ref existed, or an instance whose secret rotated). There is
        // nothing safe to address, so the card draws nothing rather than
        // inventing a client-side handle to the gate — exactly the behaviour
        // cinatra#2566 shipped for that case, and the run rail and the review
        // page are unaffected by it.
        null
      ) : isPendingApproval && effectiveHitlContext?.xRenderer ? (
        // THE HITL SCREEN CARD (cinatra#2930, lifecycle-b W3). The inline HITL
        // bubble below is UNCHANGED — the fields the gate's renderer draws and
        // the Continue that submits them, exactly as this panel has always
        // drawn them. What is new is the root around it: the kind, the host and
        // the state, so the screen the run page already shows is the lifecycle
        // card the parity ratchet owes a cell for, rather than a shape every
        // surface had to recognize.
        !panelMountsHitlScreenCard ? null : (
        <LifecycleCardSurfaceProvider host="run_card">
          <AgentHitlScreenCard
            runId={runId}
            // The gate's own identity as the CHANGE SIGNAL: a new gate is a new
            // review-task id, which is exactly when the card must re-read.
            wireRef={effectiveHitlContext.reviewTaskId}
            screen={
        <>
          <Separator />
          {/* Skill chip row — xRenderer HITL surface. WITHHELD for a run whose
              skills were decided on the recommendation card: "no skill inside
              it can be selected". Nothing replaces it — the settled chips above
              the card are the reading. */}
          {drawSkillPicker ? <HitlSkillChips skills={hitlSkills} /> : null}
          {hitlRendererEntry?.entry || hitlPresentationHint ? (
            <div
              className={HITL_FIELDS_REGION_CLASS[hitlFieldPresentationFor("run_card")]}
              data-conformance-id="hitl-screen-fields"
              // §I: the run page has no chat box for a field to be subordinate
              // to, so this screen's field IS the primary input and keeps the
              // treatment it already has. Declared through the card's own map
              // rather than restated here, so the two surfaces cannot hold a
              // different opinion about the same host.
              data-field-presentation={hitlFieldPresentationFor("run_card")}
            >
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
                const isGroupedSetup = isGroupedSetupRenderer(
                  effectiveHitlContext.xRenderer,
                );
                // THE CHAT CARD CARRIES ITS OWN CONTINUE.
                //
                // The chat setup gate used to pass `hideSubmit`: the form was
                // there, the submit was not, and the run was expected to resume
                // through Enter or the chat composer. Nothing on the card said
                // so, so a paused run read as un-actionable and the reader went
                // looking for a run page to act on. The owner ruled the whole
                // run lifecycle plays IN the conversation, which means the card
                // shows the affordance that continues it.
                //
                // So no surface hides the submit any more. Both run surfaces
                // render the same one control, and the composer path
                // (onActiveGateChange -> gate.submit) is unchanged beside it —
                // it resumes through this panel's own approval path, so the two
                // affordances are one resume path with two entrances, not two.
                return (
                  <>
                    <RendererComponent
                      // Keyed by xRenderer AND fieldName — the identity the
                      // orchestrator stepper already uses (#810), adopted here
                      // in cinatra#2541 because this surface now passes a
                      // fieldName that CHANGES between gates. Sequential
                      // per-field setup gates share one xRenderer and arrive
                      // with no RUN_STARTED/RESUME frame between them, so an
                      // xRenderer-only key would mutate `fieldName` on a LIVE
                      // renderer instance: field 1's typed text (SchemaFieldRenderer's
                      // localValue, which a non-string next value does not clear)
                      // would pre-fill field 2 under field 2's label. fieldName is
                      // undefined for mid-run gates, so those keep their existing
                      // xRenderer-keyed identity exactly.
                      key={`${effectiveHitlContext.xRenderer}::${effectiveHitlContext.fieldName ?? ""}`}
                      // The gate's REAL field identity (cinatra#2541) — the same
                      // seam the orchestrator stepper regressed at, with the
                      // same consequence: `fieldName` is what the renderer
                      // labels itself from, so the hardcoded placeholder made a
                      // per-field setup gate read "Hitl Field" instead of its
                      // own name. Falls back to the placeholder only for
                      // interrupts that carry no field name (mid-run gates).
                      fieldName={hitlRendererFieldName(effectiveHitlContext.fieldName)}
                      schema={hitlRendererEntry.fieldSchema}
                      // An OBJECT-typed setup field gets its OWN value, not the
                      // whole currentValues envelope (cinatra#2484). The
                      // unwrapping stays at the CALLER even now that the renderer
                      // is told its field name: `value` is resolved here, before
                      // the renderer sees it, and a renderer that re-derived its
                      // own slot from the envelope would still mis-seed on a
                      // sub-key name collision.
                      value={setupFieldRendererValue(
                        { ...effectiveHitlContext.currentValues, ...bufferedHitlValue },
                        effectiveHitlContext.fieldName,
                        hitlRendererEntry.fieldSchema,
                      )}
                      onChange={isMidRunHitl ? async (next: unknown) => {
                        // Compute nextBuffered synchronously, pass to performGateSubmit
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
                          await performGateSubmit({
                            reviewTaskId: effectiveHitlContext.reviewTaskId,
                            xRenderer: effectiveHitlContext.xRenderer,
                            payload: { ...nextBuffered, approved: true, approvedAt: new Date().toISOString() },
                            trackApproving: true,
                            suppressGate: true,
                            clearAttachmentsOnSuccess: false,
                            errorMode: "toast",
                          });
                        }
                      } : async (next: unknown) => {
                        // Primitive onChange (setup-loop fallback) must be wrapped
                        // to `{ [fieldName]: value }` before resume.
                        // The server-side merge path keys off `fieldName` to
                        // know which inputParams slot to fill; passing a raw
                        // primitive with fieldName=undefined silently no-ops
                        // and re-emits the same gate forever.
                        // An object-typed setup input emits the whole object —
                        // it still belongs under `fieldName` (cinatra#2484).
                        const { payload, payloadFieldName } = wrapPrimitiveSetupPayload(
                          effectiveHitlContext.fieldName,
                          next,
                          {
                            objectTypedField:
                              (hitlRendererEntry.fieldSchema as { type?: string } | undefined)
                                ?.type === "object",
                          },
                        );
                        await performGateSubmit({
                          reviewTaskId: effectiveHitlContext.reviewTaskId,
                          xRenderer: effectiveHitlContext.xRenderer,
                          payload,
                          payloadFieldName,
                          trackApproving: false,
                          suppressGate: false,
                          clearAttachmentsOnSuccess: false,
                          errorMode: "rethrow",
                        });
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
            <div
              className="soft-panel rounded-panel p-4 bg-surface-muted"
              data-conformance-id="hitl-screen-fields"
            >
              <p className="text-sm text-muted-foreground">
                Waiting for input — no renderer configured for this step.
              </p>
            </div>
          )}
        </>
            }
          />
        </LifecycleCardSurfaceProvider>
        )
      ) : isPendingApproval ? (
        // Standard HITL approval banner (tool-call gate without x-renderer).
        // cinatra#2444 — the decision for an actively-watched run is taken
        // INLINE: the shared renderApprovalActionsRow (the same machinery the
        // x-renderer paths use — approvalActionsRow only needs a
        // reviewTaskId, not an x-renderer) resumes the run in place on
        // Approve/Reject. The #1558 E8 /notifications unification stays the
        // out-of-band surface: the deep-linked "Review approval" CTA is
        // retained as a SECONDARY affordance, and it is also the sole
        // degraded path when no gate context (reviewTaskId) is available to
        // submit against — renderApprovalActionsRow renders nothing then.
        <>
          {/* Skill chip row — tool-call gate HITL surface. Same withholding as
              the xRenderer gate above, for the same ruling: a decided run offers
              nothing selectable inside its own card. */}
          {drawSkillPicker ? <HitlSkillChips skills={hitlSkills} /> : null}
          <div className="rounded-control border border-line bg-surface-muted px-4 py-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                Run paused — awaiting human approval before continuing.
              </span>
              <Button asChild variant="outline" size="sm">
                {/* Approvals moved into the unified /notifications feed in the E8
                    cutover (cinatra#1558); the run's pending approval surfaces
                    there as a row. cinatra#2413 — deep-link with `?run=<runId>`
                    instead of a bare link, so the feed highlights this run's
                    row (or its run-failure supersession) rather than dropping
                    the viewer on the generic list to hunt for it. Degrades
                    gracefully: if the gate already resolved and left no row
                    behind, the query param simply matches nothing. */}
                <Link href={`/notifications?run=${encodeURIComponent(runId)}`}>
                  Review approval
                </Link>
              </Button>
            </div>
            {renderApprovalActionsRow({
              withReject: true,
              approveLabel: "Approve",
              approvingLabel: "Approving…",
            })}
            {/* THE INVARIANT. Above this line the branch renders
                an inline decision ONLY while a gate context exists; without one
                renderApprovalActionsRow renders nothing and the banner used to
                end here — a paused run with a single link out to a feed whose
                row links straight back, and no way to act on either surface.
                The run page now always carries an inline action here: a
                "Re-check" that re-runs the very same derived-context hydration
                the panel runs every 5s, and — once the run is degraded rather
                than merely hydrating — an explicit recovery state that names
                the reason instead of leaving a silent null. The deep-link
                above is untouched: it stays the out-of-band escape until this
                recovery path is proven in the field. */}
            {!effectiveHitlContext ? (
              <div
                className="flex flex-col gap-2 pt-2 border-t border-line"
                data-testid="hitl-recovery-state"
              >
                {hitlRecoveryVisible ? (
                  <p className="text-xs text-muted-foreground">
                    This run is paused, but its approval step could not be
                    loaded: {hitlRecoveryReason(derivation)}. Re-check to try
                    again, or open the notifications feed.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Loading the approval step for this run…
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isRechecking}
                    onClick={handleRecheckDerivedContext}
                  >
                    {isRechecking ? "Re-checking…" : "Re-check"}
                  </Button>
                </div>
              </div>
            ) : null}
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

      {/* Issue 3033 — the floor: the diagnostic alone. No Error
          label, no raw <pre>, and no control beside it, because the drawing
          draws none on a floor (the settled card's one drawn control, "Start
          new run", belongs to the COMPLETED reading). Drawn as the drawing
          draws it: one muted mono status line. */}
      {runFailureFloor !== null && (
        <div className="rounded-control border border-line bg-surface-muted px-4 py-3 max-w-full overflow-hidden">
          {/* One LINE per failed target. A newline inside a single text node
              collapses to a space under normal HTML whitespace handling, which
              would run two diagnostics together as one paragraph - a reading the
              drawing does not give, since it draws a ONE-LINE diagnostic per
              target. So each target is its own element, the line breaks between
              them are real, and `whitespace-pre-line` keeps them. */}
          <p
            role="status"
            data-testid="run-failure-floor"
            className="font-mono text-xs text-muted-foreground break-words whitespace-pre-line"
          >
            {runFailureFloor.map((entry, index) => (
              <Fragment key={`${entry.package}:${entry.slot}:${entry.reason}:${index}`}>
                {index > 0 ? "\n" : null}
                <span>{formatRunFailureFloorLine(entry)}</span>
              </Fragment>
            ))}
          </p>
        </div>
      )}

      {error && status === "failed" && runFailureFloor === null && (
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
          {/* The two config CTAs below land under `/configuration`, which is
              admin-only (cinatra#2700, epic #2699). A member keeps the full
              diagnosis and is told who can fix it, instead of being handed a
              link that ends on the not-authorized panel (cinatra#2701). */}
          {isOpenAiKeyError(error) &&
            (viewerIsAdmin ? (
              <Link
                href={LLM_PROVIDER_SETTINGS_HREF}
                className="mt-2 inline-flex text-xs font-medium text-primary underline underline-offset-2"
              >
                Update your OpenAI API key →
              </Link>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Ask an administrator to update the OpenAI API key.
              </p>
            ))}
          {/* Hosted-MCP 424: the provider could not reach this instance's public
              MCP URL to load the cinatra toolbox. Link to the MCP config so the
              user can fix the public URL / tunnel. (#500) */}
          {isMcpUnreachableError(error) &&
            !isOpenAiKeyError(error) &&
            (viewerIsAdmin ? (
              <Link
                href={MCP_CONFIG_HREF}
                className="mt-2 inline-flex text-xs font-medium text-primary underline underline-offset-2"
              >
                Check your MCP server configuration →
              </Link>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Ask an administrator to check the MCP server configuration.
              </p>
            ))}
          {/* Generic fallback text ("WayFlow task failed") carries no cause and no
              next step on its own — pair it with plain-language guidance. Failures
              that already have an actionable link above (OpenAI key, MCP) don't
              need this restated. (cinatra#2412) */}
          {isGenericWayflowFailure(error) && (
            <p className="mt-2 text-xs text-muted-foreground">
              The run failed before completing. Retry, or start a new run.
            </p>
          )}
          {/* Recovery affordance for EVERY failure, not just the OpenAI-key / MCP
              hinted classes above (cinatra#2412). Retry resets this run back to
              pending_input (inputParams untouched) so the Setup tab's Run button
              reappears with the original inputs already filled in; Start new run
              creates a fresh run with blank inputs (StartNewRunButton — orphaned
              since it was first exported, cinatra#2412 archaeology). Start new
              run needs the template slug, so it's omitted where the caller
              doesn't have one (e.g. chat surfaces) rather than mounted broken. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isRetrying}
              onClick={handleRetryFailedRun}
            >
              {isRetrying ? "Retrying…" : "Retry"}
            </Button>
            {agentId ? <StartNewRunButton agentId={agentId} /> : null}
          </div>
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

      {/* cinatra#2482 — terminal `completed` state. Without this the panel's
          only terminal rendering was the "No messages yet." line below, which
          says nothing about the run being over, offers no output and no next
          action: the immediate-trigger flow's dead end. The chat card now shows
          it too, so a run that finishes in a conversation hands the reader its
          produced artifact there (see `showCompletionCard` above). */}
      {showCompletionCard && (
        <RunCompletionCard
          runId={runId}
          agentId={completionAgentId}
          outputHint="transcript"
        />
      )}

      {messages.length > 0 ? (
        <div className="flex flex-col gap-2 max-h-[480px] overflow-y-auto">
          {messages.map((msg) => (
            <ThreadRow key={msg.id} message={msg} />
          ))}
        </div>
      ) : (
        // Suppressed under the completion card: "No messages yet." next to
        // "Run finished without output" reads as a run that is still coming,
        // which is precisely the frozen-in-place impression this fixes.
        !showCompletionCard && (
          <p className="text-sm text-muted-foreground">
            {status === "queued" ? "Waiting to start..." : "No messages yet."}
          </p>
        )
      )}
    </section>
    {hitlConversationPanelNode}
    </>
  );
}
