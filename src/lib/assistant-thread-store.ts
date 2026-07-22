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
// The PURE title-slug allocator core (cinatra#1878 W3, AC#2). Zero-dep leaf —
// keeps this sync store sync (reaches no async-root import); the container-scoped
// atomic mint below drives it against the `assistant_threads_container_slug_uniq`
// unique index.
import { allocateByAttempt, slugifyTitle } from "@cinatra-ai/chat/thread-slug";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantTurnStatus = "running" | "completed" | "error";
export type AssistantTurnRole = "user" | "assistant";

/** Thread-origin discriminator (cinatra#1037 P5.6 PR2 CUTOVER): the PROVENANCE
 *  of a structured thread, stamped by whichever writer minted it.
 *   - 'legacy-chat'      — minted through the legacy chat_threads write path
 *     (the assistant_threads mirror write-through stamps this).
 *   - 'assistant-native' — minted directly on the structured store by the
 *     assistant runtime (createAssistantThread stamps this).
 *  The legacy delete-all wipe restricts to the caller's OWN 'legacy-chat'
 *  threads, so runtime-native threads survive it. */
export type AssistantThreadOrigin = "legacy-chat" | "assistant-native";

export type AssistantThread = {
  id: string;
  /** The bound assistant PRINCIPAL (assistant-user id) for this thread. */
  assistantUserId: string | null;
  /** The human owner who created/owns the thread. */
  ownerUserId: string | null;
  orgId: string | null;
  /** Project scope (cinatra#1037 P5.6 PR2): the structured twin of
   *  chat_threads.project_id. NULL for ambient/legacy threads. */
  projectId: string | null;
  /** Team ownership (cinatra#1037 P5.6 PR2, coordinator-authorized Fork-B
   *  extension): the structured twin of the legacy payload's teamId. NULL for
   *  personal/legacy threads. The axis the list/http/classifier visibility
   *  consumers distinguish team-owned threads by once re-pointed off chat_threads. */
  teamId: string | null;
  /** Thread-origin discriminator (cinatra#1037 P5.6 PR2 CUTOVER): 'legacy-chat'
   *  vs 'assistant-native' provenance. NULL for rows written before the column
   *  existed (until their writer re-stamps them). */
  origin: AssistantThreadOrigin | null;
  title: string | null;
  /** A2A `contextId` continuity handle (epic #1037 §4/§5). */
  contextId: string | null;
  /** Canonical thread BINDING (cinatra#1875 W2, AC#4): the registered assistant
   *  PACKAGE that drives the thread (package-keyed, so the W1 registry reader's
   *  audience gate resolves it directly). NULL == an unbound thread
   *  (implicit-@cinatra, backward compatible). */
  assistantPackage: string | null;
  /** Canonical thread BINDING (cinatra#1875 W2, AC#4): the OPTIONAL project/site
   *  instance the binding is scoped to, carried into dispatch context. NULL when
   *  the binding is not instance-scoped. */
  instanceId: string | null;
  /** The thread's URL title-slug (cinatra#1878 W3, AC#2): the stable
   *  `/chat/<vendor>/<slug>/[<instance>/]<titleSlug>` segment, minted ONCE by the
   *  atomic allocator from the title, container-scoped-unique. NULL == a
   *  titleless thread whose slug has not been minted yet. */
  titleSlug: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The canonical per-thread binding `{assistantPackage, instanceId?}` (cinatra#1875
 *  W2, AC#4). `assistantPackage` is the registered assistant package that drives
 *  the thread; `instanceId` scopes the binding to a project/site instance when
 *  present. Read/written at the thread seam the W1 registry reader supports. */
export type AssistantThreadBinding = {
  assistantPackage: string;
  instanceId?: string | null;
};

/** Durable per-turn message content (cinatra#1037 P5.6 drop-history PR1 EXPAND):
 *  a JSON object holding what /chat needs to reconstruct the turn faithfully
 *  (role, content, parts, tool calls, …). Persisted in `assistant_turns.content`
 *  jsonb; NULL on pre-EXPAND / content-less mirror shadow rows. */
export type AssistantTurnContent = Record<string, unknown>;

export type AssistantTurn = {
  id: string;
  threadId: string;
  /** The AG-UI run id keying the durable event log; null until the run starts. */
  runId: string | null;
  /** Principal attribution (I4): the assistant that produced this turn. */
  assistantUserId: string | null;
  role: AssistantTurnRole;
  status: AssistantTurnStatus;
  /** Durable per-turn message content (PR1 EXPAND); null when contentless. */
  content: AssistantTurnContent | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAssistantThreadInput = {
  /** Optional explicit id (defaults to a fresh UUID). */
  id?: string;
  assistantUserId?: string | null;
  ownerUserId?: string | null;
  orgId?: string | null;
  projectId?: string | null;
  title?: string | null;
  contextId?: string | null;
  /** Optional canonical binding at creation (cinatra#1875 W2, AC#4); usually
   *  seeded/updated later via {@link bindAssistantThread}. */
  assistantPackage?: string | null;
  instanceId?: string | null;
};

export type AppendAssistantTurnInput = {
  id?: string;
  threadId: string;
  runId?: string | null;
  assistantUserId?: string | null;
  role?: AssistantTurnRole;
  status?: AssistantTurnStatus;
  /** Optional durable content at insert (PR1 EXPAND); usually written later via
   *  updateAssistantTurn when the turn completes. */
  content?: AssistantTurnContent | null;
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

const VALID_THREAD_ORIGINS: readonly AssistantThreadOrigin[] = ["legacy-chat", "assistant-native"];

/** Narrow a raw `origin` cell to the discriminator domain, or null. A stray
 *  out-of-domain value (the column CHECK forbids one at rest) maps to null so
 *  the mapper stays total and never over-classifies. */
function toOriginOrNull(v: unknown): AssistantThreadOrigin | null {
  return typeof v === "string" && (VALID_THREAD_ORIGINS as readonly string[]).includes(v)
    ? (v as AssistantThreadOrigin)
    : null;
}

/** Normalize a raw `content` jsonb cell to a plain object or null. The pg driver
 *  parses jsonb to a JS value, but tolerate a raw JSON string defensively (some
 *  drivers/paths hand back the text). Non-object → null. */
function toContentOrNull(v: unknown): AssistantTurnContent | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as AssistantTurnContent;
  }
  if (typeof v === "string" && v.length > 0) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AssistantTurnContent;
      }
    } catch {
      // not JSON — no durable content
    }
  }
  return null;
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
    projectId: toStringOrNull(row.project_id),
    teamId: toStringOrNull(row.team_id),
    origin: toOriginOrNull(row.origin),
    title: toStringOrNull(row.title),
    contextId: toStringOrNull(row.context_id),
    assistantPackage: toStringOrNull(row.assistant_package),
    instanceId: toStringOrNull(row.instance_id),
    titleSlug: toStringOrNull(row.title_slug),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Extract the canonical binding from a thread record, or null when the thread is
 *  unbound (no `assistantPackage`). Pure — the read-side twin of
 *  {@link bindAssistantThread}. */
