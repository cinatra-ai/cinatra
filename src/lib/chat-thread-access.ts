/**
 * Pure chat-thread authorization decision (no I/O).
 *
 * The `chat_threads` legacy sync table has NO `org_id` column, so read
 * authorization is derived from the thread payload's own `ownerUserId` /
 * `teamId` / `taggedAssistantUserIds` fields plus the trusted auth-derived
 * actor. This is the single source of truth for that matrix, kept in its own
 * leaf module so it can be exhaustively unit tested without a database (the
 * `@/lib/database` module is stubbed in the root vitest sandbox).
 *
 * `isActorTeamMember` is resolved by the caller (a tenant-scoped DB lookup) and
 * is only consulted on the team path.
 *
 * Two surfaces share this one contract, differing only by the OPTIONAL knobs:
 *   - the authenticated HTTP read route (GET /api/chat/thread/[threadId]):
 *     owner / team / admin, and legacy ownerless rows are PUBLIC. It passes
 *     neither optional param, so its behavior is unchanged.
 *   - the MCP handler surface (packages/chat/src/mcp/handlers.ts get / pause /
 *     resume / send-continuation): additionally honors the tagged-assistant
 *     axis (mirroring chat_thread_list / chat_thread_update visibility) and
 *     denies legacy ownerless rows to non-admins (`legacyOwnerlessPolicy:
 *     "deny-non-admin"`), so an unowned legacy thread's full content is not
 *     readable by an arbitrary caller.
 *
 * Allow matrix:
 *   - platform admin                              → allow
 *   - actor in taggedAssistantUserIds             → allow (thread participant)
 *   - ownerUserId === actorUserId                 → allow (personal owner)
 *   - ownerUserId set and ≠ actorUserId           → deny  (cross-user)
 *   - teamId set (and not personally owned)       → allow iff isActorTeamMember
 *   - legacy row (no owner, no team):
 *       legacyOwnerlessPolicy "public"            → allow (default; HTTP route)
 *       legacyOwnerlessPolicy "deny-non-admin"    → deny  (MCP hardened paths)
 */
export function evaluateChatThreadAccess(input: {
  ownerUserId: string | null;
  teamId: string | null;
  actorUserId: string;
  isPlatformAdmin: boolean;
  isActorTeamMember: boolean;
  /**
   * Assistant/user ids explicitly tagged into the thread (from the persisted
   * thread payload — NEVER caller-supplied input). A tagged actor is a thread
   * participant and is allowed even when another user owns the thread, matching
   * the MCP list/update visibility contract. Omitted (HTTP route) → not
   * consulted.
   */
  taggedAssistantUserIds?: readonly string[] | null;
  /**
   * How to treat a legacy row that carries neither an owner nor a team.
   * "public" (default) preserves the HTTP route's grandfather behavior;
   * "deny-non-admin" hardens the MCP surface so an unowned thread's full
   * content is not readable by a non-admin caller.
   */
  legacyOwnerlessPolicy?: "public" | "deny-non-admin";
}): boolean {
  if (input.isPlatformAdmin) return true;
  // Tagged-assistant participant axis (MCP surface only; HTTP route omits it).
  // Checked before owner so a tagged participant retains access on a thread
  // another user owns — the same rule chat_thread_list / chat_thread_update use.
  if (
    input.actorUserId &&
    input.taggedAssistantUserIds &&
    input.taggedAssistantUserIds.includes(input.actorUserId)
  ) {
    return true;
  }
  if (input.ownerUserId) return input.ownerUserId === input.actorUserId;
  if (input.teamId) return input.isActorTeamMember;
  // Legacy ownerless + teamless row.
  return (input.legacyOwnerlessPolicy ?? "public") === "public";
}
