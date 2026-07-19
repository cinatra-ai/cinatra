import "server-only";

// S5-W1 §5 — resolve the trusted `public_site_widget` delegated actor for the
// ACTIVE MCP request frame.
//
// The wordpress/drupal content-editor connectors bind their `resolveWidgetActor`
// deps seam to THIS function (through the `@cinatra-ai/host:content-editor-
// dispatch` capability). It reads the VERIFIED delegated actor the MCP transport
// boundary (packages/mcp-server/src/index.tsx) stamped onto
// `mcpRequestContextStorage` — the SAME trusted store `resolveExtensionActor
// Context()` / the write-authority gate read — and NEVER connector tool input or
// the SDK `request.actor` field. So a connector can never assert or forge the
// widget identity through tool arguments.
//
// Returns `null` on every non-widget turn (cookie chat, agent-run OBO, plain
// bearer, no delegated actor). A non-null result is ALWAYS a `public_site_widget`
// delegation with the server-pinned {runBy, orgId, instanceId} — the connector's
// `*_content_editor_run` reconstructs the pinned `actorOverride` from exactly
// these fields.

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { WidgetActorContext } from "@cinatra-ai/sdk-extensions";

/**
 * Read the trusted widget actor from the live MCP request frame. Synchronous —
 * `mcpRequestContextStorage.getStore()` is an AsyncLocalStorage read; the
 * connector deps seam (`() => WidgetActorContext | null`) is sync by contract.
 */
export function resolveWidgetActorFromFrame(): WidgetActorContext | null {
  const ctx = mcpRequestContextStorage.getStore();
  const actor = ctx?.delegatedActor;
  if (!actor || actor.delegation !== "public_site_widget") return null;
  // The union already narrows the widget branch to {userId, orgId, instanceId,
  // kind, platformRole:"member", jti}. Project ONLY the fields the connector's
  // WidgetActorContext contract exposes (the kind is enforced at the boundary's
  // kind-keyed tool policy, so the connector override does not re-carry it).
  return {
    delegation: "public_site_widget",
    runBy: actor.userId,
    orgId: actor.orgId,
    instanceId: actor.instanceId,
  };
}
