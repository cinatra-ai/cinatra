import "server-only";

/**
 * Write-time project inheritance and substrate exclusion.
 *
 * The worker entry (`runAgentBuilderExecutionJob`) wraps an agent run's
 * execution body in `mcpRequestContextStorage.run({ projectContext:
 * { projectId } }, ...)`. Every artifact/object writer reads the frame here
 * and (when the type is NOT on the substrate-exclusion list) propagates
 * `projectId` to `objects.project_id` at INSERT time.
 *
 * Substrate exclusion: these types are pan-project catalog/CRM substrate
 * and MUST NOT be auto-tagged inside a project frame. Tagging them would
 * silently scope catalog/CRM rows to the project that happened to create
 * them, breaking sharing.
 *
 * Type strings: the exclusion list covers the "${vendor}/${kind}" prefix
 * (e.g. `@cinatra-ai/contact`, `@cinatra-ai/account`, `@cinatra-ai/skill`,
 * `@cinatra-ai/extension`). The actual registered object types are vendored
 * under longer namespaces (e.g. `@cinatra-ai/entity-contacts:contact`,
 * `@cinatra-ai/entity-accounts:account`) — we cover BOTH the exact prefix
 * literals AND the vendored variants registered in packages/entity-contacts
 * and packages/entity-accounts. Skills and extensions are not currently
 * stored as objects rows (they have their own tables outside the objects
 * layer), but keeping them in the set is defense-in-depth in case they later
 * become object rows.
 *
 * **Fail-closed unknown types:** if the type cannot be classified
 * positively (the registry of known project-scoped types has not been
 * threaded through here), the helper STILL propagates the project frame —
 * the substrate-exclusion list is exhaustive for substrate; everything
 * else is project-scoped-by-default per the nullable `objects.project_id`
 * refinement, and the writer only auto-tags when a project frame is active.
 * The console.warn surfaces the unrecognised type to the developer for the
 * case where they expected exclusion.
 */
export const SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED: ReadonlySet<string> = new Set([
  // Exact prefix-literal list (defense-in-depth):
  "@cinatra-ai/contact",
  "@cinatra-ai/account",
  "@cinatra-ai/skill",
  "@cinatra-ai/extension",
  // Vendored canonical type strings actually registered by the
  // packages/* registers (cross-checked via
  // packages/entity-contacts/src/integration/register-object-types.ts and
  // packages/entity-accounts/src/integration/register-object-types.ts):
  "@cinatra-ai/entity-contacts:contact",
  "@cinatra-ai/entity-accounts:account",
]);

/**
 * Pure predicate — does this type allow project_id auto-tagging?
 * `true`  → propagate the active projectContext.projectId.
 * `false` → leave projectId NULL even inside a project frame (substrate).
 */
export function shouldAutoTagProject(objectType: string): boolean {
  return !SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED.has(objectType);
}

/**
 * Resolver used by the canonical writers (`upsertObjectAndEnqueue`,
 * `upsertObject`, `artifact-creation.ts` objects-INSERT). Returns the
 * projectId the new row should be tagged with, or `null` to skip.
 *
 * `frameProjectId` is the projectContext.projectId from the current
 * mcpRequestContextStorage frame (already extracted by the caller — avoids
 * a duplicate `getStore()` per writer and lets unit tests inject the value
 * without async-local-storage gymnastics).
 *
 * `objectType` is the row's `type` field — the discriminator for substrate
 * exclusion.
 */
export function resolveProjectInheritanceForType(
  frameProjectId: string | null | undefined,
  objectType: string,
): string | null {
  // No project frame active OR frame is the explicit ambient signal — no
  // auto-tag.
  if (!frameProjectId) return null;

  // Substrate types are NEVER project-scoped — defense-in-depth at the
  // writer layer even if a project frame is active (e.g. a project-scoped
  // chat triggers contact discovery; the contact row STAYS pan-project).
  if (!shouldAutoTagProject(objectType)) return null;

  return frameProjectId;
}

// ---------------------------------------------------------------------------
// chat_threads payload→column lockstep query builder.
//
// Extracted as a pure builder so the SQL shape + parameter ordering can be
// unit-tested without a live `@/lib/database` module (the root vitest alias
// stubs that module, so the wired writer can't be exercised directly in
// unit tests). The real writer in src/lib/database.ts:upsertChatThreadInDatabase
// composes this builder into the same tx that writes the pin queries.
// ---------------------------------------------------------------------------

