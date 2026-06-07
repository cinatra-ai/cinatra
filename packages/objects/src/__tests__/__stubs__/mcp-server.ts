// Test stub for @cinatra-ai/mcp-server.
// Real entry point is packages/mcp-server/src/index.tsx, which imports next/navigation,
// better-auth, react, etc. — none of which can be loaded in a node test runner.
// We only need `mcpRequestContextStorage` for tests that depend on request context,
// so re-export an equivalent AsyncLocalStorage with the same shape declared on main
// (packages/mcp-server/src/index.tsx:480).
// Includes run-context provenance fields (runId, agentId, packageVersion,
// agentSpecVersion) so objects-layer tests can simulate the transport-handler
// injection path.
import { AsyncLocalStorage } from "node:async_hooks";

export const mcpRequestContextStorage = new AsyncLocalStorage<{
  clientId?: string;
  orgId?: string | null;
  userId?: string | null;
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
}>();

// Type-only shim — real type is from @modelcontextprotocol/server.
export type McpRuntimeToolServer = {
  registerTool: (name: string, meta: unknown, handler: (input: unknown) => Promise<unknown>) => void;
};