export function threadBindingOf(thread: AssistantThread): AssistantThreadBinding | null {
  if (!thread.assistantPackage) return null;
  return { assistantPackage: thread.assistantPackage, instanceId: thread.instanceId };
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
    // jsonb is already parsed to a JS value by the pg driver. Keep only a plain
    // object (the column CHECK enforces this at rest; the mapper stays total).
    content: toContentOrNull(row.content),
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

// ---------------------------------------------------------------------------
// Thread title-slug allocator — the DB seam (cinatra#1878 W3, AC#2). The PURE
// normalization + collision policy lives in @cinatra-ai/chat/thread-slug; this
// half drives the atomic, container-scoped mint against the
// `assistant_threads_container_slug_uniq` unique index. First-writer-wins:
//   - createAssistantThread mints AT insert when a title is present (no titled
//     row commits slugless);
//   - a titleless create defers (title_slug NULL);
//   - ensureThreadSlug is the deferred/idempotent mint the FIRST titled persist
//     calls (no-op if a slug already exists; concurrent titled writers of the
//     SAME thread converge on exactly one slug via the `title_slug IS NULL`
//     guard);
//   - a rename never re-slugs (the guard + no-op keep the URL stable).
// ---------------------------------------------------------------------------

/** True when a sync-runner error is a container slug-uniqueness violation (the
 *  index the allocator retries against). The sync worker surfaces the pg error
 *  as a plain message string (no `.code`), so match the constraint name. */
export function isContainerSlugUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /duplicate key value violates unique constraint/i.test(msg) &&
    /assistant_threads_container_slug_uniq/.test(msg)
  );
}

