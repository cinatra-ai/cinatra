import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, eq, inArray, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import { WIDGET_PARTICIPANTS_GRANT } from "@/lib/widget-conversation-grants";
import {
  betterAuthDb,
  betterAuthMembers,
  betterAuthUsers,
  lookupAssistantHandlesByIds,
} from "@/lib/better-auth-db";

export const dynamic = "force-dynamic";

/** Derive a GitLab-style ASCII handle: lowercase, spaces→_, strip non-[a-z0-9_-].
 * Humans are not in the handle registry, so their display handle is still derived
 * here; ASSISTANT handles come from the registry below (the authoritative,
 * collision-suffixed handle mention resolution matches). */
function toHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+|[_-]+$/g, "") || "unknown";
}

// TWO AUTH BRANCHES (cinatra#2683, epic #2564 S8f opened the second), on the
// pattern `/api/lifecycle-views/resolve` established.
//
// The widget's composer draws the SAME @-mention flyout `/chat` draws — it always
// could; what it lacked was a list to draw. That list is this reader, and it is
// the reader itself that makes the widget safe to point at it: the directory is
// tenant-scoped by a PROVEN current membership, so a widget session enumerates
// exactly the co-members its holder enumerates in the app, and nothing else.
//
// The BRANCH is decided by the presented credential and never falls back: this
// route is same-origin to the embed frame, so a failed widget consume must 401
// rather than drop to an ambient cookie, which would enumerate somebody else's
// organization into a third-party site's chrome.
export async function GET(request: Request) {
  let callerUserId: string;
  let activeOrgId: string | null;

  if (isWidgetBranchRequest(request)) {
    const authed = await authenticateWidgetConversationRequest(
      request,
      WIDGET_PARTICIPANTS_GRANT,
    );
    if (!authed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    callerUserId = authed.claims.userId;
    // The org the TOKEN is bound to — never a session's active org. The
    // membership proof below still runs against it, exactly as it does for a
    // cookie caller whose `activeOrganizationId` may be stale.
    activeOrgId = authed.claims.orgId;
  } else {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    callerUserId = session.user.id;
    activeOrgId = session.session?.activeOrganizationId ?? null;
  }

  // Tenant-scope the human directory: a caller may only enumerate other HUMAN
  // users who are co-members of their active organization. Built-in assistant
  // bots (userType = "assistant", e.g. @cinatra) are platform-global — they
  // carry no membership row — so they are always included. Fail closed to
  // assistants-only unless the caller PROVES a current membership row in their
  // active org (a stale `activeOrganizationId` from a since-revoked membership
  // must not grant enumeration of that org's users).
  let scopedOrgId: string | null = null;
  if (activeOrgId) {
    const callerMembership = await betterAuthDb
      .select({ userId: betterAuthMembers.userId })
      .from(betterAuthMembers)
      .where(
        and(
          eq(betterAuthMembers.organizationId, activeOrgId),
          eq(betterAuthMembers.userId, callerUserId),
        ),
      )
      .limit(1);
    if (callerMembership.length > 0) scopedOrgId = activeOrgId;
  }
  const coOrgMemberIds = scopedOrgId
    ? betterAuthDb
        .select({ userId: betterAuthMembers.userId })
        .from(betterAuthMembers)
        .where(eq(betterAuthMembers.organizationId, scopedOrgId))
    : null;
  const directoryFilter = coOrgMemberIds
    ? or(
        eq(betterAuthUsers.userType, "assistant"),
        inArray(betterAuthUsers.id, coOrgMemberIds),
      )
    : eq(betterAuthUsers.userType, "assistant");

  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      username: betterAuthUsers.username,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
      userType: betterAuthUsers.userType,
    })
    .from(betterAuthUsers)
    .where(directoryFilter);

  // Authoritative assistant handles come from the registry (cinatra#1037 P1.2) so
  // the picker shows exactly what mention resolution will match. Humans keep the
  // derived slug (they are not registry principals).
  const assistantIds = rows.filter((r) => r.userType === "assistant").map((r) => r.id);
  const registryHandles = await lookupAssistantHandlesByIds(assistantIds);

  const mentionables = rows
    .filter((r) => r.id !== callerUserId) // exclude current user
    .map((r) => {
      const isAssistant = r.userType === "assistant";
      // displayName: prefer name for humans, username for bots
      const displayName = isAssistant
        ? (r.username?.trim() ?? r.name?.trim() ?? r.email?.split("@")[0] ?? null)
        : (r.name?.trim() ?? r.username?.trim() ?? r.email?.split("@")[0] ?? null);
      if (!displayName) return null;
      // handle: assistants use the registry handle ONLY (authoritative — never
      // advertise a derived slug that mention resolution would reject); an
      // assistant not yet backfilled is omitted until its handle is minted (boot
      // backfill / assistant-agent registration). Humans (not registry principals) derive.
      const handleSource = r.username?.trim() || r.name?.trim() || r.email?.split("@")[0] || "";
      const handle = isAssistant ? registryHandles.get(r.id) : toHandle(handleSource);
      if (!handle || handle === "unknown") return null;
      return {
        id: r.id,
        handle,
        displayName,
        type: isAssistant ? ("assistant" as const) : ("user" as const),
        image: r.image ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return NextResponse.json({ assistants: mentionables });
}
