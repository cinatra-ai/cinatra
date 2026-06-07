import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { registerExtensionsPrimitives } from "./registry";

// ---------------------------------------------------------------------------
// Module factory for the extensions MCP tools.
// Registered in src/lib/mcp-server.ts.
// ---------------------------------------------------------------------------

export function createExtensionsModule() {
  return {
    async registerCapabilities(server: McpRuntimeToolServer) {
      await registerExtensionsPrimitives(server);
    },
  };
}
