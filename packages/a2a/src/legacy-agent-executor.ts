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

import { TERMINAL_A2A_STATES } from "./types";

// ---------------------------------------------------------------------------
// LegacyAgentA2AExecutor
//
// Bridges the `@a2a-js/sdk` AgentExecutor contract to LEGACY code-based agent
// packages (agent-scrape, agent-research, agent-enrichment, ...), which do
// NOT live in the `agent_templates` table and do NOT execute via the
// `AGENT_BUILDER_EXECUTION` BullMQ job.
//
// Unlike `InProcessAgentExecutor`, this executor is entirely hook-driven: the
// caller provides a `LegacyAgentHooks` object with `start`, `readStatus`,
// `readArtifacts`, `cancel`, so this package has zero imports from any
// `@cinatra/agent-*` package. Each legacy package wires its own store + job
// enqueue on the consumer side (e.g. the Ross pipeline).
//
// LIFECYCLE SEMANTICS (mirrors InProcessAgentExecutor):
//   (1) Observer-side timeout (`pollTimeoutMs`) — publishes failed with code
//       OBSERVER_TIMEOUT. Does NOT cancel the underlying legacy job.
//   (2) Deduplication — consecutive identical states are not re-emitted.
//   (3) Artifact-update is published BEFORE the terminal completed
//       status-update (same order as InProcessAgentExecutor).
//   (4) cancelTask() invokes the `cancel` hook — best-effort; errors from the
//       hook are swallowed so the observer-side abort still succeeds.
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 1000;
// 287.2-deferred batch-LLM alignment — bumped from 300_000 (5 min) to
// 86_400_000 (24h) for consistency with agent-executor.ts. The legacy
// path is kept for backwards compat; aligning timeouts prevents
// surprising callers that switch between executors.
const DEFAULT_POLL_TIMEOUT_MS = 86_400_000; // 24 hours

export type LegacyAgentStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

export type LegacyStartInput = { taskId: string; text: string };
export type LegacyStartResult = { executionId: string };
export type LegacyReadStatusInput = { executionId: string };
/**
 * Result of reading legacy execution status. `error` is surfaced verbatim
 * into the `failed` TaskStatus message parts — callers must ensure hook
 * error strings do NOT leak secrets.
 */
export type LegacyReadStatusResult = {
  status: LegacyAgentStatus;
  error?: string | null;
};
export type LegacyReadArtifactsInput = { executionId: string };
export type LegacyCancelInput = { executionId: string; taskId: string };

export type LegacyAgentHooks = {
  start(input: LegacyStartInput): Promise<LegacyStartResult>;
  readStatus(input: LegacyReadStatusInput): Promise<LegacyReadStatusResult>;
  readArtifacts(input: LegacyReadArtifactsInput): Promise<TextPart[]>;
  cancel(input: LegacyCancelInput): Promise<void>;
};

