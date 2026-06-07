import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for the crm-connector's request-actor resolution
// (SDK-only decouple).
//
// The crm-connector's MCP handlers import `mcpRequestContextStorage` indirectly:
// rather than reaching @cinatra-ai/mcp-server by name to read the current
// request's identity and mint the actor-scoped objects_save pointer-write actor,
// they resolve the identity through the SDK's host-injected
// `requireCrmRequestActorResolver()` DI slot, which this module binds at boot.
//
// This file imports ONLY the SDK setter + the host @cinatra-ai/mcp-server
// AsyncLocalStorage (a `packages/` host-infra module, not an extension), so it
// adds NO core→extension edge. Pure-SDK-contract binding (the preferred IoC
// mechanism). Auto-registers on import; src/instrumentation.node.ts imports it at
// boot.
// ---------------------------------------------------------------------------

import { setCrmRequestActorResolver } from "@cinatra-ai/sdk-extensions";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

setCrmRequestActorResolver({
  getActor() {
    const store = mcpRequestContextStorage.getStore();
    if (!store) return null;
    // Pass the request identity through VERBATIM: userId/orgId/platformRole.
    // Returning null outside an MCP request frame matches the connector's
    // `getStore()`-undefined fallback to a userless model actor.
    return {
      userId: store.userId ?? null,
      orgId: store.orgId ?? null,
      platformRole: store.platformRole,
    };
  },
});
