import { NextResponse } from "next/server";

import { getAuthSession } from "@/lib/auth-session";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsReadByHrefPrefix,
} from "@/lib/notifications";

/**
 * Notifications API — per-user, session-required.
 *
 * This route returns a per-user Postgres-backed notification list, and the
 * user is derived from the better-auth session server-side. Unauthenticated
 * clients receive 401 — a UI shell behind the sign-in gate already covers
 * this, but the explicit check defends against direct fetches.
 *
 * In-progress background tasks live in the same Postgres-backed
 * `notifications` table with `metadata.category = "background_process"`,
 * written at worker.on("active") time by `notifyJobStarted` in
 * `src/lib/background-jobs.ts`. The flyout's `collapseByJobId` helper
 * merges running + terminal rows by `sourceJobId`. The asset-blog modal
 * keeps its own separate state path (see `@cinatra-ai/sdk-ui`
 * background-process modal).
 */
async function requireUserId(): Promise<string | NextResponse> {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session.user.id;
}

export async function GET() {
  const userIdOrResponse = await requireUserId();
  if (typeof userIdOrResponse !== "string") return userIdOrResponse;
  const notifications = await listNotifications();
  return NextResponse.json({ notifications });
}

export async function PATCH(request: Request) {
  const userIdOrResponse = await requireUserId();
  if (typeof userIdOrResponse !== "string") return userIdOrResponse;
  const body = (await request.json().catch(() => null)) as
    | { id?: string; href?: string; all?: boolean }
    | null;
  if (body?.all) {
    await markAllNotificationsRead();
    return NextResponse.json({ ok: true });
  }
  if (body?.id) {
    await markNotificationRead(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body?.href) {
    await markNotificationsReadByHrefPrefix(body.href);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(
    { error: "Notification id or href is required." },
    { status: 400 },
  );
}
