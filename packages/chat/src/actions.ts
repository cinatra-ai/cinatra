"use server";

import {
  readChatThreadsFromDatabase,
  upsertChatThreadInDatabase,
  deleteChatThreadFromDatabase,
  deleteAllChatThreadsFromDatabase,
} from "@/lib/database";
import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";
import { runDeterministicLlmTask } from "@cinatra-ai/llm";
import { readLocalPackageSkillContent } from "@cinatra-ai/skills";
import { parseMentions, resolveMentions } from "./mentions";
import type { ChatThread, Mention } from "./types";

// Chat prompt-window HITL extraction skill, loaded once at module init
// (synchronous; matches the mcp-instructions pattern). Static LLM instructions
// live in SKILL.md per repo rule, never inlined in TS.
const HITL_PROMPT_DRIVE_SKILL: string =
  readLocalPackageSkillContent({
    extensionDir: "assistant-skills",
    skillSlug: "chat-hitl-prompt-drive",
    stripFrontmatter: true,
  }) ??
  // Fail-soft: a missing skill file degrades to "extract nothing" rather
  // than "free-form hallucinate values".
  "Return ONLY {} \u2014 the HITL prompt-drive skill file was not found.";

export type HitlGateField = {
  name: string;
  type: string;
  title?: string;
  required: boolean;
};

/**
 * LLM fallback for the chat prompt-window HITL classifier. Called ONLY after
 * the deterministic ladder in chat-page.tsx fails to
 * classify a short/medium non-question message. Extracts the subset of the
 * open gate's fields the message supplies, against a response schema built
 * from the flattened field list. Returns a JSON object string (subset of
 * field names) or "{}" on any failure \u2014 the caller treats "{}" as
 * "not a gate response \u2192 route to normal chat".
 */
export async function extractHitlGateValuesAction(
  message: string,
  fields: HitlGateField[],
): Promise<string> {
  // Auth-first: same gate as every other chat server action. The actor is
  // required by runDeterministicLlmTask's fail-closed ALS frame.
  await requireAuthSession();
  const actor = await requireActorContext();

  if (!Array.isArray(fields) || fields.length === 0) return "{}";

  const properties: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    if (!f || typeof f.name !== "string" || f.name.length === 0) continue;
    const t =
      f.type === "boolean" ||
      f.type === "number" ||
      f.type === "integer" ||
      f.type === "array" ||
      f.type === "object"
        ? f.type
        : "string";
    properties[f.name] = { type: t, title: f.title ?? f.name };
  }
  if (Object.keys(properties).length === 0) return "{}";

  const responseSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };

  try {
    const result = await runDeterministicLlmTask({
      provider: "openai",
      system: HITL_PROMPT_DRIVE_SKILL,
      user: message,
      outputSchema: responseSchema,
      logLabel: "chat-hitl-prompt-drive",
      reasoningEffort: "low",
      actorContext: actor,
    });
    const text = result.text?.trim() ?? "{}";
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Symmetric trust boundary with the deterministic fast-path's
      // own-property Set filter (explicit-dispatch-server.ts).
      // The provider *should* honor additionalProperties:false, but never
      // trust it: allowlist to the known gate field names so a stray key
      // (incl. inherited prototype names) can't flow into the gate submit
      // payload.
      const allowed = new Set(fields.map((f) => f.name));
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (allowed.has(k)) filtered[k] = v;
      }
      return JSON.stringify(filtered);
    }
    return "{}";
  } catch {
    return "{}";
  }
}


type ThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type Thread = {
  id: string;
  title: string;
  messages: unknown[];
  createdAt: string;
  updatedAt: string;
};

export type TeamSummary = { id: string; name: string; orgName: string };