export type LegacyAgentA2AExecutorOptions = {
  /** Used for artifact.name = `${agentId}-results`. */
  agentId: string;
  hooks: LegacyAgentHooks;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

const LEGACY_TO_A2A: Record<LegacyAgentStatus, TaskState> = {
  idle: "submitted", // job exists but worker has not picked it up yet
  running: "working",
  succeeded: "completed",
  failed: "failed",
  stopped: "canceled",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export class LegacyAgentA2AExecutor implements AgentExecutor {
  private readonly options: LegacyAgentA2AExecutorOptions;
  private readonly aborters = new Map<string, AbortController>();
  private readonly executions = new Map<string, string>();
  private readonly contexts = new Map<string, string>();

  constructor(options: LegacyAgentA2AExecutorOptions) {
    this.options = options;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const pollIntervalMs =
      this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollTimeoutMs =
      this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

    const aborter = new AbortController();
    this.aborters.set(requestContext.taskId, aborter);
    this.contexts.set(requestContext.taskId, requestContext.contextId);

    try {
      const text = (requestContext.userMessage.parts ?? [])
        .filter((p): p is TextPart => p.kind === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();

      let executionId: string;
      try {
        const started = await this.options.hooks.start({
          taskId: requestContext.taskId,
          text,
        });
        executionId = started.executionId;
      } catch (err) {
        eventBus.publish(
          buildStatusUpdate(requestContext, "failed", {
            final: true,
            errorMessage: err instanceof Error ? err.message : "start threw",
            errorCode: "START_ERROR",
          }),
        );
        return;
      }
      this.executions.set(requestContext.taskId, executionId);

      // Initial Task in "submitted" state seeds InMemoryTaskStore.
      let lastPublishedState: TaskState | null = "submitted";
      eventBus.publish({
        kind: "task",
        id: requestContext.taskId,
        contextId: requestContext.contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [requestContext.userMessage],
      } satisfies Task);

      const deadline = Date.now() + pollTimeoutMs;
      let terminal = false;

      while (!terminal) {
        if (aborter.signal.aborted) return;
        await sleep(pollIntervalMs);
        if (aborter.signal.aborted) return;

        let result: LegacyReadStatusResult;
        try {
          result = await this.options.hooks.readStatus({ executionId });
        } catch (err) {
          eventBus.publish(
            buildStatusUpdate(requestContext, "failed", {
              final: true,
              errorMessage:
                err instanceof Error ? err.message : "readStatus threw",
              errorCode: "READ_STATUS_ERROR",
            }),
          );
          return;
        }

        const nextState: TaskState =
          LEGACY_TO_A2A[result.status] ?? "unknown";
        const isTerminal = TERMINAL_A2A_STATES.has(nextState);

        if (nextState !== lastPublishedState) {
          if (isTerminal) {
            if (nextState === "completed") {
              let parts: TextPart[] = [];
              try {
                parts = await this.options.hooks.readArtifacts({
                  executionId,
                });
              } catch {
                parts = [];
              }
              const finalParts: TextPart[] =
                parts.length > 0
                  ? parts
                  : [{ kind: "text", text: "(no results)" }];
              const artifact: Artifact = {
                artifactId: randomUUID(),
                name: `${this.options.agentId}-results`,
                parts: finalParts,
              };
              eventBus.publish({
                kind: "artifact-update",
                taskId: requestContext.taskId,
                contextId: requestContext.contextId,
                artifact,
              } satisfies TaskArtifactUpdateEvent);
            }
            eventBus.publish(
              buildStatusUpdate(requestContext, nextState, {
                final: true,
                errorMessage:
                  nextState === "failed"
                    ? result.error ?? undefined
                    : undefined,
              }),
            );
            terminal = true;
            lastPublishedState = nextState;
            continue;
          }
          eventBus.publish(
            buildStatusUpdate(requestContext, nextState, { final: false }),
          );
          lastPublishedState = nextState;
        }

        if (!terminal && Date.now() > deadline) {
          eventBus.publish(
            buildStatusUpdate(requestContext, "failed", {
              final: true,
              errorMessage:
                "A2A observer timeout — underlying legacy job may still be running",
              errorCode: "OBSERVER_TIMEOUT",
            }),
          );
          return;
        }
      }
    } finally {
      this.aborters.delete(requestContext.taskId);
      this.executions.delete(requestContext.taskId);
      this.contexts.delete(requestContext.taskId);
      eventBus.finished();
    }
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const aborter = this.aborters.get(taskId);
    const executionId = this.executions.get(taskId);
    if (aborter) aborter.abort();
    if (executionId) {
      try {
        await this.options.hooks.cancel({ executionId, taskId });
      } catch {
        // swallow — cancel is best-effort; observer aborted regardless.
      }
    }
    const contextId = this.contexts.get(taskId) ?? "";
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
    // execute()'s finally block owns eventBus.finished() + map cleanup.
  }
}