/** Create a structured assistant thread; returns the persisted record. When a
 *  title is present, mints the container-scoped title-slug ATOMICALLY at insert
 *  (retrying a suffixed candidate on a container collision) so a titled row never
 *  commits slugless; a titleless create defers the slug (NULL). */
export function createAssistantThread(input: CreateAssistantThreadInput): AssistantThread {
  ensurePostgresSchema();
  const id = input.id ?? randomUUID();
  const schema = schemaIdent();

  const insertWithSlug = (titleSlug: string | null): AssistantThread => {
    // origin is stamped 'assistant-native' — createAssistantThread is the
    // structured-native writer (assistant runtime). The legacy delete-all wipe
    // restricts to 'legacy-chat' rows, so a thread born here survives it.
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `INSERT INTO "${schema}"."assistant_threads"
                   (id, assistant_user_id, owner_user_id, org_id, project_id, origin, title, context_id, assistant_package, instance_id, title_slug)
                 VALUES ($1, $2, $3, $4, $5, 'assistant-native', $6, $7, $8, $9, $10)
                 RETURNING id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at`,
          values: [
            id,
            input.assistantUserId ?? null,
            input.ownerUserId ?? null,
            input.orgId ?? null,
            input.projectId ?? null,
            input.title ?? null,
            input.contextId ?? null,
            input.assistantPackage ?? null,
            input.instanceId ?? null,
            titleSlug,
          ],
        },
      ],
    });
    const row = res?.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("createAssistantThread: insert returned no row");
    return mapAssistantThreadRow(row);
  };

  // Titleless create → defer the slug (NULL); the first titled persist mints it.
  if (input.title == null || input.title.trim().length === 0) {
    return insertWithSlug(null);
  }

  // Titled create → mint the slug at insert. Each attempt is its OWN transaction
  // (a failed insert on the container index rolls back cleanly and the id is free
  // to reuse), so the retry loop is atomic per attempt.
  let created: AssistantThread | null = null;
  allocateByAttempt(
    slugifyTitle(input.title),
    (candidate) => {
      try {
        created = insertWithSlug(candidate);
        return true;
      } catch (err) {
        if (isContainerSlugUniqueViolation(err)) return false; // container collision → next candidate
        throw err;
      }
    },
    { uniqueTail: id },
  );
  if (!created) throw new Error("createAssistantThread: slug allocation returned no row");
  return created;
}

/**
 * The DEFERRED, idempotent title-slug mint (cinatra#1878 W3, AC#2) — the seam a
 * title-bearing persist calls to give a titleless thread its stable URL slug.
 *   - NO-OP if a slug already exists (returns it) — the idempotency that keeps a
 *     rename from re-slugging and makes concurrent titled writers converge.
 *   - Otherwise a CONDITIONAL update (`title_slug IS NULL` guard) mints the
 *     container-scoped slug; a container collision retries a suffixed candidate;
 *     if another writer set the slug first (0 rows updated), re-reads and returns
 *     THEIR slug — so exactly one slug is ever minted for a thread.
 * Returns the thread's slug, or null when the thread does not exist.
 */
export function ensureThreadSlug(
  threadId: string,
  title?: string | null,
): string | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const existing = getAssistantThread(threadId);
  if (!existing) return null;
  if (existing.titleSlug) return existing.titleSlug; // no-op: slug already minted

  const base = slugifyTitle(title ?? existing.title);
  let minted: string | null = null;
  allocateByAttempt(
    base,
    (candidate) => {
      let res;
      try {
        [res] = runPostgresQueriesSync({
          connectionString: getPostgresConnectionString(),
          queries: [
            {
              // First-writer-wins guard: only sets the slug while it is still NULL.
              text: `UPDATE "${schema}"."assistant_threads"
                     SET title_slug = $1, updated_at = now()
                     WHERE id = $2 AND title_slug IS NULL
                     RETURNING title_slug`,
              values: [candidate, threadId],
            },
          ],
        });
      } catch (err) {
        if (isContainerSlugUniqueViolation(err)) return false; // container collision → next candidate
        throw err;
      }
      if ((res?.rowCount ?? 0) > 0) {
        minted = candidate;
        return true;
      }
      // 0 rows: another writer minted first (or the thread vanished) — adopt the
      // committed slug so exactly one slug is minted for the thread.
      minted = getAssistantThread(threadId)?.titleSlug ?? null;
      return true;
    },
    { uniqueTail: threadId },
  );
  return minted;
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
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads" WHERE id = $1 LIMIT 1`,
        values: [threadId],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  return row ? mapAssistantThreadRow(row) : null;
}

