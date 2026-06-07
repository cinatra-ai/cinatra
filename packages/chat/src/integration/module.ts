import "server-only";

import { registerChatPrimitives } from "../mcp/registry";

export function createChatModule() {
  return {
    createDeterministicClient() {
      return null;
    },
    registerCapabilities: registerChatPrimitives,
  };
}
