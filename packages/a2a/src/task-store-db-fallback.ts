import "server-only";

import type { Task, TaskState } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

import { CinatraTaskStatusMap } from "./types";
import { requireA2AActor, resolveAuthorizedRunForA2AId } from "./actor-adapter";

// ---------------------------------------------------------------------------
// createA2ATaskStoreWithDbFallback
//
// Wraps an inner TaskStore (typically `InMemoryTaskStore`) with a fallback
// path that synthesizes an A2A Task from an `agent_runs` row when the inner
// store has no entry for the requested taskId. This enables `tasks/get` to
// recover a terminal task after a process restart has evicted the in-memory
// cache.
//
// Semantics:
//   - inner.load hit     → return the inner result; DB is never queried.
//   - inner.load miss    → look up `agent_runs` by id; synthesize if present.
//   - both miss          → return undefined so the SDK emits the canonical
//                          `taskNotFound` JSON-RPC error envelope.
//
// BOTH paths are bound to the verified actor (fail-closed). Previously the DB
// fallback called readAgentRunById(taskId) with NO actor (returning the row +
// synthesized stepResults artifacts unauthenticated) AND the in-memory hit was
// returned with no authz at all — so a caller who guessed a task id could read
// another tenant's run. We now resolve the verified actor fail-closed (from the
// SDK call context's `a2aActorContext`, falling back to the ALS frame) and
// authorize run.read for the requested id on BOTH the hit and the fallback path.
//
// NOTE: the A2A task id is NOT always the agent_runs PK. Live tasks created by
// InProcessAgentExecutor use a distinct task id persisted in
// `agent_runs.a2a_task_id`; only the synthesized terminal-recovery path uses
// run.id as the task id. resolveAuthorizedRunForA2AId tries BOTH forms, so the
// gate never 404s a legitimate live in-memory task.
// ---------------------------------------------------------------------------

export function createA2ATaskStoreWithDbFallback(inner: TaskStore): TaskStore {
  return {
    async save(task, ctx) {
      return inner.save(task, ctx);
    },
    async load(taskId, ctx) {
      // Fail closed: resolve the verified actor (explicit ctx.a2aActorContext
      // preferred; ALS frame fallback). Throws when no actor is available.
      const actor = requireA2AActor(ctx);
      // Authorize run.read for the requested id (by task-id OR run-id form)
      // BEFORE returning anything. On a run match this throws AuthzError
      // (404 hidden / 403 forbidden) for an unauthorized actor; it returns null
      // ONLY when NO agent_runs row matches either id form.
      const run = await resolveAuthorizedRunForA2AId(taskId, actor);
      // FAIL CLOSED on an unresolvable run: if we could not resolve+authorize a
      // canonical run, do NOT return an in-memory hit — a guessed task id whose
      // run row is missing/stale (or an in-memory task created before its run
      // row commits) must not leak task data without an enforceRunAccess pass.
      if (!run) return undefined;
      // Authorized: prefer the live in-memory task, else synthesize from the
      // (now authorized) run row.
      const hit = await inner.load(taskId, ctx);
      if (hit) return hit;
      return synthesizeTaskFromAgentRun(run);
    },
  };
}

type MinimalAgentRun = {
  id: string;
  status: string;
  stepResults: unknown[] | null;
  error: string | null;
};

function synthesizeTaskFromAgentRun(run: MinimalAgentRun): Task {
  const a2aState: TaskState =
    (CinatraTaskStatusMap[run.status] ?? "unknown") as TaskState;
  const status: Task["status"] = {
    state: a2aState,
    timestamp: new Date().toISOString(),
  };
  if (run.error) {
    status.message = {
      kind: "message",
      role: "agent",
      messageId: `${run.id}-err`,
      parts: [{ kind: "text", text: run.error }],
    };
  }
  const artifacts = Array.isArray(run.stepResults) && run.stepResults.length > 0
    ? [
        {
          artifactId: `${run.id}-results`,
          name: "stepResults",
          parts: [
            {
              kind: "data" as const,
              data: { stepResults: run.stepResults } as Record<string, unknown>,
            },
          ],
        },
      ]
    : [];
  return {
    id: run.id,
    contextId: run.id,
    kind: "task",
    status,
    artifacts,
    history: [],
  } as Task;
}
