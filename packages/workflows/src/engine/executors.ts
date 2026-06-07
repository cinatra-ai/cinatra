// Step-executor registry. A task's `type` selects an executor;
// agent_task is one of several. Non-agent executors (checkpoint/wait/manual/
// notification) are first-class + package-internal; notification + agent_task are
// INJECTED by the host (notification → @cinatra-ai/notifications; agent_task is
// the agent-dispatch executor).

export type ExecutorOutcome = {
  status: "succeeded" | "failed" | "running";
  error?: Record<string, unknown>;
  childRunId?: string;
  note?: string;
};

export type ExecutorTask = {
  id: string;
  key: string;
  type: string;
  title: string;
  input: Record<string, unknown> | null;
  agentRef: Record<string, unknown> | null;
  assigneeLevel: string | null;
  assigneeId: string | null;
};

export type ExecutorInput = {
  task: ExecutorTask;
  /** Delegated execution-actor provenance stamped on side effects / child runs.
   *  Shape: ChildRunProvenance (orgId/projectId/runBy/source/workflowId/workflowTaskId). */
  provenance: Record<string, unknown>;
  /** The reconciler-computed attempt idempotency key (`${workflowId}:${taskId}:${attemptNo}`).
   *  The agent_task executor passes this VERBATIM to createAgentRun so an
   *  at-least-once redispatch of the same attempt resolves to the same child run,
   *  while a retry (new attemptNo → new key) correctly spawns a fresh run. */
  idempotencyKey: string;
  /** 1-based attempt number (retries increment). */
  attemptNo: number;
};

export type Executor = (input: ExecutorInput) => Promise<ExecutorOutcome> | ExecutorOutcome;

export type InjectedExecutors = {
  notification?: Executor;
  agent_task?: Executor;
};

/** Build the executor registry. Built-in non-agent executors + injected
 *  notification/agent_task. Unknown/unwired types are left `running` with a
 *  diagnostic note (never throw inside a tick). */
export function buildExecutorRegistry(injected: InjectedExecutors = {}): Record<string, Executor> {
  return {
    // Gate-only: reaching dispatch means all gates passed → done.
    checkpoint: () => ({ status: "succeeded" }),
    // Approval: the approval gate only opens once a human grants it, so reaching
    // dispatch means the grant landed → the task itself is a no-op success.
    approval: () => ({ status: "succeeded" }),
    // Timer: the timing gate already enforced due_at → done.
    wait: () => ({ status: "succeeded" }),
    timer: () => ({ status: "succeeded" }),
    // Human action: transition to running; a human completes it (markManualDone).
    manual: () => ({ status: "running", note: "Awaiting manual completion" }),
    // In-app notification (host-injected); default no-op success keeps ticks safe.
    notification:
      injected.notification ?? (() => ({ status: "succeeded", note: "notification executor not wired (no-op)" })),
    // Agent dispatch (idempotent agent_run start) is host-injected. Until wired,
    // leave the task running with a diagnostic — never error the tick.
    agent_task:
      injected.agent_task ?? (() => ({ status: "running", note: "agent executor not wired (no-op)" })),
  };
}
