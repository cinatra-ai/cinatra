// Chat-thread tenant-access store (vertical slice extracted from
// src/lib/database.ts). The legacy `chat_threads` JSON "sync" table has NO
// org_id column, so authorization is derived from each thread payload's own
// `ownerUserId` / `teamId` fields plus the trusted auth-derived actor. This
// module owns the tenant-scoped reads/predicates used by the authenticated chat
// HTTP routes; the pure allow/deny decision lives in
// `src/lib/chat-thread-access.ts` and is applied by the route.
//
// Imports only SYNC LEAF primitives (postgres-sync / postgres-config /
// postgres-schema-init) and inlines a local JSON parse, so it never reaches an
// async-root module.
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * May `actorUserId` access team `teamId`'s chat thread? A team chat is visible
 * to every member of the ORGANIZATION that owns the team — matching the product
 * model in `fetchUserTeams` (packages/chat/src/actions.ts), which lists a team
 * for a user when they hold a direct `teamMember` row OR any membership in the
 * team's org (an org owner who has not joined the team can still open its chat).
 * Org membership is therefore the correct tenant boundary: a user who is NOT a
 * member of the team's org is denied (closing the cross-tenant hole), while
 * same-org members keep the access the UI already grants them.
 *
 * Better Auth shape: `public."team" (id, organizationId)` joined to
 * `public."member" (organizationId, userId)`.
 */
function isActorMemberOfTeamOrg(teamId: string, actorUserId: string): boolean {
  const [memberRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT 1
               FROM public."team" t
               JOIN public."member" m ON m."organizationId" = t."organizationId"
               WHERE t.id = $1
                 AND m."userId" = $2
               LIMIT 1`,
        values: [teamId, actorUserId],
      },
    ],
  });
  return Boolean(memberRes?.rows && memberRes.rows.length > 0);
}

export type ChatThreadAccessInputs = {
  payload: Record<string, unknown>;
  ownerUserId: string | null;
  teamId: string | null;
  isActorTeamMember: boolean;
};

/**
 * Tenant-safe single-thread loader for the authenticated HTTP read path
 * (GET /api/chat/thread/[threadId]).
 *
 * Fetches the payload and, only on the branch that needs it, resolves the
 * actor's membership in the team's owning org, returning the raw inputs. The
 * pure decision itself lives in `evaluateChatThreadAccess`
 * (src/lib/chat-thread-access.ts); the route applies it (which keeps the
 * decision helper unit-testable without a database).
 *
 * Returns `null` only when the row does not exist; access is decided by the
 * caller so a denial can be surfaced as a 404 (existence not disclosed).
 */
export function loadChatThreadForActorAccess(input: {
  threadId: string;
  actorUserId: string;
  isPlatformAdmin: boolean;
}): ChatThreadAccessInputs | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [threadRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT payload FROM "${schema}"."chat_threads" WHERE id = $1 LIMIT 1`,
        values: [input.threadId],
      },
    ],
  });
  const row = threadRes?.rows?.[0] as { payload?: string } | undefined;
  if (!row?.payload) return null;
  const payload = safeParseJson<Record<string, unknown> | null>(row.payload, null);
  if (!payload) return null;

  const ownerUserId =
    typeof payload.ownerUserId === "string" ? payload.ownerUserId : null;
  const teamId = typeof payload.teamId === "string" ? payload.teamId : null;

  // Resolve team membership only on the branch that consults it (team-owned,
  // non-admin, non-owner), so the DB round-trip is avoided everywhere else. The
  // truthy guards narrow teamId to non-null for the lookup call.
  let isActorTeamMember = false;
  if (!input.isPlatformAdmin && !ownerUserId && teamId) {
    isActorTeamMember = isActorMemberOfTeamOrg(teamId, input.actorUserId);
  }

  return { payload, ownerUserId, teamId, isActorTeamMember };
}

/**
 * Raw payload read for a chat thread by id, WITHOUT authorization — for
 * SERVER-INTERNAL consumers that already hold a verified identity for the
 * thread (the chat-capture detection job re-reads the persisted turn text it
 * was enqueued for, keyed by the ledger-claimed (thread, turn); cinatra#1367).
 * Never expose through a route without an access decision.
 */
export function readChatThreadPayloadById(
  threadId: string,
): ({ id: string } & Record<string, unknown>) | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [threadRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT payload FROM "${schema}"."chat_threads" WHERE id = $1 LIMIT 1`,
        values: [threadId],
      },
    ],
  });
  const row = threadRes?.rows?.[0] as { payload?: string } | undefined;
  if (!row?.payload) return null;
  const payload = safeParseJson<Record<string, unknown> | null>(row.payload, null);
  if (!payload || typeof payload.id !== "string") return null;
  return payload as { id: string } & Record<string, unknown>;
}

/**
 * Raw ownership-axis lookup for a chat thread by id. Returns the persisted
 * `ownerUserId` / `teamId` (or `null` when the row does not exist) WITHOUT any
 * authorization — the write path (POST /api/assistants/threads) uses this to decide
 * overwrite authorization from the EXISTING row rather than from client-supplied
 * body fields (so the body can never spoof ownership). Distinguishing "missing"
 * from "unauthorized" is intentional here: a missing row is a create, a present
 * row's owner/team axes gate the update.
 */
export function readChatThreadOwnershipById(
  threadId: string,
): { ownerUserId: string | null; teamId: string | null } | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [threadRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT payload FROM "${schema}"."chat_threads" WHERE id = $1 LIMIT 1`,
        values: [threadId],
      },
    ],
  });
  const row = threadRes?.rows?.[0] as { payload?: string } | undefined;
  if (!row?.payload) return null;
  const payload = safeParseJson<Record<string, unknown> | null>(row.payload, null);
  if (!payload) return null;
  return {
    ownerUserId:
      typeof payload.ownerUserId === "string" ? payload.ownerUserId : null,
    teamId: typeof payload.teamId === "string" ? payload.teamId : null,
  };
}

/**
 * Same tenant-scoped predicate as the reader, for the chat-save write path: a
 * caller may only write a team-owned thread when they are a member of the
 * team's owning organization (matching the read-side visibility).
 */
export function isActorTeamMemberForChat(
  teamId: string,
  actorUserId: string,
): boolean {
  ensurePostgresSchema();
  return isActorMemberOfTeamOrg(teamId, actorUserId);
}
