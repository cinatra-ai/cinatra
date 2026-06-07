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
 * string + the SQL schema identifier; emits the query the writer executes
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
