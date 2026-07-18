import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, eq, inArray, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
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

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Tenant-scope the human directory: a caller may only enumerate other HUMAN
  // users who are co-members of their active organization. Built-in assistant
  // bots (userType = "assistant", e.g. @cinatra) are platform-global — they
  // carry no membership row — so they are always included. Fail closed to
  // assistants-only unless the caller PROVES a current membership row in their
  // active org (a stale `activeOrganizationId` from a since-revoked membership
  // must not grant enumeration of that org's users).
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  let scopedOrgId: string | null = null;
  if (activeOrgId) {
    const callerMembership = await betterAuthDb
      .select({ userId: betterAuthMembers.userId })
      .from(betterAuthMembers)
      .where(
        and(
          eq(betterAuthMembers.organizationId, activeOrgId),
          eq(betterAuthMembers.userId, session.user.id),
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
    .filter((r) => r.id !== session.user.id) // exclude current user
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
