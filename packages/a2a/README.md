# @cinatra-ai/a2a

The Agent-to-Agent (A2A) protocol layer for Cinatra. It wraps the `@a2a-js/sdk`
server and client primitives to expose Cinatra virtual agents over A2A, call
in-process and external A2A agents through one uniform client, and stream run
events via Redis. This package is server-only.

## Public API

### Server & executors
- `createA2AServerForAgent` — build an A2A server stack for one agent
- `resolveAgentByPackageName` — resolve a published agent by package name
- `buildAgentCard` — construct an A2A `AgentCard`
- `InProcessAgentExecutor`, `MultiAgentExecutor`, `LegacyAgentA2AExecutor` — A2A executors
- `createDefaultEnqueueJobFn` — default job-enqueue function for executors
- `CinatraTaskStatusMap`, `TERMINAL_A2A_STATES` — run-status to `TaskState` mapping
- `resolveVersionBeforeRun` — pin the agent version before a run
- `createA2ATaskStoreWithDbFallback` — task store with database fallback

### Transport & clients
- `InProcessTransport` — zero-HTTP transport over a local handler
- `createInProcessA2AClient` — client for same-process agents
- `createExternalA2AClient` — client for remote HTTP A2A agents
- `createLegacyAgentA2AClient` — client for legacy agent executors
- `fetchExternalAgentCard` — discover a remote agent's card

### Streaming
- `publishRunEvent`, `subscribeToRunEvents` — Redis run-event pub/sub
- `xaddRunEvent`, `readRunEvents`, `readRecentRunEventsReverse`, `expireRunStream` — durable Redis Streams event log
- `startExternalSseProxyFromStream` — bridge external SSE into Redis
- `CinatraResubscribeHandler` — replays the event log on resubscribe
- `toSseResponse`, `toMuxSseResponse` — SSE response adapters

### Re-exported `@a2a-js/sdk` server primitives
- `A2AError`, `DefaultRequestHandler`, `InMemoryTaskStore`, `JsonRpcTransportHandler`, and core types

## Usage

```ts
import { createInProcessA2AClient } from "@cinatra-ai/a2a";

const client = await createInProcessA2AClient({ packageName, enqueueJob });
const task = await client.sendMessage({ text: "Run the report" });
const status = await client.getTask(task.id);
```

## Docs

See https://docs.cinatra.ai
