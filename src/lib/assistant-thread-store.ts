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
//
// cinatra#2562 (codex rounds 2-3): a title-slug must NEVER be UUID-shaped.
// That shape is reserved for a thread's pre-slug id-addressed URL — the /chat
// route guard (chat-route-resolver.ts) resolves a UUID-shaped trailing
// segment as an id FIRST, before ever trying a title-slug match. Without the
// exclusion below, `slugifyTitle` could mint a UUID-shaped slug from an
// ordinary title (e.g. a thread literally titled with UUID-like text), and
// that slug could collide with a DIFFERENT thread's real id in the same
// container. TWO independent layers close this, going forward AND for any
// pre-existing data:
//   1. GOING FORWARD: both allocator call sites below reject a UUID-shaped
//      candidate exactly like a container collision (retry the next suffixed
//      candidate, including the `nonUuidUniqueTail`-guarded last resort — see
//      below), so no title_slug this allocator mints is EVER UUID-shaped.
//   2. FOR ANY thread already carrying a UUID-shaped title_slug (impossible
//      to mint going forward, but not provably absent from data written
//      before this fix): the route guard's id-first ordering means an actual
//      id-owner thread, if one exists in the same container, always wins that
//      URL — the legacy slug-owning thread simply stays reachable by every
//      OTHER means (the sidebar, its own current title-slug once re-derived,
//      etc.) except that one specific segment. No thread's CONTENT ever
//      becomes reachable by another actor from this — thread reads are
//      tenant-scoped independently of route resolution (assistant-thread-http.ts).
// ---------------------------------------------------------------------------

/** Canonical UUID shape (the `id` column's Postgres type, and the shape a
 *  title-slug must never take — see the allocator note above). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `uniqueTail` passed to `allocateByAttempt`'s GUARANTEED-unique last
 * resort (`slugWithUniqueTail`, packages/chat/src/thread-slug.ts) — used only
 * after every random-suffix candidate collides. `slugWithUniqueTail` strips
 * non-alnum chars from its input and takes the first 12, so passing a thread's
 * raw (hex-only) id verbatim could — for a title that ALSO slugifies to an
 * exact 23-char `xxxxxxxx-xxxx-xxxx-xxxx` hex/hyphen prefix — complete into a
 * UUID-shaped 5th group, defeating the exclusion above for this one
 * always-mintable last resort (a codex round-3 finding on cinatra#2562).
 * Prefixing with a fixed NON-HEX marker (`z`, outside `[0-9a-f]`) guarantees
 * the derived tail can never be pure hex, so no `uniqueTail`-derived candidate
 * can ever match {@link UUID_RE} — while staying just as unique as the raw id
 * it is 1:1 derived from.
 */
function nonUuidUniqueTail(rawId: string): string {
  return `z${rawId}`;
}

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
      // cinatra#2562: a title-slug must never be UUID-shaped (reserved for the
      // pre-slug id URL) — reject exactly like a container collision.
      if (UUID_RE.test(candidate)) return false;
      try {
        created = insertWithSlug(candidate);
        return true;
      } catch (err) {
        if (isContainerSlugUniqueViolation(err)) return false; // container collision → next candidate
        throw err;
      }
    },
    { uniqueTail: nonUuidUniqueTail(id) },
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
      // cinatra#2562: a title-slug must never be UUID-shaped (reserved for the
      // pre-slug id URL) — reject exactly like a container collision.
      if (UUID_RE.test(candidate)) return false;
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
    { uniqueTail: nonUuidUniqueTail(threadId) },
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

/**
 * Resolve a thread by its durable id, scoped to the EXACT container
 * (assistantPackage, instanceId) — the /chat route guard's pre-slug fallback
 * (cinatra#2562): a thread is addressable by id before its title-slug mints,
 * so `pushChatUrl` builds `/chat/<vendor>/<slug>/[<instance>/]<id>` in that
 * window, and the guard tries this lookup FIRST (before the slug lookup —
 * see the allocator note above on why id-first is safe: no stored title_slug
 * is ever UUID-shaped, so this only ever matches a real id). Container-scoped
 * so an id belonging to a different assistant/instance never resolves as
 * though this route addressed it — mirrors {@link getAssistantThreadBySlug}'s
 * scoping. Returns null for a non-UUID-shaped value (checked before touching
 * the database — a non-UUID param would otherwise throw a Postgres "invalid
 * input syntax for type uuid" error), an absent thread, or a container
 * mismatch. No authorization beyond the container match — the caller applies
 * the actor's audience/thread-access policy exactly like the slug lookup.
 */
export function getAssistantThreadByIdInContainer(
  assistantPackage: string | null,
  instanceId: string | null,
  threadId: string,
): AssistantThread | null {
  if (!UUID_RE.test(threadId)) return null;
  const thread = getAssistantThread(threadId);
  if (!thread) return null;
  if ((thread.assistantPackage ?? null) !== (assistantPackage ?? null)) return null;
  if ((thread.instanceId ?? null) !== (instanceId ?? null)) return null;
  return thread;
}

// ---------------------------------------------------------------------------
// The IMPLICIT-DEFAULT container (cinatra#2642) — an UNBOUND thread's home.
//
// `assistant_package IS NULL` is the documented "unbound thread
// (implicit-@cinatra, backward compatible)" state (see AssistantThread above),
// and the CLIENT's own URL builder already encodes exactly that reading:
// `chatPathForThread` addresses a thread at
// `thread.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE`
// (packages/chat/src/chat-client-url.ts). The SERVER, however, resolved the
// trailing segment ONLY against the EXACT container
// (`COALESCE(assistant_package,'')` = the route's package), so an unbound row
// was out-of-container for the very URL the client builds for it → 404
// (cinatra#2642; the #2589 id-fallback inherits the same container scoping).
//
// These two lookups close that read-side gap WITHOUT widening the container
// rule: they resolve a thread ONLY in the one container the client already
// puts an unbound thread in (the builtin default assistant, no instance), and
// ONLY for the actor who OWNS the row. They take NO destination-package
// parameter BY DESIGN — a caller can never name the package a thread is
// resolved (or repaired) into, so "claim someone's thread into an assistant I
// merely name" is structurally impossible, not merely policy-checked.
//
// The ORDER the route guard applies them in matters and is pinned there
// (chat-route-resolver.ts): exact-container id → implicit-default unbound id →
// exact-container slug → implicit-default unbound slug. Id-before-slug
// preserves #2589's namespace rule; an EXPLICIT binding always beats the
// implicit alias.
// ---------------------------------------------------------------------------

