// Re-exports the canonical mcpRequestContextStorage and McpRequestContext type
// from the MCP server package. This file is kept as a stable re-export path
// so that any future importers from src/lib/ get the real AsyncLocalStorage
// instance rather than a dead parallel one.
export { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

// Single import path for app-layer call sites that need the ActorContext ALS
// frame. Re-exports the canonical helpers from the llm package
// so we don't sprinkle workspace imports across app code.
export {
  withActorContext,
  getActorContext,
  getActorContextOrThrow,
} from "@cinatra-ai/llm";
