// Structured assistant-thread + assistant-turn store (cinatra-ai/cinatra#1037
// P2a, the assistant-runtime persistence half).
//
// Owns the #1037-P2 side of the unified assistant-stream boundary named in
// @cinatra-ai/agent-ui-protocol CONTRACT.md §1: the THREAD MODEL, message/turn
// PERSISTENCE, principal ATTRIBUTION, and the TURN↔RUN linkage. It deliberately
// does NOT persist the event stream — a turn's AG-UI events live in the durable
// Redis-Streams log keyed by `run_id` (`cinatra:a2a:events:{run_id}`), which the
// stream contract owns. A `assistant_turns` row is metadata + the run pointer,
// so there is no double persistence model.
//
// A **turn** is one AG-UI run in a thread (the contract's definition): the
// events between a RUN_STARTED and its terminal frame. `status` mirrors that
// lifecycle: 'running' → 'completed' | 'error'.
//
// This is a SYNC LEAF store (like chat-thread-store.ts): it imports only the
// sync postgres primitives and never reaches an async-root module, so it stays
// callable from the sync store composition. The pure row/serialization helpers
// are exported separately so they are unit-testable without a database. Wiring
// the runtime + the /chat persistence subroutes onto this store is P2b/P3 — for
// now the store exists and is covered, and the legacy chat_threads path is
// untouched (no double-write).
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantTurnStatus = "running" | "completed" | "error";
export type AssistantTurnRole = "user" | "assistant";

