import "server-only";

import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import { readPublishedAgentTemplates } from "@cinatra-ai/agents";

import { InProcessAgentExecutor } from "./agent-executor";
import type {
  EnqueueJobFn,
  InProcessAgentExecutorOptions,
} from "./agent-executor";
import type { CinatraA2AConfig } from "./types";

// ---------------------------------------------------------------------------
// A2A Server Factory
//
// Assembles the full `@a2a-js/sdk` server stack for a single Cinatra virtual
// agent and wires it to an in-process transport surface. This helper currently
// resolves one published agent at startup; generic discovery can expand it to
// one A2A endpoint per published template.
//
// Streaming capability is intentionally disabled in the AgentCard until the
// streaming transport bridge is implemented.
// ---------------------------------------------------------------------------

export type CreateA2AServerForAgentInput = CinatraA2AConfig & {
  enqueueJob: EnqueueJobFn;
  /**
   * Prototype-only. Do NOT set to true in production until
   * InProcessTransport.sendMessageStream is implemented.
   *
   * Setting this without a real streaming transport creates a capabilities
   * mismatch: AgentCard advertises streaming=true but the transport throws
   * "Streaming not yet supported on InProcessTransport" unconditionally.
   * The explicit field name makes the prototype-only intent clear and prevents
   * accidental production use before the streaming transport exists.
   */
  streamingSpike?: boolean;
};

export type A2AServerBundle = {
  handler: JsonRpcTransportHandler;
  agentCard: AgentCard;
  taskStore: InMemoryTaskStore;
  requestHandler: DefaultRequestHandler;
  executor: InProcessAgentExecutor;
};

/**
 * Build an A2A server stack bound to a single Cinatra virtual agent.
 *
 * - AgentCard: uses `packageName` as the agent name. `capabilities.streaming`
 *   is false until the streaming bridge exists. No auth: in-process only.
 * - TaskStore: `InMemoryTaskStore` (stateful tasks live in memory for the
 *   lifetime of the process; persistent task storage is separate infrastructure).
 * - Executor: `InProcessAgentExecutor` built from the provided config.
 * - Handler: `DefaultRequestHandler` wrapped in `JsonRpcTransportHandler` so
 *   it can be fronted by `InProcessTransport` (zero-HTTP) today and by an
 *   HTTP/SSE mount when that transport surface is added.
 */
export function createA2AServerForAgent(
  input: CreateA2AServerForAgentInput,
): A2AServerBundle {
  const agentCard: AgentCard = {
    name: input.packageName,
    description: `Cinatra virtual agent: ${input.packageName}`,
    // In-process URL placeholder. Clients using InProcessTransport ignore
    // this; HTTP mounts can overwrite it.
    url: `in-process://${input.packageName}`,
    version: "0.0.1",
    protocolVersion: "0.3.0",
    capabilities: {
      // streamingSpike must not be set true until
      // InProcessTransport.sendMessageStream is implemented.
      streaming: input.streamingSpike ?? false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: input.packageName,
        name: input.packageName,
        description: `Run the ${input.packageName} Cinatra virtual agent.`,
        tags: ["cinatra", "virtual-agent"],
      },
    ],
  } as unknown as AgentCard;

  const taskStore = new InMemoryTaskStore();
  const executorOptions: InProcessAgentExecutorOptions = {
    templateId: input.templateId,
    packageName: input.packageName,
    pollIntervalMs: input.pollIntervalMs,
    pollTimeoutMs: input.pollTimeoutMs,
    enqueueJob: input.enqueueJob,
    taskStore,
  };
  const executor = new InProcessAgentExecutor(executorOptions);
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );
  const handler = new JsonRpcTransportHandler(requestHandler);

  return { handler, agentCard, taskStore, requestHandler, executor };
}

/**
 * Helper that resolves the first published virtual agent from the
 * `agent_templates` table.
 *
 * @throws when no published agent templates exist.
 */
export async function resolveFirstPublishedAgent(): Promise<{
  templateId: string;
  packageName: string;
}> {
  const templates = await readPublishedAgentTemplates();
  const first = templates[0];
  if (!first) {
    throw new Error(
      "resolveFirstPublishedAgent: no published agent templates found. " +
        "Publish at least one agent (packageName set, status='published') " +
        "before starting the A2A server.",
    );
  }
  if (!first.packageName) {
    // readPublishedAgentTemplates already filters for non-null packageName,
    // but defend against a future filter change.
    throw new Error(
      `resolveFirstPublishedAgent: template ${first.id} has no packageName. ` +
        "readPublishedAgentTemplates should have filtered this out.",
    );
  }
  return { templateId: first.id, packageName: first.packageName };
}
