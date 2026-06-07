import "server-only";

import type { ActorContext } from "./types";
import { getNotificationsHostAdapters } from "./host-adapters";

// ---------------------------------------------------------------------------
// Resolve an ActorContext from the current request scope.
//
// This is the third tier of `enqueueBackgroundJob`'s auto-attribution cascade:
//   1. explicit options.actorContext
//   2. getActorContext() ALS frame (HumanUser only)
//   3. resolveRequestActorContext() - reads better-auth session
//
// next/headers throws when called outside a request context (background
// workers, instrumentation cron, tests). The host-supplied auth adapters are
// lazy async wrappers, so host auth imports stay off the notifications package
// boot graph. The try/catch keeps this helper safe to call from anywhere; it
// returns undefined when no request context is available.
//
// `ActorContext` is the package-local full shape re-exported by ./types from
// host-adapters.ts. There is no `@/lib/authz/actor-context` (`@/`) import here.
//
// Always uses the host-supplied buildActorContext() (wraps
// src/lib/authz/enforce.ts) to get the canonical platformRole semantics
// (comma-trim of session.user.role) so the attributed ctx matches every
// other authz path.
// ---------------------------------------------------------------------------
export async function resolveRequestActorContext(): Promise<
  ActorContext | undefined
> {
  try {
    const host = getNotificationsHostAdapters();
    const session = await host.getAuthSession();
    if (!session?.user?.id) return undefined;
    return await host.buildActorContext(session);
  } catch {
    // headers()/getAuthSession() raised; we're not in a request scope.
    return undefined;
  }
}
