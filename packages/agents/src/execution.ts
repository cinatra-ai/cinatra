import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import semver from "semver";
import {
  readAgentRunById,
  readAgentTemplateById,
  readAgentTemplates,
  readAgentTemplateVersionBySemver,
  transitionRunStatus,
  RunTransitionError,
  findSavedConnectionForAgentUrl,
  updateAgentRunA2ATaskId,
  updateAgentRunA2AContextId,
} from "./store";
import type { AgentTemplateRecord, AgentRunRecord, AgentRunStatus } from "./store";
import {
  resolveWayflowUrl,
  WAYFLOW_A2A_TIMEOUT_MS,
  WAYFLOW_UNDICI_TIMEOUT_MS,
} from "./wayflow-url";
import { runSkillAutosaveOnRunCompletion } from "./skill-autosave";
import { isTriggerReleased } from "./trigger-gate";
import { resolveTemplateInputSchema } from "./input-schema-resolver";
// The run-worker entry reads `run.projectId`
// from the DB row and wraps the execution body in a fresh
// mcpRequestContextStorage frame whose `projectContext.projectId` is the
// inheritance source for every artifact/object write inside this run. The
// frame is preserved through async dispatch (BullMQ→fetch→A2A) by
// AsyncLocalStorage. The merge with any pre-existing context preserves
// fields set by upstream callers (e.g. delegatedActor on the MCP path,
// a2aActorContext on A2A); only `projectContext` is rewritten.
import {
  mcpRequestContextStorage,
  type McpRequestContext,
} from "@cinatra-ai/mcp-server";

// ---------------------------------------------------------------------------
// Side-effects gate at the WayFlow dispatch boundary.
//
// Sentinel error thrown when a run with a non-empty `template.gatedSteps[]`
// reaches the WayFlow A2A dispatch boundary while the trigger gate is still
// closed. The dispatcher in `src/lib/background-jobs.ts` catches this in its
// `case AGENT_BUILDER_EXECUTION` clause and re-queues the job via
// `job.moveToDelayed(...)`. `moveToDelayed` is BullMQ flow control — it does
// NOT consume a retry attempt.
//
// RUN-START GATING — NOT PER-STEP. WayFlow dispatches the entire flow via
// a single `client.sendTask` blocking call; there is no per-step TS hook in
// the dispatcher. The gate is therefore per-run, scoped by
// `template.gatedSteps[]` non-empty.
// ---------------------------------------------------------------------------
export class TriggerGateClosedError extends Error {
  readonly runId: string;
  readonly nextAttempt: number;
  readonly delayMs: number;
  constructor(args: { runId: string; nextAttempt: number; delayMs: number }) {
    super(
      `Trigger gate closed for run ${args.runId} (attempt ${args.nextAttempt}, retry in ${args.delayMs}ms)`,
    );
    this.name = "TriggerGateClosedError";
    this.runId = args.runId;
    this.nextAttempt = args.nextAttempt;
    this.delayMs = args.delayMs;
  }
}

/**
 * Exponential backoff for gated-step retries: 30s → 60s → 120s → 240s,
 * capped at 300s (5min). Defensive lower bound: attempt < 1 → 30s.
 */
export function gateBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, attempt);
  const ms = 30_000 * Math.pow(2, safeAttempt - 1);
  return Math.min(ms, 300_000);
}
import {
  AgUiAdapter,
  publishAgUiEvent,
  A2UiAdapter,
  publishA2UiEvent,
  DualAdapterDispatch,
  enrichSchemaWithResolvedData,
} from "@cinatra-ai/agent-ui-protocol/server";
import { getOrAddWayflowGateIndex } from "@cinatra-ai/a2a";
// Host capability resolution for the HITL schema enricher: the enricher itself
// is provider-agnostic (agent-ui-protocol imports no provider package); THIS
// host-side caller injects the live `email-send` providers so sender-alias
// enums resolve registration-driven.
import { resolveEmailSendProviders } from "@/lib/email-send-providers";

/** EnrichmentContext for a run owner — injects the email-send provider source. */
function enrichmentContextFor(userId: string | null) {
  return { userId, resolveEmailSendProviders };
}

// ---------------------------------------------------------------------------
// Credential keys are stripped from WayFlow task.history before persistence.
// MUST stay in lockstep with docker/wayflow/cinatra_executors/input_message.py
// _CREDENTIAL_KEYS and approval_gate.py _CREDENTIAL_KEYS (single source of truth
// across the TS persistence path and the Python executor strip; tested for
// parity in docker/wayflow/tests/test_approval_gate.py).
// ---------------------------------------------------------------------------
const WAYFLOW_HISTORY_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "bearer_token",
  "api_key",
  "a2a_bearer_token",
  "mcp_server_url",
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
]);

/**
 * Recursively scrub credential keys from any value before persisting it in
 * stepResults. Walks plain objects and arrays; primitives pass through. Keys
 * matched by WAYFLOW_HISTORY_CREDENTIAL_KEYS are dropped (not redacted) to
 * mirror the Python executors' frozenset-based strip exactly — replacing with
 * a placeholder would diverge from the executors and break future parity tests.
 */
function scrubWayflowHistoryCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubWayflowHistoryCredentials(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (WAYFLOW_HISTORY_CREDENTIAL_KEYS.has(k)) continue;
      out[k] = scrubWayflowHistoryCredentials(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Surface EndNode declared output values into stepResults.
//
// WayFlow's `_patched_run_task` (docker/wayflow/agent_loader.py) appends a
// synthetic A2A DataPart message whenever a Flow reaches `FinishedStatus`,
// carrying the EndNode declared output values under the sentinel key
// `__cinatra_endnode_outputs__`. The dispatcher detects the sentinel,
// surfaces the structured values into `stepResults[0].output_data` (which
// `packages/a2a/src/agent-executor.ts:stepResultsToArtifact` already
// renders as an A2A DataPart artifact for external consumers), and strips
// the sentinel from the persisted history so chat UIs never render it.
//
// The sentinel constant is duplicated on both sides because the Python
// side has no way to import a TS constant — keep the strings in sync.
// ---------------------------------------------------------------------------

export const CINATRA_ENDNODE_OUTPUTS_SENTINEL = "__cinatra_endnode_outputs__";

type HistoryMessage = { role?: string; parts?: readonly unknown[] };

/**
 * Walk WayFlow `task.history` and return the EndNode output object the
 * Python loader stashed via the sentinel DataPart. Returns `null` when no
 * sentinel is present (WayFlow image without sentinel support / non-completed task / agent
 * with no declared EndNode outputs).
 *
 * Tolerant of the duplicate-sentinel case: if multiple sentinels appear
 * (defensive — shouldn't happen) the LAST one wins so the most-recent
 * EndNode outputs are surfaced.
 */
export function extractCinatraEndNodeOutputs(
  history: ReadonlyArray<HistoryMessage> | undefined,
): Record<string, unknown> | null {
  if (!history || history.length === 0) return null;
  let found: Record<string, unknown> | null = null;
  for (const message of history) {
    const parts = message?.parts as ReadonlyArray<{ kind?: string; data?: unknown }> | undefined;
    // Defensive hardening: guard against non-array parts shapes
    // (the matching `for...of` would throw on a plain object).
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.kind !== "data") continue;
      const data = part.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") continue;
      const candidate = data[CINATRA_ENDNODE_OUTPUTS_SENTINEL];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        found = candidate as Record<string, unknown>;
      }
    }
  }
  return found;
}

