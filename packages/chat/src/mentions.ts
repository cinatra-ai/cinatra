import "server-only";

import {
  resolveAssistantHandles,
  lookupAssistantHandlesByIds,
} from "@/lib/better-auth-db";
import type { Mention } from "./types";
// parseMentions and RawMention live in the pure module (no server-only/DB imports).
// Re-export parseMentions so existing callers (actions.ts, chat-page.tsx) keep working.
export { parseMentions } from "./mentions-pure";
import { parseMentions, type RawMention } from "./mentions-pure";

// ---------------------------------------------------------------------------
// resolveMentions — resolve @handles to assistant user ids
//
// Reads the platform handle REGISTRY (`assistant_handles`, cinatra#1037 P1.2),
// NOT the un-normalized raw-lowercase `public."user".username`. The registry is
// the deterministic, collision-suffixed source of truth: a handle hit IS a
// mentionable assistant principal (the registry only ever holds assistants).
// ---------------------------------------------------------------------------

export async function resolveMentions(raw: RawMention[]): Promise<Mention[]> {
  if (raw.length === 0) return [];

  const byHandle = await resolveAssistantHandles(raw.map((r) => r.handle));

  return raw
    .map((r): Mention | null => {
      const id = byHandle.get(r.handle);
      return id ? { handle: r.handle, assistantUserId: id, offset: r.offset, length: r.length } : null;
    })
    .filter((m): m is Mention => m !== null);
}

// ---------------------------------------------------------------------------
// resolveAssistantsByIds — reverse lookup: userId[] → Mention[]
// Used for broadcast dispatch when taggedAssistantUserIds are known but handles
// aren't. Reads the registry handle (not the raw username).
// ---------------------------------------------------------------------------

export async function resolveAssistantsByIds(ids: string[]): Promise<Mention[]> {
  if (ids.length === 0) return [];

  const byId = await lookupAssistantHandlesByIds(ids);

  return ids
    .map((id): Mention | null => {
      const handle = byId.get(id);
      return handle ? { handle, assistantUserId: id, offset: 0, length: 0 } : null;
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

  // No explicit mention — fall back to @cinatra via the registry.
  const byHandle = await resolveAssistantHandles(["cinatra"]);
  const cinatraId = byHandle.get("cinatra");
  if (!cinatraId) {
    // @cinatra not registered yet — no routing.
    return [];
  }

  return [
    {
      handle: "cinatra",
      assistantUserId: cinatraId,
      offset: 0,
      length: 0, // synthetic — not present in content
    },
  ];
}