/**
 * Build the parameterised INSERT...ON CONFLICT statement for chat_threads
 * that mirrors the payload's project_id/created_at/updated_at fields into
 * typed columns. Pure — takes the resolved scalar values + the JSON payload
 * string + the SQL schema identifier. RETAINED for its SQL-shape unit test
 * ONLY: the final teardown dropped the legacy chat_threads INSERT, so this
 * builder has NO product call site and is fenced at the DB; it is removed with
 * chat_threads in PR3. Historically emitted the query the writer executed
 * verbatim.
 *
 * The COALESCE on UPDATE preserves established column values when a
 * partial payload omits a field (lockstep doctrine: column NEVER ahead of
 * payload, NEVER lags behind a payload write).
 */
export function buildChatThreadUpsertQuery(args: {
  schemaName: string;
  threadId: string;
  payloadJson: string;
  projectId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}): { text: string; values: unknown[] } {
  const schema = args.schemaName.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${schema}"."chat_threads" (id, payload, project_id, created_at, updated_at)
VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))
ON CONFLICT (id) DO UPDATE SET
  payload    = EXCLUDED.payload,
  project_id = EXCLUDED.project_id,
  -- created_at is immutable post-INSERT (mirror payload only on INSERT)
  updated_at = COALESCE(EXCLUDED.updated_at, now())`,
    values: [
      args.threadId,
      args.payloadJson,
      args.projectId,
      args.createdAt,
      args.updatedAt,
    ],
  };
}

/**
 * Extract a typed string field from a chat thread payload. Returns the
 * trimmed string, or null when the field is missing/blank/wrong-type.
 * Defensive: chat thread payloads are arbitrary JSON from many writers;
 * tolerating shape drift is required.
 */
export function extractStringFieldFromThread(
  thread: Record<string, unknown>,
  field: string,
): string | null {
  const value = thread[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract a timestamp field from a chat thread payload. Accepts ISO 8601
 * strings and Date instances. Returns the ISO string or null. Date.parse
 * validation guards against arbitrary strings landing in timestamptz
 * columns.
 */
export function extractTimestampFieldFromThread(
  thread: Record<string, unknown>,
  field: string,
): string | null {
  const value = thread[field];
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Legacy chat_threads -> structured assistant_threads/assistant_turns MIRROR
// (cinatra-ai/cinatra#1037 P2b — the persistence rewiring deferred from P2a).
//
// Every chat-thread write (all writers funnel through
// `upsertChatThreadInDatabase`) composes these builders into its single
// transaction. Post-cutover (final teardown) the legacy chat_threads INSERT is
// DROPPED, so these builders are the SOLE authoritative write of a thread — no
// longer a projection alongside a legacy payload:
//
//   • assistant_threads — thread identity/ordering/ownership shadow
//     (id, owner_user_id, org_id set-once, title raw bytes, timestamps).
//     `assistant_user_id` / `context_id` are NEVER touched here — those
//     columns are owned by the AG-UI cutover (#1216 S2).
//   • assistant_turns   — one METADATA + attribution + durable CONTENT row per
//     legacy message. `run_id` stays NULL (no AG-UI run exists on the bespoke
//     wire; the unified stream contract owns the durable event log and this
//     mirror NEVER fabricates a run pointer). Message CONTENT is now COPIED into
//     the `content` jsonb column (cinatra#1037 P5.6 drop-history PR1 EXPAND) —
//     the full message object, so the structured store holds what /chat needs
//     for faithful reconstruction. Post-cutover the structured store is the
//     AUTHORITATIVE source for BOTH read (reconstructThreadPayload) and write
//     (the legacy chat_threads INSERT is dropped) — the read swap and the
//     write cutover have both landed.
//   • assistant_thread_pause_state — structured pause/resume rows projected from
//     payload.pausedParticipants (PR1 EXPAND), presence-gated so a partial write
//     never clears pause state it did not carry.
//
// Mirror rows are IDEMPOTENT and SELF-BACKFILLING: turn ids are deterministic
// (`legacy:`-namespaced, injective length-prefixed encoding below), inserts
// are ON CONFLICT DO NOTHING, and a reconcile DELETE scoped to the mirror
// namespace removes rows for messages dropped by edit/regenerate truncation.
// The namespace guarantees a legacy write can never delete a structured-store
// row minted by the assistant runtime (which mints bare UUIDs and fail-loud
// rejects the reserved prefix — see assistant-thread-store.ts).
//
// These builders are PURE (SQL text + parameter assembly only) and live in
// this module alongside `buildChatThreadUpsertQuery` deliberately: the
// route-graph ratchet counts every module reachable from database.ts
// (require() edges included), so a new module here would raise the locked
// route ceilings. Design codex-converged (AGREE, 2026-07-11).
// ---------------------------------------------------------------------------

/** Reserved id namespace for mirror-originated assistant_turns rows. The
 *  assistant-thread-store's `appendAssistantTurn` rejects explicit ids under
 *  this prefix (equality pinned by a unit test on both sides). */
export const LEGACY_MIRROR_TURN_ID_PREFIX = "legacy:";

/**
 * Deterministic, INJECTIVE mirror-turn id: `legacy:{len(threadId)}:{threadId}:{messageId}`.
 * The explicit length prefix makes the encoding injective for arbitrary text
 * ids (colons embedded in either component cannot produce a collision:
 * decode by parsing the decimal length, taking exactly that many chars as the
 * threadId, skipping one `:`, remainder = messageId).
 */
export function buildLegacyMirrorTurnId(threadId: string, messageId: string): string {
  return `${LEGACY_MIRROR_TURN_ID_PREFIX}${threadId.length}:${threadId}:${messageId}`;
}

/**
 * Extract a string field from a chat thread payload PRESERVING exact bytes
 * (no trim — the mirror must not normalize user-visible values like `title`).
 */
export function extractRawStringFieldFromThread(
  thread: Record<string, unknown>,
  field: string,
): string | null {
  const value = thread[field];
  return typeof value === "string" ? value : null;
}

export type AssistantTurnMirrorRow = {
  /** Deterministic `legacy:`-namespaced id (see buildLegacyMirrorTurnId). */
  id: string;
  /** Principal attribution passthrough (message.authorUserId), or null. */
  assistantUserId: string | null;
  role: "user" | "assistant";
  /** Validated ISO timestamp, or null (SQL falls back to now()). */
  createdAt: string | null;
  /**
   * The message's position in payload.messages[] (cinatra#1037 P5.6 drop-history
   * PR2 CUTOVER): the durable, faithful message ORDER the read reconstruction
   * orders by, because created_at/id do not preserve array order when message
   * timestamps are absent/equal (codex convergence). This is the index among the
   * EMITTED (valid) rows, so skipped invalid messages never leave gaps that
   * reorder the survivors. Refreshed on conflict (edit/regenerate).
   */
  ordinal: number;
  /**
   * Durable per-turn message CONTENT (cinatra#1037 P5.6 drop-history PR1
   * EXPAND): the FULL message object serialized to a JSON string, so /chat can
   * reconstruct the turn faithfully (role, content, parts, thinking, toolCalls,
   * citations, attachments, mentions — not just terminal text). Cast to jsonb at
   * write time; the assistant_turns_content_object_check keeps it a JSON object.
   * Legacy content home stays chat_threads.payload until the PR2 cutover — this
   * is a write-through PROJECTION, not the read source.
   */
  content: string | null;
};

/**
 * Map a legacy thread payload's messages[] to mirror turn rows. Defensive:
 * payloads are arbitrary JSON from many writers — messages without a
 * non-empty string id or with an out-of-domain role are skipped (the turn
 * table's CHECK constraints would abort the whole transaction otherwise).
 * The FULL message object is captured as durable `content` (PR1 EXPAND) so the
 * structured store holds what /chat needs for faithful reconstruction.
 */
export function extractAssistantTurnMirrorRowsFromThread(
  thread: { id: string } & Record<string, unknown>,
): AssistantTurnMirrorRow[] {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const rows: AssistantTurnMirrorRow[] = [];
  const seen = new Set<string>();
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.id !== "string" || msg.id.length === 0) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const id = buildLegacyMirrorTurnId(thread.id, msg.id);
    if (seen.has(id)) continue; // defensive: duplicate message ids in one payload
    seen.add(id);
    rows.push({
      id,
      assistantUserId:
        typeof msg.authorUserId === "string" && msg.authorUserId.length > 0
          ? msg.authorUserId
          : null,
      role: msg.role,
      createdAt: extractTimestampFieldFromThread(msg, "createdAt"),
      // Position among the EMITTED rows == faithful payload.messages[] order.
      ordinal: rows.length,
      // The whole message object is the durable content — faithful by
      // construction (parse(content) deep-equals payload.messages[i]). The
      // messages came from JSON (chat_threads.payload), so they re-serialize
      // safely. The CHECK requires a JSON object; a message is always an object.
      content: JSON.stringify(msg),
    });
  }
  return rows;
}

/**
 * Extract the structured pause set (cinatra#1037 P5.6 PR1 EXPAND). Presence is
 * an OWN-PROPERTY check so ABSENCE (a partial write) is distinguished from a
 * present-but-malformed value (codex convergence):
 *   - field ABSENT → `null`: the mirror leaves the structural pause rows
 *     UNTOUCHED (a partial write must not clear pause state it never saw;
 *     lockstep "column never lags a payload write" doctrine, presence-gated like
 *     buildChatThreadUpsertQuery's COALESCE);
 *   - field PRESENT as an array → the de-duplicated, non-empty-string ids; an
 *     empty array is a real "no one paused" state that CLEARS the rows;
 *   - field PRESENT but malformed (null / object / string) → an empty set, so
 *     the reconcile CLEARS stale rows (fail-closed: never silently PRESERVE a
 *     stale pause set behind a corrupt payload — treat an uninterpretable
 *     present value as "no valid paused participants").
 */
export function extractPausedParticipantsFromThread(
  thread: Record<string, unknown>,
): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(thread, "pausedParticipants")) {
    return null; // absent → leave the structural rows untouched
  }
  const raw = thread.pausedParticipants;
  const arr = Array.isArray(raw) ? raw : []; // present-but-malformed → clear
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v === "string" && v.length > 0) seen.add(v);
  }
  return Array.from(seen);
}

/**
 * Extract the durable thread-level render-state scalars (cinatra#1037 P5.6 PR2
 * CUTOVER) the /chat client restores on load — `activeAssistantHandle`,
 * `taggedAssistantUserIds`, `slackMode`. These are STATE, not losslessly
 * derivable from the messages (codex convergence: the tagged set is cumulative,
 * the active handle can be set without retained mention metadata, and slackMode
 * can be true with a single re-mentioned assistant), so the write path persists
 * the EXACT values and the read reconstruction reads them back directly.
 *
 * Only present, well-typed fields are captured (defensive against payload drift);
 * returns null when NONE are present so the column stays NULL for a plain thread.
 * The full-snapshot /chat POST always carries the current values, so the mirror's
 * wholesale-overwrite keeps the column a lockstep twin of the payload.
 */
export function extractThreadScalarsFromThread(
  thread: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (typeof thread.activeAssistantHandle === "string" && thread.activeAssistantHandle.length > 0) {
    out.activeAssistantHandle = thread.activeAssistantHandle;
  }
  if (Array.isArray(thread.taggedAssistantUserIds)) {
    out.taggedAssistantUserIds = thread.taggedAssistantUserIds.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
  }
  if (typeof thread.slackMode === "boolean") {
    out.slackMode = thread.slackMode;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Resolve the org tenancy anchor the mirror persists for this write.
 * Central, payload-derived policy (codex-converged):
 *   - team-owned threads (payload.teamId set) mirror with org NULL — the
 *     team→org anchoring decision is deferred to the S2 cutover; set-once
 *     SQL semantics keep it repairable.
 *   - otherwise the caller's EXPLICIT `assistantMirrorOrgId` option (which
 *     never falls back to the artifact-pin `orgId` option — option presence
 *     distinguishes explicit null from unspecified).
 */
export function resolveAssistantMirrorOrgId(
  thread: Record<string, unknown>,
  explicitMirrorOrgId: string | null,
): string | null {
  const teamId = extractStringFieldFromThread(thread, "teamId");
  if (teamId) return null;
  return explicitMirrorOrgId;
}

/**
 * Build the assistant_threads mirror upsert. Semantics (codex-converged):
 *   - title mirrors the server-sanitized payload wholesale (the payload is the
 *     full truth on every legacy write);
 *   - owner_user_id / team_id / org_id are the OWNERSHIP/AUTHORIZATION axes and
 *     are SET-ONCE (an established non-null value is never reassigned or cleared
 *     by a later write). Codex convergence (PR2 team-axis extension): team_id is
 *     an authz axis, NOT a mutable projection like project_id — a wholesale
 *     overwrite would let ANY partial-shaped writer (saveChatThread, an internal
 *     send path) that omits teamId silently NULL a team thread's ownership. The
 *     same reasoning applies to owner_user_id. A distinct trusted
 *     ownership-transition operation is the only way an established owner/team
 *     axis changes (there is none today — thread ownership is immutable
 *     per-thread in this model);
 *   - project_id (cinatra#1037 P5.6 PR2 CUTOVER) mirrors the payload's projectId
 *     wholesale on every write — it is a MUTABLE SCOPE (a thread moves between
 *     projects; the MCP chat_thread_update project-move that once drove this is
 *     retired in the final teardown), the SAME source + overwrite semantics as the
 *     (now product-callerless) buildChatThreadUpsertQuery's chat_threads.project_id;
 *   - created_at is immutable post-INSERT; updated_at mirrors the payload
 *     (falling back to now()) so activity ordering matches the legacy table;
 *   - assistant_user_id / context_id are never listed (S2-owned columns).
 */
export function buildAssistantThreadMirrorUpsertQuery(args: {
  schemaName: string;
  threadId: string;
  ownerUserId: string | null;
  orgId: string | null;
  projectId: string | null;
  /** Team ownership axis (cinatra#1037 P5.6 PR2, coordinator-authorized Fork-B
   *  extension). SET-ONCE on conflict (authz axis, never wholesale-cleared). */
  teamId: string | null;
  /** Durable thread-level render-state scalars (extractThreadScalarsFromThread);
   *  null → the column is NULL. Mirrored WHOLESALE (matches project_id). */
  scalars: Record<string, unknown> | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}): { text: string; values: unknown[] } {
  const schema = args.schemaName.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${schema}"."assistant_threads" (id, owner_user_id, org_id, project_id, team_id, origin, scalars, title, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, 'legacy-chat', $6::jsonb, $7, COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, now()))
ON CONFLICT (id) DO UPDATE SET
  -- ownership axis is SET-ONCE: never reassign/clear an established owner
  owner_user_id = COALESCE(assistant_threads.owner_user_id, EXCLUDED.owner_user_id),
  -- org tenancy anchor is SET-ONCE: never reassign an established org
  org_id        = COALESCE(assistant_threads.org_id, EXCLUDED.org_id),
  -- project scope is a MUTABLE projection (thread moves between projects)
  project_id    = EXCLUDED.project_id,
  -- team ownership axis is SET-ONCE: an omitting writer can never NULL a team
  -- thread's ownership (codex-converged — team_id is authz, not a projection)
  team_id       = COALESCE(assistant_threads.team_id, EXCLUDED.team_id),
  -- thread-origin DISCRIMINATOR is SET-ONCE PROVENANCE (cinatra#1037 PR2): the
  -- mirror always projects 'legacy-chat', but never overwrites an established
  -- origin — an assistant-native thread that a legacy write ever touches keeps
  -- its provenance, so the delete-all legacy-scope can never mis-erase it.
  origin        = COALESCE(assistant_threads.origin, EXCLUDED.origin),
  -- durable render-state scalars mirror the payload wholesale (lockstep twin)
  scalars       = EXCLUDED.scalars,
  title         = EXCLUDED.title,
  -- created_at is immutable post-INSERT
  updated_at    = EXCLUDED.updated_at`,
    values: [
      args.threadId,
      args.ownerUserId,
      args.orgId,
      args.projectId,
      args.teamId,
      args.scalars != null ? JSON.stringify(args.scalars) : null,
      args.title,
      args.createdAt,
      args.updatedAt,
    ],
  };
}

