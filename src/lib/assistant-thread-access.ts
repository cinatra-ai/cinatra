/**
 * Pure assistant-thread authorization decision (no I/O) — cinatra#1037 P5.5.
 *
 * The GENERALIZATION of the G2 chat-thread seam (`evaluateChatThreadAccess`,
 * src/lib/chat-thread-access.ts) re-targeted at the STRUCTURED
 * `assistant_threads` store (src/lib/assistant-thread-store.ts) instead of the
 * legacy `chat_threads` JSON table. Kept in its own leaf module so the matrix
 * is exhaustively unit-testable without a database, exactly like its legacy
 * twin — which stays untouched (the chat_thread_* teardown is P5.6).
 *
 * Shape differences vs the legacy table, and how each maps:
 *   - `assistant_threads` HAS an `org_id` column (chat_threads does not), so
 *     this surface adds a hard cross-org seal: a thread in another org is
 *     denied outright (404-hidden by the callers).
 *   - there is NO `teamId` column, so the legacy team axis is vacuous here —
 *     a structured thread is owned personally or not at all.
 *   - the participant axis is the thread's BOUND ASSISTANT PRINCIPAL
 *     (`assistant_user_id`): the analog of the legacy
 *     `taggedAssistantUserIds` membership. An assistant principal calling
 *     about its own thread is a participant and is allowed even though the
 *     thread is owned by a human.
 *   - legacy-ownerless rows (no ownerUserId) are ALWAYS deny-to-non-admin on
 *     this surface (the hardened MCP posture; there is no "public" mode —
 *     this module serves only the MCP surface, never the HTTP route).
 *
 * Allow matrix (first hit wins):
 *   - platform admin                                → allow
 *   - thread.orgId set and ≠ actor's orgId          → deny  (cross-org seal)
 *   - thread.orgId null (org-less mirror rows)      → deny  (non-admin;
 *       team-mirrored threads centrally resolve orgId to NULL and cannot be
 *       team-checked here — fail closed, the legacy surface still serves them)
 *   - actor IS the bound assistant principal        → allow (participant)
 *   - ownerUserId === actorUserId                   → allow (personal owner)
 *   - ownerUserId set and ≠ actorUserId             → deny  (cross-user)
 *   - ownerless                                     → deny  (non-admin)
 *
 * Callers surface EVERY deny as a missing row (the sealed-room 404-hide
 * contract): a denied thread must be indistinguishable from a nonexistent one.
 */
export function evaluateAssistantThreadAccess(input: {
  /** The persisted thread's bound assistant principal (assistant_user_id). */
  threadAssistantUserId: string | null;
  /** The persisted thread's human owner (owner_user_id). */
  threadOwnerUserId: string | null;
  /** The persisted thread's org anchor (org_id). */
  threadOrgId: string | null;
  /** Transport-verified caller identity — NEVER tool input. */
  actorUserId: string;
  /** Transport-verified caller org — NEVER tool input. */
  actorOrgId: string;
  isPlatformAdmin: boolean;
}): boolean {
  if (input.isPlatformAdmin) return true;
  // Cross-org seal: the structured store is org-anchored; a thread outside the
  // caller's active org does not exist for them. An org-less row (the central
  // team-thread mirror resolution) cannot be team-checked here → fail closed.
  if (!input.threadOrgId || input.threadOrgId !== input.actorOrgId) return false;
  // Participant axis: the bound assistant principal (the structured analog of
  // the legacy taggedAssistantUserIds membership). Checked before owner so a
  // participant retains access on a thread another user owns.
  if (
    input.actorUserId &&
    input.threadAssistantUserId &&
    input.threadAssistantUserId === input.actorUserId
  ) {
    return true;
  }
  if (input.threadOwnerUserId) return input.threadOwnerUserId === input.actorUserId;
  // Ownerless row: always deny-to-non-admin on this (MCP-only) surface.
  return false;
}
