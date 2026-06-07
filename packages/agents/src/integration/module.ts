import "server-only";

import { registerAgentBuilderObjectTypes } from "./register-object-types";
import { registerAgentBuilderPrimitives } from "../mcp/registry";
import { createDeterministicAgentsClient } from "../mcp/client/deterministic-client";

export function createAgentsModule() {
  registerAgentBuilderObjectTypes();
  return {
    createDeterministicClient() {
      return createDeterministicAgentsClient({
        actor: { actorType: "human" as const, source: "ui" as const },
      });
    },
    registerCapabilities: registerAgentBuilderPrimitives,
  };
}