/**
 * Build the assistant_turns mirror reconcile pair for one thread write:
 *   1. DELETE mirror-namespace rows for messages no longer in the payload
 *      (edit/regenerate truncation). Scoped by `id LIKE 'legacy:%'` so a
 *      legacy write can NEVER delete a runtime-minted turn row.
 *   2. Constant-parameter multi-row INSERT (parallel unnest arrays — no
 *      per-message parameters, so long histories cannot hit the parameter
 *      ceiling). run_id NULL, status 'completed', plus the durable per-turn
 *      `content` jsonb (PR1 EXPAND). ON CONFLICT (id) DO UPDATE SET content so a
 *      re-written message (edit/regenerate reusing the same id) refreshes its
 *      durable content; the identity metadata (role/created_at/attribution) is
 *      immutable and left as first inserted.
 * Returns [delete] when there are no rows, else [delete, insert].
 */
export function buildAssistantTurnMirrorReconcileQueries(args: {
  schemaName: string;
  threadId: string;
  turns: AssistantTurnMirrorRow[];
}): Array<{ text: string; values: unknown[] }> {
  const schema = args.schemaName.replaceAll('"', '""');
  const ids = args.turns.map((t) => t.id);
  const queries: Array<{ text: string; values: unknown[] }> = [
    {
      text: `DELETE FROM "${schema}"."assistant_turns"
WHERE thread_id = $1
  AND id LIKE '${LEGACY_MIRROR_TURN_ID_PREFIX}%'
  AND NOT (id = ANY($2::text[]))`,
      values: [args.threadId, ids],
    },
  ];
  if (args.turns.length > 0) {
    queries.push({
      text: `INSERT INTO "${schema}"."assistant_turns" (id, thread_id, run_id, assistant_user_id, role, status, content, ordinal, created_at, updated_at)
SELECT t.id, $1, NULL, t.assistant_user_id, t.role, 'completed', t.content::jsonb, t.ordinal::int,
       COALESCE(t.created_at::timestamptz, now()), COALESCE(t.created_at::timestamptz, now())
FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[]) AS t(id, assistant_user_id, role, created_at, content, ordinal)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, ordinal = EXCLUDED.ordinal, updated_at = now()`,
      values: [
        args.threadId,
        ids,
        args.turns.map((t) => t.assistantUserId),
        args.turns.map((t) => t.role),
        args.turns.map((t) => t.createdAt),
        args.turns.map((t) => t.content),
        args.turns.map((t) => t.ordinal),
      ],
    });
  }
  return queries;
}

