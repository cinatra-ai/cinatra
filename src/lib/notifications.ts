// ---------------------------------------------------------------------------
// Notifications — compat surface for the Postgres-backed service layer.
//
// The 5 public functions below preserve their original signatures. All work
// delegates through @cinatra-ai/notifications/server; implementation lives in packages/notifications/src/service.ts.
//
// User resolution:
//   - Browser/API/page callers: better-auth session via getAuthSession()
//   - Worker callers (no HTTP session): the ActorContext ALS frame attached
//     by enqueueBackgroundJob() carries the initiator's user id. If neither
//     is available, list/mark operations return [] / no-op (safe defaults),
//     and createNotification falls back to a platform-admins fanout.
//
// BullMQ worker hooks prefer the explicit `createNotificationForRecipient`
// path with a resolved policy. The legacy
// `createNotification(input)` entrypoint stays for in-job calls already
// present in packages/asset-blog/src/generation.ts and the connector code.
// ---------------------------------------------------------------------------

import "server-only";

// Side-effect import — registers the notifications host adapters before the
// FIRST @cinatra-ai/notifications/server use on the facade entry path. This
// is a permitted top-level @/lib host import (NOT the @cinatra-ai/notifications
// package); the facade is not boot-reachable from instrumentation.node.ts, and
// notifications-host.ts itself pulls only the TRUE-LEAF
// @cinatra-ai/notifications/host-adapters.
import "@/lib/notifications-host";

// `@cinatra-ai/llm` (getActorContext) is a heavy server graph
// and is ONLY needed by the BullMQ worker fallback. It is dynamically imported
// inside resolveWorkerUserId() so page/API/browser callers — which always have
// a session and never reach the worker fallback — do not pull it into their
// cold server module graph.

import { getAuthSession } from "@/lib/auth-session";

import {
  countUnreadForUser,
  createNotificationForRecipient,
  listNotificationsForUser,
  markAllNotificationsReadForUser,
  markNotificationReadForUser,
  markNotificationsReadByHrefPrefixForUser,
} from "@cinatra-ai/notifications/server";
import type {
  AppNotification,
  BackgroundProcess,
  NotificationInput,
  NotificationKind,
  NotificationRecipient,
} from "@cinatra-ai/notifications/types";

// The `AppNotification` + `BackgroundProcess` types moved to
// @cinatra-ai/notifications/types. Re-export them here so every existing
// `import { AppNotification } from "@/lib/notifications"` and
// `import type { AppNotification } from "@/lib/notifications"` compiles
// unchanged (signature-preserving facade).
export type { AppNotification, BackgroundProcess };

// Re-export the explicit-recipient surface for BullMQ hooks + callers that
// already know the routing policy.
export {
  createNotificationForRecipient,
  countUnreadForUser,
} from "@cinatra-ai/notifications/server";
export type {
  NotificationInput,
  NotificationRecipient,
  NotificationKind,
} from "@cinatra-ai/notifications/types";

function toAppNotification(
  record: Awaited<ReturnType<typeof listNotificationsForUser>>[number],
): AppNotification {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    // Pass `info` through instead of folding to `success` — the flyout needs
    // the `info` kind (plus `metadata.progress.status`) to identify
    // background-process running rows.
    kind: record.kind,
    href: record.href,
    createdAt: record.createdAt,
    readAt: record.readAt,
    sourceJobId: record.sourceJobId,
    sourceJobName: record.sourceJobName,
    metadata: record.metadata,
  };
}

async function resolveSessionUserId(): Promise<string | undefined> {
  try {
    const session = await getAuthSession();
    if (session?.user?.id) return session.user.id;
  } catch {
    // No request context — fall through.
  }
  return undefined;
}

async function resolveWorkerUserId(): Promise<string | undefined> {
  // Lazy: only the worker fallback needs llm. Keeps it out of
  // the cold module graph of every page/API route that imports this wrapper.
  // A genuine import failure is unexpected (core workspace dep) and must stay
  // fail-VISIBLE — do not fold it into the same silent catch as the expected
  // "ALS frame not active" path.
  let getActorContext: Awaited<
    typeof import("@cinatra-ai/llm")
  >["getActorContext"];
  try {
    ({ getActorContext } = await import("@cinatra-ai/llm"));
  } catch (err) {
    console.warn(
      "[notifications] worker-fallback: @cinatra-ai/llm import failed:",
      err,
    );
    return undefined;
  }

  try {
    const actor = getActorContext();
    // Only HumanUser principals carry a real user id. InternalWorker /
    // ServiceAccount / System / ExternalA2AAgent are not end users and must
    // not receive user-scoped notifications via the worker fallback.
    if (actor?.principalType === "HumanUser" && actor.principalId) {
      return actor.principalId;
    }
  } catch {
    // Expected: ALS frame not active outside a worker actor context.
  }
  return undefined;
}

async function resolveCurrentUserId(): Promise<string | undefined> {
  const sessionUserId = await resolveSessionUserId();
  if (sessionUserId) return sessionUserId;
  // No session — only now (worker context) load the heavy fallback dep.
  return resolveWorkerUserId();
}

// ---------------------------------------------------------------------------
// Public API (preserved signatures)
// ---------------------------------------------------------------------------

export async function listNotifications(): Promise<AppNotification[]> {
  const userId = await resolveCurrentUserId();
  if (!userId) return [];
  const records = listNotificationsForUser(userId);
  return records.map(toAppNotification);
}

/**
 * Session-free variant for callers that have ALREADY resolved the session
 * (e.g. a page that called `requireAuthSession()`). Avoids a redundant
 * second `getAuthSession()` better-auth round-trip + enrichment pass on the
 * same request.
 *
 * Synchronous: `listNotificationsForUser` (from `@cinatra-ai/notifications/server`)
 * runs a single sync pg query.
 */
export function listNotificationsForUserId(userId: string): AppNotification[] {
  if (!userId) return [];
  return listNotificationsForUser(userId).map(toAppNotification);
}

export async function createNotification(input: {
  title: string;
  body: string;
  kind?: AppNotification["kind"];
  href?: string;
}): Promise<void> {
  const userId = await resolveCurrentUserId();
  const payload: NotificationInput = {
    title: input.title,
    body: input.body,
    kind: input.kind,
    href: input.href,
  };
  if (userId) {
    await createNotificationForRecipient(
      { kind: "user", userId } satisfies NotificationRecipient,
      payload,
    );
    return;
  }
  // No user context — fall back to platform admins so system-context calls
  // (e.g. legacy asset-blog/generation.ts) keep producing visible
  // notifications instead of disappearing silently.
  await createNotificationForRecipient(
    { kind: "admins" } satisfies NotificationRecipient,
    payload,
  );
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const userId = await resolveCurrentUserId();
  if (!userId || !notificationId) return;
  markNotificationReadForUser({ userId, notificationId });
}

export async function markNotificationsReadByHrefPrefix(
  hrefPrefix: string,
): Promise<void> {
  const userId = await resolveCurrentUserId();
  if (!userId || !hrefPrefix) return;
  markNotificationsReadByHrefPrefixForUser({ userId, hrefPrefix });
}

export async function markAllNotificationsRead(): Promise<void> {
  const userId = await resolveCurrentUserId();
  if (!userId) return;
  markAllNotificationsReadForUser(userId);
}
