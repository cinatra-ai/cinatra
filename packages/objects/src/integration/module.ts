import "server-only";
import { createDeterministicObjectsClient } from "../mcp/client/deterministic-client";
import { registerObjectsPrimitives } from "../mcp/registry";
import { registerAllObjectTypes } from "./register-types";

export function createObjectsModule() {
  registerAllObjectTypes();
  return {
    createDeterministicClient() {
      return createDeterministicObjectsClient({
        actor: { actorType: "human", source: "ui" },
      });
    },
    registerCapabilities: registerObjectsPrimitives,
  };
}
