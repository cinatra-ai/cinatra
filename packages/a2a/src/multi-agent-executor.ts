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

/**
 * Decision returned by the injected `resolveEdgeBoundServing` seam (cinatra#1392
 * Gap 2). The app binding resolves the TRUSTED dependent identity (from the run's
 * signed lineage / ActorContext) against the target package's dependency edge:
 *
 *   - `{ kind: "none" }`  — no trusted dependent id, or no applicable edge: the
 *     dispatch uses ordinary default / requestedVersion resolution
 *     (compatibility-preserving; the untrusted client version is honored here).
 *   - `{ kind: "serve", targetInstallId, snapshotId?, version? }` — the dependent
 *     is served the resolved install. `snapshotId` present ⇒ a NON-DEFAULT pin
 *     (immutable snapshot + `version`); absent ⇒ serve the DEFAULT (no snapshot
 *     pin). `targetInstallId` is stamped onto the created run's
 *     `dependent_install_id` so an edge-bound chain self-propagates.
 *   - `{ kind: "refuse", code, message }` — the resolved edge points at an
 *     unreachable non-default version (or a corrupt resolved shape):
 *     refuse-with-evidence, NEVER serve the default silently.
 */
export type EdgeBoundServingDecision =
  | { kind: "none" }
  | { kind: "serve"; targetInstallId: string; snapshotId?: string; version?: string | null }
  | { kind: "refuse"; code: string; message: string };

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
  /**
   * cinatra#1392 Gap 2 — injected edge-bound serving resolver. The app binding
   * (src/lib/a2a-server.ts) reads the TRUSTED dependent install id from the
   * request's ActorContext (the run's signed lineage) and resolves it against
   * the target package's dependency edge, keeping this package free of `@/lib`
   * imports (same DI pattern as `createAndEnqueueAgentRun`). Omitted ⇒ no
   * edge-bound serving (legacy default / requestedVersion resolution).
   */
  resolveEdgeBoundServing?: (input: {
    targetPackageName: string;
  }) => Promise<EdgeBoundServingDecision>;
};

export class MultiAgentExecutor implements AgentExecutor {
  private readonly byPackageName: Map<string, InProcessAgentExecutor>;
  private readonly templateByPackageName: Map<string, AgentTemplateRecord>;
  // Pinned version per taskId — consumed by the owning InProcessAgentExecutor
  // via a constructor-injected lookup function, NOT via metadata mutation.
  private readonly pinnedVersionByTaskId: Map<string, string> = new Map();
  // Pinned REQUIRED-snapshot id per taskId (cinatra#1040 S7). Set ONLY when the
  // request-time seam resolved an explicit requestedVersion to an immutable
  // agent_template_versions snapshot — threaded into the created run's
  // `versionId` so the execution worker enforces the pin FAIL-CLOSED. Absent for
  // a default resolution (the run stays best-effort live-template).
  private readonly pinnedSnapshotIdByTaskId: Map<string, string> = new Map();
  // Ownership map — taskId → packageName. Used by ownsTask() to short-circuit
  // cancelTask broadcasts.
  private readonly ownerByTaskId: Map<string, string> = new Map();
  // Stamped dependent install id per taskId (cinatra#1392 Gap 2) — the resolved
  // install id the created run executes AS. Consumed by the owning
  // InProcessAgentExecutor via getPinnedDependentInstallIdForTask and persisted
  // on the run's dependent_install_id so an edge-bound chain self-propagates.
  private readonly pinnedDependentInstallIdByTaskId: Map<string, string> = new Map();
  // cinatra#1392 Gap 2 — injected app-side edge-bound serving resolver (reads the
  // trusted dependent id from the request ActorContext). Undefined ⇒ disabled.
  private readonly resolveEdgeBoundServing?: MultiAgentExecutorOptions["resolveEdgeBoundServing"];

