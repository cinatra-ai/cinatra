// @cinatra-ai/workflows engine — the durable reconciler core.

export { evaluateTaskGates, resolveDependency } from "./gate-eval";
export type { TaskGateContext, DependencyEdge } from "./gate-eval";
export { buildExecutorRegistry } from "./executors";
export type { Executor, ExecutorInput, ExecutorOutcome, InjectedExecutors, ExecutorTask } from "./executors";
export { ENGINE_OPS, retryBackoffMs } from "./ops";
export { reconcileWorkflow } from "./reconciler";
export type { ReconcileDeps, ChildRunStatus } from "./reconciler";
export {
  startWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  markManualDone,
  reconcileDueWorkflows,
  findStuckTasks,
} from "./lifecycle";
export type { StartResult, LifecycleResult, LifecycleDeps } from "./lifecycle";
export {
  NOTIFICATION_MATRIX,
  WORKFLOW_NOTIFICATION_EVENTS,
  notificationFor,
} from "./notifications";
export type {
  WorkflowNotificationEvent,
  WorkflowNotificationRecipient,
  WorkflowNotification,
  WorkflowNotifier,
  WorkflowAuditWriter,
  WorkflowAuditEntry,
} from "./notifications";
export { ensureWorkflowEngine, enqueueWorkflowReconcile } from "./runtime";
export type { EngineRuntime } from "./runtime";
