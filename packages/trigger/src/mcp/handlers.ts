import "server-only";

// ---------------------------------------------------------------------------
// @cinatra-ai/trigger MCP handlers.
//
// Thin wrappers around the actor-aware trigger service in @cinatra-ai/agents.
// Auth + business logic lives in trigger-service.ts; we only construct the
// actor envelope and delegate. NO duplicate storage code here.
//
// The agent_run_trigger_set / _get / _delete handlers in
// packages/agents/src/mcp/handlers.ts support direct callers. These primitives
// are a parallel surface scoped to the trigger-agent's tool list.
// ---------------------------------------------------------------------------

import {
  setRunTriggerForActor,
  getRunTriggerForActor,
  deleteRunTriggerForActor,
  type TriggerActorContext,
} from "@cinatra-ai/agents";
import type {
  PrimitiveActorContext,
  PrimitiveInvocationRequest,
} from "@cinatra-ai/mcp-client";
import {
  runIdSchema,
  triggerConfigSetSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actorContextFromRequest(
  actor: PrimitiveActorContext | undefined,
): TriggerActorContext | null {
  const userId = actor?.userId;
  if (!userId) return null;
  const role = (actor as { role?: string | null } | undefined)?.role ?? null;
  return { userId, role, source: actor?.source ?? "mcp" };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createTriggerHandlers() {
  return {
    "trigger_config_set": async (
      request: PrimitiveInvocationRequest<unknown>,
    ): Promise<unknown> => {
      const actor = actorContextFromRequest(request.actor);
      if (!actor) return { error: "unauthorized" };
      const args = triggerConfigSetSchema.parse(request.input);
      const result = await setRunTriggerForActor(actor, {
        runId: args.runId,
        triggerType: args.triggerType,
        scheduledAt: args.scheduledAt ?? undefined,
        cronExpression: args.cronExpression ?? undefined,
        timezone: args.timezone,
        enabled: args.enabled,
      });
      if (!result.ok) return { error: result.error };
      return { runId: result.runId, jobSchedulerId: result.jobSchedulerId };
    },

    "trigger_config_get": async (
      request: PrimitiveInvocationRequest<unknown>,
    ): Promise<unknown> => {
      const actor = actorContextFromRequest(request.actor);
      if (!actor) return { error: "unauthorized" };
      const args = runIdSchema.parse(request.input);
      const result = await getRunTriggerForActor(actor, args.runId);
      if (!result.ok) return { error: result.error };
      const trigger = result.trigger;
      if (!trigger) return null;
      return {
        runId: trigger.runId,
        triggerType: trigger.triggerType,
        scheduledAt: trigger.scheduledAt?.toISOString() ?? null,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        enabled: trigger.enabled,
        releasedAt: trigger.releasedAt?.toISOString() ?? null,
        createdAt: trigger.createdAt.toISOString(),
        updatedAt: trigger.updatedAt.toISOString(),
      };
    },

    "trigger_config_delete": async (
      request: PrimitiveInvocationRequest<unknown>,
    ): Promise<unknown> => {
      const actor = actorContextFromRequest(request.actor);
      if (!actor) return { error: "unauthorized" };
      const args = runIdSchema.parse(request.input);
      const result = await deleteRunTriggerForActor(actor, {
        runId: args.runId,
      });
      if (!result.ok) return { error: result.error };
      return { ok: true };
    },
  } as const;
}
