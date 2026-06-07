import "server-only";

import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { registerWorkflowObjectTypes } from "./register-object-types";
import { registerWorkflowPrimitives } from "../mcp/registry";
import type { WorkflowHandlerDeps } from "../mcp/handlers";

/**
 * Host wiring entry. The host injects authz/agent-existence/project-archive deps
 * (which live in @/lib + @cinatra-ai/agents) so the package stays a leaf.
 */
export function createWorkflowsModule(deps: WorkflowHandlerDeps = {}) {
  registerWorkflowObjectTypes();
  return {
    registerCapabilities: (server: McpRuntimeToolServer) =>
      registerWorkflowPrimitives(server, deps),
    createDeterministicClient: () => null,
  };
}