/**
 * Build the structured pause-state reconcile queries (cinatra#1037 P5.6 PR1
 * EXPAND) for one thread write, given the resolved pause set from
 * `extractPausedParticipantsFromThread` (call this ONLY when that returned
 * non-null — a null set means the payload omitted `pausedParticipants` and the
 * rows must be left untouched):
 *   1. DELETE the thread's pause rows whose participant is no longer paused
 *      (resume). An empty set clears them all.
 *   2. Constant-parameter unnest INSERT of the paused participants ON CONFLICT
 *      DO NOTHING (presence == paused; re-pausing is idempotent).
 * Written ALONGSIDE the legacy payload; the payload stays authoritative until
 * the PR2 cutover.
 */
export function buildAssistantPauseStateReconcileQueries(args: {
  schemaName: string;
  threadId: string;
  participantIds: string[];
}): Array<{ text: string; values: unknown[] }> {
  const schema = args.schemaName.replaceAll('"', '""');
  const queries: Array<{ text: string; values: unknown[] }> = [
    {
      text: `DELETE FROM "${schema}"."assistant_thread_pause_state"
WHERE thread_id = $1
  AND NOT (participant_id = ANY($2::text[]))`,
      values: [args.threadId, args.participantIds],
    },
  ];
  if (args.participantIds.length > 0) {
    queries.push({
      text: `INSERT INTO "${schema}"."assistant_thread_pause_state" (thread_id, participant_id)
SELECT $1, p FROM unnest($2::text[]) AS p
ON CONFLICT (thread_id, participant_id) DO NOTHING`,
      values: [args.threadId, args.participantIds],
    });
  }
  return queries;
}

