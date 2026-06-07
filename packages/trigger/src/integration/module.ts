import "server-only";

import { registerTriggerPrimitives } from "../mcp/registry";

// ---------------------------------------------------------------------------
// Host wiring for @cinatra-ai/trigger.
// Mirrors the createSkillsModule() / createAgentBuilderModule() shape used
// by src/lib/mcp-server.ts.
// ---------------------------------------------------------------------------

export function createTriggerModule() {
  return {
    createDeterministicClient() {
      return null;
    },
    registerCapabilities: registerTriggerPrimitives,
  };
}
