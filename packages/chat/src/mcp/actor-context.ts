import "server-only";

import { resolveAssistantUserByClientId } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedActor = {
  actorType: string;
  source: string;
  userId?: string;
  clientId?: string;
  userType?: "human" | "assistant";
};

// ---------------------------------------------------------------------------
// resolveActorFromRequest
//
// Reads the request envelope to determine who is calling.
// - If actor.userId is already set and actor.userType is set, trust them.
// - If actor.clientId is set, resolve it to an assistant user via DB lookup.
// - Otherwise, return the legacy default (model/agent with no user context).
//
// NOTE — TODO(mcp-actor-plumbing): The current MCP SDK registry passes a
// hardcoded actor = { actorType: "model", source: "agent" } in registry.ts.
// Until the MCP request pipeline exposes JWT claims to handlers, callers
// can inject clientId/userId via the actor object or via input.__actor.
// ---------------------------------------------------------------------------

export async function resolveActorFromRequest(
  request: { actor?: Record<string, unknown>; input?: Record<string, unknown> },
): Promise<ResolvedActor> {
  const actor = request.actor ?? {};

  // Prefer explicit actor.userId + userType (already resolved upstream)
  if (typeof actor.userId === "string" && actor.userId) {
    return {
      actorType: String(actor.actorType ?? "model"),
      source: String(actor.source ?? "agent"),
      userId: actor.userId,
      clientId: typeof actor.clientId === "string" ? actor.clientId : undefined,
      userType: actor.userType === "assistant" ? "assistant" : "human",
    };
  }

  // Try to resolve via clientId (MCP client_credentials path)
  const clientId = typeof actor.clientId === "string" ? actor.clientId : undefined;
  if (clientId) {
    const user = await resolveAssistantUserByClientId(clientId);
    if (user) {
      return {
        actorType: String(actor.actorType ?? "model"),
        source: String(actor.source ?? "agent"),
        userId: user.id,
        clientId,
        userType: "assistant",
      };
    }
  }

  // Check input.__actor for injected context (future plumbing hook)
  const inputActor = request.input?.__actor;
  if (inputActor && typeof inputActor === "object" && !Array.isArray(inputActor)) {
    const ia = inputActor as Record<string, unknown>;
    if (typeof ia.clientId === "string" && ia.clientId) {
      const user = await resolveAssistantUserByClientId(ia.clientId);
      if (user) {
        return {
          actorType: "model",
          source: "agent",
          userId: user.id,
          clientId: ia.clientId,
          userType: "assistant",
        };
      }
    }
  }

  // Legacy default — no user context
  return {
    actorType: String(actor.actorType ?? "model"),
    source: String(actor.source ?? "agent"),
  };
}
