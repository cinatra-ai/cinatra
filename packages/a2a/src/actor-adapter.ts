import "server-only";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  readAgentRunById,
  readAgentRunByTaskId,
  type AgentRunRecord,
} from "@cinatra-ai/agents";
import { getActorContext } from "@cinatra-ai/llm/actor-context";

// ---------------------------------------------------------------------------
// Actor binding for the A2A read paths (confused-deputy authorization fix).
//
// The A2A route resolves a verified ActorContext and (a) installs it into an
// AsyncLocalStorage frame (withActorContext) AND (b) passes it explicitly on the
// SDK ServerCallContext as `a2aActorContext`. The read primitives use the
// helpers below to resolve that actor FAIL-CLOSED and authorize the requested
// A2A task before reading/replaying it.
//
// IMPORTANT (codex Group-C finding): the SDK iterates streaming generators
// (tasks/resubscribe) LAZILY, AFTER the route's `withActorContext(...)` wrapper
// has already returned — so the ALS frame is NOT reliably active during
// iteration. The authoritative source is therefore the EXPLICIT
// `context.a2aActorContext`; the ALS frame is only a fallback for the
// synchronous (tasks/get) path. Both fail closed when neither is present.
// ---------------------------------------------------------------------------

/**
 * Narrow ActorContext -> PrimitiveActorContext adapter. Preserves the verified
 * principal classification (codex seed-caution #3) rather than collapsing to
 * "system":
 *   HumanUser        -> "human" (userId set so the owner short-circuit matches)
 *   ServiceAccount   -> "model" (round-trips back to ServiceAccount in
 *                       buildActorContextFromPrimitive, NOT ExternalA2AAgent)
 *   ExternalA2AAgent -> "a2a"
 *   InternalWorker / System -> "system"
 * userId/orgId/tokenScopes/platformRole/orgRole are carried so the owner /
 * co-owner / cross-org / token-scope gates stay load-bearing.
 */
export function primitiveActorFromActorContext(
  actor: ActorContext,
): PrimitiveActorContext {
  let actorType: PrimitiveActorContext["actorType"];
  switch (actor.principalType) {
    case "HumanUser":
      actorType = "human";
      break;
    case "ServiceAccount":
      actorType = "model";
      break;
    case "ExternalA2AAgent":
      actorType = "a2a";
      break;
    default:
      actorType = "system";
      break;
  }
  return {
    actorType,
    source: "a2a",
    userId: actor.principalId,
    orgId: actor.organizationId ?? null,
    tokenScopes: actor.tokenScopes,
    platformRole: actor.platformRole,
    orgRole: actor.orgRole,
  };
}

/**
 * Resolve the verified actor for an A2A read path, FAIL-CLOSED. Prefers the
 * explicit `context.a2aActorContext` (survives lazy generator iteration), then
 * the ALS frame (synchronous paths). Throws when neither is available so a read
 * path can never proceed without a verified principal.
 */
export function requireA2AActor(context?: unknown): PrimitiveActorContext {
  const fromContext = (context as { a2aActorContext?: ActorContext } | undefined)
    ?.a2aActorContext;
  const actorContext = fromContext ?? getActorContext();
  if (!actorContext) {
    throw new A2AActorMissingError();
  }
  return primitiveActorFromActorContext(actorContext);
}

/** Thrown when no verified actor can be resolved for a read path. */
export class A2AActorMissingError extends Error {
  readonly statusCode = 403 as const;
  readonly reason = "forbidden" as const;
  constructor() {
    super("A2A read denied: no verified actor context.");
    this.name = "A2AActorMissingError";
  }
}

/**
 * Resolve an A2A id to its agent_run and AUTHORIZE run.read for `actor`,
 * fail-closed. The A2A id may be EITHER the agent_runs PK
 * (`run.id`, used by the synthesized terminal-task recovery path) OR the
 * separate A2A task id persisted in `agent_runs.a2a_task_id` (live tasks created
 * by InProcessAgentExecutor — taskId !== run.id). Try both forms, then enforce
 * run.read against the resolved run. Returns the authorized run, or null when no
 * run matches either id. Throws AuthzError when a run matches but the actor may
 * not read it (no existence leak: 404 hidden / 403 forbidden).
 */
export async function resolveAuthorizedRunForA2AId(
  a2aId: string,
  actor: PrimitiveActorContext,
): Promise<AgentRunRecord | null> {
  // Locate the run by either id form WITHOUT enforcement first. readAgentRunByTaskId
  // matches a2a_task_id (live tasks: taskId !== run.id); a PK match falls back to
  // readAgentRunById (terminal-recovery path uses run.id as the task id).
  let resolved = await readAgentRunByTaskId(a2aId);
  if (!resolved) {
    // No actor here: this is only an existence probe by PK. Authorization is
    // enforced below via the actor-aware readAgentRunById(run.id, actor).
    resolved = await readAgentRunById(a2aId);
  }
  if (!resolved) return null;
  // Authorize run.read by RE-READING via the actor-aware overload, keyed on the
  // canonical run.id. readAgentRunById(id, actor) internally loads co-owners +
  // effective policy and calls enforceRunAccess(...,"read"), so this applies the
  // SAME owner / co-owner / token-scope / policy gating as every other read path
  // (and throws AuthzError 404-hidden / 403-forbidden on deny — no leak).
  return await readAgentRunById(resolved.id, actor);
}
