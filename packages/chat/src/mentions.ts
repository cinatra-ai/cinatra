import "server-only";

import { and, eq } from "drizzle-orm";
import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";
import type { Mention } from "./types";
// parseMentions and RawMention live in the pure module (no server-only/DB imports).
// Re-export parseMentions so existing callers (actions.ts, chat-page.tsx) keep working.
export { parseMentions } from "./mentions-pure";
import { parseMentions, type RawMention } from "./mentions-pure";

// ---------------------------------------------------------------------------
// resolveMentions — resolve @handles to assistant user ids
// ---------------------------------------------------------------------------

export async function resolveMentions(raw: RawMention[]): Promise<Mention[]> {
  if (raw.length === 0) return [];

  // Fetch all assistant users — the set is small and changes rarely
  const users = await betterAuthDb
    .select({ id: betterAuthUsers.id, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.userType, "assistant")));

  const byHandle = new Map(
    users.filter((u) => u.username).map((u) => [u.username!.toLowerCase(), u.id]),
  );

  return raw
    .map((r): Mention | null => {
      const id = byHandle.get(r.handle);
      return id ? { handle: r.handle, assistantUserId: id, offset: r.offset, length: r.length } : null;
    })
    .filter((m): m is Mention => m !== null);
}

// ---------------------------------------------------------------------------
// resolveAssistantsByIds — reverse lookup: userId[] → Mention[]
// Used for broadcast dispatch when taggedAssistantUserIds are known but handles aren't.
// ---------------------------------------------------------------------------

export async function resolveAssistantsByIds(ids: string[]): Promise<Mention[]> {
  if (ids.length === 0) return [];

  const users = await betterAuthDb
    .select({ id: betterAuthUsers.id, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.userType, "assistant")));

  return ids
    .map((id): Mention | null => {
      const user = users.find((u) => u.id === id);
      return user?.username
        ? { handle: user.username.toLowerCase(), assistantUserId: id, offset: 0, length: 0 }
        : null;
    })
    .filter((m): m is Mention => m !== null);
}

// ---------------------------------------------------------------------------
// resolveMentionsWithDefault
// Returns at least one mention. If no @mentions found, injects @cinatra.
// Returns [] only when @cinatra itself is unresolvable.
// ---------------------------------------------------------------------------

export async function resolveMentionsWithDefault(content: string): Promise<Mention[]> {
  const raw = parseMentions(content);
  if (raw.length > 0) {
    return resolveMentions(raw);
  }

  // No explicit mention — fall back to @cinatra
  const cinatra = await betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.username, "cinatra"), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);

  if (!cinatra[0]) {
    // @cinatra not seeded yet — no routing
    return [];
  }

  return [
    {
      handle: "cinatra",
      assistantUserId: cinatra[0].id,
      offset: 0,
      length: 0, // synthetic — not present in content
    },
  ];
}
