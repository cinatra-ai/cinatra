import "server-only";

import { randomUUID } from "node:crypto";

import type { TextPart } from "@a2a-js/sdk";
import {
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  A2AError,
} from "@a2a-js/sdk/server";
import type { AgentTemplateRecord } from "@cinatra-ai/agents";

import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import { InProcessAgentExecutor, type EnqueueJobFn, type CreateAndEnqueueAgentRunFn } from "./agent-executor";
import { resolveVersionBeforeRun } from "./version-pinning";

// ---------------------------------------------------------------------------
// MultiAgentExecutor
//
// Routes an incoming A2A RequestContext to the correct InProcessAgentExecutor
// instance based on a `skillId` (== template packageName) extracted from:
//
//   1) `ctx.userMessage.metadata.skillId` (primary, A2A-native),
//   2) first text part parsed as JSON envelope `{ skillId, version?, ... }`
//      (compat fallback for clients that can't set metadata),
//
// throwing a clean invalidParams error otherwise.
//
// Version pinning — resolveVersionBeforeRun is called BEFORE delegating, and
// the resolved `packageVersion` is stored in `pinnedVersionByTaskId` so the
// owning InProcessAgentExecutor can read it via its constructor-injected
// lookup callback and persist it on `agent_runs`. This avoids mutating the
// SDK's immutable `RequestContext.userMessage.metadata`.
//
// Ownership — `ownerByTaskId` maps taskId → packageName BEFORE delegation so
// `cancelTask()` can short-circuit broadcasts to non-owning sub-executors
// This prevents spurious canceled events on unrelated runs.
// ---------------------------------------------------------------------------

export type MultiAgentExecutorOptions = {
  templates: AgentTemplateRecord[];
  /**
   * Required — InProcessAgentExecutor needs a way to enqueue the BullMQ
   * execution job. The app layer passes a bound `enqueueBackgroundJob` here
   * so this package stays free of `@/lib/background-jobs` imports.
   */
  enqueueJob: EnqueueJobFn;
  /**
   * Preferred over `enqueueJob`. Host injects `enqueueAgentRun` from
   * `src/lib/agent-run-enqueue.ts` here so the connector preflight runs before
   * the BullMQ enqueue.
   */
  createAndEnqueueAgentRun?: CreateAndEnqueueAgentRunFn;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /**
   * The inner InMemoryTaskStore (not the DB-fallback wrapper). Forwarded to
   * each InProcessAgentExecutor so the background poller can update it after
   * execute() closes the eventBus early — keeping tasks/get accurate without
   * holding the send_message HTTP connection open for the run duration.
   */
  taskStore?: InMemoryTaskStore;
};

export class MultiAgentExecutor implements AgentExecutor {
  private readonly byPackageName: Map<string, InProcessAgentExecutor>;
  private readonly templateByPackageName: Map<string, AgentTemplateRecord>;
  // Pinned version per taskId — consumed by the owning InProcessAgentExecutor
  // via a constructor-injected lookup function, NOT via metadata mutation.
  private readonly pinnedVersionByTaskId: Map<string, string> = new Map();
  // Ownership map — taskId → packageName. Used by ownsTask() to short-circuit
  // cancelTask broadcasts.
  private readonly ownerByTaskId: Map<string, string> = new Map();

  constructor(opts: MultiAgentExecutorOptions) {
    this.byPackageName = new Map();
    this.templateByPackageName = new Map();
    const pinnedLookup = (taskId: string): string | undefined =>
      this.pinnedVersionByTaskId.get(taskId);
    for (const t of opts.templates) {
      if (!t.packageName) continue;
      this.templateByPackageName.set(t.packageName, t);
      this.byPackageName.set(
        t.packageName,
        new InProcessAgentExecutor({
          templateId: t.id,
          packageName: t.packageName,
          pollIntervalMs: opts.pollIntervalMs,
          pollTimeoutMs: opts.pollTimeoutMs,
          enqueueJob: opts.enqueueJob,
          createAndEnqueueAgentRun: opts.createAndEnqueueAgentRun,
          getPinnedVersionForTask: pinnedLookup,
          taskStore: opts.taskStore,
        }),
      );
    }
  }

