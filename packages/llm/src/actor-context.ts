/**
 * AsyncLocalStorage carrier for the triggering ActorContext.
 *
 * This module belongs in @cinatra-ai/llm so all four LLM entry
 * points can wrap their bodies in a frame and downstream MCP handlers /
 * BullMQ workers / A2A callbacks can read the originating actor without the
 * caller threading it through every argument.
 *
 * IMPORTANT: This module must NOT import from `@/lib/database`,
 * `@/lib/drizzle-store`, or any app-layer DB modules. Doing so pulls the
 * entire app server graph into the package and breaks isolation. Only the
 * pure type from `@/lib/authz/actor-context` is referenced.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ActorContext } from "@/lib/authz/actor-context";

export const actorContextStorage = new AsyncLocalStorage<ActorContext>();

/**
 * Run `fn` inside an ALS frame populated with `ctx`. Nested calls override
 * the inner frame for the duration of the inner callback only.
 */
export function withActorContext<T>(
  ctx: ActorContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return actorContextStorage.run(ctx, fn);
}

/**
 * Returns the current frame's ActorContext, or `undefined` if no frame is
 * active. Use this from non-MCP code paths that can tolerate an absent
 * frame (e.g., direct LLM calls without a triggering principal).
 */
export function getActorContext(): ActorContext | undefined {
  return actorContextStorage.getStore();
}

/**
 * Fail-closed accessor. Throws an Error with `code:
 * "ACTOR_CONTEXT_MISSING"` when called outside an ALS frame. MCP handlers
 * that filter by scope MUST use this — never `getActorContext()` — so a
 * missing frame becomes a structured error rather than a silent
 * unscoped read.
 */
export function getActorContextOrThrow(): ActorContext {
  const ctx = actorContextStorage.getStore();
  if (!ctx) {
    const err = new Error("ActorContext is required for this operation");
    (err as Error & { code: string }).code = "ACTOR_CONTEXT_MISSING";
    throw err;
  }
  return ctx;
}