/**
 * Resolve a thread by its container-scoped title-slug (cinatra#1878 W3) — the
 * read the /chat route uses to turn `/chat/<vendor>/<slug>/[<instance>/]<slug>`
 * back into the durable thread id. The container is `(assistantPackage,
 * instanceId?)`; NULL package/instance collapse to '' exactly like the unique
 * index, so the lookup key matches the mint key. No authorization — the caller
 * applies the actor's audience/thread-access policy (the route guard + the
 * downstream authorized thread load). Returns the thread, or null when no thread
 * in that container carries the slug.
 */
export function getAssistantThreadBySlug(
  assistantPackage: string | null,
  instanceId: string | null,
  titleSlug: string,
): AssistantThread | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads"
               WHERE COALESCE(assistant_package, '') = COALESCE($1, '')
                 AND COALESCE(instance_id, '') = COALESCE($2, '')
                 AND title_slug = $3
               LIMIT 1`,
        values: [assistantPackage, instanceId, titleSlug],
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
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
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

/** List the org threads VISIBLE TO one non-admin actor, most-recently-updated
 *  first: personally owned rows plus rows whose bound assistant principal IS
 *  the actor (the participant axis). The SQL predicate is the store-side twin
 *  of the non-admin branch of `evaluateAssistantThreadAccess`
 *  (src/lib/assistant-thread-access.ts) so a page of `limit` rows can never be
 *  crowded out by newer rows the actor may not see (cinatra#1037 P5.5; codex
 *  round-1 #1). Callers still re-apply the pure decision per row —
 *  defense-in-depth against predicate drift. */
export function listAssistantThreadsForOrgVisibleTo(
  orgId: string,
  actorUserId: string,
  limit = 50,
): AssistantThread[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads"
               WHERE org_id = $1
                 AND (owner_user_id = $2 OR assistant_user_id = $2)
               ORDER BY updated_at DESC, id
               LIMIT $3`,
        values: [orgId, actorUserId, limit],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => mapAssistantThreadRow(r as Record<string, unknown>));
}

/** Load the team-owned thread for a team (cinatra#1037 P5.6 PR2 CUTOVER) — the
 *  structured lookup twin of `ensureTeamThread`'s legacy `chat_threads` scan for
 *  the row whose `teamId` matches. A team has at most one thread (ensureTeamThread
 *  creates one if absent); the most-recently-updated match is returned defensively
 *  via the partial team index (`assistant_threads_team_updated_idx`, team_id +
 *  updated_at DESC WHERE team_id IS NOT NULL). NO durable-content filter — this is
 *  an EXISTENCE/ownership probe, so a freshly-minted (empty) team thread is found;
 *  NO authorization — callers apply their own active-org membership policy. Returns
 *  null when the team has no thread. */
export function getAssistantThreadByTeamId(teamId: string): AssistantThread | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads"
               WHERE team_id = $1
               ORDER BY updated_at DESC, id
               LIMIT 1`,
        values: [teamId],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  return row ? mapAssistantThreadRow(row) : null;
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

/** Persist the canonical BINDING `{assistantPackage, instanceId?}` on a thread
 *  (cinatra#1875 W2, AC#4). Sets `assistant_package` + `instance_id` and bumps
 *  `updated_at`. `instanceId` omitted/undefined clears the instance scope (NULL);
 *  pass an explicit value to scope the binding. The write-side twin the W3 route
 *  seeds; dispatch reads it back via {@link readAssistantThreadBinding}. */
export function bindAssistantThread(threadId: string, binding: AssistantThreadBinding): void {
  ensurePostgresSchema();
  const schema = schemaIdent();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."assistant_threads"
               SET assistant_package = $1, instance_id = $2, updated_at = now()
               WHERE id = $3`,
        values: [binding.assistantPackage, binding.instanceId ?? null, threadId],
      },
    ],
  });
}

/** Read a thread's canonical binding, or null when the thread is absent or
 *  unbound (no `assistant_package`). The read-side twin of
 *  {@link bindAssistantThread}; dispatch consults it to carry the bound package
 *  (+ instance) into the turn context. */