  /**
   * Returns true iff this MultiAgentExecutor currently owns the given taskId.
   * Used by cancelTask to avoid broadcasting to non-owning sub-executors.
   */
  ownsTask(taskId: string): boolean {
    return this.ownerByTaskId.has(taskId);
  }

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    let skillId: string;
    let requestedVersion: string | undefined;
    try {
      ({ skillId, requestedVersion } = extractRouting(ctx));
    } catch (err) {
      publishFailed(
        ctx,
        eventBus,
        "SKILL_ID_REQUIRED",
        (err as Error).message,
      );
      return;
    }

    const sub = this.byPackageName.get(skillId);
    console.log(`[MultiAgentExecutor] skillId=${JSON.stringify(skillId)} sub=${sub ? "found" : "NOT_FOUND"} keys=${JSON.stringify([...this.byPackageName.keys()])}`);
    if (!sub) {
      publishFailed(
        ctx,
        eventBus,
        "SKILL_NOT_FOUND",
        `Unknown agent package: ${skillId}`,
      );
      return;
    }

    let pinned;
    try {
      pinned = await resolveVersionBeforeRun({
        packageName: skillId,
        requestedVersion,
      });
    } catch (err) {
      publishFailed(
        ctx,
        eventBus,
        "VERSION_RESOLUTION_FAILED",
        (err as Error).message,
      );
      return;
    }

    // Record pinned version + ownership BEFORE delegating so the sub-executor
    // can read the pinned version when it calls createAgentRun, and cancelTask
    // can route correctly.
    const taskId = ctx.taskId ?? ctx.contextId ?? "unknown";
    this.pinnedVersionByTaskId.set(taskId, pinned.resolvedVersion);
    this.ownerByTaskId.set(taskId, skillId);

    try {
      return await sub.execute(ctx, eventBus);
    } finally {
      // Prune pinnedVersion after run — the sub-executor has already persisted
      // it on the agent_runs row. Leave ownerByTaskId so a subsequent
      // cancelTask can still route correctly. Cleanup is bounded by process
      // lifetime until a finished() hook owns full cleanup.
      this.pinnedVersionByTaskId.delete(taskId);
    }
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // ownsTask guard — short-circuits broadcasts to non-owning sub-executors,
    // preventing spurious `canceled` events on unrelated runs.
    if (!this.ownsTask(taskId)) {
      return;
    }
    const ownerPackage = this.ownerByTaskId.get(taskId)!;
    const owningSub = this.byPackageName.get(ownerPackage);
    this.ownerByTaskId.delete(taskId);
    if (!owningSub) return;
    await owningSub.cancelTask(taskId, eventBus);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRouting(
  ctx: RequestContext,
): { skillId: string; requestedVersion?: string } {
  const meta = (ctx.userMessage.metadata ?? {}) as {
    skillId?: string;
    version?: string;
  };
  if (typeof meta.skillId === "string" && meta.skillId.length > 0) {
    return { skillId: meta.skillId, requestedVersion: meta.version };
  }
  const firstText =
    ctx.userMessage.parts?.find((p): p is TextPart => p.kind === "text")?.text
      ?? "";
  const trimmed = firstText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const env = JSON.parse(trimmed) as {
        skillId?: string;
        version?: string;
      };
      if (typeof env.skillId === "string" && env.skillId.length > 0) {
        return { skillId: env.skillId, requestedVersion: env.version };
      }
    } catch {
      /* fall through */
    }
  }
  throw A2AError.invalidParams(
    "skillId is required — pass as metadata.skillId or first text part JSON envelope",
  );
}

function publishFailed(
  ctx: RequestContext,
  eventBus: ExecutionEventBus,
  code: string,
  message: string,
): void {
  const taskId = ctx.taskId ?? randomUUID();
  const contextId = ctx.contextId ?? randomUUID();
  console.log(`[MultiAgentExecutor] publishFailed code=${code} message=${message} taskId=${taskId}`);
  // Publish a task event first so ResultManager.currentTask is set (prevents -32603).
  eventBus.publish({
    kind: "task",
    id: taskId,
    contextId,
    status: { state: "failed", timestamp: new Date().toISOString() },
    history: ctx.userMessage ? [ctx.userMessage] : [],
  });
  eventBus.publish({
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: `[${code}] ${message}` }],
      },
    },
    final: true,
  });
  eventBus.finished();
}
