import "server-only";

// ---------------------------------------------------------------------------
// @cinatra-ai/a2a — A2A Protocol Layer
//
// Public surface for the A2A (Agent-to-Agent) protocol integration. This
// package wraps `@a2a-js/sdk` primitives (Transport, JsonRpcTransportHandler,
// DefaultRequestHandler, InMemoryTaskStore) and exposes cinatra-specific
// wiring for in-process transport and agent executors.
// ---------------------------------------------------------------------------

export { InProcessTransport } from "./in-process-transport";
export {
  InProcessAgentExecutor,
  createDefaultEnqueueJobFn,
  type EnqueueJobFn,
  type EnqueueJobFnOptions,
  type InProcessAgentExecutorOptions,
} from "./agent-executor";
export {
  CinatraTaskStatusMap,
  TERMINAL_A2A_STATES,
  type CinatraA2AConfig,
} from "./types";
export {
  createA2AServerForAgent,
  /** @deprecated Use `resolveAgentByPackageName`. */
  resolveFirstPublishedAgent,
  type CreateA2AServerForAgentInput,
  type A2AServerBundle,
} from "./server";
export { resolveAgentByPackageName } from "./agent-resolver";
export {
  createInProcessA2AClient,
  type CreateInProcessA2AClientInput,
  type InProcessA2AClient,
} from "./client";
export {
  createExternalA2AClient,
  type ExternalA2AClient,
  type ExternalA2AClientOptions,
  type ExternalA2AClientCredentials,
  type StaticTokenCredentials,
  type ClientCredentials,
  type SendTaskOptions,
  type StreamTaskOptions,
  type GetTaskOptions,
  type CancelTaskOptions,
  type A2AStreamEventData,
} from "./external-client";
// Typed Result envelope for external AgentCard discovery.
// Used only at dispatch/sync time (external-template upsert); never in read paths.
export {
  fetchExternalAgentCard,
  type FetchExternalAgentCardInput,
  type FetchExternalAgentCardResult,
  type FetchExternalAgentCardReason,
} from "./external-agent-card";
// External A2A SSE → Redis bridge (fire-and-forget).
// Consumes ExternalA2AClient.streamTask AsyncGenerator; publishes RunStreamEvents
// onto cinatra:a2a:run:{runId}. Exactly-one terminal { type: "done" } per run.
export {
  startExternalSseProxyFromStream,
  type StartExternalSseProxyOptions,
} from "./external-sse-proxy";
export {
  publishRunEvent,
  subscribeToRunEvents,
  type RunStreamEvent,
  type SubscribeToRunEventsOptions,
} from "./streaming-bridge";
export {
  LegacyAgentA2AExecutor,
  type LegacyAgentHooks,
  type LegacyAgentStatus,
  type LegacyAgentA2AExecutorOptions,
  type LegacyStartInput,
  type LegacyStartResult,
  type LegacyReadStatusInput,
  type LegacyReadStatusResult,
  type LegacyReadArtifactsInput,
  type LegacyCancelInput,
} from "./legacy-agent-executor";
export {
  createLegacyAgentA2AClient,
  type CreateLegacyAgentA2AClientInput,
  type LegacyAgentA2AClient,
} from "./legacy-client";
export { buildAgentCard } from "./agent-card";
export type {
  AgentCard,
  AgentCardSkill,
  AgentCardAuthentication,
  AgentCardHitlScreen,
  BuildAgentCardInput,
} from "./agent-card";

// Version pinning + task-store DB fallback.
export { resolveVersionBeforeRun } from "./version-pinning";
export type {
  ResolveVersionInput,
  ResolveVersionResult,
} from "./version-pinning";
export { createA2ATaskStoreWithDbFallback } from "./task-store-db-fallback";
export {
  MultiAgentExecutor,
  type MultiAgentExecutorOptions,
} from "./multi-agent-executor";

// SSE response adapter for message/stream + tasks/resubscribe.
export { toSseResponse } from "./sse-response";

// Multiplexed SSE adapter for A2A + AG-UI event passthrough.
export { toMuxSseResponse } from "./mux-sse-response";

// Redis Streams durable event log + live-tail reader.
// Consumer contract: xaddRunEvent is called by publishRunEvent internally;
// readRunEvents is called by CinatraResubscribeHandler and by
// AG-UI subscribers.
export {
  xaddRunEvent,
  readRunEvents,
  readRecentRunEventsReverse,
  expireRunStream,
  __disconnectSharedEventLogPublisher,
  type StreamReadOptions,
} from "./event-log";

// CinatraResubscribeHandler.
// Drop-in replacement for DefaultRequestHandler in src/lib/a2a-server.ts;
// overrides resubscribe() to replay from the Redis Streams durable event log
// instead of the ephemeral in-memory ExecutionEventBus.
export { CinatraResubscribeHandler } from "./resubscribe-handler";

// Re-export @a2a-js/sdk server primitives so src/lib/ files access the SDK
// through the @cinatra-ai/a2a architecture boundary and never import @a2a-js/sdk
// directly (which would require adding it to the root package.json).
export type { AgentCard as SdkAgentCard, JSONRPCResponse, Task, TaskState } from "@a2a-js/sdk";
export {
  A2AError,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
export { getOrAddWayflowGateIndex, resolveRunIdByWayflowTaskId } from "./event-log";