export function readAssistantThreadBinding(threadId: string): AssistantThreadBinding | null {
  const thread = getAssistantThread(threadId);
  return thread ? threadBindingOf(thread) : null;
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
                 (id, thread_id, run_id, assistant_user_id, role, status, content)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
               RETURNING id, thread_id, run_id, assistant_user_id, role, status, content, created_at, updated_at`,
        values: [
          id,
          input.threadId,
          input.runId ?? null,
          input.assistantUserId ?? null,
          input.role ?? "assistant",
          input.status ?? "running",
          // Durable content is usually written later at completion; NULL at
          // insert unless the caller supplied it.
          input.content != null ? JSON.stringify(input.content) : null,
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("appendAssistantTurn: insert returned no row");
  return mapAssistantTurnRow(row);
}

/** Advance a turn's lifecycle status (RUN_FINISHED → 'completed', RUN_ERROR →
 *  'error'), optionally binding the AG-UI `runId` when the run starts, and
 *  (PR1 EXPAND) writing the durable per-turn `content` when the turn completes.
 *  `content` is written only when the key is present in the patch; pass `null`
 *  to explicitly clear it (distinct from omitting the key = leave unchanged). */
export function updateAssistantTurn(
  turnId: string,
  patch: {
    status?: AssistantTurnStatus;
    runId?: string | null;
    content?: AssistantTurnContent | null;
  },
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
  if ("content" in patch) {
    values.push(patch.content != null ? JSON.stringify(patch.content) : null);
    sets.push(`content = $${values.length}::jsonb`);
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

/** Resolve a turn by its AG-UI `run_id` (the durable-log key). Used by the
 *  assistant run-stream route (cinatra#1216 S2) to authorize a resume/tail
 *  subscription: run_id → turn → thread → the thread's access policy. Uses the
 *  partial run_id index (`assistant_turns_run_id_idx`); mirror rows have
 *  run_id NULL and never match. Returns the newest match defensively (run_id
 *  is minted per-turn by the runtime and should be unique). */
export function findAssistantTurnByRunId(runId: string): AssistantTurn | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, thread_id, run_id, assistant_user_id, role, status, content, created_at, updated_at
               FROM "${schema}"."assistant_turns"
               WHERE run_id = $1
               ORDER BY created_at DESC, id
               LIMIT 1`,
        values: [runId],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  return row ? mapAssistantTurnRow(row) : null;
}

/** List a thread's turns in creation order (uses the per-thread index). */
export function listAssistantTurns(threadId: string): AssistantTurn[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, thread_id, run_id, assistant_user_id, role, status, content, created_at, updated_at
               FROM "${schema}"."assistant_turns"
               WHERE thread_id = $1
               ORDER BY created_at, id`,
        values: [threadId],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => mapAssistantTurnRow(r as Record<string, unknown>));
}

/** List a thread's paused participants (cinatra#1037 P5.6 PR2 CUTOVER). The
 *  structured read twin of the legacy payload's `pausedParticipants` array:
 *  presence in `assistant_thread_pause_state` == paused. Empty when none. */
export function listPausedParticipants(threadId: string): string[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT participant_id FROM "${schema}"."assistant_thread_pause_state"
               WHERE thread_id = $1 ORDER BY participant_id`,
        values: [threadId],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => String((r as Record<string, unknown>).participant_id));
}

/** Pause or resume ONE participant in a thread (cinatra#1037 P5.6 PR2 CUTOVER),
 *  writing DIRECTLY to the structured `assistant_thread_pause_state` table — the
 *  ATOMIC replacement for setAssistantPauseState's read-chat_threads +
 *  whole-payload re-upsert (which last-writer-wins under concurrency). Presence
 *  == paused: `paused=true` INSERTs the row (idempotent ON CONFLICT DO NOTHING),
 *  `paused=false` DELETEs it. Deliberately does NOT bump the thread's updated_at
 *  — pausing is not conversational activity, so it must not reorder the
 *  activity-sorted sidebar (#283). The `listPausedParticipants` read is its twin. */
export function setAssistantThreadPauseParticipant(
  threadId: string,
  participantId: string,
  paused: boolean,
): void {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const query = paused
    ? {
        text: `INSERT INTO "${schema}"."assistant_thread_pause_state" (thread_id, participant_id)
               VALUES ($1, $2)
               ON CONFLICT (thread_id, participant_id) DO NOTHING`,
        values: [threadId, participantId],
      }
    : {
        text: `DELETE FROM "${schema}"."assistant_thread_pause_state"
               WHERE thread_id = $1 AND participant_id = $2`,
        values: [threadId, participantId],
      };
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [query],
  });
}

