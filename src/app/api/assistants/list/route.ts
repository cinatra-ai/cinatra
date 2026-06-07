import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";

export const dynamic = "force-dynamic";

/** Derive a GitLab-style ASCII handle: lowercase, spaces→_, strip non-[a-z0-9_-] */
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

  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      username: betterAuthUsers.username,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
      userType: betterAuthUsers.userType,
    })
    .from(betterAuthUsers);

  const mentionables = rows
    .filter((r) => r.id !== session.user.id) // exclude current user
    .map((r) => {
      const isAssistant = r.userType === "assistant";
      // displayName: prefer name for humans, username for bots
      const displayName = isAssistant
        ? (r.username?.trim() ?? r.name?.trim() ?? r.email?.split("@")[0] ?? null)
        : (r.name?.trim() ?? r.username?.trim() ?? r.email?.split("@")[0] ?? null);
      if (!displayName) return null;
      // handle: ASCII slug derived from username first (already a handle), then name
      const handleSource = r.username?.trim() || r.name?.trim() || r.email?.split("@")[0] || "";
      const handle = toHandle(handleSource);
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
