/**
 * Pure chat-thread authorization decision (no I/O).
 *
 * The `chat_threads` legacy sync table has NO `org_id` column, so read
 * authorization is derived from the thread payload's own `ownerUserId` /
 * `teamId` fields plus the trusted auth-derived actor. This is the single
 * source of truth for that matrix, kept in its own leaf module so it can be
 * exhaustively unit tested without a database (the `@/lib/database` module is
 * stubbed in the root vitest sandbox).
 *
 * `isActorTeamMember` is resolved by the caller (a tenant-scoped DB lookup) and
 * is only consulted on the team path.
 *
 * Allow matrix (mirrors the list route in src/app/api/chat/threads/route.ts,
 * the MCP handler in packages/chat/src/mcp/handlers.ts, and the classifier
 * reader in src/lib/database.ts — one consistent contract):
 *   - platform admin                         → allow
 *   - ownerUserId === actorUserId            → allow (personal owner)
 *   - ownerUserId set and ≠ actorUserId      → deny  (cross-user)
 *   - teamId set (and not personally owned)  → allow iff isActorTeamMember
 *   - legacy row (no ownerUserId, no teamId) → allow (legacy threads are public)
 */
export function evaluateChatThreadAccess(input: {
  ownerUserId: string | null;
  teamId: string | null;
  actorUserId: string;
  isPlatformAdmin: boolean;
  isActorTeamMember: boolean;
}): boolean {
  if (input.isPlatformAdmin) return true;
  if (input.ownerUserId) return input.ownerUserId === input.actorUserId;
  if (input.teamId) return input.isActorTeamMember;
  return true;
}