/** The set of thread ids that hold DURABLE /chat content (cinatra#1037 P5.6 PR2
 *  CUTOVER). A thread is POST-cutover (readable/listable) iff it has >=1
 *  LEGACY-MIRROR turn (deterministic `legacy:` id, run_id NULL) with non-NULL
 *  `content` — the DB-observable exclusion predicate (codex-converged). The
 *  legacy-mirror scope is load-bearing: a runtime-native turn (bare UUID, run_id
 *  set) also carries content but is a DIFFERENT representation and must never
 *  false-include a pre-EXPAND shadow. Pre-cutover threads (content-less shadows
 *  minted before PR1 EXPAND, or empty threads) are absent and excluded. One
 *  scan; the caller intersects it with the thread rows it is listing. */
export function listAssistantThreadIdsWithDurableContent(): Set<string> {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT DISTINCT thread_id FROM "${schema}"."assistant_turns"
               WHERE content IS NOT NULL
                 AND run_id IS NULL
                 AND id LIKE '${RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX}%'`,
        values: [],
      },
    ],
  });
  return new Set((res?.rows ?? []).map((r) => String((r as Record<string, unknown>).thread_id)));
}

/** The set of thread ids ANCHORED to one org (cinatra#1037 P5.6 PR2 CUTOVER —
 *  the "#134" listing contract). The structured mirror carries the
 *  `org_id` tenancy anchor that the legacy `chat_threads` table lacks, so this
 *  is how the flat /chat list is org-scoped to the acting org: a personal thread
 *  is listable only when its mirror `org_id` equals the caller's active org (the
 *  built-in assistant's workspace audience, interim per the #1873 W3 binding).
 *  Unbounded id-only scan (no LIMIT) — the caller intersects it with the rows it
 *  is listing. Team-owned threads mirror with org_id NULL and never enter this
 *  set (they belong to the team panel, not the flat list). */
export function listAssistantThreadIdsForOrg(orgId: string): Set<string> {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id FROM "${schema}"."assistant_threads" WHERE org_id = $1`,
        values: [orgId],
      },
    ],
  });
  return new Set((res?.rows ?? []).map((r) => String((r as Record<string, unknown>).id)));
}

/** A lightweight thread SUMMARY for the flat /chat list (cinatra#1037 P5.6 PR2
 *  CUTOVER): identity + title + timestamps + the ownership axes the list-visibility
 *  consumers distinguish, WITHOUT reconstructing the full message payload. */
export type AssistantThreadSummary = {
  id: string;
  title: string | null;
  ownerUserId: string | null;
  teamId: string | null;
  origin: AssistantThreadOrigin | null;
  /** Canonical binding + URL slug (cinatra#1878 W3) — the fields a consumer needs
   *  to build the thread's canonical `/chat/<vendor>/<slug>[/<instance>]/<titleSlug>`
   *  link via the codec (the user-profile "Recent Conversations" list). NULL slug
   *  == not-yet-minted; NULL package == an unbound thread (no addressable
   *  container yet — the caller falls back to the bare `/chat` mount). */
  assistantPackage: string | null;
  instanceId: string | null;
  titleSlug: string | null;
  createdAt: string;
  updatedAt: string;
};

/** List the durable-content thread SUMMARIES owned by one user within one org
 *  (cinatra#1037 P5.6 PR2 CUTOVER) — the structured replacement for the flat
 *  /chat list's `readChatThreadsFromDatabase()` scan on the #134 org+owner
 *  audience seam (handleListAssistantThreads / users/[userId] / fetchChatThreads).
 *  Scoped in BOTH axes via the structured mirror's `org_id` + `owner_user_id`
 *  anchors (chat_threads carries neither): only rows the caller OWNS AND anchored
 *  to the acting org. Excludes PRE-CUTOVER threads — a thread is listable iff it
 *  has >=1 legacy-mirror content turn (the SAME durable-content predicate as
 *  listAssistantThreadIdsWithDurableContent, applied as a correlated EXISTS so the
 *  scope + content gate + ordering are one indexed scan). Team threads
 *  (owner_user_id NULL / team_id set) never enter an owner-scoped list. Ordered
 *  createdAt DESC to match the PINNED legacy sidebar ordering (#1037 PR2). */