/**
 * Return `history` with sentinel-bearing messages removed. Use for both
 * the text-extraction last-agent-message lookup (so the sentinel can't
 * shadow the real LLM output) and the persisted `scrubbedHistory` (so
 * downstream consumers — chat panels, run-detail screens, eval tooling —
 * never see the marker).
 */
export function stripCinatraEndNodeOutputMessages(
  history: ReadonlyArray<HistoryMessage> | undefined,
): ReadonlyArray<HistoryMessage> | undefined {
  if (!history) return history;
  return history.filter((message) => {
    const parts = message?.parts as ReadonlyArray<{ kind?: string; data?: unknown }> | undefined;
    // Defensive hardening: keep messages whose `parts` shape is not
    // an iterable array — they cannot bear a sentinel by construction.
    if (!Array.isArray(parts)) return true;
    for (const part of parts) {
      if (part?.kind !== "data") continue;
      const data = part.data as Record<string, unknown> | undefined;
      if (data && typeof data === "object" && CINATRA_ENDNODE_OUTPUTS_SENTINEL in data) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// WayFlow HITL step tracker (Redis-backed)
// Persists the ordered list of WayFlow task IDs per run in Redis so the gate
// index survives Next.js hot-reloads and server restarts. A module-level Map
// resets to empty when execution.ts is reloaded between the
// initial BullMQ dispatch and the Next.js server-action approval, causing
// idx=0 for every resume and the setup-form to re-appear instead of advancing.
// ---------------------------------------------------------------------------

async function resolveWayflowXRenderer(
  runId: string,
  taskId: string,
  approvalPolicySteps: Array<{ stepNumber?: number; requiresApproval?: boolean; hitlOwnedBy?: string; xRenderer?: string; gateCount?: number; schema?: Record<string, unknown>; inputMessageSchema?: Record<string, unknown>; skipLlm?: boolean }>,
): Promise<{ xRenderer: string; stepNumber: number | null; schema: Record<string, unknown> | null }> {
  const fallback = "@cinatra-ai/agent-builder:schema-field-fallback";
  // All WayFlow-gated steps ordered by appearance: both self-owned (orchestrator
  // InputMessageNode gates) and child-agent steps. Steps without xRenderer still
  // advance the accumulator correctly (e.g. email-reviewer with no approval gate).
  //
  // Exclude the Inputs setup-loop step (skipLlm:true) from the
  // WayFlow gate index. That step is handled by Cinatra's setup-* synthetic
  // reviewTaskId BEFORE WayFlow ever runs the orchestrator. Counting it here
  // shifted every subsequent step by one, so trigger-agent:configure /
  // reviewer-agent:output renderers fell back to schema-field-fallback in
  // orchestrators with required StartNode inputs (multi-subflow agents with a
  // setup-loop URL gate). Single-AgentNode agents (no orchestrator steps) were
  // unaffected. The skipLlm:true flag is the canonical marker for the pre-
  // WayFlow Inputs gate (oas-compiler.ts:1148-1156, 1234-1235).
  //
  // Only count childSteps that declare an xRenderer.
  // A WayFlow gate-index slot exists for a step IFF that step fires a
  // UI-bearing HITL gate at runtime. The canonical marker is `xRenderer`
  // on the compiled policy step. Steps WITHOUT xRenderer fall into one
  // of two categories that must NOT consume a gate slot:
  //   (a) Child subflows that don't fire HITL at all (e.g. an inline
  //       FlowNode whose `url` is DFE-fed so there is no setup-loop, and
  //       whose only LLM step is an AgentNode which doesn't pause).
  //   (b) The pre-WayFlow Inputs setup-loop step (stepNumber:0 +
  //       skipLlm:true) — uses synthetic `setup-<runId>` reviewTaskIds
  //       and never reaches this walker.
  // Including either shifted the renderer-to-gate mapping by one and
  // misrouted reviewer-agent:output in multi-subflow orchestrators to
  // the schema-field-fallback. This filter
  // subsumes the prior setup-loop and gate-index logic — xRenderer is
  // strictly tighter than (hitlOwnedBy ∈ {childAgent, self}) ∨
  // (xRenderer set) and excludes the Inputs gate implicitly.
  const childSteps = approvalPolicySteps.filter(
    (s) => typeof s.xRenderer === "string",
  );
  if (childSteps.length === 0) return { xRenderer: fallback, stepNumber: null, schema: null };

  // Redis-backed index: survives hot-reloads and restarts unlike a module-level
  // Map that can reset between the BullMQ dispatch and server-action approval.
  const idx = await getOrAddWayflowGateIndex(runId, taskId);

  // gateCount tells the resolver how many orchestrator-level input-required events
  // a single approval step spans.
  //
  // Default gateCount by hitlOwnedBy:
  //   "self"       = InputMessageNode directly in the orchestrator → exactly 1 event.
  //   "childAgent" = child agent owns its own HITL via internal approval_gate → exactly 1 event
  //                  (the child's interrupt propagates up; the outer FlowNode must have
  //                  requiresApproval=false so no second orchestrator-level gate is added).
  // Steps can override gateCount explicitly (e.g. split child gates into separate steps).
  //
  // Example for email-recipients (Account scope gateCount=1, Recipients gateCount=1):
  //   step "Account scope"  gateCount=1 → gate  1   shows list-picker
  //   step "Recipients"     gateCount=1 → gate  2   shows recipients:output
  // Example for email-drafts (child approval_gate only, outer requiresApproval=false):
  //   step "Initial emails" gateCount=1 → gate  3   shows drafts:output
  let accumulated = 0;
  for (const step of childSteps) {
    const defaultGateCount = 1;
    const gateCount = typeof step.gateCount === "number" ? step.gateCount : defaultGateCount;
    if (idx < accumulated + gateCount) {
      const xRenderer = typeof step.xRenderer === "string" ? step.xRenderer : fallback;
      return {
        xRenderer,
        stepNumber: typeof step.stepNumber === "number" ? step.stepNumber : null,
        schema: step.schema ?? step.inputMessageSchema ?? null,
      };
    }
    accumulated += gateCount;
  }
  return { xRenderer: fallback, stepNumber: null, schema: null };
}

// ---------------------------------------------------------------------------
// handleWayflowTaskState
//
// Single source of truth for triaging a WayFlow A2A Task response. Used by
// THREE call sites:
//   1. Initial dispatch in runAgentBuilderExecutionJob (this file)
//   2. Resume via approveReviewTaskInternal (review-task-actions.ts:242)
//   3. Resume via agent_run_resume MCP handler (mcp/handlers.ts:631)
//
// The state machine MUST stay identical across the three sites — drift was
// the root cause of the recurring multi-gate HITL drop bug. The fix is one
// helper, one source of truth.
//
// The fromStatus parameter is EXPLICIT (not derived from run.status) because
// the in-memory `run` object loaded at line 137 is never reassigned — its
// `status` field is stale ("queued") by the time the initial-dispatch path
// reaches this helper. Each call site passes the literal status it KNOWS the
// DB row is in:
//   - initial dispatch (this file) → "running"
//   - review-task-actions resume   → "pending_approval"
//   - mcp/handlers resume          → "pending_approval"
//
// Same-status short-circuit: when fromStatus === target, return without
// calling transitionRunStatus. The pair pending_approval -> pending_approval
// is NOT in LEGAL_TRANSITIONS (store.ts:995-1024); calling transitionRunStatus
// with that pair would throw RunTransitionError code="illegal_transition"
// which is NOT swallowable. The short-circuit is what makes multi-gate
// resumes work.
//
// WHY a short-circuit and not a swallowable error code: same-status is a
// no-op in our domain, not an error. Modeling no-ops as exceptions to be
// caught is a smell; pushing the multi-gate idempotency concern down into
// store.ts (the canonical state-machine owner) would couple it to WayFlow
// semantics. The boundary check is local, explicit, and trivially testable.
//
// Related state-machine fixes:
//   - store.ts:LEGAL_TRANSITIONS includes pending_approval->completed
//     so the resume terminal-success path (covered in handle-wayflow-task-state.test.ts)
//     can transition without throwing illegal_transition.
//   - store.ts:updateAgentRunA2ATaskId is an unconditional
//     overwrite so the resync below actually works (was first-writer-wins).
//
// RunTransitionError codes (from store.ts:1038-1061): "illegal_transition"
// and "stale_from_status" — only the latter is swallowed.
//
// State machine (canonical):
//   - input-required → re-emit INTERRUPT, transition to pending_approval (skipped on resume)
//   - failed         → emit RUN_ERROR, transition to failed
//   - other (completed) → emit TEXT_MESSAGE_*, persist stepResults, RUN_FINISHED, transition to completed
// ---------------------------------------------------------------------------
export type HandleWayflowTaskStateArgs = {
  runId: string;
  run: AgentRunRecord;
  fromStatus: AgentRunStatus;
  // The `task` shape intentionally accepts WayFlow's @a2a-js/sdk `Task` type
  // (status.message.parts is a discriminated union of TextPart | DataPart | FilePart;
  // history.parts is the same union). We narrow at access time inside the helper
  // rather than constraining the signature, so all three call sites can pass `Task`
  // directly without unsafe casts. Using `unknown` for parts forces internal narrowing.
  task: {
    id: string;
    contextId?: string | null;
    status?: { state?: string; message?: { parts?: readonly unknown[] } };
    history?: ReadonlyArray<{ role?: string; parts?: readonly unknown[] }>;
    metadata?: unknown;
  };
};

export async function handleWayflowTaskState(args: HandleWayflowTaskStateArgs): Promise<void> {
  const { runId, run, fromStatus, task } = args;
  const taskState = task.status?.state;

  // Defensive resync (idempotent if unchanged): persist task.id / contextId
  // so the next resume's reverse-lookup by a2aTaskId still finds the run if
  // WayFlow assigned a new task ID. updateAgentRunA2ATaskId is an
  // unconditional overwrite so this persists on every call.
  if (task.id !== run.a2aTaskId) {
    await updateAgentRunA2ATaskId(runId, task.id).catch(() => undefined);
  }
  if (task.contextId && task.contextId !== run.a2aContextId) {
    await updateAgentRunA2AContextId(runId, task.contextId).catch(() => undefined);
  }

  console.log(
    `[wayflow] run=${runId} task=${task.id} state=${taskState} ` +
    `status=${JSON.stringify(task.status)} ` +
    `artifacts=${JSON.stringify((task as { artifacts?: unknown }).artifacts ?? null)}`,
  );

  if (taskState === "input-required") {
    const adapter = new DualAdapterDispatch(
      new AgUiAdapter(runId, run.templateId, (event) => publishAgUiEvent(runId, event)),
      new A2UiAdapter(runId, run.templateId, (message) => publishA2UiEvent(runId, message)),
    );
    const interruptPayload = ((task.metadata as { pendingApproval?: unknown } | undefined)?.pendingApproval ?? {}) as Record<string, unknown>;
    console.log(`[wayflow-interrupt] run=${runId} task=${task.id} interruptPayload=${(JSON.stringify(interruptPayload) ?? "null").slice(0, 500)} metadata=${(JSON.stringify(task.metadata) ?? "null").slice(0, 500)} history_last=${(JSON.stringify((task as { history?: unknown[] }).history?.slice(-1)) ?? "null").slice(0, 500)}`);
    // Resolve the xRenderer + stepNumber from the template's approvalPolicy so
    // each child HITL step shows its custom renderer and the stepper advances.
    let wayflowXRenderer = "@cinatra-ai/agent-builder:schema-field-fallback";
    let wayflowStepNumber: number | null = null;
    let wayflowSchema: Record<string, unknown> | null = null;
    try {
      const tmpl = await readAgentTemplateById(run.templateId);
      const policySteps = (tmpl?.approvalPolicy?.steps ?? []) as Array<{
        stepNumber?: number; requiresApproval?: boolean; hitlOwnedBy?: string; xRenderer?: string; gateCount?: number; schema?: Record<string, unknown>; inputMessageSchema?: Record<string, unknown>;
      }>;
      ({ xRenderer: wayflowXRenderer, stepNumber: wayflowStepNumber, schema: wayflowSchema } =
        await resolveWayflowXRenderer(runId, task.id, policySteps));
    } catch {
      // non-fatal — fallback renderer is acceptable
    }
    // HITL renderers resolve campaignId via context.runId (passed
    // at agentic-run-panel.tsx:378) and a typed-object lookup. We no longer
    // enrich the HITL SSE payload with a precomputed campaignId.
    // Surface LLM output text for data-review renderers (e.g. confirmedRecipients).
    // History is checked FIRST — the last agent/assistant message is the LLM's output
    // (from the preceding ApiNode such as recipients-generate or drafts-generate).
    // interruptPayload (task.metadata.pendingApproval) is used as a fallback only when
    // history is empty. This order matters: InputMessageNode gates propagate StartNode
    // DFE context inputs through pendingApproval (e.g. agent_run_id, accountScope) which
    // must NOT override the LLM output text that data-review renderers need to parse.
    // Checking interruptPayload first would cause the recipients review renderer to
    // see {agent_run_id, accountScope} instead of the confirmedRecipients JSON, leaving
    // the list empty even when objects_save also failed.
    const interruptOutput: string | undefined = (() => {
      // Always try history first — it contains the preceding ApiNode's LLM output.
      const history = (task as { history?: ReadonlyArray<{ role?: string; parts?: readonly unknown[] }> }).history;
      const lastAgent = history?.slice().reverse().find((m) => m?.role === "agent" || m?.role === "assistant");
      const text = (lastAgent?.parts as Array<{ kind?: string; text?: string }> | undefined)
        ?.filter((p) => p.kind === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
      if (text && text.length > 0) return text;
      // Fall back to pendingApproval when history is empty (e.g. FlowNode gates or
      // InputMessageNodes that carry their own approval payload rather than LLM output).
      if (Object.keys(interruptPayload).length > 0) return JSON.stringify(interruptPayload);
      return undefined;
    })();
    // Generic interrupt-value pass-through: when the gate's upstream node
    // emitted a flat JSON object as `output` (e.g. an OutputMessageNode like
    // the context-selection-agent's `emit_context_payload`, or any future
    // structured-gate producer), spread its keys into the renderer values so
    // presentational renderers receive their structured payload (the
    // ContextSelectorRenderer needs candidates/selectedRefs/slotMeta present).
    // This is renderer-agnostic by design — NOT special-cased to one renderer.
    // Only fires when the ENTIRE trimmed `output` parses as a plain JSON
    // object, so prose+JSON LLM outputs (existing data-review gates) are
    // unaffected. Reserved keys stepNumber/output are applied last and never
    // clobbered.
    const spreadFromOutput: Record<string, unknown> = (() => {
      if (typeof interruptOutput !== "string") return {};
      const trimmed = interruptOutput.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
      try {
        const p = JSON.parse(trimmed);
        return p && typeof p === "object" && !Array.isArray(p)
          ? (p as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();
    const enrichedValues: Record<string, unknown> = {
      ...(run.inputParams ?? {}),
      ...spreadFromOutput,
      ...(wayflowStepNumber !== null ? { stepNumber: wayflowStepNumber } : {}),
      ...(interruptOutput !== undefined ? { output: interruptOutput } : {}),
    };
    // Synthesize the {contentType, contentBundle, summary}
    // envelope for `@cinatra-ai/reviewer-agent:output` gates when the upstream
    // subflow didn't emit one. Without it the renderer falls back to
    // SchemaFieldRenderer fallback path and the LLM-produced
    // review text never reaches the user-facing SummaryLine component.
    //
    // The reviewer-agent's purpose is "human reviews the LLM's output text"
    // — that text lives in `output` (history-derived). For orchestrators
    // whose reviewer subflow doesn't construct a typed envelope yet, we
    // inject a minimal "text" envelope here so the renderer's SummaryLine
    // displays the LLM output and the fallback SchemaFieldRenderer renders
    // an empty approve/edit input. Subflows that DO emit the envelope (any
    // value with `contentType` already present) are passed through
    // unchanged.
    if (
      wayflowXRenderer === "@cinatra-ai/reviewer-agent:output" &&
      typeof enrichedValues["contentType"] !== "string"
    ) {
      // Do not gate envelope synthesis on `typeof output === "string"`:
      // some reviewer gates fire BEFORE any LLM produced a history.last_assistant text
      // (e.g. an orchestrator's reviewer subflow gets the title
      // via DFE, not from a preceding LLM step). In that case `output` is
      // undefined and the synthesis no-ops, leaving the renderer to fall
      // back to the schema-field-fallback path — un-advanceable on
      // last-HITL steps. Always set a minimal envelope so the renderer's
      // text-case branch (with its own Continue button) always fires.
      const inputParams = (run.inputParams as Record<string, unknown> | null) ?? {};
      const out =
        typeof enrichedValues["output"] === "string"
          ? (enrichedValues["output"] as string)
          : "";
      // Best-effort body: prefer the LLM output, then any title/summaryLine
      // in inputParams or the interruptPayload — anything to give the user
      // SOMETHING to read while approving.
      const fallbackTitle =
        (typeof inputParams["title"] === "string" && (inputParams["title"] as string)) ||
        (typeof inputParams["summaryLine"] === "string" && (inputParams["summaryLine"] as string)) ||
        "";
      const text = out || fallbackTitle || "(reviewer agent — approve to continue)";
      enrichedValues["contentType"] = "text";
      enrichedValues["summary"] = text.length > 200 ? `${text.slice(0, 197)}...` : text;
      enrichedValues["contentBundle"] = {
        text,
        url: (inputParams["url"] as string | undefined) ?? "",
      };
    }
    const wayflowSchemaToSend = await enrichSchemaWithResolvedData(
      (wayflowSchema ?? interruptPayload) as Record<string, unknown>,
      enrichmentContextFor(run.runBy),
    );
    adapter.onInterrupt(
      wayflowSchemaToSend,
      wayflowXRenderer,
      enrichedValues,
      `wayflow-${task.id}`,
    );
    // Multi-gate idempotency — already in pending_approval, the AG-UI re-emit above
    // is enough; transitionRunStatus would throw illegal_transition.
    if (fromStatus === "pending_approval") {
      return;
    }
    // Otherwise (initial-dispatch path: fromStatus === "running"), perform the
    // legal running -> pending_approval transition.
    await transitionRunStatus(runId, fromStatus, "pending_approval").catch((e) => {
      if (e instanceof RunTransitionError && e.code === "stale_from_status") return;
      throw e;
    });
    return;
  }

  if (taskState === "failed") {
    const firstFailPart = task.status?.message?.parts?.[0] as { text?: string } | undefined;
    const errMsg = firstFailPart?.text ?? "WayFlow task failed";
    await Promise.resolve(
      publishAgUiEvent(runId, {
        type: "RUN_ERROR",
        threadId: runId,
        runId,
        message: errMsg,
        timestamp: Date.now(),
      } as never),
    ).catch(() => undefined);
    // Defense-in-depth same-status short-circuit (failed -> failed is also
    // not in LEGAL_TRANSITIONS, though no real call path should hit this).
    if (fromStatus === "failed") {
      return;
    }
    await transitionRunStatus(runId, fromStatus, "failed", { error: errMsg }).catch((e) => {
      if (e instanceof RunTransitionError && e.code === "stale_from_status") return;
      throw e;
    });
    return;
  }

  // Default: completed (or unknown — treat as terminal-success).
  const rawHistory = task.history;
  // Extract structured EndNode outputs from the synthetic
  // sentinel DataPart message before any text-extraction reads the history,
  // and strip the sentinel from the working history so it cannot shadow
  // the real last-assistant text message (`lastAgentMessage` below) or
  // leak into the persisted `scrubbedHistory` payload.
  const endNodeOutputs = extractCinatraEndNodeOutputs(rawHistory);
  const history = stripCinatraEndNodeOutputMessages(rawHistory);
  // A2A spec: role is "user" | "agent". Cinatra also emits "assistant". Accept BOTH.
  const lastAgentMessage = history?.slice().reverse().find((m) => m?.role === "agent" || m?.role === "assistant");
  // Narrow parts at access time — the signature accepts `unknown[]` so all three
  // call sites can pass WayFlow's discriminated `Part[]` (TextPart | DataPart | FilePart)
  // without an unsafe cast at the boundary.
  const finalText: string =
    (lastAgentMessage?.parts as Array<{ kind?: string; text?: string }> | undefined)
      ?.filter((p) => p.kind === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("") ?? "";
  let parsedOutput: unknown = finalText;
  try {
    parsedOutput = JSON.parse(finalText);
  } catch {
    // not JSON — keep raw text
  }

  if (finalText.length > 0) {
    const messageId = randomUUID();
    await Promise.resolve(
      publishAgUiEvent(runId, { type: "TEXT_MESSAGE_START", messageId, timestamp: Date.now() } as never),
    ).catch(() => undefined);
    await Promise.resolve(
      publishAgUiEvent(runId, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: finalText, timestamp: Date.now() } as never),
    ).catch(() => undefined);
    await Promise.resolve(
      publishAgUiEvent(runId, { type: "TEXT_MESSAGE_END", messageId, timestamp: Date.now() } as never),
    ).catch(() => undefined);
  }

  const scrubbedHistory = scrubWayflowHistoryCredentials(history);

  // Defense-in-depth same-status short-circuit (completed -> completed is
  // a terminal-state already-locked condition, would also throw illegal_transition).
  if (fromStatus === "completed") {
    return;
  }

  // Both terminal-success edges are legal:
  //   running          -> completed
  //   pending_approval -> completed
  let transitioned = true;
  await transitionRunStatus(runId, fromStatus, "completed", {
    completedAt: new Date(),
    stepResults: [
      {
        kind: "wayflow_response",
        a2aTaskId: task.id,
        output: parsedOutput,
        // Structured EndNode declared outputs are surfaced via
        // the WayFlow synthetic-DataPart sentinel. `packages/a2a/src/
        // agent-executor.ts:stepResultsToArtifact` renders `output_data`
        // as an A2A DataPart artifact for external consumers, and
        // downstream consumers assert on the structured object rather than
        // lossy text fields such as `failures`, `failureCode`, `items`, and
        // `extractionNotes`.
        ...(endNodeOutputs !== null ? { output_data: endNodeOutputs } : {}),
        history: scrubbedHistory,
      },
    ],
  }).catch((err) => {
    // stale_from_status: a concurrent stop/cancel already moved the row;
    // skip RUN_FINISHED so the UI reflects the DB winner, not us.
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      transitioned = false;
      return;
    }
    throw err;
  });

  if (!transitioned) return;

  // 1. Publish terminal AG-UI event immediately so the operator's UI shows
  //    "completed" without waiting on autosave latency.
  await Promise.resolve(
    publishAgUiEvent(runId, {
      type: "RUN_FINISHED",
      threadId: runId,
      runId,
      status: "completed",
      timestamp: Date.now(),
    } as never),
  ).catch(() => undefined);

  // 2. Trigger autosave sidecar AFTER RUN_FINISHED — non-blocking by contract.
  //    Mirrors the writeHitlPrompt sidecar pattern (review-task-actions.ts:215-223).
  //    The .catch() wrapper is required: a
  //    flag-read failure or LLM error must NOT destabilize the WayFlow state
  //    machine. The autosave is gated by the global skill_autosave.enabled
  //    flag — when disabled (default) the helper short-circuits before any
  //    DB read. Current limitation: single-user-only; thread session userId
  //    before enabling multi-user autosave.
  runSkillAutosaveOnRunCompletion(runId).catch((e) => {
    console.warn(`[skill-autosave] autosave failed, run=${runId}`, e);
  });
}

// ---------------------------------------------------------------------------
// Orchestrator readiness gate.
// ---------------------------------------------------------------------------

/**
 * Orchestrator readiness gate.
 *
 * Called at execution start. For orchestrator-type templates, verifies every
 * declared agentDependency resolves to an INSTALLED template — defined as a
 * published template row with a matching packageName. Draft and archived
 * templates do NOT satisfy the gate (installing a package publishes a row, so
 * "published" is the correct filter).
 *
 * Leaf and proxy types return immediately without issuing any DB query
 * (fast path preserved; Anti-Pattern: routing on agentDependencies.length is wrong).
 *
 * This check is state-dependent and runs on every execution start — not at
 * install time — so upgrade/reinstall flows remain unblocked (Pitfall 6).
 */
export async function assertOrchestratorReady(
  template: AgentTemplateRecord,
): Promise<void> {
  // Accept both "orchestrator" and OAS-aligned "flow".
  if (template.type !== "orchestrator" && template.type !== "flow") return;
  const deps = template.agentDependencies ?? {};
  const depNames = Object.keys(deps);
  if (depNames.length === 0) return;

  const missing: string[] = [];
  for (const pkgName of depNames) {
    const found = await readAgentTemplates({
      packageName: pkgName,
      status: "published",
      limit: 1,
    });
    if (found.items.length === 0) {
      missing.push(pkgName);
    } else {
      // Warn when the installed version doesn't satisfy the declared semver range.
      // Not a hard block — preserves existing flows; a future phase can promote this.
      const installedVersion = found.items[0]?.packageVersion;
      const requiredRange = deps[pkgName];
      if (installedVersion && requiredRange && !semver.satisfies(installedVersion, requiredRange)) {
        console.warn(
          `[agent-builder] Orchestrator sub-agent ${pkgName}@${installedVersion} does not satisfy required range ${requiredRange}`,
        );
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Orchestrator cannot run — missing installed sub-agents: ${missing.join(", ")}. ` +
        `Run \`cinatra agents install ${missing[0]}\`` +
        (missing.length > 1 ? " (and others)" : "") +
        " first.",
    );
  }
}

// ---------------------------------------------------------------------------
// BullMQ worker function
// ---------------------------------------------------------------------------

export async function runAgentBuilderExecutionJob(
  data: { runId: string; gateAttempt?: number },
  jobId: string,
): Promise<void> {
  const { runId } = data;
  // ProjectContext propagation. Read the
  // run row OUTSIDE the inheritance frame so the read itself does not
  // accidentally tag substrate-look-up rows. Then wrap the actual
  // execution body in `mcpRequestContextStorage.run({ ...prev,
  // projectContext: { projectId } })` so every artifact/object write
  // inside the run inherits `objects.project_id = run.projectId` via the
  // canonical writer's frame read.
  //
  // The frame is established whether `run.projectId` is a UUID or NULL —
  // NULL is the explicit ambient-project signal that downstream writers
  // recognise (no auto-tag). Establishing the frame ALWAYS is safer than
  // gating on truthy projectId: a stale outer frame from the BullMQ
  // worker pool can no longer leak into a non-project run.
  const probeRun = await readAgentRunById(runId);
  if (!probeRun) {
    console.log(`[agent-builder] run ${runId} not found, skipping`);
    return;
  }
  const prev = mcpRequestContextStorage.getStore();
  const next: McpRequestContext = {
    ...(prev ?? {}),
    projectContext: { projectId: probeRun.projectId ?? null },
  };
  return mcpRequestContextStorage.run(next, () =>
    runAgentBuilderExecutionJobInner(data, jobId),
  );
}

// Extracted inner. The outer wraps in the
// ProjectContext frame; the inner contains the job body, unchanged except for
// the moved run-row read (probeRun above is re-read here for clarity).
async function runAgentBuilderExecutionJobInner(
  data: { runId: string; gateAttempt?: number },
  jobId: string,
): Promise<void> {
  const { runId } = data;
  // gateAttempt threading. Dispatcher writes
  // `{ ...job.data, gateAttempt: err.nextAttempt }` via `job.updateData(...)`
  // before calling `job.moveToDelayed(...)`, so each re-queue increments.
  const currentGateAttempt = typeof data.gateAttempt === "number" ? data.gateAttempt : 0;

  // 1. Read run row
  const run = await readAgentRunById(runId);
  if (!run) {
    console.log(`[agent-builder] run ${runId} not found, skipping`);
    return;
  }
  if (run.status !== "queued") {
    // Federated children parked by WaitingForHumanError may retry
    // after resume transitions them to a terminal state. If the child reached
    // "failed"/"stopped" while parked, re-throw so BullMQ sees a job-level failure
    // and failParentOnFailure cascades to the orchestrator flow — aligning BullMQ
    // job telemetry with run telemetry. For "completed", the quiet return is correct
    // (FlowProducer proceeds to rollup normally).
    if (run.parentRunId && (run.status === "failed" || run.status === "stopped")) {
      throw new Error(
        `Child run ${runId} already terminal (${run.status}) — surfacing to parent flow`,
      );
    }
    console.log(`[agent-builder] run ${runId} not queued (status: ${run.status}), skipping`);
    return;
  }

  // 2. Load template to determine execution mode before any status transition.
  // The agentic path owns its own "running" transition inside runAgentBuilderAgenticJob,
  // so we must NOT mark as running here for that branch — otherwise the agentic job
  // would see status "running" (not "queued") and silently skip the run.
  const template = await readAgentTemplateById(run.templateId);
  if (!template) {
    await transitionRunStatus(runId, "queued", "failed", {
      error: `Template ${run.templateId} not found`,
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Version pinning. When the A2A request-time surface sets
  // run.packageVersion, the worker loads the immutable snapshot for
  // (templateId, semver) and applies it on top of the live template before
  // any dispatch. Later `agent_registry_publish` calls cannot retarget
  // an in-flight task (invariant: "published version cannot change in-flight").
  // No-op when run.packageVersion === null (existing live-template behavior).
  // ---------------------------------------------------------------------------
  let pinnedSnapshot: {
    compiledPlan?: unknown;
    taskSpec?: string | null;
  } | null = null;
  if (run.packageVersion) {
    const versionRow = await readAgentTemplateVersionBySemver(run.templateId, run.packageVersion);
    if (versionRow) {
      // Snapshot is JSON already parsed by deserializeVersionRow.
      // If the row exists but the shape is unexpected, fall back to live template
      // rather than running with half-applied data.
      try {
        const snap = versionRow.snapshot as {
          compiledPlan?: unknown;
          taskSpec?: string | null;
        };
        pinnedSnapshot = {
          compiledPlan: snap.compiledPlan,
          taskSpec: snap.taskSpec,
        };
      } catch (err) {
        await transitionRunStatus(runId, "queued", "failed", {
          error: `version snapshot corrupt for ${run.templateId}@${run.packageVersion}: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    } else {
      console.log(`[agent-builder] run ${runId} requested packageVersion ${run.packageVersion} but no snapshot found — falling back to live template`);
    }
  }

  if (pinnedSnapshot) {
    // The pinned snapshot is authoritative — later publishes cannot retarget this run.
    if (pinnedSnapshot.compiledPlan !== undefined) {
      (template as any).compiledPlan = pinnedSnapshot.compiledPlan;
    }
    if (pinnedSnapshot.taskSpec !== undefined) {
      (template as any).taskSpec = pinnedSnapshot.taskSpec;
    }
    console.log(`[agent-builder] run ${runId} pinned to version ${run.packageVersion}`);
  }

  // Orchestrator readiness gate. Fail fast BEFORE any dispatch
  // if a declared sub-agent is not installed.
  // Leaf / proxy templates short-circuit inside the helper (no DB calls).
  try {
    await assertOrchestratorReady(template);
  } catch (err) {
    await transitionRunStatus(runId, "queued", "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Setup Interrupt Loop — emit one INTERRUPT per required
  // inputSchema field not already present in run.inputParams. The resume path
  // re-enters this function, which re-reads inputParams and either emits the
  // next INTERRUPT or falls through to the existing dispatch branches.
  //
  // Mirrors packages/agent-builder/src/agentic-execution.ts lines 381-507
  // (HitlPauseSignal catch branch) — same primitive sequence, different
  // provenance shape (kind: "setup_field" discriminator).
  //
  // CRITICAL ordering: this loop MUST run BEFORE the dispatch branches
  // (WayFlow / orchestrator) so that a run
  // missing setup input is paused before any provider-specific worker fires.
  // This loop must own setup-input pauses because it can stop execution before
  // any provider-specific worker fires.
  // ---------------------------------------------------------------------------
  // When the DB row's inputSchema is empty AND the agent is
  // an in-repo @cinatra/<slug>, derive the schema from the source OAS
  // StartNode metadata on disk. Some installed rows have stale-empty inputSchema; without
  // this resolver the setup loop short-circuits (requiredFields = []) and
  // WayFlow rejects with `missing inputs "url"`. Memoized per
  // packageName@packageVersion in the resolver module.
  const inputSchema = await resolveTemplateInputSchema(template);
  const properties = inputSchema.properties;
  const requiredFields = inputSchema.required;

  // Concurrent dispatch guard is provided by the early-exit at the top of this
  // function (run.status !== "queued" → return). A run that is already
  // pending_approval will not be "queued", so it exits before reaching this point.
  // The readReviewTasksByRunId guard is redundant once the review_tasks table is dropped.

  // Threshold-based dispatch, gated on agent-level grouped opt-in.
  //   length >= 2 AND agentOptsIntoGrouped → grouped INTERRUPT
  //   length === 1 OR !agentOptsIntoGrouped → per-field INTERRUPT
  //   length === 0 → fall through to dispatch
  //
  // Opt-in rule:
  // An agent template opts into the grouped setup form by declaring
  //   "x-renderer": "@cinatra-ai/agent-builder:grouped-setup-form"
  // on at least one of its setup fields. Agents without this decoration keep
  // per-field interrupts regardless of pending-field count — this prevents
  // grouped setup from silently changing setup UX for every agent with ≥2 pending
  // fields.
  const GROUPED_SETUP_FORM_RENDERER_ID = "@cinatra-ai/agent-builder:grouped-setup-form";

  const pendingFields = requiredFields.filter((fieldName) => {
    const fieldSchema = properties[fieldName] ?? {};
    if ((fieldSchema as { "x-hidden"?: boolean })["x-hidden"]) return false;
    if (Object.prototype.hasOwnProperty.call(run.inputParams, fieldName)) return false;
    return true;
  });

  const agentOptsIntoGrouped = pendingFields.some((fieldName) => {
    const fieldSchema = properties[fieldName] ?? {};
    return (fieldSchema as { "x-renderer"?: string })["x-renderer"]
      === GROUPED_SETUP_FORM_RENDERER_ID;
  });

  if (pendingFields.length === 0) {
    // No pending setup fields — fall through to dispatch (existing behavior).
  } else if (pendingFields.length === 1 || !agentOptsIntoGrouped) {
    // PER-FIELD path — sequential setup behavior preserved.
    // Covers two cases:
    //   (1) Exactly one required field is pending (sequential UX only path)
    //   (2) ≥2 fields pending BUT agent did not opt in via schema decoration
      //       (prevents broad activation for agents designed
    //        for sequential prompting).
    // PLUS a parallel A2UI onInterrupt (no-op for non-grouped xRenderers).
    const fieldName = pendingFields[0] as string;
    const fieldSchema = properties[fieldName] ?? {};
    const xRenderer =
      (fieldSchema as { "x-renderer"?: string })["x-renderer"]
        ?? "@cinatra-ai/agent-builder:schema-field-fallback";

    await transitionRunStatus(runId, "queued", "pending_approval");

    // No DB writes — use synthetic ID so approveReviewTaskInternal
    // routes to the "setup-" branch, which re-enqueues AGENT_BUILDER_EXECUTION.
    const syntheticId = `setup-${runId}`;

    const adapter = new DualAdapterDispatch(
      new AgUiAdapter(runId, run.templateId, (event) =>
        publishAgUiEvent(runId, event),
      ),
      new A2UiAdapter(runId, run.templateId, (message) =>
        publishA2UiEvent(runId, message),
      ),
    );
    // The composite forwards all 5 args (including fieldName) to both children.
    // A2UiAdapter.onInterrupt declares only 4 params — the 5th is silently ignored at
    // runtime. A2UI ignores the extra fieldName argument; composite
    // uniformly forwards it. No behavioral change for A2UI.
    // Wrap in an object-schema envelope so the enricher can match the field
    // by name against the whitelist. Without the envelope, schema-enricher.ts
    // short-circuits at the `properties` guard and emits no enum.
    const fieldSchemaEnvelope = {
      type: "object" as const,
      properties: { [fieldName]: fieldSchema as Record<string, unknown> },
    };
    const enrichedEnvelope = await enrichSchemaWithResolvedData(fieldSchemaEnvelope, enrichmentContextFor(run.runBy));
    const enrichedFieldSchema =
      (enrichedEnvelope.properties as Record<string, Record<string, unknown>>)[fieldName]
      ?? (fieldSchema as Record<string, unknown>);
    adapter.onInterrupt(
      enrichedFieldSchema,
      xRenderer,
      run.inputParams,
      syntheticId,
      fieldName,
    );

    console.log(
      `[setup-interrupt-loop] run ${runId} paused on field '${fieldName}' (syntheticId=${syntheticId})`,
    );
    return;
  } else {
    // GROUPED path — length >= 2 AND agent opts in.
    const groupedProperties: Record<string, unknown> = {};
    // Include all pending REQUIRED fields first.
    for (const fieldName of pendingFields) {
      groupedProperties[fieldName] = properties[fieldName];
    }
    // Include visible OPTIONAL fields (in properties, NOT in requiredFields, not x-hidden, not already in inputParams)
    // so users can fill them in the same form (e.g. email-outreach's `senderName`).
    const optionalFieldNames: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(properties)) {
      if (requiredFields.includes(fieldName)) continue;
      if ((fieldSchema as { "x-hidden"?: boolean })["x-hidden"]) continue;
      if (Object.prototype.hasOwnProperty.call(run.inputParams, fieldName)) continue;
      groupedProperties[fieldName] = fieldSchema;
      optionalFieldNames.push(fieldName);
    }

    const groupedSchema = {
      type: "object" as const,
      properties: groupedProperties,
      required: pendingFields,
    };

    const xRenderer = GROUPED_SETUP_FORM_RENDERER_ID;

    await transitionRunStatus(runId, "queued", "pending_approval");

    // No DB writes — use synthetic ID so approveReviewTaskInternal
    // routes to the "setup-" branch, which re-enqueues AGENT_BUILDER_EXECUTION.
    const syntheticId = `setup-${runId}`;

    const adapter = new DualAdapterDispatch(
      new AgUiAdapter(runId, run.templateId, (event) =>
        publishAgUiEvent(runId, event),
      ),
      new A2UiAdapter(runId, run.templateId, (message) =>
        publishA2UiEvent(runId, message),
      ),
    );
    const enrichedGroupedSchema = await enrichSchemaWithResolvedData(
      groupedSchema as unknown as Record<string, unknown>,
      enrichmentContextFor(run.runBy),
    );
    adapter.onInterrupt(
      enrichedGroupedSchema,
      xRenderer,
      run.inputParams,
      syntheticId,
    );

    console.log(
      `[setup-interrupt-loop] run ${runId} paused on grouped setup (${pendingFields.length} required fields: ${pendingFields.join(", ")}) (syntheticId=${syntheticId})`,
    );
    return;
  }

  // All required fields present — fall through to the existing dispatch branches.

  // ---------------------------------------------------------------------------
  // External A2A dispatch branch.
  // MUST run BEFORE the WayFlow dispatch — external templates carry
  // sourceType="external" and must short-circuit before WayFlow
  // URL resolution (otherwise their packageName would be passed to
  // resolveWayflowUrl, which only routes internal @<vendor>/<slug> agents
  // against WAYFLOW_BASE_URL).
  // Mirrors the external branch in a2a-actions.ts sendAgentBuilderMessage but
  // operates on an already-created run row (queued by createAndTriggerRunWithParams
  // or the BullMQ job handler). Awaits the SSE proxy so the BullMQ job stays
  // active until the stream ends and the DB status is set to completed/failed.
  // AG-UI / A2UI events flow through startExternalSseProxyFromStream → Redis.
  // ---------------------------------------------------------------------------
  if (template.sourceType === "external") {
    if (!template.agentUrl) {
      await transitionRunStatus(runId, "queued", "failed", {
        error: "external template missing agentUrl",
      });
      return;
    }
    const saved = findSavedConnectionForAgentUrl(template.agentUrl);
    if (!saved) {
      await transitionRunStatus(runId, "queued", "failed", {
        error: `no saved connection for external A2A server: ${template.agentUrl}`,
      });
      return;
    }

    const { getNangoConnection } = await import("@cinatra-ai/nango-connector");
    const {
      createExternalA2AClient,
      startExternalSseProxyFromStream,
    } = await import("@cinatra-ai/a2a");
    type ExternalCreds = { token: string };

    let credentials: ExternalCreds | undefined;
    try {
      const connection = await getNangoConnection(
        saved.providerConfigKey,
        saved.connectionId,
      );
      if (connection) {
        const raw = (connection as { credentials?: { apiKey?: unknown } }).credentials;
        if (raw?.apiKey && typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
          credentials = { token: raw.apiKey };
        }
      }
    } catch {
      // No-auth dev peer — credentials remain undefined.
    }

    try {
      await transitionRunStatus(runId, "queued", "running");
    } catch (err) {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        console.log(`[external-a2a] run ${runId} status no longer "queued" — skipping stale transition`);
        return;
      }
      throw err;
    }

    let client;
    let stream;
    let firstEvent: unknown;
    let externalTaskId: string;
    let initialStatus = "submitted";
    try {
      client = await createExternalA2AClient({ agentUrl: template.agentUrl, credentials });
      stream = client.streamTask(JSON.stringify((run.inputParams ?? {}) as Record<string, unknown>));
      const first = await stream.next();
      if (first.done) {
        await transitionRunStatus(runId, "running", "failed", { error: "external streamTask returned empty stream" });
        return;
      }
      firstEvent = first.value;
      const ev = firstEvent as { kind?: string; id?: string; status?: { state?: string } };
      externalTaskId = ev.id ?? randomUUID();
      if (ev.kind === "status-update" && ev.status?.state) initialStatus = ev.status.state;
    } catch (err) {
      await transitionRunStatus(runId, "running", "failed", {
        error: err instanceof Error ? err.message : "external streamTask failed",
      });
      return;
    }

    await updateAgentRunA2ATaskId(runId, externalTaskId).catch(() => {});

    // Re-inject consumed first event then run proxy to completion.
    // Await so the BullMQ job is active for the duration of the stream;
    // terminal DB status is set here, AG-UI events flow via Redis.
    const peeked = firstEvent;
    async function* resumeStream() {
      yield peeked as Awaited<ReturnType<typeof stream.next>>["value"];
      yield* stream;
    }

    try {
      await startExternalSseProxyFromStream(resumeStream(), initialStatus, runId, {
        publishAgUiEvent: (event) => publishAgUiEvent(runId, event as never),
      });
      // Only swallow stale_from_status (benign race where a concurrent
      // cancel has already moved the run off "running"). illegal_transition or
      // any other error must surface so future refactor bugs (typos, wrong
      // "from" argument) are caught at test/CI time, not silently masked.
      await transitionRunStatus(runId, "running", "completed").catch((err) => {
        if (err instanceof RunTransitionError && err.code === "stale_from_status") {
          console.log(
            `[external-a2a] run ${runId} no longer running — skipping running→completed transition`,
          );
          return;
        }
        throw err;
      });
    } catch (err) {
      // Stream error OR an unexpected transition error from the completed path.
      // Apply the same discrimination on the failed-branch transition.
      await transitionRunStatus(runId, "running", "failed", {
        error: err instanceof Error ? err.message : String(err),
      }).catch((e) => {
        if (e instanceof RunTransitionError && e.code === "stale_from_status") {
          console.log(
            `[external-a2a] run ${runId} no longer running — skipping running→failed transition`,
          );
          return;
        }
        throw e;
      });
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // WayFlow A2A dispatch (LangGraph retired — unconditional).
  // Vendor-namespaced multi-tenant routing. The upstream URL is
  // derived from `template.packageName` (`@vendor/slug`) via the canonical
  // `resolveWayflowUrl` helper, which composes
  //   `${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/`
  // and rejects malformed input (path-traversal, URL-injection chars).
  // A single `WAYFLOW_BASE_URL` env var is the only configuration knob.
  // ---------------------------------------------------------------------------
  {
    if (!template.packageName) {
      throw new Error(
        `template.packageName is null for templateId=${template.id}; cannot route to WayFlow`,
      );
    }
    // The strict-regex resolver throws on malformed packageName, so
    // no further guard is required. WAYFLOW_BASE_URL must be set in the env.
    const wayflowUrl = resolveWayflowUrl(template.packageName);

    // Dynamic imports — mirrors the existing external A2A pattern (execution.ts:371).
    // Only createExternalA2AClient is used in the WayFlow branch; the
    // SSE proxy is not invoked here because we drive DB transitions from the
    // sendTask result directly (blocking-mode WayFlow returns a completed Task,
    // not a stream).
    const { createExternalA2AClient } = await import("@cinatra-ai/a2a");

    // -------------------------------------------------------------------------
    // Side-effects gate. WayFlow dispatches the entire flow via a single
    // `client.sendTask` blocking call; there is no per-step hook in the TS
    // dispatcher. The gate is therefore per-run, scoped by
    // `template.gatedSteps[]` non-empty.
    //
    // The gate fires BEFORE `transitionRunStatus(runId, "queued", "running")`
    // so a parked run's DB status stays "queued" while the BullMQ job moves to
    // delayed (the dispatcher in src/lib/background-jobs.ts catches the
    // sentinel error and calls `job.moveToDelayed(...)`).
    //
    // Conservative defaults: triggerMode === null → treat as "full"; gatedSteps
    // === null (template without gatedSteps) → treat as
    // empty (gate disabled). For `start-only` agents the compiler emits
    // gatedSteps: [] so the length check correctly disables the gate without
    // an extra branch.
    // -------------------------------------------------------------------------
    const gatedSteps = template.gatedSteps ?? [];
    const triggerMode = template.triggerMode ?? "full";
    if (triggerMode === "full" && gatedSteps.length > 0) {
      const released = await isTriggerReleased(runId);
      if (!released) {
        const nextAttempt = currentGateAttempt + 1;
        throw new TriggerGateClosedError({
          runId,
          nextAttempt,
          delayMs: gateBackoffMs(nextAttempt),
        });
      }
    }

    try {
      await transitionRunStatus(runId, "queued", "running");
    } catch (err) {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        console.log(`[wayflow] run ${runId} no longer queued — skipping stale transition`);
        return;
      }
      throw err;
    }

    // RUN_STARTED before sendTask so AG-UI consumers
    // see the run begin. Errors swallowed (Redis publish is best-effort).
    await Promise.resolve(
      publishAgUiEvent(runId, {
        type: "RUN_STARTED",
        threadId: runId,
        runId,
        timestamp: Date.now(),
      } as never),
    ).catch(() => undefined);

    try {
      // WayFlow A2AServer: one agent per container instance — served at root.
      // wayflowUrl already points to the container running `slug` (per-slug
      // routing handled above).
      // Orchestrator chains through
      // 5 child agents do not fit in the default 30s budget. 600s = 10min.
      //
      // Node.js undici defaults headersTimeout=300s.
      // WayFlow blocking mode holds the connection up to 720s before responding.
      // At 300s undici fires HeadersTimeoutError ("fetch failed") before the
      // response arrives. Use a custom undici Agent with the timeout lifted
      // to WAYFLOW_UNDICI_TIMEOUT_MS (slightly above the 720s WayFlow server
      // blocking cap) so the AbortSignal timeout (600s) governs cancellation,
      // not undici's internal timer. Shared with the
      // catch-all proxy at src/app/api/a2a/agents/[...slug]/route.ts.
      const wayflowAgent = new UndiciAgent({
        headersTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
        bodyTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
      });
      const wayflowFetch = (
        (url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
          undiciFetch(url, { ...init, dispatcher: wayflowAgent })
      ) as unknown as typeof fetch;
      const client = await createExternalA2AClient({
        agentUrl: wayflowUrl,
        // 24h ceiling aligned with wayflow's ApiNode + A2A Pydantic
        // timeout patches (docker/wayflow/agent_loader.py). Batch LLM
        // workflows can run up to the OpenAI batch SLA. The dispatcher
        // built above (headersTimeout + bodyTimeout = WAYFLOW_UNDICI_TIMEOUT_MS)
        // governs undici-level timers; the AbortSignal here governs
        // total wait.
        timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
        fetchImpl: wayflowFetch,
      });

      // Use blocking sendTask so WayFlow processes the full flow synchronously
      // and returns a completed Task. WayFlow requires `acceptedOutputModes` in
      // configuration — omitting it yields a Pydantic ValidationError (HTTP 500).
      // Merge cinatra_run_id into the WayFlow A2A
      // initial message payload. The orchestrator agent.json declares
      // cinatra_run_id as a flow input and threads it via
      // DataFlowEdge to each leaf ApiNode. Run identity is owned by the
      // dispatcher; the WayFlow flow inherits it.
      const task = await client.sendTask({
        message: {
          role: "user",
          kind: "message",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: JSON.stringify({ ...(run.inputParams ?? {}), cinatra_run_id: run.id } as Record<string, unknown>) }],
        },
        configuration: { acceptedOutputModes: ["text"] },
      });

      // Single source of truth. The helper performs:
      //   - Defensive resync of task.id and contextId (idempotent if unchanged)
      //   - Triage on task.status.state: input-required / failed / completed
      //   - Atomic transition (running -> {pending_approval, failed, completed})
      // See handleWayflowTaskState above for the full state machine.
      //
      // fromStatus is the literal "running" — NOT run.status — because the
      // in-memory run object loaded at line 137 still has the stale "queued"
      // status (the DB row was just moved to "running" by the CAS at line 760).
      await handleWayflowTaskState({ runId, run, fromStatus: "running", task });
    } catch (err) {
      await transitionRunStatus(runId, "running", "failed", {
        error: err instanceof Error ? err.message : String(err),
      }).catch((e) => {
        if (e instanceof RunTransitionError && e.code === "stale_from_status") return;
        throw e;
      });
    }
    return;
  }

  // WayFlow is the only dispatch path. Reaching this point means
  // the WayFlow body did not return — this should be unreachable.
  throw new Error(
    `Unreachable: WayFlow dispatch did not return for runId=${runId}`,
  );
}
