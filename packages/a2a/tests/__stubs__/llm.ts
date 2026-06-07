// Stub for "@cinatra-ai/llm" — vitest alias target.
//
// The real package transitively imports `@cinatra-ai/openai-connector`, which in
// turn imports host-only `@/lib/database` etc. — those aliases are not
// available inside @cinatra-ai/a2a's vitest config, so any import of the real
// module aborts the suite with "Cannot find package '@/lib/database'".
//
// agent-executor.ts only uses `getActorContext` from this package. This stub
// provides that surface plus a real AsyncLocalStorage so that tests which need
// the "no ALS frame" path see `undefined` AND tests which need the "frame with
// org" path can wrap their call in
// `withActorContext({ organizationId: "..." }, fn)`.
//
// Default ctx: a minimal { organizationId: "org-test" } so tests without
// explicit ActorContext setup still reach the happy path. Tests that need the
// missing-org path explicitly call `withActorContext` with a no-org ctx, or
// override this entire module via
// `vi.mock("@cinatra-ai/llm", () => …)` (see
// agent-executor-org-required.test.ts).
import { AsyncLocalStorage } from "node:async_hooks";

export type ActorContextLike = {
  organizationId?: string;
  [key: string]: unknown;
};

export const actorContextStorage = new AsyncLocalStorage<ActorContextLike>();

const DEFAULT_TEST_CTX: ActorContextLike = {
  principalType: "TestStub",
  organizationId: "org-test",
};

export function getActorContext(): ActorContextLike | undefined {
  // If a test wrapped its call in withActorContext, return that ctx.
  const live = actorContextStorage.getStore();
  if (live !== undefined) return live;
  // Otherwise fall back to the test default so legacy tests without explicit
  // ActorContext setup still pass through the executor's org guard.
  return DEFAULT_TEST_CTX;
}

export function getActorContextOrThrow(): ActorContextLike {
  const ctx = getActorContext();
  if (!ctx) {
    const err = new Error("ActorContext is required");
    (err as unknown as { code: string }).code = "ACTOR_CONTEXT_MISSING";
    throw err;
  }
  return ctx;
}

export function withActorContext<T>(
  ctx: ActorContextLike,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return actorContextStorage.run(ctx, fn);
}
