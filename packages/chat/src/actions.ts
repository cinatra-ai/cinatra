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
import {
  ensureSkillForCapability,
  readSkillsCatalog,
  stripSkillFrontmatter,
} from "@cinatra-ai/skills";
import { classifyMentions } from "./classify-mentions";
import { buildAudienceRoutingContext } from "./server-audience-resolver";
import { decideMessageRouting } from "./route-decision";
import type { MessageRoutingResult } from "./chat-routing";
import type { ChatThread } from "./types";

// Chat prompt-window HITL extraction skill, resolved through the canonical
// catalog by its package-OWNED capability key (`chat.hitl-prompt-drive`,
// declared by the internal `@cinatra-ai/hitl-prompt-drive-skill` extension) \u2014
// the same true-IoC contract as `skill-prefill-generation`. No hardcoded
// extension dir or on-disk path (the pre-fold module-init read of
// `extensions/cinatra-ai/assistant-skills/...` died with that pack,
// cinatra#2090 S3). Static LLM instructions live in SKILL.md per repo rule,
// never inlined in TS.
//
// Semantics (fail-closed where it matters, fail-soft where it doesn't):
//   - EXACTLY ONE active provider (`unique: true`) \u2014 an internal system
//     prompt must never depend on filesystem scan order between two rival
//     capability providers; ambiguity resolves to "skill unavailable".
//   - Lazily registered, then the body is read from the CATALOG ROW the
//     registration wrote (never the raw extension path): a swallowed
//     registration failure inside the fail-soft resolver surfaces here as a
//     catalog miss and correctly fails closed. Frontmatter stripped; memoized
//     per process on SUCCESS only, so a transient miss retries next call.
//   - On ANY failure the caller returns "{}" WITHOUT invoking the LLM \u2014
//     "extract nothing" rather than "free-form hallucinate values",
//     preserving the pre-fold fail-soft contract.
const HITL_PROMPT_DRIVE_CAPABILITY = "chat.hitl-prompt-drive";
let hitlPromptDriveSkillMemo: string | null = null;

async function loadHitlPromptDriveSkill(): Promise<string | null> {
  if (hitlPromptDriveSkillMemo !== null) return hitlPromptDriveSkillMemo;
  try {
    const skillId = await ensureSkillForCapability(HITL_PROMPT_DRIVE_CAPABILITY, {
      unique: true,
    });
    // The registration path above is deliberately fail-soft; the catalog row
    // is the proof it actually happened. No row (or empty content) \u21d2 null \u21d2
    // the caller answers "{}" without an LLM call.
    const catalog = await readSkillsCatalog();
    const row = catalog.skills.find((skill) => skill.id === skillId);
    const content = typeof row?.content === "string" ? row.content : "";
    const body = stripSkillFrontmatter(content).trim();
    if (!body) return null;
    hitlPromptDriveSkillMemo = body;
    return body;
  } catch {
    return null;
  }
}

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

  // Resolve the extraction skill BEFORE any LLM work: no skill, no call —
  // "{}" means "not a gate response → route to normal chat".
  const hitlPromptDriveSkill = await loadHitlPromptDriveSkill();
  if (!hitlPromptDriveSkill) return "{}";

  try {
    const result = await runDeterministicLlmTask({
      provider: "openai",
      system: hitlPromptDriveSkill,
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

/**
 * Resolve whether — and how — a message dispatches to assistants.
 *
 * DECLARATION-DRIVEN (cinatra#1875 W2, Epic #1873 — AC#2). This is the retirement
 * site of the hardcoded `chatgpt`/`gemini` routing: the message's mention tokens
 * are CLASSIFIED against the actor's AUDIENCE-FILTERED registry (`classifyMentions`
 * over the W1 reader — a forged out-of-audience mention never classifies as an
 * assistant), then the classified assistants are PLANNED by their DECLARED
 * delivery channel (`decideMessageRouting` → `planAssistantDispatch`). An
 * assistant dispatches because it is a REGISTERED, IN-AUDIENCE assistant with a
 * DECLARED delivery — never because its handle matches a built-in table.
 *
 * Ruling (Epic #1873 plan-of-record, 2026-07-21): there is no built-in assistant
 * class and no `@chatgpt` token — the former `@chatgpt` route is GONE, so an
 * `@chatgpt` mention is now an HONEST NO-RESPONDER (delisted; it neither streams
 * nor hangs). The OpenAI assistant returns as the `@openai` connector-backed
 * package in W6. @cinatra remains the implicit host default (byte-parity).
 *
 * Routing outcomes (see `decideMessageRouting`):
 *   - a DECLARED host-runtime assistant → in-band AG-UI stream, attributed to its
 *     own principal (`hostRuntimeMention`);
 *   - a DECLARED webhook/mcp-poll assistant → persisted pending (`externalMentions`),
 *     the connector delivers out of band;
 *   - @cinatra / no mention → the host Cinatra reply;
 *   - tagged participants (no explicit assistant mention) → broadcast;
 *   - an @-token that resolves to no in-audience assistant → honest no-responder.
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
): Promise<MessageRoutingResult> {
  // ONE audience-scoped read: the classifier resolver, the delivery lookup, and
  // the Cinatra host principal, all built from the W1 registry reader filtered to
  // this actor's audience.
  const { resolver, deliveryFor, cinatraHostId } = await buildAudienceRoutingContext();

  // Phase 1+2: lex the message and classify each token against the audience
  // registry (an out-of-audience or unknown token never classifies as assistant).
  const classified = await classifyMentions(message, resolver);

  // Pure decision: declared assistants → planner-driven dispatch; @cinatra host
  // default + broadcast preserved byte-for-byte.
  return decideMessageRouting({ classified, deliveryFor, cinatraHostId, broadcastContext });
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