/**
 * AUTHORITATIVE single-thread structured delete (cinatra#1037 P5.6 PR2 CUTOVER
 * step 4): removes the structured row (and its assistant_turns via FK cascade)
 * UNCONDITIONALLY by id. The prior EXISTS(chat_threads) guard is GONE — a
 * post-cutover thread has NO chat_threads row, so the guard would have made the
 * delete a silent no-op. The legacy chat_threads DELETE that runs alongside this
 * in deleteChatThreadFromDatabase is now pure best-effort cleanup.
 */
export function buildAssistantThreadMirrorDeleteQuery(
  schemaName: string,
  threadId: string,
): { text: string; values: unknown[] } {
  const schema = schemaName.replaceAll('"', '""');
  return {
    text: `DELETE FROM "${schema}"."assistant_threads"
WHERE id = $1`,
    values: [threadId],
  };
}

// buildAssistantThreadMirrorDeleteAllQuery (a GLOBAL mirror wipe keyed on the
// full chat_threads set) was RETIRED in the PR2 CUTOVER: the delete-all path is
// now OWNER + 'legacy-chat' scoped (deleteAllChatThreadsFromDatabase computes the
// id set directly from the mirror's owner_user_id + origin axes), closing the
// cross-tenant global-wipe vuln — a set-form mirror arm is no longer meaningful.