/** The canonical DEFAULT assistant package — the IMPLICIT container an UNBOUND
 *  thread lives in. Held as a CONSTANT, never taken as a parameter: the repair
 *  below can only ever write this one package.
 *
 *  Kept LOCAL (not imported from `@cinatra-ai/chat/chat-path-codec`, which
 *  declares the same value) for the SAME reason that module keeps its own copy
 *  of the builtin package rather than importing the host schema: an import here
 *  would add a cross-package edge to every route that reaches this store — four
 *  locked routes grow by exactly one module and the route-graph ratchet fails.
 *  Pinned equal to the codec's `DEFAULT_ASSISTANT_PACKAGE` by a unit test
 *  (assistant-thread-unbound-store.test.ts), so the two can never drift. */
export const IMPLICIT_DEFAULT_ASSISTANT_PACKAGE = "@cinatra-ai/cinatra-assistant";

/** The transport-verified actor an implicit-default lookup is scoped to. NEVER
 *  built from route/tool input — the caller derives it from the session. */
export type UnboundThreadActor = {
  /** The authenticated user id (the thread's `owner_user_id` must equal it). */
  userId: string;
  /** The actor's active organization, or null when they have none. */
  orgId: string | null;
};

/** True when a thread row is GENUINELY unbound — neither a package nor an
 *  instance, treating the empty string as unset (rows in the field carry both
 *  NULL and '' for these columns). Pure. */
export function isUnboundAssistantThread(thread: AssistantThread): boolean {
  return !(thread.assistantPackage ?? "") && !(thread.instanceId ?? "");
}

/**
 * The PURE eligibility decision for the implicit-default alias (cinatra#2642)
 * — exhaustively unit-testable without a database, and re-asserted in SQL by
 * {@link repairImplicitDefaultThreadBinding} so the write can never outrun it.
 *
 * Eligible iff ALL hold:
 *   - the row is genuinely UNBOUND ({@link isUnboundAssistantThread}) — an
 *     explicitly bound thread keeps the exact-container rule, unchanged;
 *   - the row is NOT team-owned (`team_id IS NULL`) — a team thread's home is
 *     the team panel, and its ownership axis is not the personal owner axis;
 *   - the row has a NON-NULL `owner_user_id` EQUAL to the actor's user id —
 *     ownerless/legacy rows are never adoptable, and no platform-admin bypass
 *     exists here (this is ownership repair, not administrative access);
 *   - the row's org anchor is absent, or equals the actor's active org.
 */
export function isImplicitDefaultThreadEligible(
  thread: AssistantThread,
  actor: UnboundThreadActor,
): boolean {
  if (!isUnboundAssistantThread(thread)) return false;
  if (thread.teamId) return false;
  if (!actor.userId) return false;
  if (!thread.ownerUserId || thread.ownerUserId !== actor.userId) return false;
  if (thread.orgId && thread.orgId !== actor.orgId) return false;
  return true;
}

/**
 * Resolve an UNBOUND thread the ACTOR OWNS by its durable id, as though it sat
 * in the implicit-default container (cinatra#2642). READ-ONLY. Returns null for
 * a non-UUID-shaped value (checked before touching the database, exactly like
 * {@link getAssistantThreadByIdInContainer}), an absent row, or a row failing
 * {@link isImplicitDefaultThreadEligible}.
 */
export function getOwnedUnboundAssistantThreadById(
  threadId: string,
  actor: UnboundThreadActor,
): AssistantThread | null {
  if (!UUID_RE.test(threadId)) return null;
  const thread = getAssistantThread(threadId);
  if (!thread) return null;
  return isImplicitDefaultThreadEligible(thread, actor) ? thread : null;
}

/**
 * The title-slug twin of {@link getOwnedUnboundAssistantThreadById}: resolve an
 * UNBOUND thread the ACTOR OWNS by its `title_slug` (cinatra#2642). READ-ONLY.
 *
 * This class is real: `createAssistantThread` mints a slug at insert whenever a
 * title is supplied (the MCP `assistant_send` path does), while NOTHING on the
 * /chat path ever writes `assistant_package` — so a slugged-but-unbound row is
 * addressed by the client at its slug and was 404-hidden by the exact-container
 * slug lookup.
 *
 * The empty string is NOT a slug (it addresses nothing) and never matches.
 * Ordered LAST by the route guard, so an EXPLICITLY bound thread owning the
 * same slug in the default container always wins the segment.
 */