export function listAssistantThreadSummariesForOwnerInOrg(
  orgId: string,
  ownerUserId: string,
  limit = 200,
): AssistantThreadSummary[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const prefix = RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX;
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT at.id, at.owner_user_id, at.team_id, at.origin, at.title, at.assistant_package, at.instance_id, at.title_slug, at.created_at, at.updated_at
               FROM "${schema}"."assistant_threads" at
               WHERE at.org_id = $1
                 AND at.owner_user_id = $2
                 AND EXISTS (
                   SELECT 1 FROM "${schema}"."assistant_turns" tt
                   WHERE tt.thread_id = at.id
                     AND tt.content IS NOT NULL
                     AND tt.run_id IS NULL
                     AND tt.id LIKE '${prefix}%'
                 )
               ORDER BY at.created_at DESC, at.id
               LIMIT $3`,
        values: [orgId, ownerUserId, limit],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      title: toStringOrNull(row.title),
      ownerUserId: toStringOrNull(row.owner_user_id),
      teamId: toStringOrNull(row.team_id),
      origin: toOriginOrNull(row.origin),
      assistantPackage: toStringOrNull(row.assistant_package),
      instanceId: toStringOrNull(row.instance_id),
      titleSlug: toStringOrNull(row.title_slug),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  });
}

/**
 * PURE reconstruction of the /chat thread payload from the structured parts —
 * unit-testable without a database (the DB reads live in
 * `reconstructThreadPayload`). Returns null when the thread is PRE-CUTOVER.
 *
 * EXCLUSION + FAITHFUL CONTENT (codex-converged): the /chat message content
 * lives EXCLUSIVELY in the LEGACY-MIRROR projection turns (deterministic
 * `legacy:` ids, run_id NULL, non-NULL `content`). Runtime-native turns (bare
 * UUID, run_id set) are a DIFFERENT representation and are NEVER mixed into the
 * reconstruction. A thread is readable iff it has >=1 such turn; a content-less
 * shadow or an empty thread reconstructs to null (404 / absent-from-list). Each
 * surviving turn's `content` IS the full persisted message object (PR1 EXPAND:
 * `parse(content)` deep-equals `payload.messages[i]`); `turns` MUST already be in
 * `ordinal` order (the caller's query orders by it), so `messages` is a faithful,
 * lossless, correctly-ordered reconstruction.
 *
 * The durable thread-level render-state scalars (`activeAssistantHandle`,
 * `taggedAssistantUserIds`, `slackMode`) are read back DIRECTLY from the persisted
 * `scalars` object (they are state, not losslessly derivable from the messages —
 * codex convergence), spread first so the modeled fields always win.
 */
export function assembleThreadPayloadFromParts(
  thread: AssistantThread,
  turns: AssistantTurn[],
  pausedParticipants: string[],
  scalars: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const contentTurns = turns.filter(
    (t) =>
      t.content !== null &&
      t.runId === null &&
      t.id.startsWith(RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX),
  );
  if (contentTurns.length === 0) return null; // pre-cutover: no durable /chat content

  const messages = contentTurns.map((t) => t.content as Record<string, unknown>);

  const payload: Record<string, unknown> = {
    // Durable render-state scalars, reconstructed directly; modeled fields below
    // deliberately overwrite any stale duplicate.
    ...(scalars ?? {}),
    id: thread.id,
    title: thread.title ?? "",
    messages,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    pausedParticipants,
  };
  if (thread.ownerUserId) payload.ownerUserId = thread.ownerUserId;
  if (thread.projectId) payload.projectId = thread.projectId;
  // teamId round-trips faithfully (cinatra#1037 P5.6 PR2): any full-payload
  // re-saver (rename, pause, MCP send) spreads the reconstructed payload back
  // through the mirror's WHOLESALE-overwrite of team_id, so team ownership must
  // survive the round-trip — the same reason ownerUserId/projectId are emitted.
  if (thread.teamId) payload.teamId = thread.teamId;
  return payload;
}

/**
 * Reconstruct the full /chat thread payload for a thread from the STRUCTURED
 * store (cinatra#1037 P5.6 PR2 CUTOVER) — the authoritative read source
 * replacing the legacy `chat_threads.payload`. Reads the thread row (incl. the
 * durable `scalars`), the legacy-mirror content turns ORDERED BY `ordinal` (then
 * created_at/id for pre-PR2 rows without an ordinal), and the structured pause
 * set — ALL in ONE `REPEATABLE READ` transaction so the assembled payload is a
 * single consistent snapshot (never metadata/turns/pause from different
 * concurrent revisions; codex convergence). Returns null when the thread is
 * absent OR pre-cutover (content-less) — callers 404 / exclude.
 */
export function reconstructThreadPayload(threadId: string): Record<string, unknown> | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const prefix = RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX;
  const [, threadRes, turnsRes, pauseRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      // Snapshot isolation for the multi-statement read (BEGIN was issued by the
      // runner; SET TRANSACTION must precede the first query in the tx).
      { text: `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, values: [] },
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, scalars, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads" WHERE id = $1 LIMIT 1`,
        values: [threadId],
      },
      {
        text: `SELECT id, thread_id, run_id, assistant_user_id, role, status, content, created_at, updated_at
               FROM "${schema}"."assistant_turns"
               WHERE thread_id = $1
                 AND content IS NOT NULL
                 AND run_id IS NULL
                 AND id LIKE '${prefix}%'
               ORDER BY ordinal NULLS LAST, created_at, id`,
        values: [threadId],
      },
      {
        text: `SELECT participant_id FROM "${schema}"."assistant_thread_pause_state"
               WHERE thread_id = $1 ORDER BY participant_id`,
        values: [threadId],
      },
    ],
  });

  const threadRow = threadRes?.rows?.[0] as Record<string, unknown> | undefined;
  if (!threadRow) return null;
  const thread = mapAssistantThreadRow(threadRow);
  const scalars = toContentOrNull(threadRow.scalars);
  const turns = (turnsRes?.rows ?? []).map((r) => mapAssistantTurnRow(r as Record<string, unknown>));
  const pausedParticipants = (pauseRes?.rows ?? []).map(
    (r) => String((r as Record<string, unknown>).participant_id),
  );
  return assembleThreadPayloadFromParts(thread, turns, pausedParticipants, scalars);
}

