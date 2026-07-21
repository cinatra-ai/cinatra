"use server";

import {
  upsertChatThreadInDatabase,
  deleteChatThreadFromDatabase,
  deleteAllChatThreadsFromDatabase,
} from "@/lib/database";
import {
  requireActorContext,
  requireAuthSession,
  resolveOrgRoleForSession,
  resolveOrgRoleForUser,
  isPlatformAdmin,
} from "@/lib/auth-session";
import { canDo } from "@/lib/authz/enforce";
import { readChatThreadOwnershipById } from "@/lib/chat-thread-store";
import {
  getAssistantThread,
  getAssistantThreadByTeamId,
  setAssistantThreadPauseParticipant,
  listAssistantThreadSummariesForOwnerInOrg,
  reconstructThreadPayload,
} from "@/lib/assistant-thread-store";
import { betterAuthDb } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";
import { runDeterministicLlmTask } from "@cinatra-ai/llm";
import { readLocalPackageSkillContent } from "@cinatra-ai/skills";
import { parseMentions, resolveMentions, resolveBuiltInCinatraAssistantUserId } from "./mentions";
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
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  // PR2 CUTOVER (cinatra#1037 P5.6): the flat /chat list is served from the
  // structured store, scoped in BOTH the org and owner axes (#134 audience
  // contract: the built-in assistant's list is org-scoped to the acting org).
  // Only the caller's own durable-content threads anchored to the acting org are
  // returned — team threads live in the team panel (owner axis excludes them),
  // and pre-cutover content-less shadows + ownerless legacy rows are excluded
  // (the ownerless-quarantine seam). Ordered createdAt DESC by the store op.
  // Fail-closed with an empty list when there is no active org.
  if (!activeOrgId) return [];
  return listAssistantThreadSummariesForOwnerInOrg(activeOrgId, effectiveUserId).map((t) => ({
    id: t.id,
    title: t.title ?? "",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
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
  // Hardening (cinatra#1037 P5.6 PR2 CUTOVER) — verify ACTIVE-ORG team
  // membership before touching a team thread. Without this a caller could
  // probe/pre-create another tenant's team thread by id. Fail-closed: the team
  // must belong to the caller's active org AND the caller must be a member of
  // that org.
  const session = await requireAuthSession();
  const callerId = session.user.id;
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  if (!activeOrgId) {
    throw new Error("Forbidden: an active organization is required to open a team thread.");
  }
  const authRows = await betterAuthDb.execute(sql`
    SELECT 1
    FROM public.team t
    JOIN public.member m ON m."organizationId" = t."organizationId"
    WHERE t.id = ${teamId}
      AND t."organizationId" = ${activeOrgId}
      AND m."userId" = ${callerId}
    LIMIT 1
  `);
  if (!authRows.rows || authRows.rows.length === 0) {
    throw new Error("Forbidden: not an active-org member of this team.");
  }

  // PR2 CUTOVER (cinatra#1037 P5.6): probe the structured store for the team's
  // existing thread (existence/ownership probe — no durable-content filter, so a
  // freshly-minted empty team thread is found) instead of scanning chat_threads.
  const existing = getAssistantThreadByTeamId(teamId);
  if (existing) return existing.id;

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
  // PR2 CUTOVER (cinatra#1037 P5.6): reconstruct from the structured store
  // (assistant_threads + durable assistant_turns.content), NOT the legacy
  // chat_threads.payload. A pre-cutover / content-less thread reconstructs to
  // null → treated as absent (same as the HTTP single-read seam).
  return (reconstructThreadPayload(threadId) as Thread | null) ?? null;
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
  // assistantMirrorOrgId: org tenancy anchor for the structured
  // assistant_threads mirror (cinatra#1037 P2b) — distinct from the pin-sync
  // orgId option; team threads resolve to NULL centrally from the payload.
  upsertChatThreadInDatabase(thread, { orgId, assistantMirrorOrgId: orgId });
}

export async function deleteChatThread(threadId: string): Promise<void> {
  const session = await requireAuthSession();
  const callerId = session.user.id;
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  // Permission gate (cinatra#1037 P5.6 PR2 CUTOVER) — OWNER-or-ORG-ADMIN,
  // FAIL-CLOSED. The prior form let ANY authenticated user delete ANY thread by
  // id (codex flagged this as a cross-tenant delete vuln). Ownership is read
  // from the PERSISTED row (never caller input); admin power is mapped through
  // the REAL permission catalog — `object.delete` is granted to org_admin /
  // org_owner + platform_admin, NOT to a plain member.
  const ownership = readChatThreadOwnershipById(threadId);
  if (!ownership) return; // absent → idempotent no-op (nothing to delete; no cross-tenant probe signal)

  const isOwner = !!ownership.ownerUserId && ownership.ownerUserId === callerId;
  if (!isOwner) {
    let adminAllowed = isPlatformAdmin(session);
    if (!adminAllowed && ownership.ownerUserId) {
      // Personal thread owned by ANOTHER user → an org_admin/org_owner of the
      // thread's OWN org (the structured mirror anchor). A non-null org lets the
      // kernel's cross-org guard deny a foreign-org admin; a NULL/legacy anchor
      // is fail-closed (only the owner or a platform admin can delete it).
      const threadOrgId = getAssistantThread(threadId)?.orgId ?? undefined;
      const orgRole = await resolveOrgRoleForSession(session);
      adminAllowed =
        threadOrgId !== undefined &&
        canDo(
          session,
          "object.delete",
          { resourceType: "object", resourceId: threadId, organizationId: threadOrgId },
          orgRole ? { orgRole } : {},
        );
    } else if (!adminAllowed && ownership.teamId) {
      // Team thread — the mirror org is NULL by policy, so canDo's org guard
      // cannot scope it (codex convergence). Authorize an org_admin/org_owner of
      // the TEAM'S OWN org: resolve the team's org, then the caller's role IN
      // that org. A plain member (even of the team's org) is NOT authorized to
      // delete — "owner-or-org-admin" per the ruling.
      const teamOrgRows = await betterAuthDb.execute(sql`
        SELECT "organizationId" FROM public.team WHERE id = ${ownership.teamId} LIMIT 1
      `);
      const teamOrgId =
        (teamOrgRows.rows?.[0] as { organizationId?: string } | undefined)?.organizationId ?? null;
      if (teamOrgId) {
        const roleInTeamOrg = await resolveOrgRoleForUser(teamOrgId, callerId);
        adminAllowed = roleInTeamOrg === "org_admin" || roleInTeamOrg === "org_owner";
      }
    }
    if (!adminAllowed) {
      throw new Error("Forbidden: not authorized to delete this chat thread.");
    }
  }

  deleteChatThreadFromDatabase(threadId, { orgId });
}

export async function deleteAllChatThreads(): Promise<void> {
  // Scoped to the caller's OWN 'legacy-chat' threads (cinatra#1037 P5.6 PR2
  // CUTOVER) — no longer a global cross-tenant wipe. The DB helper restricts by
  // the structured mirror's owner_user_id + origin axes, so a runtime-native
  // thread and every other user's/team's thread are untouched. Ownership scope
  // IS the permission gate here (an authenticated caller may clear only rows it
  // owns); an org-wide admin wipe is intentionally NOT this action's semantic.
  const session = await requireAuthSession();
  deleteAllChatThreadsFromDatabase(session.user.id);
}

export async function renameChatThread(threadId: string, newTitle: string): Promise<void> {
  // PR2 CUTOVER (cinatra#1037 P5.6): reconstruct the thread from the structured
  // store, re-title, and re-persist through the promoted structured writer
  // (chat_threads is no longer read or written).
  const thread = reconstructThreadPayload(threadId);
  if (!thread) return;
  // A title-only rename is not conversational activity — preserve the existing
  // updatedAt (carried in the reconstructed payload) so renaming does NOT bump
  // the thread to the top of the activity-sorted sidebar (#283). createdAt is
  // likewise preserved.
  upsertChatThreadInDatabase({
    ...thread,
    id: threadId,
    title: newTitle,
  });
}

// Handles that bypass webhook delivery and respond via a dedicated built-in
// endpoint. Keep in sync with BUILT_IN_HANDLES in
// packages/chat/src/mcp/handlers.ts. Only current built-in chat handles are
// routed here.
const BUILT_IN_HANDLES = new Set(["chatgpt"]);

const BUILT_IN_ENDPOINTS: Record<string, string> = {
  chatgpt: "/api/assistants/chatgpt",
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
): Promise<{ shouldCallLlm: boolean; activeHandle?: string; externalMentions?: Mention[]; isBroadcast?: boolean; chatEndpoint?: string; builtInMention?: Mention; hostAssistantUserId?: string }> {
  // Parse explicit @mentions — explicit always wins over broadcast.
  const rawMentions = parseMentions(message);

  if (rawMentions.length > 0) {
    const resolved = await resolveMentions(rawMentions);

    if (resolved.length > 0) {
      const builtIn = resolved.find((m) => BUILT_IN_HANDLES.has(m.handle));
      if (builtIn) {
        // Built-in assistant: route to its dedicated AG-UI producer endpoint
        // instead of the default Cinatra assistant endpoint.
        // Its reply is attributed to the built-in principal (builtInMention), not Cinatra.
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
      // When Cinatra replies (!allExternal), cinatra IS in `resolved` (allExternal
      // is false only if a non-external handle — cinatra — is present). Attribute
      // the host reply to that principal (P2.4).
      const cinatraMention = resolved.find((m) => m.handle === "cinatra");
      return {
        shouldCallLlm: !allExternal,
        activeHandle: lastExternal?.handle ?? "cinatra",
        externalMentions: allExternal ? external : undefined,
        ...(!allExternal && cinatraMention
          ? { hostAssistantUserId: cinatraMention.assistantUserId }
          : {}),
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
    // Broadcast: Cinatra also replies unless paused — attribute its reply (P2.4).
    const hostId = cinatraPaused ? null : await resolveBuiltInCinatraAssistantUserId();
    return {
      shouldCallLlm: !cinatraPaused,
      externalMentions: externalMentions.length > 0 ? externalMentions : undefined,
      isBroadcast: true,
      ...(hostId ? { hostAssistantUserId: hostId } : {}),
    };
  }

  // Default: the host Cinatra assistant replies — attribute its reply (P2.4).
  const hostId = await resolveBuiltInCinatraAssistantUserId();
  return { shouldCallLlm: true, ...(hostId ? { hostAssistantUserId: hostId } : {}) };
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
  // PR2 CUTOVER (cinatra#1037 P5.6): write the pause DIRECTLY to the structured
  // assistant_thread_pause_state table (atomic INSERT-or-DELETE) instead of the
  // read-chat_threads + whole-payload re-upsert (which last-writer-wins under
  // concurrency). Guard on structured existence first (idempotent no-op for an
  // absent thread). The store op deliberately does not bump updated_at (#283).
  if (!getAssistantThread(threadId)) return;
  setAssistantThreadPauseParticipant(threadId, assistantId, paused);
}