export function getOwnedUnboundAssistantThreadBySlug(
  titleSlug: string,
  actor: UnboundThreadActor,
): AssistantThread | null {
  if (!titleSlug) return null;
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, assistant_user_id, owner_user_id, org_id, project_id, team_id, origin, title, context_id, assistant_package, instance_id, title_slug, created_at, updated_at
               FROM "${schema}"."assistant_threads"
               WHERE title_slug = $1
                 AND COALESCE(assistant_package, '') = ''
                 AND COALESCE(instance_id, '') = ''
                 AND COALESCE(team_id, '') = ''
                 AND owner_user_id = $2
               ORDER BY updated_at DESC, id
               LIMIT 1`,
        values: [titleSlug, actor.userId],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const thread = mapAssistantThreadRow(row);
  // Re-apply the PURE decision on the mapped row — defense-in-depth against
  // predicate drift between this SQL and the decision table (the same
  // belt-and-braces the visible-thread list read uses).
  return isImplicitDefaultThreadEligible(thread, actor) ? thread : null;
}

/**
 * Make an eligible unbound thread's IMPLICIT default binding EXPLICIT
 * (cinatra#2642) — the repair half of the alias above.
 *
 * BEST-EFFORT BY CONTRACT. Resolution never depends on it: the two lookups
 * above already address the row read-only, so a failed/raced/refused repair
 * strands nothing. That is what lets this run on a GET render at all — a
 * prefetched or retried render performs an IDEMPOTENT normalization of a row
 * into the container it already logically belongs to, and nothing else.
 *
 * - Takes NO destination package: it writes {@link IMPLICIT_DEFAULT_ASSISTANT_PACKAGE}
 *   and a NULL instance, or nothing.
 * - The full eligibility predicate is RE-ASSERTED in the UPDATE's WHERE clause,
 *   so the write can never outrun a concurrent ownership/binding change (no
 *   TOCTOU window between the read above and this write).
 * - Does NOT bump `updated_at`: a repair is not thread ACTIVITY, and
 *   `updated_at` orders the sidebar/list reads.
 * - EVERY predicate is the SQL twin of {@link isImplicitDefaultThreadEligible},
 *   including its empty-string-is-absent reading of `team_id`/`org_id`, so a row
 *   the pure decision accepts is exactly a row this statement can repair.
 *
 * WHAT THE REPAIR DELIBERATELY CHANGES (codex round-1, MEDIUM — accepted and
 * documented rather than papered over): once the binding is explicit, the row
 * leaves the owner-scoped alias and joins the ORDINARY, container-scoped
 * resolution namespace — where, exactly like every already-bound thread since
 * #1878 W3, route RESOLUTION is not owner-scoped. Another actor in the same
 * assistant audience who addresses that URL therefore gets a resolved route
 * (and, on a slug URL, sees the thread's durable id) instead of a 404, where
 * before the repair the row resolved for nobody at all. That is the platform's
 * established route contract, not a widening of it: the thread's CONTENT stays
 * sealed by the tenant-scoped thread reads (assistant-thread-http.ts), and the
 * repair only puts the row into the state every /chat thread was always meant
 * to be created in. `chat-unbound-thread-repair.integration.test.ts` pins this
 * end-to-end sequence explicitly.
 * - `title_slug = NULLIF(title_slug, '')` normalizes the empty-string slug seen
 *   on rows in the field. '' is not an addressable slug, yet it IS inside the
 *   `WHERE title_slug IS NOT NULL` container-unique index, so two ''-slug rows
 *   repaired into the same container would otherwise collide. A NON-empty slug
 *   is never touched (the slug is stable forever by contract).
 *
 * Returns true iff this call performed the repair.
 */
export function repairImplicitDefaultThreadBinding(
  threadId: string,
  actor: UnboundThreadActor,
): boolean {
  if (!UUID_RE.test(threadId) || !actor.userId) return false;
  try {
    ensurePostgresSchema();
    const schema = schemaIdent();
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `UPDATE "${schema}"."assistant_threads"
                 SET assistant_package = $1,
                     instance_id = NULL,
                     title_slug = NULLIF(title_slug, '')
                 WHERE id = $2
                   AND COALESCE(assistant_package, '') = ''
                   AND COALESCE(instance_id, '') = ''
                   AND COALESCE(team_id, '') = ''
                   AND owner_user_id = $3
                   AND (COALESCE(org_id, '') = '' OR org_id = $4)`,
          values: [IMPLICIT_DEFAULT_ASSISTANT_PACKAGE, threadId, actor.userId, actor.orgId],
        },
      ],
    });
    return (res?.rowCount ?? 0) > 0;
  } catch (err) {
    // A container-slug collision is the one EXPECTED refusal: an explicitly
    // bound thread already owns this slug in the default container (the unique
    // index keys `COALESCE(assistant_package,'')`, so an unbound row and a
    // default-bound row may legally share a slug today). Staying unbound is the
    // correct outcome — the read-only alias still addresses the row, and the
    // bound thread keeps the slug. Anything else is unexpected: surface it in
    // the log (no row data) rather than swallowing it silently.
    if (!isContainerSlugUniqueViolation(err)) {
      console.warn(
        "[assistant-thread-store] implicit-default binding repair failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// BIND-AT-CREATION — the thread's CONTAINER (cinatra#2650, successor to #2642).
//
// #2642/#2649 closed the READ side for unbound rows and repaired them into the
// implicit default. This is the WRITE side the repair was always a backstop
// for: the creation seam records the container, so a thread carries
// `assistant_package` from its first persisted moment — default and
// NON-default alike (a non-default thread is the class the repair provably
// cannot recover: nothing in the row records which assistant drove it, and
// adopting into a package the caller merely names is exactly what #2649's
// design forbids).
//
// TWO IDENTITIES, DELIBERATELY DISTINCT (the #2650 design ruling, codex-converged):
//   * CONTAINER — the thread's HOME: the server-resolved /chat route the thread
//     was created under. Set ONCE, at creation. THIS is `assistant_package`.
//   * PRODUCER — who answers ONE turn: the optional `@mention` selector
//     (`body.assistant`). It never touches the binding.
// They may intentionally differ: `@wordpress` inside a Cinatra thread answers
// that turn without re-homing the conversation. Binding the PRODUCER instead
// would move the row out of the container the client's own URL builder
// addresses it at (`assistantPackage ?? DEFAULT`), 404-ing the thread on the
// very next reload — and leaving it un-repairable, because #2649's alias only
// adopts genuinely UNBOUND rows.
//
// SET-ONCE, OWNER-SCOPED, NO ADMIN BYPASS — the #2642 predicate verbatim, so a
// bound thread is never re-pointed and an administrator driving somebody else's
// unbound thread can never re-home it.
//
// THE INVARIANT THIS SHIPS (stated precisely, because the refusal cases are
// real): a thread THIS REQUEST CREATES, or an unbound thread whose OWNER is
// this request's actor, carries its container binding BEFORE the producer
// starts. Every refusal below leaves the row EXACTLY as unbound as it is
// without this change, where #2649's backstop still addresses and repairs it —
// so a refusal is never worth failing a user's chat turn over.
// ---------------------------------------------------------------------------

/** A thread's CONTAINER: the assistant package it is homed in, plus the
 *  optional project/site instance that scopes it. Both halves are always
 *  written together — a package with a NULL instance is a legitimate
 *  non-instance container, NOT a partial binding. */
export type ThreadContainer = {
  assistantPackage: string;
  instanceId: string | null;
};

/**
 * The MALFORMED partial binding: an instance scope with NO package. That row is
 * in no container at all (the container key is the pair) and is not the
 * documented unbound state either, so it is refused rather than "repaired" —
 * writing a package onto it would silently adopt an instance scope nobody in
 * this request ever authorized. Pure.
 *
 * NOTE the asymmetry, which is deliberate: package-without-instance is VALID
 * (every local assistant's container), instance-without-package is not.
 */
export function isMalformedPartialBinding(thread: AssistantThread): boolean {
  return !(thread.assistantPackage ?? "") && !!(thread.instanceId ?? "");
}

/** Why a container bind did not write — or that the row is already home. */
export type ThreadContainerBindOutcome =
  /** This call performed the set-once bind. */
  | { kind: "bound" }
  /** The row does not exist. */
  | { kind: "absent" }
  /** The actor may not bind this row: team-owned, ownerless, another owner's
   *  (INCLUDING a platform admin — there is no bypass here), or a foreign org. */
  | { kind: "refused-ineligible" }
  /** Instance scope with no package — malformed; never adopted. */
  | { kind: "refused-malformed-partial" }
  /** A non-empty `title_slug` already exists in the TARGET container. The row is
   *  left byte-unchanged: a minted slug is stable forever, so binding never
   *  clears or re-mints one. */
  | { kind: "refused-slug-collision" }
  /** Already bound to exactly this container (an idempotent re-assert). */
  | { kind: "already-in-container" }
  /** Bound to a DIFFERENT container — never re-pointed. */
  | { kind: "bound-elsewhere"; container: ThreadContainer }
  /** Eligible and unbound on re-read, yet the conditional write matched nothing
   *  — a concurrent writer changed the row between the two statements. Reported
   *  honestly rather than folded into a refusal it is not. */
  | { kind: "raced" };

/** Container equality: the package case-insensitively (rows written before the
 *  canonical-casing rule may differ in case from the registry's own spelling),
 *  the instance exactly (an instance id is opaque). Pure. */
function sameContainer(thread: AssistantThread, container: ThreadContainer): boolean {
  return (
    (thread.assistantPackage ?? "").toLowerCase() === container.assistantPackage.toLowerCase() &&
    (thread.instanceId ?? "") === (container.instanceId ?? "")
  );
}

/**
 * The PURE, TOTAL classification of a row against a container + actor — the
 * decision table {@link bindThreadContainerIfUnbound} re-asserts in SQL, and
 * the one it re-reads through when its conditional UPDATE matches nothing.
 *
 * PRECEDENCE (deterministic, and the reason the order is fixed here rather than
 * emergent from the SQL): ELIGIBILITY is decided BEFORE binding state, so a
 * caller who could never have written this row is told exactly that — an
 * administrator observing another owner's row is `refused-ineligible`, never
 * handed a container claim it has no standing to make.
 *
 *   ineligible → malformed-partial → already-in-container → bound-elsewhere →
 *   "bindable"
 *
 * `"bindable"` means the row is genuinely unbound AND the actor owns it; the
 * caller maps a post-UPDATE `"bindable"` to {@link ThreadContainerBindOutcome}
 * `raced`, since a matching row that the conditional write missed can only be a
 * concurrent writer.
 */
export function classifyThreadContainerBind(
  thread: AssistantThread,
  container: ThreadContainer,
  actor: UnboundThreadActor,
):
  | "bindable"
  | "refused-ineligible"
  | "refused-malformed-partial"
  | "already-in-container"
  | "bound-elsewhere" {
  // Eligibility FIRST — same axes as isImplicitDefaultThreadEligible, minus its
  // unbound test (which is the binding-STATE question decided below).
  if (thread.teamId) return "refused-ineligible";
  if (!actor.userId) return "refused-ineligible";
  if (!thread.ownerUserId || thread.ownerUserId !== actor.userId) return "refused-ineligible";
  if (thread.orgId && thread.orgId !== actor.orgId) return "refused-ineligible";

  if (isMalformedPartialBinding(thread)) return "refused-malformed-partial";
  if (isUnboundAssistantThread(thread)) return "bindable";
  return sameContainer(thread, container) ? "already-in-container" : "bound-elsewhere";
}

/**
 * Bind an UNBOUND thread into `container` — the #2650 creation-seam write.
 *
 * ONE conditional UPDATE whose WHERE clause re-asserts the FULL predicate (no
 * TOCTOU window against a concurrent ownership or binding change), then, when
 * it matches nothing, ONE re-read classified through
 * {@link classifyThreadContainerBind}. Never bumps `updated_at`: recording a
 * thread's home is not thread ACTIVITY, and `updated_at` orders the sidebar.
 *
 * `title_slug = NULLIF(title_slug, '')` normalizes the empty-string slug out of
 * the partial container-unique index, exactly as #2649's repair does. A
 * NON-empty slug is never touched — if it collides in the target container the
 * whole statement rolls back and the row is left alone
 * (`refused-slug-collision`); a minted slug is stable forever by contract, so
 * binding may never clear or re-mint one. (Unreachable from either creation
 * seam today: the turn path creates titleless, and the /chat mirror upsert
 * writes no `title_slug` at all — so a row arriving here from creation has
 * `title_slug IS NULL`. It is classified anyway, not swallowed.)
 */
export function bindThreadContainerIfUnbound(
  threadId: string,
  container: ThreadContainer,
  actor: UnboundThreadActor,
): ThreadContainerBindOutcome {
  if (!UUID_RE.test(threadId) || !actor.userId || !container.assistantPackage) {
    return { kind: "refused-ineligible" };
  }
  ensurePostgresSchema();
  const schema = schemaIdent();
  try {
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `UPDATE "${schema}"."assistant_threads"
                 SET assistant_package = $1,
                     instance_id = $2,
                     title_slug = NULLIF(title_slug, '')
                 WHERE id = $3
                   AND COALESCE(assistant_package, '') = ''
                   AND COALESCE(instance_id, '') = ''
                   AND COALESCE(team_id, '') = ''
                   AND owner_user_id = $4
                   AND (COALESCE(org_id, '') = '' OR org_id = $5)`,
          values: [
            container.assistantPackage,
            container.instanceId,
            threadId,
            actor.userId,
            actor.orgId,
          ],
        },
      ],
    });
    if ((res?.rowCount ?? 0) > 0) return { kind: "bound" };
  } catch (err) {
    if (isContainerSlugUniqueViolation(err)) return { kind: "refused-slug-collision" };
    throw err;
  }

  // Matched nothing — re-read and say WHY, rather than reporting a bare false.
  const row = getAssistantThread(threadId);
  if (!row) return { kind: "absent" };
  const verdict = classifyThreadContainerBind(row, container, actor);
  if (verdict === "bound-elsewhere") {
    return {
      kind: "bound-elsewhere",
      container: {
        assistantPackage: row.assistantPackage ?? "",
        instanceId: row.instanceId ?? null,
      },
    };
  }
  return verdict === "bindable" ? { kind: "raced" } : { kind: verdict };
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

// ---------------------------------------------------------------------------
// WHICH CONVERSATION IS THIS AGENT RUN PLAYING OUT IN (cinatra#2729)
// ---------------------------------------------------------------------------
//
// A chat-started agent run does its whole lifecycle inside the conversation
// that started it, so a notification about that run has to bring the reader
// BACK to the conversation — not to a separate page carrying a second copy of
// the same card.
//
// `agent_runs` has no conversation column, and this lookup deliberately does
// not ask for one: the link already exists, durably, on the chat side. A turn
// that dispatched an agent persists the run card's own part
// (`{ kind: "tool_call", name: "agent_run", runId }`) inside `content`, which
// is exactly how a reloaded thread re-mounts the card. Reading it back is
// reading the record the chat already keeps, in the direction the notifier
// needs it.
//
// Containment (`@>`) over the JSONB column matches an array element that
// carries BOTH keys, so a run id appearing in some other shape cannot match.
// The read is best-effort by construction — a turn persisted after the run
// paused, a thread the reader cannot address, or a store that cannot answer
// all return null, and the caller falls back to the run page.

/**
 * Build a thread's `/chat` path.
 *
 * The grammar is the codec's (`packages/chat/src/chat-path-codec.ts`):
 * `/chat/<vendor>/<slug>[/<instance>]/<titleSlug-or-threadId>`, and the
 * unbound-thread rule is this module's own
 * {@link IMPLICIT_DEFAULT_ASSISTANT_PACKAGE}. It is rebuilt here rather than
 * imported because the codec lives in the chat PACKAGE, which this server leaf
 * does not depend on — the same call `packages/notifications` makes for the
 * agent-run path builder. A unit test pins the output against the codec's.
 */
function buildChatThreadPath(thread: {
  id: string;
  assistantPackage: string | null;
  instanceId: string | null;
  titleSlug: string | null;
}): string | null {
  const pkg = thread.assistantPackage ?? IMPLICIT_DEFAULT_ASSISTANT_PACKAGE;
  const match = pkg.match(/^@([^/]+)\/(.+)$/);
  if (!match) return null;
  const segments = [match[1], match[2]];
  // An instance segment belongs to a bound container only — an unbound thread
  // is addressed in the default container, which has no instance.
  if (thread.assistantPackage && thread.instanceId) {
    segments.push(thread.instanceId);
  }
  // A thread is addressable by its id before its title slug is minted; the
  // route resolver tries the id first, then the slug.
  segments.push(thread.titleSlug ?? thread.id);
  return `/chat/${segments.join("/")}`;
}

/**
 * Resolve the `/chat` path of the conversation that started an agent run, or
 * null when there is none to resolve.
 */
export function findChatConversationPathForAgentRun(
  agentRunId: string,
): string | null {
  const id = typeof agentRunId === "string" ? agentRunId.trim() : "";
  if (!id || id.length > 128) return null;
  let row: Record<string, unknown> | undefined;
  try {
    ensurePostgresSchema();
    const schema = schemaIdent();
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT th.id, th.assistant_package, th.instance_id, th.title_slug
                 FROM "${schema}"."assistant_turns" tt
                 JOIN "${schema}"."assistant_threads" th ON th.id = tt.thread_id
                 WHERE tt.content @> $1::jsonb
                 ORDER BY tt.created_at DESC, tt.id
                 LIMIT 1`,
          values: [
            JSON.stringify({ parts: [{ name: "agent_run", runId: id }] }),
          ],
        },
      ],
    });
    row = res?.rows?.[0] as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  return buildChatThreadPath({
    id: String(row.id),
    assistantPackage:
      typeof row.assistant_package === "string" ? row.assistant_package : null,
    instanceId: typeof row.instance_id === "string" ? row.instance_id : null,
    titleSlug: typeof row.title_slug === "string" ? row.title_slug : null,
  });
}