/** One pending @mention of an assistant on a user message (cinatra#1037 P5.6 PR2
 *  CUTOVER) — the structured-store item shape returned to chat_mentions_poll. */
export type PendingMentionItem = {
  threadId: string;
  threadTitle: string;
  messageId: string;
  content: string;
  createdAt: string;
  mentions: unknown[];
};

/** Scan every durable-content thread for user messages carrying a PENDING mention
 *  of `assistantUserId` (cinatra#1037 P5.6 PR2 CUTOVER) — the structured
 *  replacement for chat_mentions_poll's `readChatThreadsFromDatabase()` full-table
 *  scan. Enumerates the readable threads via `listAssistantThreadIdsWithDurableContent`,
 *  reconstructs each faithful payload from the structured store
 *  (`reconstructThreadPayload`), and collects the user messages whose
 *  `mentionState[assistantUserId] === 'pending'`. Pre-cutover / content-less
 *  threads hold no durable messages and are never scanned. Optionally bounded by
 *  `since` (EXCLUSIVE, on a message's createdAt — matches the legacy poll's
 *  `<=` skip) and `limit` (clamped 1..100, default 20; matches the legacy poll).
 *  Message order within a thread follows the ordinal-ordered reconstruction. */
export function scanPendingMentionsForAssistant(
  assistantUserId: string,
  opts?: { since?: string; limit?: number },
): PendingMentionItem[] {
  ensurePostgresSchema();
  const since = opts?.since;
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const items: PendingMentionItem[] = [];
  const threadIds = listAssistantThreadIdsWithDurableContent();
  for (const threadId of threadIds) {
    const payload = reconstructThreadPayload(threadId);
    if (!payload) continue;
    const title = typeof payload.title === "string" ? payload.title : "";
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const raw of messages) {
      const msg = raw as Record<string, unknown>;
      if (msg.role !== "user") continue;
      // Legacy messages with no mentionState are treated as handled (skip).
      const mentionState = msg.mentionState as Record<string, unknown> | undefined;
      if (!mentionState || mentionState[assistantUserId] !== "pending") continue;
      const createdAt = typeof msg.createdAt === "string" ? msg.createdAt : "";
      if (since && createdAt && createdAt <= since) continue;
      items.push({
        threadId,
        threadTitle: title,
        messageId: typeof msg.id === "string" ? msg.id : "",
        content: typeof msg.content === "string" ? msg.content : "",
        createdAt,
        mentions: Array.isArray(msg.mentions) ? (msg.mentions as unknown[]) : [],
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}
