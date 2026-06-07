import "server-only";

import { randomUUID } from "node:crypto";

import type { AgentCard, MessageSendParams, Task } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";

import { InProcessTransport } from "./in-process-transport";
import {
  LegacyAgentA2AExecutor,
  type LegacyAgentA2AExecutorOptions,
  type LegacyAgentHooks,
} from "./legacy-agent-executor";

// ---------------------------------------------------------------------------
// createLegacyAgentA2AClient
//
// Ergonomic factory mirroring `createInProcessA2AClient` but
// routed through `LegacyAgentA2AExecutor` for code-based agent packages that
// do NOT live in `agent_templates` (agent-scrape, agent-research,
// agent-enrichment, ...). The AgentCard is synthesized in-process — no DB
// lookup is required because legacy agents are identified by `agentId` alone.
// ---------------------------------------------------------------------------

export type CreateLegacyAgentA2AClientInput = {
  agentId: string;
  hooks: LegacyAgentHooks;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type LegacyAgentA2AClient = {
  agentId: string;
  agentCard: AgentCard;
  sendMessage(input: { text?: string; json?: unknown }): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
};

export function createLegacyAgentA2AClient(
  input: CreateLegacyAgentA2AClientInput,
): LegacyAgentA2AClient {
  const agentCard: AgentCard = {
    name: input.agentId,
    description: `Cinatra legacy code-based agent: ${input.agentId}`,
    url: `in-process-legacy://${input.agentId}`,
    version: "0.0.1",
    protocolVersion: "0.3.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: input.agentId,
        name: input.agentId,
        description: `Run the ${input.agentId} legacy Cinatra agent.`,
        tags: ["cinatra", "legacy-agent"],
      },
    ],
  } as unknown as AgentCard;

  const options: LegacyAgentA2AExecutorOptions = {
    agentId: input.agentId,
    hooks: input.hooks,
    pollIntervalMs: input.pollIntervalMs,
    pollTimeoutMs: input.pollTimeoutMs,
  };
  const executor = new LegacyAgentA2AExecutor(options);
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );
  const handler = new JsonRpcTransportHandler(requestHandler);
  const transport = new InProcessTransport(handler, agentCard);

  return {
    agentId: input.agentId,
    agentCard,
    async sendMessage({ text, json }) {
      const body =
        typeof text === "string" && text.length > 0
          ? text
          : json !== undefined
            ? JSON.stringify(json)
            : "";
      const params: MessageSendParams = {
        message: {
          role: "user",
          kind: "message",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: body }],
        },
      };
      const result = await transport.sendMessage(params);
      if (!result || (result as { kind?: string }).kind !== "task") {
        throw new Error(
          `createLegacyAgentA2AClient.sendMessage: expected Task result, got ${JSON.stringify(result)}`,
        );
      }
      return result as Task;
    },
    async getTask(taskId) {
      return transport.getTask({ id: taskId });
    },
    async cancelTask(taskId) {
      return transport.cancelTask({ id: taskId });
    },
  };
}
