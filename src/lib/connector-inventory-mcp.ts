import "server-only";

// ---------------------------------------------------------------------------
// The connector-inventory MCP capability module (cinatra#2723).
//
// ONE read-only primitive: `connector_inventory_list`. It lives in a
// CORE/PLATFORM capability module — platform inventory is a HOST capability,
// not any one connector's — and is composed into the registration pass in
// `src/lib/mcp-server.ts`.
//
// THE SCHEMA TAKES NO SCOPE OR ACTOR INPUTS, and that is the whole injection
// story. A possibly-injected chat LLM cannot ask for another user's, another
// org's, or another scope's inventory, because there is nothing to ask WITH:
// identity is read from the TRUSTED MCP request frame
// (`mcpRequestContextStorage`, via `resolveExtensionActorSummary` /
// `resolveExtensionActorContext`), exactly like `projects_list` takes its
// userId/orgId from that frame rather than from tool input. A cookie session is
// deliberately NOT consulted as a substitute — a delegated chat / worker / A2A
// call carries no cookie, so cookie-only resolution would answer for nobody.
//
// ONE NAME, ONE OWNER. `collectAllPrimitiveHandlers()` (the non-MCP passthrough
// registry) composes handler maps with plain object SPREADS, which overwrite
// silently, and the existing collision guard is scoped to the
// `appointment_schedule_*` family — it does not cover this name. This module is
// the sole registrar of `connector_inventory_list`; the ownership test
// (`src/lib/__tests__/connector-inventory-primitive-ownership.test.ts`) pins
// that against the real tree, including the extension packages on disk.
//
// The result shape, its exclusions, and the per-row authorization boundary are
// documented at the data core: `src/lib/connector-inventory.server.ts`.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";

/** The primitive's name. Registered as a STRING LITERAL below (the authz
 *  inventory builder scans `server.registerTool("<name>"` statically); this
 *  constant exists for the tests that pin name ownership + policy parity. */
export const CONNECTOR_INVENTORY_TOOL_NAME = "connector_inventory_list";

/**
 * The tool's input schema: EMPTY, by design. No scope, no actor, no org, no
 * connector filter — see the module header. `.strict()` so a caller that tries
 * to smuggle one gets a validation failure instead of a silently-ignored field.
 */
export const connectorInventoryListSchema = z.object({}).strict();

/**
 * The model-facing description. It carries the GROUNDING half of cinatra#2723:
 * before this tool existed the only honest answer was "I cannot read the
 * connector inventory from chat", and the assistant instead implied the
 * negative ("no configured live connector accounts") whenever a connector had
 * no operational tool. The description now says what an empty answer means, so
 * the model has no reason to reach for the negative.
 */
export const CONNECTOR_INVENTORY_TOOL_DESCRIPTION =
  "List this workspace's connector inventory: every catalog connector with its " +
  "display name and whether the CALLING USER holds a `use` grant on at least one " +
  "live connection for it, plus the authorized connection ids behind that. " +
  "Read-only. Takes no arguments — scope and identity come from the request " +
  "context, never from input. Use this to answer 'which connectors are " +
  "connected/live?'. IMPORTANT: `hasAuthorizedConnection: false` means 'no " +
  "connection YOU are authorized to use' — it does NOT mean nobody has " +
  "connected that connector, so never report it as 'nothing is connected'. " +
  "A connector may hold NO connection of its own and work off another " +
  "connector's: when `consumesConnectionFrom` names a connector, this row's " +
  "`hasAuthorizedConnection` is read from THAT connector's connection, so true " +
  "means its tools work for you and false means the named connector is what " +
  "needs connecting. Such a connector has no connect road of its own — never " +
  "tell the user to connect it; name the connector it consumes instead. " +
  "`consumesConnectionFrom: null` means the connector holds its own connection. " +
  "Returns no credentials, tokens, secret refs, or raw connection identifiers.";

function registerConnectorInventoryPrimitive(server: McpRuntimeToolServer) {
  server.registerTool(
    "connector_inventory_list",
    {
      title: "connector_inventory_list",
      description: CONNECTOR_INVENTORY_TOOL_DESCRIPTION,
      inputSchema: connectorInventoryListSchema,
    },
    (async () => {
      // Lazily imported so the host graph this reaches (pg identity store,
      // permissions store, connector catalog registry) stays off the MCP
      // server's static module graph.
      const { buildConnectorInventoryForCurrentActor } = await import(
        "@/lib/connector-inventory.server"
      );
      const result = await buildConnectorInventoryForCurrentActor();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

export function createConnectorInventoryMcpModule() {
  return { registerCapabilities: registerConnectorInventoryPrimitive };
}