export type AssistantThread = {
  id: string;
  /** The bound assistant PRINCIPAL (assistant-user id) for this thread. */
  assistantUserId: string | null;
  /** The human owner who created/owns the thread. */
  ownerUserId: string | null;
  orgId: string | null;
  title: string | null;
  /** A2A `contextId` continuity handle (epic #1037 §4/§5). */
  contextId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantTurn = {
  id: string;
  threadId: string;
  /** The AG-UI run id keying the durable event log; null until the run starts. */
  runId: string | null;
  /** Principal attribution (I4): the assistant that produced this turn. */
  assistantUserId: string | null;
  role: AssistantTurnRole;
  status: AssistantTurnStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateAssistantThreadInput = {
  /** Optional explicit id (defaults to a fresh UUID). */
  id?: string;
  assistantUserId?: string | null;
  ownerUserId?: string | null;
  orgId?: string | null;
  title?: string | null;
  contextId?: string | null;
};

export type AppendAssistantTurnInput = {
  id?: string;
  threadId: string;
  runId?: string | null;
  assistantUserId?: string | null;
  role?: AssistantTurnRole;
  status?: AssistantTurnStatus;
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

const VALID_TURN_STATUSES: readonly AssistantTurnStatus[] = ["running", "completed", "error"];
const VALID_TURN_ROLES: readonly AssistantTurnRole[] = ["user", "assistant"];

export function isAssistantTurnStatus(value: unknown): value is AssistantTurnStatus {
  return typeof value === "string" && (VALID_TURN_STATUSES as readonly string[]).includes(value);
}

export function isAssistantTurnRole(value: unknown): value is AssistantTurnRole {
  return typeof value === "string" && (VALID_TURN_ROLES as readonly string[]).includes(value);
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return new Date(0).toISOString();
}

/** Map a raw `assistant_threads` DB row to the typed record. Pure. */
export function mapAssistantThreadRow(row: Record<string, unknown>): AssistantThread {
  return {
    id: String(row.id),
    assistantUserId: toStringOrNull(row.assistant_user_id),
    ownerUserId: toStringOrNull(row.owner_user_id),
    orgId: toStringOrNull(row.org_id),
    title: toStringOrNull(row.title),
    contextId: toStringOrNull(row.context_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Map a raw `assistant_turns` DB row to the typed record. Pure. Falls back to
 *  the schema defaults for an out-of-domain role/status (a CHECK-guarded column
 *  should never yield one, but the mapper stays total). */
export function mapAssistantTurnRow(row: Record<string, unknown>): AssistantTurn {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: toStringOrNull(row.run_id),
    assistantUserId: toStringOrNull(row.assistant_user_id),
    role: isAssistantTurnRole(row.role) ? row.role : "assistant",
    status: isAssistantTurnStatus(row.status) ? row.status : "running",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Sync store operations
// ---------------------------------------------------------------------------

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** Create a structured assistant thread; returns the persisted record. */
export function createAssistantThread(input: CreateAssistantThreadInput): AssistantThread {
  ensurePostgresSchema();
  const id = input.id ?? randomUUID();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."assistant_threads"
                 (id, assistant_user_id, owner_user_id, org_id, title, context_id)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, assistant_user_id, owner_user_id, org_id, title, context_id, created_at, updated_at`,
        values: [
          id,
          input.assistantUserId ?? null,
          input.ownerUserId ?? null,
          input.orgId ?? null,
          input.title ?? null,
          input.contextId ?? null,
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("createAssistantThread: insert returned no row");
  return mapAssistantThreadRow(row);
}

/** Load a single thread by id, or null when absent. No authorization — callers
 *  apply their own tenant policy (mirrors chat-thread-store's split). */
export function getAssistantThread(threadId: string): AssistantThread | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, title, context_id, created_at, updated_at
               FROM "${schema}"."assistant_threads" WHERE id = $1 LIMIT 1`,
        values: [threadId],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  return row ? mapAssistantThreadRow(row) : null;
}

/** List an org's threads, most-recently-updated first (uses the org index). */
export function listAssistantThreadsForOrg(orgId: string, limit = 50): AssistantThread[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, title, context_id, created_at, updated_at
               FROM "${schema}"."assistant_threads"
               WHERE org_id = $1
               ORDER BY updated_at DESC, id
               LIMIT $2`,
        values: [orgId, limit],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => mapAssistantThreadRow(r as Record<string, unknown>));
}

/** Bump a thread's `updated_at` (e.g. on a new turn) so it sorts to the top. */
export function touchAssistantThread(threadId: string): void {
  ensurePostgresSchema();
  const schema = schemaIdent();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."assistant_threads" SET updated_at = now() WHERE id = $1`,
        values: [threadId],
      },
    ],
  });
}

/** Id namespace RESERVED for the legacy chat_threads write-through mirror
 *  (cinatra#1037 P2b — see LEGACY_MIRROR_TURN_ID_PREFIX in
 *  src/lib/project-inheritance.ts; a unit test pins the two constants equal).
 *  The mirror's reconcile DELETE is scoped to this prefix, so a store-minted
 *  row must never enter the namespace or a legacy write could delete it. */
export const RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX = "legacy:";

/** Append a turn (one AG-UI run) to a thread; returns the persisted record. The
 *  FK guarantees the thread exists. Does not touch the durable event log.
 *  Fail-loud rejects explicit ids in the reserved legacy-mirror namespace. */
export function appendAssistantTurn(input: AppendAssistantTurnInput): AssistantTurn {
  ensurePostgresSchema();
  if (input.id?.startsWith(RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX)) {
    throw new Error(
      `appendAssistantTurn: turn id namespace "${RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX}" is reserved for the legacy chat_threads mirror (cinatra#1037 P2b)`,
    );
  }
  const id = input.id ?? randomUUID();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."assistant_turns"
                 (id, thread_id, run_id, assistant_user_id, role, status)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, thread_id, run_id, assistant_user_id, role, status, created_at, updated_at`,
        values: [
          id,
          input.threadId,
          input.runId ?? null,
          input.assistantUserId ?? null,
          input.role ?? "assistant",
          input.status ?? "running",
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("appendAssistantTurn: insert returned no row");
  return mapAssistantTurnRow(row);
}

/** Advance a turn's lifecycle status (RUN_FINISHED → 'completed', RUN_ERROR →
 *  'error'), optionally binding the AG-UI `runId` when the run starts. */
export function updateAssistantTurn(
  turnId: string,
  patch: { status?: AssistantTurnStatus; runId?: string | null },
): void {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.runId !== undefined) {
    values.push(patch.runId);
    sets.push(`run_id = $${values.length}`);
  }
  values.push(turnId);
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."assistant_turns" SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      },
    ],
  });
}

/** List a thread's turns in creation order (uses the per-thread index). */
export function listAssistantTurns(threadId: string): AssistantTurn[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, thread_id, run_id, assistant_user_id, role, status, created_at, updated_at
               FROM "${schema}"."assistant_turns"
               WHERE thread_id = $1
               ORDER BY created_at, id`,
        values: [threadId],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => mapAssistantTurnRow(r as Record<string, unknown>));
}