export async function fetchChatThreads(userId?: string): Promise<ThreadSummary[]> {
  const session = await requireAuthSession();
  const effectiveUserId = userId ?? session.user.id;

  // Fetch user's team memberships for team thread visibility
  const rows = await betterAuthDb.execute(sql`
    SELECT tm."teamId"
    FROM public."teamMember" tm
    WHERE tm."userId" = ${effectiveUserId}
  `);
  const memberTeamIds = new Set((rows.rows as Array<{ teamId: string }>).map((r) => r.teamId));

  const threads = readChatThreadsFromDatabase();
  return threads
    .filter((t) => {
      const ownerUserId = t.ownerUserId as string | undefined;
      const teamId = t.teamId as string | undefined;
      // Legacy thread (no ownerUserId, no teamId) — always show
      if (!ownerUserId && !teamId) return true;
      // User's own thread
      if (ownerUserId === effectiveUserId) return true;
      // Team threads belong in the team panel, not the thread list
      if (teamId) return false;
      return false;
    })
    .map((t) => ({
      id: t.id as string,
      title: t.title as string,
      createdAt: t.createdAt as string,
      updatedAt: t.updatedAt as string,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function fetchUserTeams(): Promise<TeamSummary[]> {
  const session = await requireAuthSession();
  // Show every team in an organization the user belongs to: direct
  // `teamMember` rows OR org-level membership. An org owner who has not
  // joined any individual team still expects to see their org's teams
  // here so they can open a team chat without first having to add
  // themselves as a teamMember.
  const rows = await betterAuthDb.execute(sql`
    SELECT DISTINCT t.id, t.name, o.name as "orgName"
    FROM public.team t
    JOIN public.organization o ON o.id = t."organizationId"
    WHERE EXISTS (
      SELECT 1 FROM public."teamMember" tm
      WHERE tm."teamId" = t.id AND tm."userId" = ${session.user.id}
    )
    OR EXISTS (
      SELECT 1 FROM public.member m
      WHERE m."organizationId" = t."organizationId" AND m."userId" = ${session.user.id}
    )
    ORDER BY "orgName", t.name
  `);
  return rows.rows as unknown as TeamSummary[];
}

export async function ensureTeamThread(teamId: string, teamName: string): Promise<string> {
  const threads = readChatThreadsFromDatabase();
  const existing = threads.find((t) => (t as Record<string, unknown>).teamId === teamId);
  if (existing) return existing.id as string;

  const { randomUUID } = await import("node:crypto");
  const now = new Date().toISOString();
  const id = randomUUID();
  const newThread = {
    id,
    title: `#${teamName}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
    teamId,
  };
  upsertChatThreadInDatabase(newThread);
  return id;
}

export async function fetchChatThread(threadId: string): Promise<Thread | null> {
  const threads = readChatThreadsFromDatabase();
  const thread = threads.find((t) => t.id === threadId);
  return (thread as Thread) ?? null;
}

export async function saveChatThread(thread: Thread): Promise<void> {
  // Pass the auth-derived orgId so `upsertChatThreadInDatabase` can sync the
  // artifact_refs pin table for this thread's current attachment set. Without
  // orgId the ref-sync is skipped for callers that don't have a session
  // context.
  const session = await requireAuthSession();
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  upsertChatThreadInDatabase(thread, { orgId });
}

export async function deleteChatThread(threadId: string): Promise<void> {
  // Clear artifact_refs pins atomically with the thread row. The pin delete is
  // GLOBAL (no `org_id` filter) because chat_threads has no org_id column and
  // the threadId is globally unique. The `orgId` is still threaded through as a
  // compatibility option for callers that pass it; the helper's signature
  // accepts it but ignores it for the pin-side WHERE clause.
  const session = await requireAuthSession();
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  deleteChatThreadFromDatabase(threadId, { orgId });
}

export async function deleteAllChatThreads(): Promise<void> {
  // `deleteAllChatThreadsFromDatabase` is UNAMBIGUOUSLY GLOBAL (chat_threads
  // has no org_id column; an org-scoped delete is structurally impossible).
  // The session check below ensures only an authenticated user can trigger the
  // wipe; a proper admin-role gate is the natural follow-up.
  await requireAuthSession();
  deleteAllChatThreadsFromDatabase();
}

export async function renameChatThread(threadId: string, newTitle: string): Promise<void> {
  const threads = readChatThreadsFromDatabase();
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return;
  upsertChatThreadInDatabase({
    ...thread,
    id: thread.id as string,
    title: newTitle,
    updatedAt: new Date().toISOString(),
  });
}

// Handles that bypass webhook delivery and respond via a dedicated built-in
// endpoint. Keep in sync with BUILT_IN_HANDLES in
// packages/chat/src/mcp/handlers.ts. Only current built-in chat handles are
// routed here.
const BUILT_IN_HANDLES = new Set(["chatgpt"]);

const BUILT_IN_ENDPOINTS: Record<string, string> = {
  chatgpt: "/api/chat/chatgpt",
};

/**
 * Resolve whether the Cinatra LLM should respond to this message.
 *
 * - Explicit @mentions to external (non-@cinatra) assistants → skip LLM
 * - Explicit @mentions to built-in assistants (e.g. @chatgpt) → shouldCallLlm: true, chatEndpoint set
 * - No explicit @mention + thread has tagged participants → broadcast to all non-paused
 * - Otherwise → call LLM only
 */
export async function resolveMessageRouting(
  message: string,
  threadId: string | null,
  /** Client-side hint for the thread's current active assistant handle (from React state). */
  clientActiveHandle?: string,
  /** Broadcast context: all tagged IDs + paused IDs + userId→handle map from client state. */
  broadcastContext?: {
    taggedAssistantUserIds: string[];
    pausedParticipants: string[];
    handleMap: Record<string, string>;
  },
): Promise<{ shouldCallLlm: boolean; activeHandle?: string; externalMentions?: Mention[]; isBroadcast?: boolean; chatEndpoint?: string; builtInMention?: Mention }> {
  // Parse explicit @mentions — explicit always wins over broadcast.
  const rawMentions = parseMentions(message);

  if (rawMentions.length > 0) {
    const resolved = await resolveMentions(rawMentions);

    if (resolved.length > 0) {
      const builtIn = resolved.find((m) => BUILT_IN_HANDLES.has(m.handle));
      if (builtIn) {
        // Built-in assistant: route to its dedicated endpoint instead of /api/chat.
        return {
          shouldCallLlm: true,
          activeHandle: builtIn.handle,
          chatEndpoint: BUILT_IN_ENDPOINTS[builtIn.handle],
          builtInMention: builtIn,
        };
      }
      const external = resolved.filter((m) => m.handle !== "cinatra");
      const allExternal = resolved.length > 0 && external.length === resolved.length;
      const lastExternal = external[external.length - 1];
      return {
        shouldCallLlm: !allExternal,
        activeHandle: lastExternal?.handle ?? "cinatra",
        externalMentions: allExternal ? external : undefined,
      };
    }

    // resolved.length === 0: parser found `@…` but NONE resolved to an
    // assistant. Could be human-only mentions, false-positive package
    // refs like `@cinatra-ai/<slug>`, or unknown handles. Fall through to
    // the no-mention broadcast branch below so `pausedParticipants` +
    // `taggedAssistantUserIds` are honored. Returning early here caused a
    // silent-reply bug.
  }

  // No explicit mention + broadcast context with tagged participants → broadcast.
  const tagged = broadcastContext?.taggedAssistantUserIds ?? [];
  const paused = broadcastContext?.pausedParticipants ?? [];
  const handleMap = broadcastContext?.handleMap ?? {};

  if (tagged.length > 0) {
    const activeExternalIds = tagged.filter((id) => !paused.includes(id));
    const externalMentions: Mention[] = activeExternalIds
      .map((id): Mention | null => {
        const handle = handleMap[id];
        return handle ? { handle, assistantUserId: id, offset: 0, length: 0 } : null;
      })
      .filter((m): m is Mention => m !== null);

    const cinatraPaused = paused.includes("cinatra");
    return {
      shouldCallLlm: !cinatraPaused,
      externalMentions: externalMentions.length > 0 ? externalMentions : undefined,
      isBroadcast: true,
    };
  }

  return { shouldCallLlm: true };
}

/**
 * Pause or resume a participant (assistantUserId or "cinatra") in a thread.
 * Optimistically called from the client; idempotent.
 */
export async function setAssistantPauseState(
  threadId: string,
  assistantId: string,
  paused: boolean,
): Promise<void> {
  const threads = readChatThreadsFromDatabase();
  const thread = threads.find((t) => t.id === threadId) as ChatThread | undefined;
  if (!thread) return;

  const current = new Set(thread.pausedParticipants ?? []);
  if (paused) {
    current.add(assistantId);
  } else {
    current.delete(assistantId);
  }

  upsertChatThreadInDatabase({
    ...thread,
    pausedParticipants: Array.from(current),
    updatedAt: new Date().toISOString(),
  } as unknown as { id: string } & Record<string, unknown>);
}
