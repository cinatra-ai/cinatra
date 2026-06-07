import "server-only";
import type { ActorContext } from "@/lib/authz/actor-context";
import { createDeterministicObjectsClient } from "./mcp/client/deterministic-client";
import { actorContextToObjectsEnvelope } from "./objects-actor-envelope";

export { actorContextToObjectsEnvelope } from "./objects-actor-envelope";
export type { ObjectsActorEnvelope } from "./objects-actor-envelope";

/**
 * Default singleton — used by code paths that have no session context.
 * Falls back to mcpRequestContextStorage AsyncLocalStorage in handlers.ts:50
 * for orgId resolution. KEPT for sessionless / ALS-frame callers.
 */
export const objectsClient = createDeterministicObjectsClient({
  actor: { actorType: "human", source: "ui" },
});

/**
 * Session-aware objects client carrying the FULL authorization actor context
 * (userId, orgId, platform/org role, team roles, project grants) — not a bare
 * `orgId`. This lets the objects handlers apply the same authz the MCP boundary
 * applies: role hints flow into `enforceResourceAccess` and `projectGrants` into
 * the sealed-room read filter. There is intentionally NO `orgId`-only overload —
 * a partial actor would re-open the authz bypass this closes.
 *
 * Usage in a server component:
 *   const actor = await requireActorContext();   // @/lib/auth-session
 *   const client = createSessionObjectsClient(actor);
 *   const { items } = await client.list({ ... });
 *
 * For sessionless / system paths, build an org-scoped System ActorContext
 * (`principalType:"System"`, `organizationId`, no role) — see
 * src/lib/register-email-providers.ts.
 */
export function createSessionObjectsClient(actor: ActorContext) {
  return createDeterministicObjectsClient({
    actor: actorContextToObjectsEnvelope(actor),
  });
}
