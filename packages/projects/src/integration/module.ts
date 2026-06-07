import "server-only";
import { registerProjectsPrimitives } from "../mcp/registry";

// ---------------------------------------------------------------------------
// Host wiring for @cinatra-ai/projects.
// Mirrors the createTriggerModule() / createObjectsModule() shape used by
// src/lib/mcp-server.ts.
// ---------------------------------------------------------------------------

export function createProjectsModule() {
  return {
    createDeterministicClient() {
      return null;
    },
    registerCapabilities: registerProjectsPrimitives,
  };
}
