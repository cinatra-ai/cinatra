import "server-only";

import type { Task, TaskState } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { readAgentRunById } from "@cinatra-ai/agents";

import { CinatraTaskStatusMap } from "./types";

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
// ---------------------------------------------------------------------------

export function createA2ATaskStoreWithDbFallback(inner: TaskStore): TaskStore {
  return {
    async save(task, ctx) {
      return inner.save(task, ctx);
    },
    async load(taskId, ctx) {
      const hit = await inner.load(taskId, ctx);
      if (hit) return hit;
      const run = await readAgentRunById(taskId);
      if (!run) return undefined;
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