  constructor(opts: MultiAgentExecutorOptions) {
    this.byPackageName = new Map();
    this.templateByPackageName = new Map();
    this.resolveEdgeBoundServing = opts.resolveEdgeBoundServing;
    const pinnedLookup = (taskId: string): string | undefined =>
      this.pinnedVersionByTaskId.get(taskId);
    const pinnedSnapshotIdLookup = (taskId: string): string | undefined =>
      this.pinnedSnapshotIdByTaskId.get(taskId);
    const pinnedDependentInstallIdLookup = (taskId: string): string | undefined =>
      this.pinnedDependentInstallIdByTaskId.get(taskId);
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
          getPinnedSnapshotIdForTask: pinnedSnapshotIdLookup,
          getPinnedDependentInstallIdForTask: pinnedDependentInstallIdLookup,
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

    // cinatra#1392 Gap 2 — resolve the TRUSTED edge-bound serving decision FIRST,
    // BEFORE consuming the untrusted client `requestedVersion`. A dependent's
    // resolved edge (keyed on the trusted dependent install id carried on the
    // run's signed lineage, read app-side by the injected resolver) is
    // authoritative: it pins the resolved non-default snapshot, refuses an
    // unreachable non-default pin with evidence, or serves the default — and the
    // client `requestedVersion` is honored ONLY when no trusted edge applies.
    // Fail closed: any UNEXPECTED error from the trusted resolver refuses the run
    // rather than silently serving the default.
    let edge: EdgeBoundServingDecision = { kind: "none" };
    if (this.resolveEdgeBoundServing) {
      try {
        edge = await this.resolveEdgeBoundServing({ targetPackageName: skillId });
      } catch (err) {
        publishFailed(
          ctx,
          eventBus,
          "EDGE_BOUND_RESOLUTION_FAILED",
          (err as Error).message,
        );
        return;
      }
    }
    if (edge.kind === "refuse") {
      // Refuse-with-evidence — never fall through to a default serve.
      publishFailed(ctx, eventBus, edge.code, edge.message);
      return;
    }

    let resolvedVersion: string;
    let snapshotId: string | undefined;
    let dependentInstallId: string | undefined;

    if (edge.kind === "serve") {
      // The created (target) run executes AS the resolved install id — stamped so
      // an edge-bound chain self-propagates (A→B stamps B's run with B's id).
      dependentInstallId = edge.targetInstallId;
      if (edge.snapshotId) {
        // NON-DEFAULT trusted pin — authoritative; overrides any client version.
        snapshotId = edge.snapshotId;
        resolvedVersion = edge.version ?? "";
      } else {
        // Serve the DEFAULT: resolve its version WITHOUT the untrusted client
        // requestedVersion, and pin NO snapshot.
        let pinned;
        try {
          pinned = await resolveVersionBeforeRun({ packageName: skillId });
        } catch (err) {
          publishFailed(ctx, eventBus, "VERSION_RESOLUTION_FAILED", (err as Error).message);
          return;
        }
        resolvedVersion = pinned.resolvedVersion;
      }
    } else {
      // No trusted edge applies — legacy path: honor the client requestedVersion.
      let pinned;
      try {
        pinned = await resolveVersionBeforeRun({ packageName: skillId, requestedVersion });
      } catch (err) {
        publishFailed(ctx, eventBus, "VERSION_RESOLUTION_FAILED", (err as Error).message);
        return;
      }
      resolvedVersion = pinned.resolvedVersion;
      if (pinned.snapshotId) snapshotId = pinned.snapshotId;
    }

    // Record pinned version + snapshot + dependent id + ownership BEFORE
    // delegating so the sub-executor can read them when it calls createAgentRun,
    // and cancelTask can route correctly.
    const taskId = ctx.taskId ?? ctx.contextId ?? "unknown";
    this.pinnedVersionByTaskId.set(taskId, resolvedVersion);
    // REQUIRED-pin snapshot id (fail-closed marker: versionId + packageVersion
    // both set) — from an explicit requestedVersion OR a trusted non-default edge.
    if (snapshotId) {
      this.pinnedSnapshotIdByTaskId.set(taskId, snapshotId);
    }
    // Trusted dependent install id stamped onto the created run.
    if (dependentInstallId) {
      this.pinnedDependentInstallIdByTaskId.set(taskId, dependentInstallId);
    }
    this.ownerByTaskId.set(taskId, skillId);

    try {
      return await sub.execute(ctx, eventBus);
    } finally {
      // Prune the per-task pinned maps after run — the sub-executor has already
      // persisted them on the agent_runs row. Leave ownerByTaskId so a
      // subsequent cancelTask can still route correctly. Cleanup is bounded by
      // process lifetime until a finished() hook owns full cleanup.
      this.pinnedVersionByTaskId.delete(taskId);
      this.pinnedSnapshotIdByTaskId.delete(taskId);
      this.pinnedDependentInstallIdByTaskId.delete(taskId);
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
