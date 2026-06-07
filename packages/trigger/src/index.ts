// ---------------------------------------------------------------------------
// @cinatra-ai/trigger — public surface.
//
// Provider package for the trigger_config_get / _set / _delete MCP primitives
// consumed by @cinatra-ai/trigger-agent.
// ---------------------------------------------------------------------------

export { triggerPrimitiveMetadata } from "./mcp/metadata";
export type { TriggerPrimitiveMetadata } from "./mcp/metadata";
export { createTriggerHandlers } from "./mcp/handlers";
export {
  triggerConfigSetSchema,
  runIdSchema,
} from "./mcp/schemas";
export type { TriggerConfigSetInput, RunIdInput } from "./mcp/schemas";