/**
 * IS THIS TURN STILL RUNNING — and if not, is that a fact or an outage?
 *
 *   active   — the row is there and its status is still `running`;
 *   ended    — no run id was named, no row carries it, or the turn reached
 *              `completed`/`error`;
 *   unknown  — the store could not answer at all.
 *
 * THREE answers, not two, and for the same reason the widget session predicate
 * has three (cinatra#2684): a credential sealed to a turn must be refused when
 * the turn is over AND when the question cannot be asked, but only one of those
 * is a fact about the turn. Both refuse; nothing here reaps.
 *
 * WHY IT LIVES HERE. `assistant_turns` is this store's table and its lifecycle
 * (`running` → `completed` | `error`) is this module's contract, written by
 * `updateAssistantTurn`. A caller that needed to know "is the turn over" by
 * reading the row itself would be holding a second, driftable copy of that rule.
 *
 * ITS CALLER (cinatra#2687) is the widget OBO token's authorization layer: the
 * token seals the run id of the turn that minted it, and a turn that has reached
 * a terminal status can no longer authorize a CMS write — even inside the
 * token's own 120 seconds.
 *
 * WHAT "ENDED" IS PRECISELY (codex round 0, MEDIUM 1). The revocation instant is
 * the terminal STATUS COMMIT, which `streamAgUiChatTurn` performs AFTER the
 * run's terminal frame has been published to the durable log — not at the frame
 * itself. So there is a short window in which a consumer has already seen
 * RUN_FINISHED and this predicate still says `active`. Nothing legitimate calls
 * in it (the producer awaits the provider stream, so the relay's last call has
 * settled before the frame exists), and it is stated here rather than papered
 * over because the alternative — writing the status before the frame — belongs
 * to the shared chat harness that also serves the cookie-session path.
 *
 * NEVER THROWS.
 */
