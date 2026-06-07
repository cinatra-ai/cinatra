import "server-only";

import { randomUUID } from "node:crypto";

import type { AgentCard, MessageSendParams, Task } from "@a2a-js/sdk";

import { resolveAgentByPackageName } from "./agent-resolver";
import { createA2AServerForAgent } from "./server";
import { InProcessTransport } from "./in-process-transport";
import type { EnqueueJobFn } from "./agent-executor";

// ---------------------------------------------------------------------------
// createInProcessA2AClient
//
// Ergonomic factory that wraps the A2A server and in-process transport into a
// single call. Addresses sub-agents by stable `packageName` instead of by module
// factory, so callers can use A2A-as-protocol without touching their resolution
// path.
// ---------------------------------------------------------------------------

export type CreateInProcessA2AClientInput = {
  packageName: string;
  enqueueJob: EnqueueJobFn;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type InProcessA2AClient = {
  packageName: string;
  templateId: string;
  agentCard: AgentCard;
  sendMessage(input: { text?: string; json?: unknown }): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
};

export async function createInProcessA2AClient(
  input: CreateInProcessA2AClientInput,
): Promise<InProcessA2AClient> {
  const { templateId, packageName } = await resolveAgentByPackageName(
    input.packageName,
  );
  const bundle = createA2AServerForAgent({
    templateId,
    packageName,
    enqueueJob: input.enqueueJob,
    pollIntervalMs: input.pollIntervalMs,
    pollTimeoutMs: input.pollTimeoutMs,
  });
  const transport = new InProcessTransport(bundle.handler, bundle.agentCard);

  return {
    packageName,
    templateId,
    agentCard: bundle.agentCard,
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
      // DefaultRequestHandler returns a Task or Message for non-streaming
      // sendMessage. Virtual agents always resolve to a Task — narrow defensively.
      if (!result || (result as { kind?: string }).kind !== "task") {
        throw new Error(
          `createInProcessA2AClient.sendMessage: expected Task result, got ${JSON.stringify(result)}`,
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
