import "server-only";

// ---------------------------------------------------------------------------
// The MCP tool SCOPE resolver — the ONE place a host MCP tool in `src/lib`
// turns the ambient MCP request context into `{ orgId, userId, actor }`
// (cinatra#1381; extracted verbatim from `src/lib/artifacts/mcp.ts`, which was
// its only home).
//
// It is extracted rather than copied because it is the A2A precedence rule, and
// a second copy of a precedence rule is how two tools end up disagreeing about
// whose organization a call runs in. Both the artifact primitives and the
// memory promotion request tool now resolve through this one function.
//
// FAIL-CLOSED, unchanged from the original: no active organization THROWS
// rather than reading unscoped, and when an A2A identity is present its org
// MUST come from the A2A context — never from the transport, because mixing an
// A2A identity with a transport scope is exactly a cross-tenant read.
// ---------------------------------------------------------------------------

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

export function resolveScope(): {
  orgId: string;
  userId: string | null;
  actor: ActorContext;
} {
  const ctx = mcpRequestContextStorage.getStore();
  // a2a precedence (mirrors packages/agents/src/mcp/registry.ts).
  const a2a = ctx?.a2aActorContext;
  const userId = a2a?.userId ?? ctx?.userId ?? null;
  // A2A precedence is fail-closed: when an A2A identity is present its
  // org MUST come from the A2A context; we never fall back to the transport
  // org because that would mix A2A identity with transport scope. Only a
  // non-A2A call uses the transport org.
  const orgId = (a2a ? a2a.orgId : ctx?.orgId) ?? null;
  if (!orgId) {
    throw new Error(
      "host MCP tool: no active organization (fail-closed — refusing an unscoped read/write" +
        (a2a ? "; A2A context carries no orgId" : "") +
        ")",
    );
  }
  const platformRole = ctx?.platformRole;
  const primitive = {
    actorType: a2a ? "a2a" : platformRole ? "human" : "model",
    source: a2a ? "a2a" : "agent",
    ...(userId ? { userId } : {}),
    ...(a2a?.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
  } as Parameters<typeof buildActorContextFromPrimitive>[0];
  const actor = buildActorContextFromPrimitive(primitive, orgId, {
    platformRole,
    // Transport-resolved org-membership role, carried natively on the MCP
    // request context. NON-A2A ONLY: it was resolved for the transport
    // identity (ctx.userId/ctx.orgId); the A2A branch's identity comes from
    // a2aActorContext (potentially a different user/org).
    orgRole: a2a ? undefined : ctx?.orgRole,
    actorOrganizationId: orgId,
    teamIds: a2a?.teamIds,
    projectIds: a2a?.projectIds,
    // Pass projectGrants through to buildActorContextFromPrimitive so
    // the canonical axis (owned ∪ accessed, role-by-authority) reaches
    // the kernel ActorContext. projectIds is kept for back-compat
    // (binary shortcuts).
    projectGrants: a2a?.projectGrants,
  }) as unknown as ActorContext;
  return { orgId, userId, actor };
}
