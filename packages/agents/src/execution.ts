import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import semver from "semver";
import {
  readAgentRunById,
  readAgentTemplateById,
  readAgentTemplates,
  readAgentTemplateVersionBySemver,
  readAgentTemplateVersionById,
  transitionRunStatus,
  RunTransitionError,
  findSavedConnectionForAgentUrl,
  updateAgentRunA2ATaskId,
  updateAgentRunA2AContextId,
  setAgentRunTokenHash,
} from "./store";
import type { AgentTemplateRecord, AgentRunRecord, AgentRunStatus } from "./store";
import {
  resolveWayflowUrl,
  describeWayflowDispatchError,
  WAYFLOW_A2A_TIMEOUT_MS,
  WAYFLOW_UNDICI_TIMEOUT_MS,
} from "./wayflow-url";
import { runSkillAutosaveOnRunCompletion } from "./skill-autosave";
import { isTriggerReleased } from "./trigger-gate";
import { resolveTemplateInputSchema } from "./input-schema-resolver";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import { snapshotSkillsAtRunStart } from "@/lib/agent-run-skills-used";
import {
  GROUPED_SETUP_FORM_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "./agent-builder-ids";
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
// FAIL-CLOSED pinned-run snapshot resolution (cinatra#1040 S7).
//
// Deliberately INLINED in the worker module rather than a dedicated file: a new
// module would add first-party graph pressure to every hot route that reaches
// this worker (the route-graph ratchet counts it on /api/a2a, /api/llm-bridge,
// /api/mcp, /chat), and store.ts (the other already-in-graph home) is at its
// file-size ceiling. execution.ts is already in every one of those route graphs
// and is not file-size-tracked, so this adds NO graph or file-size pressure. The
// function is PURE + dependency-injected (readers are passed in) so it is still
// unit-testable without a DB.
//
// Closes the request-time refuse-with-evidence contract END-TO-END. S5 made the
// A2A REQUEST-TIME pinning seam (`resolveVersionBeforeRun`) refuse an explicit
// `requestedVersion` with no immutable `agent_template_versions` snapshot. But
// this EXECUTION worker still best-effort fell back to the LIVE template if a
// REQUESTED-and-present snapshot was PURGED between enqueue and execution,
// because the run row recorded only the resolved semver (`packageVersion`), not
// whether the pin was REQUIRED. A pinned run could therefore silently serve an
// UNPINNED (live) version.
//
// THE REQUIRED-PIN MARKER (formal encoding, migration-free). A run is a REQUIRED
// pin iff it carries BOTH `versionId` (the EXACT agent_template_versions snapshot
// id) AND `packageVersion` (the resolved semver). `resolveVersionBeforeRun` sets
// BOTH only for an explicit `requestedVersion` (a default resolution returns the
// semver but NO snapshot id). EVERY OTHER run producer sets AT MOST ONE —
// createAgentRunPendingInput, runFromRegistry, and the workflow / project /
// host-content-editor dispatch paths all set `versionId`-ONLY (an inert
// latest-snapshot pin the worker has never honored); a default A2A resolution
// sets `packageVersion`-ONLY. The A2A InProcessAgentExecutor is the SOLE
// createAgentRun caller that sets `packageVersion`, and (S7) it now also threads
// the resolved snapshot id into `versionId`. So the pair is UNAMBIGUOUS: it
// identifies exactly the A2A request-time required pin — leaving every
// `versionId`-only pin on its existing best-effort behavior (no regression).
// ---------------------------------------------------------------------------

/** The subset of `agent_template_versions` resolvePinnedRunSnapshot reads. */
export type PinnedVersionRow = {
  templateId: string;
  semver: string;
  snapshot: unknown;
};

/** The execution fields a resolved snapshot overlays onto the live template. */
export type PinnedRunSnapshotFields = {
  compiledPlan?: unknown;
  taskSpec?: string | null;
};

export type ResolvePinnedRunSnapshotDeps = {
  readAgentTemplateVersionById: (id: string) => Promise<PinnedVersionRow | null>;
  readAgentTemplateVersionBySemver: (
    templateId: string,
    semver: string,
  ) => Promise<PinnedVersionRow | null>;
};

/**
 * Thrown when a run carrying a REQUIRED version pin cannot be served that exact
 * immutable snapshot. Carries the full evidence set so the worker can fail the
 * run with an actionable refusal instead of silently serving the live template.
 */
export class PinnedRunSnapshotUnreachableError extends Error {
  readonly code = "PINNED_RUN_SNAPSHOT_UNREACHABLE";
  readonly templateId: string;
  readonly packageVersion: string;
  readonly versionId: string;
  readonly reason: string;
  constructor(input: {
    templateId: string;
    packageVersion: string;
    versionId: string;
    reason: string;
  }) {
    super(
      `pinned run refused — the REQUIRED version pin ${input.templateId}@${input.packageVersion} ` +
        `(snapshot ${input.versionId}) could not be served: ${input.reason}. Refusing rather than ` +
        `silently serving the live template (cinatra#1040 S7 fail-closed). Re-publish that ` +
        `agent_template_versions snapshot, or dispatch without an explicit version pin.`,
    );
    this.name = "PinnedRunSnapshotUnreachableError";
    this.templateId = input.templateId;
    this.packageVersion = input.packageVersion;
    this.versionId = input.versionId;
    this.reason = input.reason;
  }
}

/**
 * Resolve the immutable snapshot a queued run must be executed against.
 *
 *   - REQUIRED pin (`versionId` AND `packageVersion` both set): load the exact
 *     snapshot by id, VERIFY it binds to the run's template + version, VERIFY it
 *     is structurally usable, and return its execution fields for a FULL overlay.
 *     Any failure throws `PinnedRunSnapshotUnreachableError` — never the default.
 *   - Non-required with a `packageVersion` (default A2A resolution / legacy):
 *     best-effort load by semver; a missing/unstructured row returns `null` so
 *     the caller keeps the EXISTING live-template behavior.
 *   - `versionId`-only (inert pending-input / registry pin) or neither: `null`.
 */
export async function resolvePinnedRunSnapshot(
  run: { templateId: string; packageVersion: string | null; versionId: string | null },
  deps: ResolvePinnedRunSnapshotDeps,
): Promise<PinnedRunSnapshotFields | null> {
  const isRequiredPin = run.versionId != null && run.packageVersion != null;

  if (isRequiredPin) {
    const versionId = run.versionId as string;
    const packageVersion = run.packageVersion as string;
    const fail = (reason: string): never => {
      throw new PinnedRunSnapshotUnreachableError({
        templateId: run.templateId,
        packageVersion,
        versionId,
        reason,
      });
    };

    // (1) LOAD by the exact snapshot id. deserialization (JSON.parse of the
    //     stored snapshot) happens inside the reader and can THROW on a corrupt
    //     row — catch it and fail closed rather than let it bubble as a raw 500.
    let row: PinnedVersionRow | null;
    try {
      row = await deps.readAgentTemplateVersionById(versionId);
    } catch (err) {
      return fail(
        `snapshot load/deserialize failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // (2) PRESENCE — a purged snapshot is unreachable.
    if (!row) {
      return fail("no agent_template_versions row for the pinned snapshot id (purged mid-flight)");
    }
    // (3) BINDING — the loaded snapshot MUST be the one the run claims. A
    //     mismatched `versionId` (wrong template or wrong version) would serve a
    //     DIFFERENT plan while claiming the requested version — a silent swap.
    if (row.templateId !== run.templateId || row.semver !== packageVersion) {
      return fail(
        `pinned snapshot binds to ${row.templateId}@${row.semver}, not the requested ` +
          `${run.templateId}@${packageVersion}`,
      );
    }
    // (4) STRUCTURE — a well-formed snapshot is a plain object (not a scalar /
    //     array / null). buildSnapshotFromTemplate always emits compiledPlan +
    //     taskSpec for every kind.
    const snap = row.snapshot;
    if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
      return fail("pinned snapshot payload is structurally unusable (not a structured object)");
    }
    const s = snap as { compiledPlan?: unknown; taskSpec?: string | null };
    // (5) EXECUTION-FIELD COMPLETENESS — a required pin FULLY replaces the
    //     execution plan, so an ABSENT or `undefined` compiledPlan cannot pin
    //     the run: the worker overlays a field only when it is `!== undefined`,
    //     so a snapshot with no compiledPlan would leave the LIVE plan in place —
    //     a fail-open. Refuse it. (A well-formed snapshot always carries a
    //     defined compiledPlan — possibly `[]` — so this is not over-strict.)
    if (s.compiledPlan === undefined) {
      return fail("pinned snapshot is missing compiledPlan (cannot replace the live execution plan)");
    }
    // Both execution fields are now DEFINED (compiledPlan verified above;
    // taskSpec normalized to null), so the worker's `!== undefined` overlay is a
    // FULL replacement for a required pin — never a partial overlay onto live.
    return { compiledPlan: s.compiledPlan, taskSpec: s.taskSpec ?? null };
  }

  // NON-REQUIRED with a resolved semver — best-effort load, live-template
  // fallback preserved exactly as the pre-S7 worker behaved.
  if (run.packageVersion != null) {
    const row = await deps.readAgentTemplateVersionBySemver(run.templateId, run.packageVersion);
    if (!row) return null; // live-template fallback (unchanged)
    const snap = row.snapshot;
    if (typeof snap !== "object" || snap === null) return null;
    const s = snap as { compiledPlan?: unknown; taskSpec?: string | null };
    return { compiledPlan: s.compiledPlan, taskSpec: s.taskSpec };
  }

  // `versionId`-only (inert pin) or neither → live template.
  return null;
}

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
import {
  buildA2UiMidRunTranslatorResolver,
  resolveRendererIdForKind,
} from "./field-renderer-bindings.server";
import { stepFiresRendererGate } from "./orchestrator-gate-predicate";
import { getOrAddWayflowRendererGateIndex, rememberWayflowGateTask, rememberLatestWayflowGateTask } from "@cinatra-ai/a2a";
// Host capability resolution for the HITL schema enricher: the enricher itself
// is provider-agnostic (agent-ui-protocol imports no provider package); THIS
// host-side caller injects the live `email-send` providers so sender-alias
// enums resolve registration-driven.
import { resolveEmailSendProviders } from "@/lib/email-send-providers";
import { issueAgentRunBinding } from "@/lib/agent-run-binding";
import { mintRunToken } from "@/lib/agent-run-token";
import { buildWayflowInitialMessagePayload } from "./wayflow-dispatch-payload";

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

// #824: does the active interrupt's parsed output carry the FULL context-selector
// signature? That exact shape (slotMeta.{slotId,resolutionMode} + candidates[] +
// selectedRefs[]) is emitted ONLY by the context-selection-agent's
// emit_context_payload node, so it unambiguously identifies a context gate at
// runtime — the "describe the actual gate that paused" signal. Renderer
// resolution for context gates is driven by this shape, NOT by the policy gate
// index (context steps carry no xRenderer, so an index-based mapping misroutes
// them to the next xRenderer-bearing step). Shape-only, no substring/package
// reliance. A hypothetical false match would merely render a selection UI.
function isContextSelectorInterruptPayload(
  parsed: Record<string, unknown>,
): boolean {
  const slotMeta = parsed["slotMeta"] as
    | { slotId?: unknown; resolutionMode?: unknown }
    | undefined;
  return (
    !!slotMeta &&
    typeof slotMeta === "object" &&
    typeof slotMeta.slotId === "string" &&
    typeof slotMeta.resolutionMode === "string" &&
    Array.isArray(parsed["candidates"]) &&
    Array.isArray(parsed["selectedRefs"])
  );
}

async function resolveWayflowXRenderer(
  runId: string,
  taskId: string,
  approvalPolicySteps: Array<{ stepNumber?: number; requiresApproval?: boolean; hitlOwnedBy?: string; xRenderer?: string; gateCount?: number; schema?: Record<string, unknown>; inputMessageSchema?: Record<string, unknown>; skipLlm?: boolean; firesRendererGate?: boolean }>,
): Promise<{ xRenderer: string; stepNumber: number | null; schema: Record<string, unknown> | null }> {
  const fallback = SCHEMA_FIELD_FALLBACK_RENDERER_ID;
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
  // #839: also exclude metadata-only PHANTOM gateSteps (a FlowNode review
  // gateStep whose subflow fires no non-context runtime pause — compiler-stamped
  // firesRendererGate:false). They carry an xRenderer for the stepper but never
  // produce a runtime interrupt, so counting them shifts the real reviewer gate
  // (blog-pipeline's idea_selection_gate) onto a phantom's null schema. Shared
  // predicate keeps this walk in lockstep with run-actions + instance-screens.
  const childSteps = approvalPolicySteps.filter(stepFiresRendererGate);
  if (childSteps.length === 0) return { xRenderer: fallback, stepNumber: null, schema: null };

  // #1625 / eng#548 — SINGLE-RENDERER-GATE SHORT-CIRCUIT (contract (1)).
  // When the flow has EXACTLY ONE xRenderer-bearing gate, resolution is
  // unambiguous: there is only one renderer any gate interrupt can possibly
  // resolve to, so we SHORT-CIRCUIT past the positional renderer-gate index
  // entirely. This is what makes a REPEAT visit of a re-entrant gate resolve to
  // the SAME renderer (the exact regression this contract exists for): a fresh
  // taskId per interrupt would otherwise append and grow the positional index
  // (getOrAddWayflowRendererGateIndex) past `childSteps.length`, exhausting the
  // walk below and falling to the schema-field fallback on the 2nd+ visit. The
  // short-circuit also closes two further holes for this agent class:
  //   • the 7-day renderer-gate-list TTL (GATE_SEQUENCE_TTL_S): a post-expiry
  //     repeat can no longer re-key to index 0 and mis-select, because the index
  //     is not consulted at all;
  //   • a Redis fault: the reverse-map write below is best-effort, so the sole
  //     renderer resolves even when Redis is unavailable (never `fallback`).
  // Soundness for MULTI-gate flows is preserved by the compile-time reachability
  // invariant (validate-oas-runtime-invariants.ts): a re-entrant gate MUST be the
  // sole renderer gate, so every re-entrant gate that reaches runtime lands here.
  if (childSteps.length === 1) {
    const step = childSteps[0]!;
    // Keep the task→run reverse-map current so the resume lookup still resolves
    // this interrupt's run — but a Redis fault must NOT block resolving the sole
    // renderer (the whole point of the short-circuit is Redis-independence).
    try {
      await rememberWayflowGateTask(runId, taskId);
    } catch {
      /* best-effort: the sole-gate resolution below is independent of Redis. */
    }
    return {
      xRenderer: typeof step.xRenderer === "string" ? step.xRenderer : fallback,
      stepNumber: typeof step.stepNumber === "number" ? step.stepNumber : null,
      schema: step.schema ?? step.inputMessageSchema ?? null,
    };
  }

  // Redis-backed index: survives hot-reloads and restarts unlike a module-level
  // Map that can reset between the BullMQ dispatch and server-action approval.
  // #824: index into the RENDERER-gate sequence (excludes context-selection
  // gates, which are resolved by payload shape and never consume a policy slot),
  // so this stays aligned with `childSteps` even when context gates interleave.
  const idx = await getOrAddWayflowRendererGateIndex(runId, taskId);

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
    // eng#548 #1625 (F1) — record THIS gate visit's a2a task id to the
    // authoritative Redis latest-task map BEFORE the interrupt is published.
    // This is the fresh-guaranteed submission identity the run-scoped
    // test-delivery send resolves at the passthrough seam. AWAITED and
    // correctness-critical (NOT best-effort, NOT inside the xRenderer catch
    // below): a Redis failure THROWS here and prevents the interrupt from being
    // published, so a send can never resolve a stale identity from the racy
    // `agent_runs.a2a_task_id` column (the defensive resync above persists that
    // column best-effort and may leave it stale under a "tuple concurrently
    // updated" race). Redis is already load-bearing for gate resume (the
    // reverse-map fallback), so this is no new hard dependency.
    await rememberLatestWayflowGateTask(runId, task.id);
    const adapter = new DualAdapterDispatch(
      new AgUiAdapter(runId, run.templateId, (event) => publishAgUiEvent(runId, event)),
      new A2UiAdapter(
        runId,
        run.templateId,
        (message) => publishA2UiEvent(runId, message),
        buildA2UiMidRunTranslatorResolver(),
      ),
    );
    const interruptPayload = ((task.metadata as { pendingApproval?: unknown } | undefined)?.pendingApproval ?? {}) as Record<string, unknown>;
    console.log(`[wayflow-interrupt] run=${runId} task=${task.id} interruptPayload=${(JSON.stringify(interruptPayload) ?? "null").slice(0, 500)} metadata=${(JSON.stringify(task.metadata) ?? "null").slice(0, 500)} history_last=${(JSON.stringify((task as { history?: unknown[] }).history?.slice(-1)) ?? "null").slice(0, 500)}`);
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
    // The preceding ApiNode's LLM output (history-derived), if any. Tracked
    // separately (#839) from `interruptOutput` so the enrichedValues merge below
    // can tell whether a parsed `spreadFromOutput` came from history (a real
    // envelope — preserved) or from the pendingApproval fallback (a gate's own
    // inputs — reserved keys stripped).
    const historyText: string | undefined = (() => {
      const history = (task as { history?: ReadonlyArray<{ role?: string; parts?: readonly unknown[] }> }).history;
      const lastAgent = history?.slice().reverse().find((m) => m?.role === "agent" || m?.role === "assistant");
      const text = (lastAgent?.parts as Array<{ kind?: string; text?: string }> | undefined)
        ?.filter((p) => p.kind === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
      return text && text.length > 0 ? text : undefined;
    })();
    const interruptOutput: string | undefined =
      // History first — it contains the preceding ApiNode's LLM output. Fall back
      // to pendingApproval when history is empty (e.g. FlowNode gates or
      // InputMessageNodes that carry their own approval payload rather than LLM output).
      historyText ??
      (Object.keys(interruptPayload).length > 0
        ? JSON.stringify(interruptPayload)
        : undefined);
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
    // Resolve the xRenderer + stepNumber. #824: a context-selection child gate
    // carries NO xRenderer in the compiled approvalPolicy (it is compiled
    // requiresApproval:false because interactive-vs-autonomous is a RUNTIME
    // decision), yet it fires a real HITL interrupt. An index-based mapping over
    // xRenderer-bearing policy steps therefore misroutes the context gate to the
    // next such step (e.g. reviewer-agent:output) — dumping the raw context
    // envelope — AND drifts every later gate. So:
    //   • Context gate (detected by the unambiguous payload SIGNATURE): resolve
    //     the context-selector renderer directly, and record the task→run map
    //     WITHOUT consuming a renderer-gate index slot — keeping the context
    //     gate transparent so later xRenderer-bearing gates stay aligned.
    //   • Otherwise: resolve via the approvalPolicy, indexed by the
    //     RENDERER-gate sequence (getOrAddWayflowRendererGateIndex, which
    //     excludes context gates).
    // Does not touch the registry, the renderer, or the /api/context-finalize
    // envelope contract.
    let wayflowXRenderer: string = SCHEMA_FIELD_FALLBACK_RENDERER_ID;
    let wayflowStepNumber: number | null = null;
    let wayflowSchema: Record<string, unknown> | null = null;
    // #1625 / eng#548 (contract (1)) — SAFE CATCH: the sole renderer gate (when
    // the flow has exactly one xRenderer-bearing gate) is the unambiguous
    // resolution under ANY resolver fault. Computed up-front from the template so
    // the catch below never falls to the schema-field fallback for a
    // single-renderer-gate agent — the "never fallback for a sole-renderer gate"
    // guarantee holds even when the positional resolve throws (e.g. Redis fault).
    let soleRendererGate: { xRenderer: string; stepNumber: number | null; schema: Record<string, unknown> | null } | null = null;
    try {
      if (isContextSelectorInterruptPayload(spreadFromOutput)) {
        wayflowXRenderer =
          resolveRendererIdForKind("context-selector") ?? SCHEMA_FIELD_FALLBACK_RENDERER_ID;
        await rememberWayflowGateTask(runId, task.id);
      } else {
        const tmpl = await readAgentTemplateById(run.templateId);
        const policySteps = (tmpl?.approvalPolicy?.steps ?? []) as Array<{
          stepNumber?: number; requiresApproval?: boolean; hitlOwnedBy?: string; xRenderer?: string; gateCount?: number; schema?: Record<string, unknown>; inputMessageSchema?: Record<string, unknown>; firesRendererGate?: boolean;
        }>;
        const rendererGateSteps = policySteps.filter(stepFiresRendererGate);
        if (rendererGateSteps.length === 1) {
          const s = rendererGateSteps[0]!;
          soleRendererGate = {
            xRenderer: typeof s.xRenderer === "string" ? s.xRenderer : SCHEMA_FIELD_FALLBACK_RENDERER_ID,
            stepNumber: typeof s.stepNumber === "number" ? s.stepNumber : null,
            schema: s.schema ?? s.inputMessageSchema ?? null,
          };
        }
        ({ xRenderer: wayflowXRenderer, stepNumber: wayflowStepNumber, schema: wayflowSchema } =
          await resolveWayflowXRenderer(runId, task.id, policySteps));
      }
    } catch {
      // non-fatal. For a single-renderer-gate agent, resolve to that one gate
      // (never the schema-field fallback) — contract (1). Multi-gate / context
      // flows keep the acceptable schema-field fallback.
      if (soleRendererGate) {
        wayflowXRenderer = soleRendererGate.xRenderer;
        wayflowStepNumber = soleRendererGate.stepNumber;
        wayflowSchema = soleRendererGate.schema;
      }
    }
    // #839: Surface an InputMessageNode gate's declared DFE inputs — which the
    // WayFlow runtime propagates through task.metadata.pendingApproval
    // (interruptPayload) — to the renderer. blog-pipeline's idea_selection_gate
    // needs its `ideas[]` render input present to show an idea chooser (see
    // reviewer-agent-output-renderer.tsx). Merged BELOW spreadFromOutput and the
    // explicit stepNumber/output so history-derived output still WINS: data-review
    // gates that parse `output` are unaffected.
    //
    // Reserved host-synthesized envelope keys (set by the reviewer-output
    // envelope synthesis below) must never be SOURCED from a gate's
    // pendingApproval — else a gate input could disable synthesis or shadow a
    // real content bundle. Strip them from ALL pendingApproval-derived values:
    // the explicit gate-input merge AND the `spreadFromOutput` fallback that
    // re-parses pendingApproval when history is empty. A `spreadFromOutput`
    // derived from HISTORY (a subflow that really emits {contentType,...}) is
    // preserved (`historyText !== undefined`).
    const RESERVED_ENRICHED_KEYS = new Set([
      "contentType",
      "contentBundle",
      "summary",
      "output",
      "stepNumber",
    ]);
    const stripReserved = (o: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(o).filter(([k]) => !RESERVED_ENRICHED_KEYS.has(k)),
      );
    const gateInputValues = stripReserved(interruptPayload);
    const spreadSafe =
      historyText === undefined ? stripReserved(spreadFromOutput) : spreadFromOutput;
    const enrichedValues: Record<string, unknown> = {
      ...(run.inputParams ?? {}),
      ...gateInputValues,
      ...spreadSafe,
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
    // The reviewer output-gate ID is resolved by KIND from the manifest
    // bindings (the reviewer agent's `cinatra.fieldRenderers` declaration) —
    // undefined when no present/installed package binds "reviewer-output",
    // in which case the gate class is absent and synthesis correctly no-ops
    // (the renderer falls back to the schema-field path, as before).
    if (
      wayflowXRenderer === resolveRendererIdForKind("reviewer-output") &&
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

  // Declarative artifact materialization (cinatra#923) — runs BEFORE the
  // one terminal transition so the per-output {artifactId,
  // representationRevisionId} refs (or per-output failures) splice into the
  // SAME stepResults payload: no second transition, no second write path.
  // `materializeRunArtifacts` never throws by contract (every failure is a
  // visible per-output outcome); the catch below is defense-in-depth. A
  // materialization problem must NEVER flip a completed run to failed nor
  // block the terminal transition. Dynamic import keeps the host artifact
  // stack out of this module's static graph (same posture as the
  // nango-system import below).
  let artifactMaterializations: Array<Record<string, unknown>> = [];
  try {
    const { materializeRunArtifacts } = await import(
      "@/lib/artifacts/run-artifact-materializer"
    );
    artifactMaterializations = (await materializeRunArtifacts({
      runId,
      orgId: run.orgId,
      templateId: run.templateId,
      packageVersion: run.packageVersion,
      createdBy: run.runBy,
      endNodeOutputs,
    })) as unknown as Array<Record<string, unknown>>;
    for (const outcome of artifactMaterializations) {
      if (outcome.ok !== true) {
        console.warn(
          `[artifact-materializer] run=${runId} output=${String(outcome.outputId)} extension=${String(outcome.extension ?? "?")} failed: ${String(outcome.error)}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[artifact-materializer] run=${runId} materialization pass failed (recorded in stepResults; run still completes):`,
      err instanceof Error ? err.message : err,
    );
    artifactMaterializations = [
      {
        ok: false,
        outputId: "(materializer)",
        nodeId: null,
        extension: null,
        error: `materialization pass failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
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
        // Declarative artifact-materialization outcomes (cinatra#923): one
        // entry per declared binding — success refs or a visible failure.
        // Key absent when the run's package declares no bindings.
        ...(artifactMaterializations.length > 0
          ? { artifact_materializations: artifactMaterializations }
          : {}),
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
 *
 * cinatra#1058 — per-kind optional behavior. Each agent_dependencies entry now
 * carries a `requirement` (bare-string value ⇒ "required"; the legacy shape).
 *   - A missing REQUIRED sub-agent hard-fails the run (unchanged actionable copy).
 *   - A missing OPTIONAL sub-agent routes to STOP-RUN-HITL: the readiness gate
 *     throws {@link OrchestratorOptionalDepsUnavailableError}, which the worker
 *     catch converts to a `pending_input` pause (surfaced to a human) rather
 *     than a `failed` run. Required always wins when both are missing.
 */
export class OrchestratorOptionalDepsUnavailableError extends Error {
  override readonly name = "OrchestratorOptionalDepsUnavailableError";
  readonly code = "ORCHESTRATOR_OPTIONAL_DEPS_UNAVAILABLE" as const;
  readonly missingOptional: string[];

  constructor(missingOptional: string[]) {
    super(
      `Run paused for input — optional sub-agent(s) not installed: ${missingOptional.join(", ")}. ` +
        `Install ${missingOptional[0]}` +
        (missingOptional.length > 1 ? " (and others)" : "") +
        ` and resume the run to include their step(s).`,
    );
    this.missingOptional = missingOptional;
  }
}

export async function assertOrchestratorReady(
  template: AgentTemplateRecord,
): Promise<void> {
  // Accept both "orchestrator" and OAS-aligned "flow".
  if (template.type !== "orchestrator" && template.type !== "flow") return;
  const deps = template.agentDependencies ?? {};
  const depNames = Object.keys(deps);
  if (depNames.length === 0) return;

  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  for (const pkgName of depNames) {
    // Normalize the union value: a bare string is a legacy/required range; an
    // object carries the projected edge's requirement (cinatra#1058).
    const raw = deps[pkgName];
    const requirement: "required" | "optional" =
      typeof raw === "string" ? "required" : raw.requirement;
    const requiredRange = typeof raw === "string" ? raw : raw.range;
    const found = await readAgentTemplates({
      packageName: pkgName,
      status: "published",
      limit: 1,
    });
    if (found.items.length === 0) {
      (requirement === "optional" ? missingOptional : missingRequired).push(pkgName);
    } else {
      // Warn when the installed version doesn't satisfy the declared semver range.
      // Not a hard block — preserves existing flows; a future phase can promote this.
      const installedVersion = found.items[0]?.packageVersion;
      if (installedVersion && requiredRange && !semver.satisfies(installedVersion, requiredRange)) {
        console.warn(
          `[agent-builder] Orchestrator sub-agent ${pkgName}@${installedVersion} does not satisfy required range ${requiredRange}`,
        );
      }
    }
  }

  // Required missing ⇒ hard fail (wins over any optional-missing). Unchanged copy.
  if (missingRequired.length > 0) {
    throw new Error(
      `Orchestrator cannot run — missing installed sub-agents: ${missingRequired.join(", ")}. ` +
        `Run \`cinatra agents install ${missingRequired[0]}\`` +
        (missingRequired.length > 1 ? " (and others)" : "") +
        " first.",
    );
  }
  // Only optional deps missing ⇒ stop-run-hitl (pause, don't fail).
  if (missingOptional.length > 0) {
    throw new OrchestratorOptionalDepsUnavailableError(missingOptional);
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
  // Per-run skill-usage ledger (agent_run_skills_used) — snapshot the resolved
  // skill set at run start. This is THE run-start write path for the ledger:
  // the writer (snapshotSkillsAtRunStart) previously had zero production call
  // sites, so the ledger never populated and the run's Skills tab was always
  // empty (#848).
  //
  // Resolve the skill set exactly as the llm-bridge does at each LLM step —
  // `getAssignedSkillIdsForAgent(packageName)` with NO actor — so the ledger
  // reflects the same matched catalog skills the run's LLM steps actually
  // receive (custom/personal assignments are actor-scoped and are not delivered
  // to sessionless bridge callers, so they are intentionally excluded here).
  // These are installed catalog skills, hence skillKind "installed".
  //
  // This is the single per-run seam: every producer (LangGraph/MCP `agent_run`,
  // WayFlow/A2A) enqueues AGENT_BUILDER_EXECUTION, which this worker consumes
  // exactly once per dispatch. The write is idempotent (ON CONFLICT DO NOTHING)
  // so re-entry on resume is safe, and best-effort — a ledger write must never
  // fail a run.
  if (template.packageName) {
    try {
      const resolvedSkillIds = await getAssignedSkillIdsForAgent(template.packageName);
      await snapshotSkillsAtRunStart({
        runId,
        skills: resolvedSkillIds.map((skillId) => ({
          skillId,
          skillKind: "installed" as const,
        })),
      });
    } catch (err) {
      console.warn(
        `[agent-builder] skill-usage ledger snapshot failed for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Version pinning (cinatra#1040 S5 request-time, S7 fail-closed execution).
  // resolvePinnedRunSnapshot maps the run's (versionId, packageVersion) to the
  // immutable snapshot it must be executed against and applies it on top of the
  // live template before any dispatch, so a later `agent_registry_publish`
  // cannot retarget an in-flight task ("published version cannot change
  // in-flight").
  //   - REQUIRED pin (versionId AND packageVersion set — an A2A explicit
  //     requestedVersion): the snapshot is loaded by id, binding+structure
  //     verified, and the run FAILS CLOSED (never serves the live template) if
  //     it cannot be served — closing the request-time refuse-with-evidence
  //     contract end-to-end.
  //   - default resolution / legacy (packageVersion only): best-effort semver
  //     load with the pre-existing live-template fallback.
  //   - versionId-only (inert pin) or neither: live template (unchanged).
  // ---------------------------------------------------------------------------
  let pinnedSnapshot: PinnedRunSnapshotFields | null = null;
  try {
    pinnedSnapshot = await resolvePinnedRunSnapshot(
      {
        templateId: run.templateId,
        packageVersion: run.packageVersion,
        versionId: run.versionId,
      },
      { readAgentTemplateVersionById, readAgentTemplateVersionBySemver },
    );
  } catch (err) {
    if (err instanceof PinnedRunSnapshotUnreachableError) {
      // FAIL CLOSED (cinatra#1040 S7): a REQUIRED explicit version pin whose
      // immutable snapshot cannot be served must NEVER silently fall back to the
      // live template. Refuse the run with the full evidence set.
      await transitionRunStatus(runId, "queued", "failed", { error: err.message });
      return;
    }
    throw err;
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
    if (err instanceof OrchestratorOptionalDepsUnavailableError) {
      // stop-run-hitl (cinatra#1058): only OPTIONAL sub-agents are missing — pause
      // the run for human input instead of failing it. The message surfaces which
      // optional sub-agents are missing; a human installs them and resumes via the
      // existing pending_input → queued path (which re-runs this gate, now green).
      //
      // This is the ONE `pending_input` reason that is a GENUINE human wait, so
      // it is flagged `humanWaitGate: true` — the run-wait notifier (cinatra
      // #1559 / E9) mints a durable actionable notification for it. Every other
      // `pending_input` reason leaves the flag unset and does NOT notify.
      await transitionRunStatus(runId, "queued", "pending_input", {
        error: err.message,
        humanWaitGate: true,
      });
      return;
    }
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
  // fields. (GROUPED_SETUP_FORM_RENDERER_ID is imported from ./agent-builder-ids
  // — the single id authority — rather than re-declared locally.)

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
        ?? SCHEMA_FIELD_FALLBACK_RENDERER_ID;

    await transitionRunStatus(runId, "queued", "pending_approval");

    // No DB writes — use synthetic ID so approveReviewTaskInternal
    // routes to the "setup-" branch, which re-enqueues AGENT_BUILDER_EXECUTION.
    const syntheticId = `setup-${runId}`;

    const adapter = new DualAdapterDispatch(
      new AgUiAdapter(runId, run.templateId, (event) =>
        publishAgUiEvent(runId, event),
      ),
      new A2UiAdapter(
        runId,
        run.templateId,
        (message) => publishA2UiEvent(runId, message),
        buildA2UiMidRunTranslatorResolver(),
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
      new A2UiAdapter(
        runId,
        run.templateId,
        (message) => publishA2UiEvent(runId, message),
        buildA2UiMidRunTranslatorResolver(),
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
  // operates on an already-created run row (queued by a run-actions.ts producer
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

    const { getNangoConnection } = await import("@/lib/nango-system");
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
      await transitionRunStatus(runId, "queued", "running", {
        dispatch: { attemptId: randomUUID() },
      });
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
      await transitionRunStatus(runId, "queued", "running", {
        dispatch: { attemptId: randomUUID() },
      });
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
      //
      // Also mint a DISPATCHER-SIGNED run binding
      // (`cinatra_run_binding`) over the run's authoritative
      // {runId, orgId, runBy}, keyed by BETTER_AUTH_SECRET (a key OAS never
      // sees). The LLM bridge REFUSES to mint an MCP OBO token from
      // `cinatra_run_id` alone (forgeable via DataFlowEdge); it requires
      // this binding (or an auth-injected context-id). Only emitted when the
      // run carries both org + owner identity; otherwise the bridge degrades
      // to the anonymous machine-token path (never an elevation).
      const runBinding =
        run.orgId && run.runBy
          ? issueAgentRunBinding({
              runId: run.id,
              orgId: run.orgId,
              runBy: run.runBy,
            })
          : undefined;
      // #1193 run-token spine: mint a random per-run credential and persist
      // ONLY its hash BEFORE the blocking sendTask (the same race-free ordering
      // the context-id pre-bind below uses), then carry the RAW token in the
      // initial message under a reserved key. A later wave teaches the loader to
      // pop the key before schema-filtering and attach the token to first-party
      // callbacks (host-anchored to CINATRA_BASE_URL); until then the
      // container's _filter_inputs_to_flow_schema drops the undeclared key, so
      // it never reaches WayFlow. The builder spreads author inputs FIRST, then
      // overwrites the dispatch-owned identity keys, so inputs can neither
      // smuggle nor override them.
      const runToken = mintRunToken();
      await setAgentRunTokenHash(runId, runToken.tokenHash);
      const initialMessagePayload = buildWayflowInitialMessagePayload({
        inputParams: run.inputParams,
        runId: run.id,
        runBinding,
        runToken: runToken.token,
      });
      // #813: bind a fasta2a contextId to the run BEFORE the blocking sendTask.
      // WayFlow's flow calls back POST /api/context-resolve DURING sendTask with
      // this contextId (x-cinatra-a2a-context-id); readAgentRunByContextId must
      // already find the run or it 403s "context_unresolved" and the whole flow
      // fails. Previously no contextId was passed, so WayFlow minted its own and
      // it was only synced onto the run AFTER sendTask returned (the resync at
      // handleWayflowTaskState) — too late for the in-flow callback. Generate +
      // persist it here and pass it in, mirroring the resume path
      // (orchestrator-actions.ts: `contextId: run.a2aContextId`).
      const dispatchContextId = run.a2aContextId ?? randomUUID();
      if (dispatchContextId !== run.a2aContextId) {
        await updateAgentRunA2AContextId(runId, dispatchContextId);
      }
      const task = await client.sendTask({
        message: {
          role: "user",
          kind: "message",
          messageId: randomUUID(),
          contextId: dispatchContextId,
          parts: [{ kind: "text", text: JSON.stringify(initialMessagePayload) }],
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
      // #562: a bare `TypeError: fetch failed` from the sendTask transport
      // (WayFlow runtime unreachable) was being recorded verbatim — no target
      // URL, no cause — leaving the run undebuggable (started_at null, no
      // steps, no server log). Log the structured failure server-side (target
      // URL + cause chain) and record an actionable message on the run.
      console.error(
        `[wayflow] dispatch failed for run ${runId} targeting ${wayflowUrl}:`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
        err instanceof Error && (err as { cause?: unknown }).cause
          ? { cause: (err as { cause?: unknown }).cause }
          : "",
      );
      const runError = describeWayflowDispatchError(err, wayflowUrl);
      // Terminal-consistency for the durable AG-UI log (cinatra#809):
      // RUN_STARTED was already published before sendTask, so a dispatch
      // failure must also publish RUN_ERROR — otherwise the log ends on
      // RUN_STARTED and every later page load replays the run into a phantom
      // "running" state. Mirrors the handleWayflowTaskState failed branch
      // (publish first, then transition). Best-effort like every publish —
      // a Redis outage must not block the failed transition.
      await Promise.resolve(
        publishAgUiEvent(runId, {
          type: "RUN_ERROR",
          threadId: runId,
          runId,
          message: runError,
          timestamp: Date.now(),
        } as never),
      ).catch(() => undefined);
      await transitionRunStatus(runId, "running", "failed", {
        error: runError,
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
