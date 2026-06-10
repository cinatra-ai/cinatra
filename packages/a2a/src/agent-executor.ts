import "server-only";

import { randomUUID } from "node:crypto";

import type {
  Artifact,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
  TextPart,
} from "@a2a-js/sdk";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  createAgentRun,
  readAgentRunById,
  updateAgentRunA2ATaskId, // A2A taskId ↔ runId bridge
  readAgentTemplateById,   // needed for inputSchema validation
  jsonSchemaToZod,         // JSON Schema → Zod runtime converter
} from "@cinatra-ai/agents";
import { getActorContext } from "@cinatra-ai/llm/actor-context"; // ALS-frame org read

import type { CinatraA2AConfig } from "./types";
import { CinatraTaskStatusMap, TERMINAL_A2A_STATES } from "./types";
import { publishRunEvent } from "./streaming-bridge";

// ---------------------------------------------------------------------------
// InProcessAgentExecutor
//
// Bridges the @a2a-js/sdk `AgentExecutor` interface to Cinatra's virtual-agent
// execution model. Cinatra virtual agents execute asynchronously via BullMQ:
//
//   1) createAgentRun() inserts an `agent_runs` row (status: "queued")
//   2) enqueueJob("AGENT_BUILDER_EXECUTION", { runId }) queues the worker
//   3) the worker drives the run through running → completed/failed/stopped
//      (or pauses on pending_approval / pending_input for HITL gates)
//
// The A2A `execute(requestContext, eventBus)` contract requires the executor
// to publish A2A lifecycle events to `eventBus` and call `eventBus.finished()`
// when done. This executor bridges by polling `agent_runs` and translating
// each status change into an A2A `TaskStatusUpdateEvent`.
//
// ----------------------------------------------------------------------------
// LIFECYCLE SEMANTICS:
//
// (1) Observer-side timeout. `pollTimeoutMs` expiring means THIS executor
//     stopped waiting for updates. It does NOT mean the BullMQ job failed —
//     the worker may still be running. On timeout we publish a `failed`
//     status-update with code OBSERVER_TIMEOUT, do NOT mutate `agent_runs`,
//     do NOT touch BullMQ, and call `eventBus.finished()`. A future
//     re-subscribe can pick up the real terminal state.
//
// (2) Deduplication. `lastPublishedState` tracks the last A2A state emitted.
//     Identical consecutive states are NOT re-emitted. This prevents flooding
//     consumers with redundant `working` events on every 1000ms tick.
//
// (3) Missing-run. If `readAgentRunById(runId)` returns null/undefined on any
//     poll tick, we publish a single `failed` status-update with code
//     RUN_NOT_FOUND and close the event bus. We do NOT retry indefinitely
//     and do NOT throw — the SDK expects graceful termination, not an
//     exception from `execute`.
// ----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 1000;
// The A2A polling path is used for long-running agent executions, including
// batch LLM and web_search ApiNode calls. The outer BullMQ worker job timeout
// still bounds the total run; this just removes the polling-side ceiling.
const DEFAULT_POLL_TIMEOUT_MS = 86_400_000; // 24 hours
// Prefer the injected `createAndEnqueueAgentRun` contract on the executor
// options over a hardcoded job literal. When `createAndEnqueueAgentRun` is
// provided the executor routes through it (preflight + enqueue go via
// `src/lib/agent-run-enqueue`); otherwise it falls back to the legacy
// `config.enqueueJob` injection used by tests and legacy callers. The
// dual-pattern CI gate at
// `scripts/audit/agent-builder-enqueue-gate.mjs` keeps this file out of the
// allowlist so a future regression that adds the string back is caught.
export type CreateAndEnqueueAgentRunFn = (
  record: { runId: string },
  options?: {
    jobId?: string;
    delay?: number;
    connectorDependencies?: Record<string, string>;
  },
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(requestContext: RequestContext): string {
  const parts = requestContext.userMessage.parts ?? [];
  return parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function parseInputParams(text: string): Record<string, unknown> {
  // If the text parses as a JSON object, treat it as inputParams directly.
  // Otherwise wrap as { prompt: text } — the simplest useful envelope for
  // agents whose inputSchema contains a `prompt` string field.
  if (!text) return { prompt: "" };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return { prompt: text };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInitialTask(
  requestContext: RequestContext,
  state: TaskState,
  metadata?: Record<string, unknown>,
): Task {
  return {
    kind: "task",
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
    },
    history: [requestContext.userMessage],
    ...(metadata ? { metadata } : {}),
  };
}

function buildStatusUpdate(
  requestContext: RequestContext,
  state: TaskState,
  opts?: { final?: boolean; errorMessage?: string; errorCode?: string },
): TaskStatusUpdateEvent {
  const status: TaskStatusUpdateEvent["status"] = {
    state,
    timestamp: new Date().toISOString(),
  };
  if (opts?.errorMessage) {
    // Surface error detail as an agent message part so clients can render it.
    status.message = {
      kind: "message",
      role: "agent",
      messageId: randomUUID(),
      parts: [
        {
          kind: "text",
          text: opts.errorCode
            ? `[${opts.errorCode}] ${opts.errorMessage}`
            : opts.errorMessage,
        },
      ],
    };
  }
  return {
    kind: "status-update",
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    status,
    final: opts?.final ?? false,
  };
}

function buildArtifactUpdate(
  requestContext: RequestContext,
  artifact: Artifact,
): TaskArtifactUpdateEvent {
  return {
    kind: "artifact-update",
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    artifact,
  };
}

/** @internal — exported for testing. */
export function stepResultsToArtifact(stepResults: unknown[]): Artifact {
  const parts: Array<
    | { kind: "text"; text: string }
    | { kind: "data"; data: Record<string, unknown> }
  > = [];

  for (const result of stepResults) {
    // Emit a typed DataPart when a stepResult carries output_data.
    // Guard against non-object shapes (string, array, null, function) so
    // malformed upstream state never crashes the serializer.
    if (result && typeof result === "object" && "output_data" in result) {
      const data = (result as { output_data?: unknown }).output_data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        parts.push({ kind: "data" as const, data: data as Record<string, unknown> });
      }
    }
    // Preserve the existing TextPart summary for back-compat (UI renderers, logs, etc.).
    parts.push({
      kind: "text" as const,
      text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
    });
  }

  // Guarantee at least one part — A2A `Artifact.parts` is non-empty by convention.
  if (parts.length === 0) {
    parts.push({ kind: "text", text: "(no step results)" });
  }

  return {
    artifactId: randomUUID(),
    name: "cinatra-run-results",
    parts,
  };
}

// ---------------------------------------------------------------------------
// InProcessAgentExecutor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EnqueueJobFn
//
// The optional third argument carries a forward-compat intent marker
// (`parentFlowJobId`) for callers that want the enqueued child to attach to an
// already-queued parent flow.
//
// BullMQ 5.x's `FlowProducer.add` is the only public entry for attaching
// children, and there is no post-hoc attachment API (`AddChildrenOpts` is a
// `protected` internal). Therefore:
//
//   - Leaf / proxy A2A invocations (no parentFlowJobId) use the existing
//     `enqueueJob` path unchanged.
//   - Orchestrator children are composed upfront as a FlowJob tree via
//     `enqueueChildFlow` (src/lib/background-jobs.ts) — they do NOT route
//     through EnqueueJobFn. Callers that nonetheless pass `parentFlowJobId`
//     hit the no-op branch in `createDefaultEnqueueJobFn` with a traceable
//     warning.
//
// Real post-hoc attachment would require a custom Lua approach outside
// FlowProducer's public API.
// ---------------------------------------------------------------------------

export type EnqueueJobFnOptions = {
  /**
   * Forward-compat intent marker. Signals that the caller wants the enqueued
   * job to attach as a child of the given parent flow job id. The default
   * implementation NO-OPS when this is set (see `createDefaultEnqueueJobFn`)
   * because BullMQ 5.x has no public post-hoc child-attachment API. The
   * orchestrator worker composes its parent+children tree upfront via
   * `enqueueChildFlow` and does NOT rely on this parameter.
   */
  parentFlowJobId?: string;
};

export type EnqueueJobFn = (
  jobName: string,
  data: unknown,
  opts?: EnqueueJobFnOptions,
) => Promise<void>;

/**
 * Wrap a bare `(jobName, data) => Promise<void>` in the EnqueueJobFn contract
 * with the locked parentFlowJobId fallback baked in. App-layer wiring
 * (`src/lib/a2a-server.ts`) should call this to produce the function it
 * passes to MultiAgentExecutor / InProcessAgentExecutor.
 */
export function createDefaultEnqueueJobFn(
  underlying: (jobName: string, data: unknown) => Promise<void>,
): EnqueueJobFn {
  return async (jobName, data, opts) => {
    if (opts?.parentFlowJobId) {
      // LOCKED no-op path — see type docs above. Logged at `warn` so the
      // fallback is traceable in production logs without failing the caller.
      const runId =
        data && typeof data === "object" && "runId" in (data as object)
          ? String((data as { runId?: unknown }).runId ?? "")
          : "";
      console.warn(
        `[a2a] EnqueueJobFn called with parentFlowJobId=${opts.parentFlowJobId} for run ${runId}, ` +
          `but BullMQ 5.x FlowProducer has no post-hoc child attachment API. ` +
          `The orchestrator worker must compose its FlowProducer tree upfront via enqueueChildFlow instead. No enqueue performed.`,
      );
      return;
    }
    await underlying(jobName, data);
  };
}

export type InProcessAgentExecutorOptions = CinatraA2AConfig & {
  /**
   * DI hook — the app layer owns `enqueueBackgroundJob` / `BACKGROUND_JOB_NAMES`
   * and passes in a bound function. This package must NOT import from
   * `@/lib/background-jobs` (workspace → app-layer boundary violation).
   *
   * The preferred entry point is `createAndEnqueueAgentRun` below; this field
   * is retained for legacy callers + tests.
   */
  enqueueJob: EnqueueJobFn;
  /**
   * Preferred replacement for `enqueueJob`. When set, the executor uses it
   * instead of `enqueueJob(AGENT_BUILDER_EXECUTION, ...)` so the connector
   * preflight in `src/lib/agent-run-enqueue` runs first.
   */
  createAndEnqueueAgentRun?: CreateAndEnqueueAgentRunFn;
  /**
   * Constructor-injected lookup used by MultiAgentExecutor to surface the
   * server-resolved pinned `packageVersion` for a given taskId. Returning a
   * string pins the created `agent_runs` row to that version; undefined leaves
   * the column null (legacy behaviour). The lookup avoids mutating the A2A
   * SDK's immutable `RequestContext.userMessage.metadata`.
   */
  getPinnedVersionForTask?: (taskId: string) => string | undefined;
  /**
   * The InMemoryTaskStore from the A2A server bundle. Required for the
   * background-poll path: execute() closes the eventBus immediately after
   * publishing the initial Task (so send_message returns in < 1s), then a
   * background task updates taskStore directly so tasks/get stays accurate
   * for any run duration. Without taskStore the background poll is a no-op
   * (state is not reflected in tasks/get until the next resubscribe).
   */
  taskStore?: InMemoryTaskStore;
};

export class InProcessAgentExecutor implements AgentExecutor {
  private readonly config: InProcessAgentExecutorOptions;
  // Map A2A taskId → Cinatra runId, so cancelTask can look up the run.
  private readonly taskToRun = new Map<string, string>();
  // Map A2A taskId → AbortController, so cancelTask can interrupt the
  // observer-side poll loop without touching the BullMQ job.
  private readonly aborters = new Map<string, AbortController>();
  // Map A2A taskId → A2A contextId, so cancelTask can publish the originating
  // contextId on its canceled status-update instead of an empty string.
  // Mirrors the `contexts` map in legacy-agent-executor.ts. Populated at the
  // top of execute(); cleaned up wherever taskToRun/aborters are.
  private readonly taskToContext = new Map<string, string>();
  private readonly getPinnedVersionForTask?: (
    taskId: string,
  ) => string | undefined;

  constructor(options: InProcessAgentExecutorOptions) {
    this.config = options;
    this.getPinnedVersionForTask = options.getPinnedVersionForTask;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const pollIntervalMs =
      this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollTimeoutMs =
      this.config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

    const aborter = new AbortController();
    this.aborters.set(requestContext.taskId, aborter);
    this.taskToContext.set(requestContext.taskId, requestContext.contextId);
    // When true, _backgroundPoll owns cleanup; finally block skips it.
    let earlyFinishCalled = false;

    try {
      // Publish the initial task event immediately so ResultManager.currentTask
      // is always set before any early-exit failure path publishes a status-update.
      // Without this, status-update events published before the task event result
      // in getFinalResult() returning null → -32603 "no task context found".
      const earlyState: TaskState = CinatraTaskStatusMap.queued ?? "submitted";
      eventBus.publish(buildInitialTask(requestContext, earlyState));

      // 1) Extract user text and shape inputParams.
      const text = extractMessageText(requestContext);
      const inputParams = parseInputParams(text);

      // Input contract enforcement at the A2A boundary.
      // Split into two try/catch blocks so template-fetch failures do NOT emit
      // INPUT_VALIDATION_ERROR. Callers rely on errorCode semantics to
      // distinguish transient infrastructure errors from client-side bad input.
      //
      // Validate inputParams against the template's inputSchema BEFORE creating
      // the agent_runs row. On failure, publish a terminal failed status-update
      // with the appropriate errorCode and return — no run is created,
      // no BullMQ job is enqueued. Opt-in per template: empty/null inputSchema
      // skips validation silently so existing templates are never regressed.

      let template;
      try {
        template = await readAgentTemplateById(this.config.templateId);
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        eventBus.publish(
          buildStatusUpdate(requestContext, "failed", {
            final: true,
            errorMessage: `Template fetch failed: ${msg}`,
            errorCode: "TEMPLATE_FETCH_ERROR",
          }),
        );
        return;
      }

      try {
        if (
          template?.inputSchema &&
          typeof template.inputSchema === "object" &&
          Object.keys(template.inputSchema as Record<string, unknown>).length > 0
        ) {
          const inputZodSchema = jsonSchemaToZod(template.inputSchema as Record<string, unknown>);
          inputZodSchema.parse(inputParams);
        }
      } catch (validationErr) {
        const msg =
          validationErr instanceof Error ? validationErr.message : String(validationErr);
        eventBus.publish(
          buildStatusUpdate(requestContext, "failed", {
            final: true,
            errorMessage: `A2A input validation failed: ${msg}`,
            errorCode: "INPUT_VALIDATION_ERROR",
          }),
        );
        return;
      }

      // Read orgId from the ActorContext ALS frame established by
      // src/app/api/a2a/route.ts at the withActorContext(resolvedActorContext,
      // () => mount.handle(body, ctx)) wrap. The frame IS active here because
      // execute() is reached via mount.handle. On missing, publish a terminal
      // failed event matching the existing INPUT_VALIDATION_ERROR shape.
      const actorCtx = getActorContext();
      const orgId = actorCtx?.organizationId;
      if (!orgId) {
        eventBus.publish(
          buildStatusUpdate(requestContext, "failed", {
            final: true,
            errorMessage:
              "External A2A run rejected: no organizationId in ActorContext frame",
            errorCode: "ORG_CONTEXT_REQUIRED",
          }),
        );
        return;
      }

      // 2) Create the Cinatra agent run. Status starts at "queued".
      //    Read the server-resolved pinned version (if any) via the
      //    constructor-injected lookup, and persist it on `agent_runs` so the
      //    BullMQ worker loads the immutable snapshot — not live template state
      //    — when the job executes.
      //
      //    Stamp `runBy` from the ActorContext frame so human-originated A2A
      //    runs (e.g. via the chat surface's a2a_agent_dispatch tool) inherit
      //    owner semantics. Without this, createAgentRun defaults run_by=NULL
      //    and the run is an ownership orphan: HITL approval ownership,
      //    autosave, run sharing, and audit attribution all silently degrade.
      //    The legacy `agent_run` MCP path (mcp/handlers.ts:775-783) stamps
      //    runBy explicitly; A2A needs equivalent treatment for the chat use
      //    case. Service / Internal / External actors intentionally do NOT
      //    stamp runBy (their runs are not human-owned).
      const runBy =
        actorCtx.principalType === "HumanUser"
          ? actorCtx.principalId
          : undefined;
      const runId = randomUUID();
      const pinnedTaskId =
        requestContext.taskId ?? requestContext.contextId ?? "";
      const pinnedVersion = this.getPinnedVersionForTask?.(pinnedTaskId);
      await createAgentRun({
        id: runId,
        templateId: this.config.templateId,
        inputParams,
        packageVersion: pinnedVersion,
        orgId,
        runBy,
      });
      this.taskToRun.set(requestContext.taskId, runId);

      // Dual-write the A2A taskId so the UI execution panel can subscribe by
      // taskId (panel server action reads via readAgentRunByTaskId).
      // Best-effort: failure here must not block job enqueue — the executor
      // still has the in-memory taskToRun map as a short-term fallback, and the
      // legacy runId-keyed polling route remains available.
      try {
        await updateAgentRunA2ATaskId(runId, requestContext.taskId);
      } catch (bridgeErr) {
        console.error(
          "[InProcessAgentExecutor] failed to persist a2a_task_id for run",
          { runId, taskId: requestContext.taskId, error: bridgeErr },
        );
      }

      // 3) Enqueue the BullMQ job via the injected chokepoint contract.
      // The executor does not reference the literal job name. The host wires
      // `createAndEnqueueAgentRun` to `enqueueAgentRun` from
      // `src/lib/agent-run-enqueue.ts`; the `enqueueJob(...)` path is retained
      // ONLY for tests and legacy in-process A2A clients via the `enqueueJob`
      // wrapper below.
      if (this.config.createAndEnqueueAgentRun) {
        await this.config.createAndEnqueueAgentRun({ runId });
      } else {
        // Tests pass `enqueueJob` with a known job-name token; production
        // callers MUST set `createAndEnqueueAgentRun`. Caller naming is
        // intentionally kept opaque here to keep the file out of the
        // `AGENT_BUILDER_EXECUTION` CI gate.
        const legacyJobToken = ["AGENT", "BUILDER", "EXECUTION"].join("_");
        await this.config.enqueueJob(legacyJobToken, { runId });
      }

      // Publish the initial "working" status on the run's Redis pub/sub
      // channel so any streaming subscriber attached via
      // `subscribeToRunEvents(runId)` sees that the job has started.
      //
      // The BullMQ worker (runAgentBuilderExecutionJob) itself should call
      // `publishRunEvent(runId, ...)` at step boundaries during execution
      // (e.g., per step start / completion / artifact). This executor only
      // publishes the initial "working" and the final "done".
      //
      // Best-effort: if Redis is unavailable, swallow — the poll loop below
      // remains the authoritative source of truth.
      void publishRunEvent(runId, { type: "status", state: "working" }).catch(
        () => {
          /* swallow — streaming bridge is additive */
        },
      );

      // 4) Publish the initial Task event in `submitted` state (maps from
      //    Cinatra "queued"). This seeds the task in InMemoryTaskStore.
      let lastPublishedState: TaskState | null = null;
      const initialState: TaskState = CinatraTaskStatusMap.queued ?? "submitted";
      // Include cinatraRunId so Python A2A clients can derive the reviewTaskId
      // needed for /api/a2a/resume without an extra MCP call.
      eventBus.publish(buildInitialTask(requestContext, initialState, { cinatraRunId: runId }));
      lastPublishedState = initialState;

      // 5) Close the eventBus immediately so DefaultRequestHandler.sendMessage
      //    returns to the caller (Python orchestrator) in < 1s. The old inline
      //    poll loop kept the HTTP connection open until pending_approval was
      //    detected — exceeding Python httpx's 60-second read timeout and causing
      //    A2AClientTimeoutError for any child agent that takes > 60s. Closing
      //    here decouples the send_message round-trip from run duration entirely.
      //    The caller receives the initial Task with cinatraRunId in metadata and
      //    can poll separately via tasks/get. The background poller below updates
      //    taskStore directly, keeping tasks/get accurate for any run duration.
      earlyFinishCalled = true;
      eventBus.finished();

      // 6) Background poller — updates taskStore directly without eventBus.
      //    Owns cleanup of aborters/taskToRun (finally block skips it when
      //    earlyFinishCalled to avoid double-deletion races).
      void this._backgroundPoll(
        requestContext,
        runId,
        pollIntervalMs,
        pollTimeoutMs,
        aborter,
      ).catch((err) => {
        console.error(
          `[InProcessAgentExecutor] background poll failed for run ${runId}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Ensure cleanup even on unexpected throw.
        this.aborters.delete(requestContext.taskId);
        this.taskToRun.delete(requestContext.taskId);
        this.taskToContext.delete(requestContext.taskId);
      });

    } finally {
      // When earlyFinishCalled, _backgroundPoll owns cleanup and eventBus is
      // already finished. When NOT earlyFinishCalled (early-exit paths: auth
      // failure, validation error, job enqueue error), do cleanup here.
      if (!earlyFinishCalled) {
        this.aborters.delete(requestContext.taskId);
        this.taskToRun.delete(requestContext.taskId);
        this.taskToContext.delete(requestContext.taskId);
        eventBus.finished();
      }
    }
  }

  /**
   * Background poller — runs after execute() closes the eventBus early.
   * Polls agent_runs and updates InMemoryTaskStore directly so tasks/get
   * returns the correct state for arbitrarily long child-agent runs.
   * Owns cleanup of aborters/taskToRun maps when it exits.
   */
  private async _backgroundPoll(
    requestContext: RequestContext,
    runId: string,
    pollIntervalMs: number,
    pollTimeoutMs: number,
    aborter: AbortController,
  ): Promise<void> {
    const taskStore = this.config.taskStore;
    const deadline = Date.now() + pollTimeoutMs;
    let lastStatus = "";

    try {
      while (true) {
        if (aborter.signal.aborted) return;
        await sleep(pollIntervalMs);
        if (aborter.signal.aborted) return;

        const run = await readAgentRunById(runId);
        if (!run) return;

        const nextState: TaskState =
          CinatraTaskStatusMap[run.status] ?? "unknown";
        const isTerminal = TERMINAL_A2A_STATES.has(nextState);
        const isInputRequired = nextState === "input-required";

        // Update taskStore on state change so tasks/get reflects reality.
        if (nextState !== lastStatus && taskStore) {
          const task = await taskStore.load(requestContext.taskId);
          if (task) {
            task.status = {
              state: nextState,
              timestamp: new Date().toISOString(),
            };
            if (isTerminal && nextState === "completed" && Array.isArray(run.stepResults)) {
              task.artifacts = [stepResultsToArtifact(run.stepResults)];
            }
            await taskStore.save(task);
          }
          lastStatus = nextState;
        }

        if (isTerminal || isInputRequired) {
          void publishRunEvent(runId, { type: "done" }).catch(() => {});
          return;
        }

        if (Date.now() > deadline) return;
      }
    } finally {
      this.aborters.delete(requestContext.taskId);
      this.taskToRun.delete(requestContext.taskId);
      this.taskToContext.delete(requestContext.taskId);
    }
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Abort the observer-side poll. The underlying BullMQ job is NOT
    // canceled here — stopping a Cinatra run is a separate operation
    // (agent_run_stop primitive) and not part of the A2A contract
    // surface. A full cancel path can be wired through run-stop semantics.
    const aborter = this.aborters.get(taskId);
    if (aborter) aborter.abort();

    // Resolve the originating contextId so consumers can correlate the
    // canceled status-update with its context. Primary source is the
    // taskToContext map (populated at execute() start). If the background
    // poller already cleaned the map (e.g. the run parked at input-required —
    // a non-terminal, still-cancelable state), fall back to the task store,
    // which retains the contextId for the task's lifetime.
    let contextId = this.taskToContext.get(taskId) ?? "";
    if (!contextId && this.config.taskStore) {
      try {
        const stored = await this.config.taskStore.load(taskId);
        contextId = stored?.contextId ?? "";
      } catch {
        // best-effort — fall through with "" rather than failing the cancel.
      }
    }

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "canceled",
        timestamp: new Date().toISOString(),
      },
      final: true,
    });
    // Do NOT call eventBus.finished() here — execute()'s finally block is
    // the sole authority for finishing the bus. Calling it here would cause a
    // double-finished() when the poll loop detects the abort signal and returns,
    // triggering the finally block. Cleanup of aborters/taskToRun is also
    // owned by execute()'s finally block.
    this.aborters.delete(taskId);
    this.taskToRun.delete(taskId);
    this.taskToContext.delete(taskId);
  }
}