export type AssistantTurnActivity = "active" | "ended" | "unknown";

export function readAssistantTurnActivityByRunId(runId: unknown): AssistantTurnActivity {
  const id = typeof runId === "string" ? runId.trim() : "";
  if (!id || id.length > 128) return "ended";
  let row: Record<string, unknown> | undefined;
  try {
    ensurePostgresSchema();
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT status
                 FROM "${schemaIdent()}"."assistant_turns"
                 WHERE run_id = $1
                 ORDER BY created_at DESC, id
                 LIMIT 1`,
          values: [id],
        },
      ],
    });
    row = res?.rows?.[0] as Record<string, unknown> | undefined;
  } catch {
    return "unknown";
  }
  if (!row) return "ended";
  return row.status === "running" ? "active" : "ended";
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

// ---------------------------------------------------------------------------
// THE DURABLE ASSISTANT TURN → TRANSCRIPT MESSAGE PROJECTION
// (cinatra-ai/cinatra#2823, epic #2784 S9j — the persistence bridge).
// ---------------------------------------------------------------------------
//
// WHAT THIS IS FOR. A `/chat` turn is written down TWICE, by two different
// writers, and until this projection only one of them could be read back:
//
//   * THE CLIENT'S whole-transcript save — the `legacy:`-namespaced mirror rows.
//     It carries the projected `UiMessage`s, `dataParts` and all, and it is what
//     `reconstructThreadPayload` reads. It is also BEST-EFFORT AND SILENT
//     (`packages/chat/src/conversation-services.ts`): a save that fails is a turn
//     that will not come back, and the reader is told nothing at the time.
//   * THE STREAM ROUTE'S own record — one run-bound `assistant_turns` row whose
//     `content` is the sink's `assistant-turn-v1` durable content. It is written
//     by the server, inside the turn, and it cannot be lost by a client. It was
//     also never read by anything: the reconstruction selected mirror rows only.
//
// So the plan's §2.3 row 5 — *a card present live can be absent after a reload
// when the whole-message save fails silently* — was structural. The server had
// the turn and the reconstruction would not look at it.
//
// WHAT IT DOES. It projects ONE durable turn into the `UiMessage` shape the
// transcript renders, applying the SAME triage the AG-UI reducer applies to a
// live turn (`packages/chat/src/renderer/ag-ui-reducer.ts`): a `tool_result`
// completes its `tool_call` in place, an `agent_run` DATA_PART PINS its runId on
// that call rather than becoming a view, `citations` become the message's
// citations, and every remaining DATA_PART is CARRIED THROUGH as a renderable
// view. One triage, two implementations, and they are pinned to each other by the
// S9j contract suite, which drives the real sink and mounts the real view.
//
// WHY IT LIVES IN THIS FILE rather than in a module of its own. It is pure, it
// has one caller — the fold-in below — and the five LOCKED dev-perf routes all
// reach this store, so a separate module raised every one of their reachable-
// module ceilings by one (measured: /sign-in 218→219, /chat 1793→1794, /api/mcp
// 1714→1715, /api/a2a 1719→1720, /api/llm-bridge 1729→1730). The route-graph
// ratchet says a ceiling "should only ever be LOWERED"; buying five raises for a
// file boundary this store does not need was the wrong trade. Nothing is lost in
// testability: these functions are EXPORTED and their unit suite
// (`__tests__/assistant-turn-durable-projection.test.ts`) drives them directly,
// exactly as it would have driven a separate module.
// ---------------------------------------------------------------------------

/** The durable content format this projection understands. */
export const DURABLE_ASSISTANT_TURN_FORMAT = "assistant-turn-v1";

/** A `UiMessage`-shaped assistant turn (structurally; the shape lives in
 *  `@cinatra-ai/chat`'s `types.ts` and is deliberately not imported — this is a
 *  sync store leaf and that module reaches the client render graph). */
export type ProjectedAssistantTurn = {
  id: string;
  role: "assistant";
  content: string;
  parts?: Array<Record<string, unknown>>;
  citations?: Array<Record<string, unknown>>;
  dataParts?: Array<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Is this turn content the sink's durable `assistant-turn-v1` object? */
export function isDurableAssistantTurnContent(content: unknown): boolean {
  return isRecord(content) && content.format === DURABLE_ASSISTANT_TURN_FORMAT;
}

/**
 * Project one durable `assistant-turn-v1` content object onto the transcript's
 * message shape. Returns `null` for anything else — a mirror row's message
 * object, a legacy shape, a malformed payload — so a caller can hand it every
 * turn it has and let the format decide.
 *
 * DEFENSIVE THROUGHOUT. The input is persisted JSON from a writer that may be
 * older or newer than this reader, so every field is checked rather than
 * asserted: an unknown part type is skipped, a `tool_result` with no matching
 * `tool_call` is dropped exactly as the reducer drops it, and a `dataParts` entry
 * that is not an object is ignored. The failure mode is a THINNER turn, never a
 * thrown reconstruction — a reload that 500s is strictly worse than a reload
 * missing one part.
 */
export function projectDurableAssistantTurn(
  turnId: string,
  content: unknown,
): ProjectedAssistantTurn | null {
  if (!isDurableAssistantTurnContent(content)) return null;
  const durable = content as Record<string, unknown>;

  const parts: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [];
  const rawParts = Array.isArray(durable.parts) ? durable.parts : [];

  for (const raw of rawParts) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case "text": {
        const text = stringOrNull(raw.text);
        if (text === null || text.length === 0) break;
        parts.push({ kind: "text", content: text });
        break;
      }
      case "tool_call": {
        const id = stringOrNull(raw.id);
        const name = stringOrNull(raw.name);
        if (id === null || name === null) break;
        // Deduped by id, as the live applier dedupes: a retried call is one call.
        if (parts.some((p) => p.kind === "tool_call" && p.id === id)) break;
        parts.push({
          kind: "tool_call",
          id,
          name,
          // A turn is only persisted at terminal, so a call with no result is a
          // call that never returned — `failed` is the honest reading, and it is
          // what the live view would be showing when the stream ended.
          status: "failed",
          ...(typeof raw.serverLabel === "string" ? { serverLabel: raw.serverLabel } : {}),
        });
        break;
      }
      case "tool_result": {
        const id = stringOrNull(raw.id);
        if (id === null) break;
        const target = parts.find((p) => p.kind === "tool_call" && p.id === id);
        if (!target) break; // no matching call — the reducer drops it too
        target.status = "completed";
        if (typeof raw.resultLabel === "string") target.resultLabel = raw.resultLabel;
        if (typeof raw.serverLabel === "string") target.serverLabel = raw.serverLabel;
        break;
      }
      case "citations": {
        if (!Array.isArray(raw.citations)) break;
        for (const citation of raw.citations) {
          if (isRecord(citation)) citations.push(citation);
        }
        break;
      }
      default:
        // Vocabulary drift — a part type this reader does not know is skipped
        // rather than rendered as an unknown blob.
        break;
    }
  }

  // The DATA_PART triage, mirroring the reducer's precedence exactly.
  const views: Array<Record<string, unknown>> = [];
  const rawDataParts = Array.isArray(durable.dataParts) ? durable.dataParts : [];
  for (const raw of rawDataParts) {
    if (!isRecord(raw)) continue;
    // A renderable view is classified by `viewType` and that classification WINS
    // over any structural `kind` beside it — the reducer's rule, restated here so
    // a payload cannot be consumed structurally on reload and carried through
    // live (or the other way round), which would be a card that changes identity
    // when the page is refreshed.
    const isView = typeof raw.viewType === "string" && raw.viewType.length > 0;
    if (!isView && raw.kind === "agent_run") {
      const toolCallId = stringOrNull(raw.toolCallId);
      const runId = stringOrNull(raw.runId);
      if (toolCallId === null || runId === null) continue;
      const target = parts.find((p) => p.kind === "tool_call" && p.id === toolCallId);
      if (!target) continue; // unknown toolCallId — the reducer no-ops too
      target.runId = runId;
      continue;
    }
    if (!isView && raw.kind === "citations") {
      // Belt and braces: the sink keeps citations as an ordered PART and never
      // mints them here, but a payload written by an older/other producer must
      // not turn into a renderable view the registry cannot draw.
      continue;
    }
    views.push(raw);
  }

  const text = typeof durable.content === "string" ? durable.content : "";
  if (parts.length === 0 && views.length === 0 && text.length === 0) return null;

  return {
    id: turnId,
    role: "assistant",
    content: text,
    // Field-presence discipline, matching the live projection: a key appears
    // only once populated, so a projected turn serializes like a client-saved
    // one and a re-save cannot introduce spurious empty arrays.
    ...(parts.length > 0 ? { parts } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    ...(views.length > 0 ? { dataParts: views } : {}),
  };
}

/**
 * Does this projected turn carry LIFECYCLE render state — a renderable view, or
 * a run pinned on a tool call?
 *
 * This is the predicate that keeps the reconstruction's fold-in narrow. See
 * `assembleThreadPayloadFromParts` for why narrow is the point.
 */
export function carriesLifecycleRenderState(turn: ProjectedAssistantTurn): boolean {
  if ((turn.dataParts?.length ?? 0) > 0) return true;
  return (turn.parts ?? []).some(
    (p) => p.kind === "tool_call" && typeof p.runId === "string" && p.runId.length > 0,
  );
}

/** The tool-call ids a message's render trace carries. */
export function toolCallIdsOf(message: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(message)) return ids;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.kind !== "tool_call") continue;
    const id = stringOrNull(part.id);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/**
 * Fold the run-bound durable turns that carry lifecycle render state into the
 * legacy-mirror spine. See `assembleThreadPayloadFromParts` for the rule and why
 * every clause of it is narrow.
 *
 * COPY-ON-WRITE, never in place. The spine messages are the caller's own turn
 * `content` objects, and this function is reachable from an EXPORTED pure
 * assembler that other suites call with literals; a repaired message is a fresh
 * object so nothing a caller still holds is edited behind its back. A thread with
 * nothing to fold in returns the SAME array it was given, so the common path
 * allocates nothing.
 *
 * Ordered by `createdAt` then `id` so the append order is the order the SERVER
 * recorded the turns in, and so two rows created in the same millisecond still
 * have one deterministic order rather than the query's incidental one.
 */
function foldDurableLifecycleTurnsInto(
  messages: Array<Record<string, unknown>>,
  turns: AssistantTurn[],
): Array<Record<string, unknown>> {
  const durableTurns = turns
    .filter((t) => t.content !== null && t.runId !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (durableTurns.length === 0) return messages;

  let folded = messages;
  for (const turn of durableTurns) {
    const projected = projectDurableAssistantTurn(turn.id, turn.content);
    if (projected === null) continue;
    if (!carriesLifecycleRenderState(projected)) continue;
    const index = findCoveringSpineIndex(folded, projected);
    if (index === -1) {
      folded = folded === messages ? [...messages] : folded;
      folded.push(projected as unknown as Record<string, unknown>);
      continue;
    }
    const repaired = repairedSpineMessage(folded[index], projected);
    if (repaired === folded[index]) continue; // nothing was owed
    folded = folded === messages ? [...messages] : folded;
    folded[index] = repaired;
  }
  return folded;
}

/** The index of the spine message that is THIS turn, identified by a shared
 *  server-minted tool-call id, or -1 when the spine does not carry the turn. */
function findCoveringSpineIndex(
  messages: Array<Record<string, unknown>>,
  projected: ProjectedAssistantTurn,
): number {
  const durableIds = toolCallIdsOf(projected);
  // A lifecycle view is always minted from a tool RESULT, so a turn that carries
  // one always carries the call it came from. A durable turn with no call at all
  // therefore has no shared key, and is treated as one the spine does not have.
  if (durableIds.size === 0) return -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== "assistant") continue;
    for (const id of toolCallIdsOf(messages[i])) {
      if (durableIds.has(id)) return i;
    }
  }
  return -1;
}

/**
 * ADD what the client's save dropped; overwrite nothing it kept.
 *
 * The spine message is what the reader last saw, so it wins wherever it has an
 * answer: a save that DID carry the views is left exactly as it is. Only an
 * absent view list and an unpinned run are filled in — the two things a dropped
 * save costs, and the two things the server's own record can restore.
 *
 * Returns the SAME object when nothing was owed, which is what lets the caller
 * leave the transcript untouched instead of rebuilding an identical one.
 */
function repairedSpineMessage(
  spine: Record<string, unknown>,
  projected: ProjectedAssistantTurn,
): Record<string, unknown> {
  const spineViews = Array.isArray(spine.dataParts) ? spine.dataParts : [];
  const owesViews = spineViews.length === 0 && (projected.dataParts?.length ?? 0) > 0;

  const runIdByCall = new Map<string, string>();
  for (const durablePart of projected.parts ?? []) {
    if (durablePart.kind !== "tool_call") continue;
    const id = durablePart.id;
    const runId = durablePart.runId;
    if (typeof id !== "string" || typeof runId !== "string" || runId.length === 0) continue;
    runIdByCall.set(id, runId);
  }
  const spineParts = Array.isArray(spine.parts) ? spine.parts : [];
  let owesRun = false;
  const repairedParts = spineParts.map((raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const part = raw as Record<string, unknown>;
    if (part.kind !== "tool_call") return raw;
    if (typeof part.runId === "string" && part.runId.length > 0) return raw;
    const id = typeof part.id === "string" ? part.id : null;
    const runId = id === null ? undefined : runIdByCall.get(id);
    if (runId === undefined) return raw;
    owesRun = true;
    return { ...part, runId };
  });

  if (!owesViews && !owesRun) return spine;
  return {
    ...spine,
    ...(owesViews ? { dataParts: projected.dataParts } : {}),
    ...(owesRun ? { parts: repairedParts } : {}),
  };
}

/**
 * PURE reconstruction of the /chat thread payload from the structured parts —
 * unit-testable without a database (the DB reads live in
 * `reconstructThreadPayload`). Returns null when the thread is PRE-CUTOVER.
 *
 * THE SPINE: the LEGACY-MIRROR projection turns (deterministic `legacy:` ids,
 * run_id NULL, non-NULL `content`). A thread is readable iff it has >=1 such
 * turn; a content-less shadow or an empty thread reconstructs to null (404 /
 * absent-from-list) — unchanged, so the read and the list agree exactly as
 * before. Each surviving turn's `content` IS the full persisted message object
 * (PR1 EXPAND: `parse(content)` deep-equals `payload.messages[i]`); `turns` MUST
 * already be in `ordinal` order (the caller's query orders by it), so `messages`
 * is a faithful, lossless, correctly-ordered reconstruction.
 *
 * ─── THE LIFECYCLE FOLD-IN (cinatra#2823, epic #2784 S9j) ────────────────────
 *
 * The spine is written by the client's whole-transcript save, which is
 * BEST-EFFORT AND SILENT. So the spine can be missing the newest assistant turn,
 * and until this fold-in the server's OWN record of that turn — the run-bound
 * `assistant-turn-v1` row the stream route writes from the sink — was read by
 * nothing. That is why a lifecycle card could be present in the live render and
 * absent after a reload: not a renderer defect, a reconstruction that would not
 * look at the one writer that cannot lose the turn.
 *
 * The fold-in is deliberately NARROW, and each narrowing is load-bearing:
 *
 *   * ONLY run-bound turns whose projection carries LIFECYCLE RENDER STATE — a
 *     renderable view, or a run pinned on a tool call — participate. A thread
 *     with no lifecycle card reconstructs BYTE-IDENTICALLY to before, so this
 *     cannot change the shape of an existing transcript.
 *   * A turn the spine ALREADY CARRIES is repaired, never duplicated. The two
 *     writers share no key — the mirror row's id is built from the CLIENT's
 *     message id and the run-bound row's is the turn's — but they do share the
 *     SERVER-minted tool-call ids, which reach the client on the wire. A spine
 *     message sharing a tool-call id with a durable turn IS that turn, and the
 *     fold-in then adds only what the save dropped (the views, the pinned run)
 *     and touches nothing else.
 *   * A turn the spine does NOT carry is APPENDED, in `created_at` order. That
 *     is the correct position and not merely a convenient one: every save posts
 *     the WHOLE transcript, so the spine is always a PREFIX of the conversation
 *     — the only turns it can be missing are the ones after the last save that
 *     landed. Appending them in the order the server recorded them restores the
 *     conversation's real order.
 *
 * THE BOUND, stated: this repairs what the SERVER wrote down. A turn whose
 * run-bound row was never written (a run that died before its terminal) is not
 * recoverable here and is not claimed to be.
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

  const messages = foldDurableLifecycleTurnsInto(
    contentTurns.map((t) => t.content as Record<string, unknown>),
    turns,
  );

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
 * durable `scalars`), the content turns of BOTH representations — the
 * legacy-mirror spine ORDERED BY `ordinal` (then created_at/id for pre-PR2 rows
 * without an ordinal) and the run-bound durable turns the stream route writes
 * (cinatra#2823 S9j) — and the structured pause set, ALL in ONE `REPEATABLE READ`
 * transaction so the assembled payload is a single consistent snapshot (never
 * metadata/turns/pause from different concurrent revisions; codex convergence).
 * Returns null when the thread is absent OR pre-cutover (content-less) — callers
 * 404 / exclude. Which run-bound turns reach the transcript, and where, is
 * `assembleThreadPayloadFromParts`'s narrow fold-in rule.
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
        // BOTH representations, in ONE snapshot (cinatra#2823 S9j): the
        // legacy-mirror spine AND the run-bound durable turns the stream route
        // wrote. The assembler is what keeps them apart and decides which of the
        // run-bound rows is folded in — reading them in a second query would put
        // the two halves in different revisions, which is the exact thing this
        // REPEATABLE READ transaction exists to prevent.
        //
        // ORDERING serves the spine, which is what it always did: mirror rows
        // carry an `ordinal` and MUST come back in it. Run-bound rows have none,
        // so `NULLS LAST` puts them after the spine and the assembler re-sorts
        // them by `created_at` itself; the spine's own order is untouched.
        text: `SELECT id, thread_id, run_id, assistant_user_id, role, status, content, created_at, updated_at
               FROM "${schema}"."assistant_turns"
               WHERE thread_id = $1
                 AND content IS NOT NULL
                 AND (
                   (run_id IS NULL AND id LIKE '${prefix}%')
                   OR run_id IS NOT NULL
                 )
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
