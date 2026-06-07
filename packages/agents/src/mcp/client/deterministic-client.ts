import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createAgentsPrimitiveHandlers } from "../handlers";
import type { AgentListItem } from "../handlers";

export type DeterministicAgentsClient = ReturnType<typeof createDeterministicAgentsClient>;

export function createDeterministicAgentsClient(input: {
  actor: PrimitiveActorContext;
  transport?: PrimitiveTransport;
}) {
  const transport =
    input.transport ??
    createInProcessPrimitiveTransport(createAgentsPrimitiveHandlers());

  function invoke<TOutput>(primitiveName: string, primitiveInput: unknown) {
    return invokePrimitive<unknown, TOutput>(transport, {
      primitiveName,
      input: primitiveInput,
      actor: input.actor,
      mode: "deterministic",
    });
  }

  return {
    agents: {
      list: () => invoke<AgentListItem[]>("agents_list", {}),
    },
    agent: {
      // Narrow wrapper over the `agent_run` primitive for the
      // agent-launcher portlet. XOR templateId/packageName is enforced by the
      // handler; inputParams is a JSON string. Returns the queued run id (or a
      // structured `{ error }` envelope the handler emits on bad input).
      run: (input: {
        templateId?: string;
        packageName?: string;
        inputParams?: string;
        timeoutSeconds?: number;
      }) => invoke<{ runId: string; status: string } | { error: string }>("agent_run", input),
    },
  };
}