/**
 * One-call composition of the full P2b mirror for a legacy thread write: the
 * assistant_threads upsert followed by the assistant_turns reconcile pair,
 * with the org anchor resolved centrally (resolveAssistantMirrorOrgId).
 * database.ts spreads the result into the legacy upsert's transaction.
 */
export function buildAssistantThreadMirrorQueries(args: {
  schemaName: string;
  thread: { id: string } & Record<string, unknown>;
  /** The caller's EXPLICIT mirror-org option (null when unspecified). */
  explicitMirrorOrgId: string | null;
}): Array<{ text: string; values: unknown[] }> {
  const { schemaName, thread } = args;
  // Structured pause set (PR1 EXPAND): null == payload omitted the field, so
  // the rows stay untouched (presence-gated write-through, never a blind clear).
  const pausedParticipants = extractPausedParticipantsFromThread(thread);
  // The structured mirror is now the SOLE writer (PR2 CUTOVER — the legacy
  // chat_threads INSERT is dropped), so it always projects full durable per-turn
  // content. The dormant-backfill `stripTurnContent` identity-only shadow path
  // was retired with the boot backfill it existed for.
  const turns = extractAssistantTurnMirrorRowsFromThread(thread);
  return [
    buildAssistantThreadMirrorUpsertQuery({
      schemaName,
      threadId: thread.id,
      ownerUserId: extractRawStringFieldFromThread(thread, "ownerUserId"),
      orgId: resolveAssistantMirrorOrgId(thread, args.explicitMirrorOrgId),
      // Same source + trimming as buildChatThreadUpsertQuery's project_id.
      projectId: extractStringFieldFromThread(thread, "projectId"),
      // Team ownership axis (cinatra#1037 P5.6 PR2 team-axis extension): same
      // trimmed source as the org-null resolution above (resolveAssistantMirrorOrgId
      // reads payload.teamId). SET-ONCE at the SQL layer, so a write that omits
      // teamId (a personal thread, a partial writer) never NULLs an established
      // team thread's ownership.
      teamId: extractStringFieldFromThread(thread, "teamId"),
      // Durable render-state scalars (activeAssistantHandle/tagged/slackMode).
      scalars: extractThreadScalarsFromThread(thread),
      title: extractRawStringFieldFromThread(thread, "title"),
      createdAt: extractTimestampFieldFromThread(thread, "createdAt"),
      updatedAt: extractTimestampFieldFromThread(thread, "updatedAt"),
    }),
    // The thread row precedes its turn rows + pause rows (both FK → threads).
    ...buildAssistantTurnMirrorReconcileQueries({
      schemaName,
      threadId: thread.id,
      turns,
    }),
    // Structured pause/resume write-through — only when the payload carried the
    // field (a partial write must not clear pause state it never saw).
    ...(pausedParticipants !== null
      ? buildAssistantPauseStateReconcileQueries({
          schemaName,
          threadId: thread.id,
          participantIds: pausedParticipants,
        })
      : []),
  ];
}
