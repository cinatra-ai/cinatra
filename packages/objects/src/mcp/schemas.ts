import { z } from "zod";

export const objectsSaveSchema = z.object({
  rawData: z.record(z.string(), z.unknown()).optional().describe("REQUIRED: the actual data payload as a plain JSON object. Put ALL data here — never inside typeHint."),
  // The legacy `payload` alias (of rawData) and top-level `type` alias
  // (of typeHint) are removed. Use `rawData` + `typeHint` only; no
  // compatibility wrapper is provided.
  typeHint: z.string().optional().describe("Namespaced type identifier, e.g. '@cinatra-ai/campaigns:recipients'. Must be a type ID, not a description of the data."),
  parentId: z.string().optional(),
  // Optional explicit ownership inputs. The server re-derives defaults
  // from actor and rejects any client-supplied values that the actor cannot
  // satisfy via scope ratchet. Clients that omit these fields receive the
  // actor-derived defaults.
  ownerLevel: z.enum(["user", "team", "organization", "workspace"]).optional(),
  ownerId: z.string().optional(),
  visibility: z.enum(["private", "team", "organization", "public"]).optional(),
  // Explicit project binding for EXTERNAL callers (cinatra#1377, epic #1373).
  //
  // An external (CLI) writer reaches this primitive over the authenticated MCP
  // transport and has NO ambient `projectContext` frame — the request-scoped
  // frame only exists inside an agent-run/chat execution. Without this field
  // such a caller can only ever write pan-project (ambient) rows.
  //
  // Three-state precedence, keyed on PRESENCE (JSON has no `undefined`, so the
  // wire can express all three unambiguously):
  //   - omitted        → ambient inheritance, unchanged (the frame's projectId,
  //                      subject to the substrate-exclusion list).
  //   - explicit null  → no project (substrate write); the ambient frame is
  //                      IGNORED, not consulted.
  //   - explicit id    → bind the row to that project, ambient frame IGNORED.
  //
  // A supplied id is NOT a grant: the handler authorizes it against the
  // caller's own `projectGrants` (write tier) plus the archive gate via
  // `assertProjectWritable`, fail-closed and 404-hidden for a project the
  // caller cannot see. Blank strings are rejected here rather than silently
  // read as ambient — an authorization-adjacent input must not be ambiguous.
  //
  // `orgId` remains actor-derived and is deliberately NOT accepted from the
  // caller on this or any other objects primitive.
  projectId: z.string().min(1).nullish(),
}).strict();

export const objectsListSchema = z.object({
  type: z.string().optional(),
  category: z.enum(["profile", "content", "project", "idea", "report"]).optional(),
  query: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  // Filter to objects saved during a specific agent run. Lets agents read
  // back "everything I just saved" via
  // `objects_list { runId: <agent_run_id from state> }`.
  runId: z.string().optional(),
  // Sealed-room read filter. When set, the handler 404-hides if the actor
  // has no read+ grant on the project, and the underlying SQL adds
  // `AND project_id = $projectId` so the result contains only rows tagged
  // for this project. This also applies to the semantic-search path:
  // Graphiti candidate IDs from project/query/ambient inputs are
  // re-filtered to project-only inside `listObjectsByFilter`.
  // Null is interpreted as ambient (no project filter), same as omission.
  projectId: z.string().nullish(),
  // cinatra#1456: indexed equality filters over the JSONB `data` column, backing
  // the email thread / campaign / contact query seam. Keys are a CLOSED enum
  // (each backed by a partial expression index on `objects.data`); values are
  // parameterized in the SQL layer. Entries AND together. Per-row `object.read`
  // authorization still applies to every returned row — this is a filter, never
  // an authorization bypass. `runId` is deliberately NOT here (use `runId`, the
  // indexed provenance column). A `contactId` entry must be paired with a
  // `connectorId` entry (the composite index leads with connectorId).
  dataEquals: z
    .array(
      z.object({
        key: z.enum(["threadId", "campaignId", "contactId", "connectorId"]),
        value: z.string().min(1),
      }),
    )
    .optional(),
  // cinatra#1378: BATCH lookup by the row's `data.externalId` — the memory-sync
  // preflight. One call answers "which of these concepts already have a row",
  // which is what lets a resync write nothing for untouched concepts instead of
  // re-saving every file and churning versions and history.
  //
  // Deliberately a filter on the EXISTING primitive rather than a new one: the
  // authorization it needs is exactly `objects_list`'s. Every returned row is
  // still org-scoped in SQL, ownership-filtered in SQL, and `object.read`-probed
  // per row in the handler — so a row the caller may not read is simply absent,
  // indistinguishable from one that does not exist. That is what keeps the
  // preflight from being an existence oracle.
  //
  // Capped at 500, the same ceiling as `limit`: a batch that could ask for more
  // rows than the call can return would report present rows as absent, which is
  // exactly the misreading that turns a skip into a duplicate write. An EMPTY
  // array is rejected rather than read as "no filter" — a filter that silently
  // disappears would widen the read to the whole type.
  //
  // The 500 ceiling is the ARRAY cap; the handler additionally refuses a batch
  // larger than the call's EFFECTIVE `limit`, whose default is 100
  // (cinatra#1378 review item 7) — the array cap alone does not bind.
  //
  // Each id is capped too: an external id is a key, and 500 unbounded strings
  // reaching the array parameter is an author-controlled surface with no
  // ceiling. 256 bytes sits far above every key this filter is built for (the
  // memory preflight's are 64-character sha256 hex digests).
  externalIds: z.array(z.string().min(1).max(256)).min(1).max(500).optional(),
});

export const objectsGetSchema = z.object({
  objectId: z.string().min(1),
}).strict();

export const objectsUpdateSchema = z.object({
  objectId: z.string().min(1),
  // The legacy `payload` alias is removed. Use `data`. The handler still
  // allows a project-move-only call (no `data`).
  data: z.record(z.string(), z.unknown()).optional(),
  // Optional project-move field. When supplied (and different from the
  // current row's project_id), the handler requires write/admin on the
  // source project, write on the target project, and a target that is not
  // archived via assertProjectWritable. It then runs a transactional
  // cascade: UPDATE objects.project_id and INSERT a resource_project_moves
  // audit row. Passing the same value as the current project_id is a no-op.
  // Pass `null` to unset the project tag (move to "ambient"); the handler
  // still runs the source-side authz check.
  projectId: z.string().nullable().optional(),
  // Optional `reason` annotation recorded on the resource_project_moves
  // audit row.
  reason: z.string().min(1).max(500).optional(),
}).strict();

export const objectsDeleteSchema = z.object({
  objectId: z.string().min(1),
}).strict();

export const objectsClassifySchema = z.object({
  // Classify can run dry (rawData supplied) or against an existing object
  // (objectId supplied). The latter requires object.read on the target row.
  rawData: z.record(z.string(), z.unknown()).optional(),
  objectId: z.string().min(1).optional(),
  typeHint: z.string().optional(),
}).strict();

export const objectsTypesListSchema = z.object({}).strict();

// Data Safety: Undo & Versioning MCP primitive schemas.

export const changeSetUndoSchema = z.object({
  changeSetId: z.string().min(1),
  // `bypassEligibility` is intentionally absent from the user-reachable
  // primitive. Eligibility-bypass is a platform-admin power; if ever needed
  // it ships as a SEPARATE primitive (`platform_change_set_undo_force`)
  // gated by the RBAC kernel.
  reason: z.string().optional(),
}).strict();

export const objectVersionRestoreSchema = z.object({
  objectId: z.string().min(1),
  targetVersion: z.number().int().min(1),
  reason: z.string().optional(),
}).strict();

export const changeSetGetSchema = z.object({
  changeSetId: z.string().min(1),
  includeEligibility: z.boolean().optional().default(true),
}).strict();

export const changeSetListSchema = z.object({
  // No caller-supplied orgId — the handler ALWAYS scopes the list to
  // the current actor's organization. Cross-org browsing is a future
  // platform-admin-gated tool, not this one.
  runId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
  // Filter/search. All optional + backward-compatible: omitted fields =
  // no filter, so existing callers are unaffected.
  objectId: z.string().optional(),
  actorId: z.string().optional(),
  effectRollup: z
    .enum(["reversible-internal", "irreversible-logged", "compensating-action"])
    .optional(),
  restorable: z.boolean().optional(),
  createdAfter: z.string().datetime().optional(), // opened_at lower bound
  createdBefore: z.string().datetime().optional(), // opened_at upper bound
  closedAtAfter: z.string().datetime().optional(), // closed_at lower bound (chat-undo polling)
}).strict();

export const objectHistoryListSchema = z.object({
  objectId: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

export const changeSetEligibilityGetSchema = z.object({
  changeSetId: z.string().min(1),
}).strict();

// Freshness probe for a change-set. Reader-authz primitive
// (org + per-event read); NOT in the delegated-chat allowlist.
export const freshnessCheckForChangeSetSchema = z.object({
  changeSetId: z.string().min(1),
}).strict();

// Remote-effect attempts list + admin retry.
export const remoteEffectAttemptsListForChangeSetSchema = z.object({
  changeSetId: z.string().min(1),
}).strict();

export const remoteEffectAttemptRetrySchema = z.object({
  attemptId: z.string().min(1),
}).strict();

// ---------------------------------------------------------------------------
// memory_recall (cinatra#1380, epic #1373) — the SHARED-memory recall surface.
//
// The offline counterpart (recall over local bundle files) stays in the
// `memory` CLI; this primitive is the server-side one, and it reads the SAME
// canonical Postgres rows `objects_list` reads, through the SAME authorization.
// It exists as its own primitive rather than a flag on `objects_list` because
// it answers a narrower question with a narrower answer: it is pinned to
// `@cinatra-ai/memory:concept`, it projects a capped recall row instead of the
// whole envelope, and it carries an explicit `mode` the caller must read.
//
// STRICT (the #1378 lesson, applied at the door). An unknown top-level key is
// a REJECTION, not a tolerated stray — which is also what makes a
// client-supplied `group_ids` / `groupIds` / `lanes` impossible to express.
// Lanes are SERVER-DERIVED from the authenticated actor (cinatra#1379) and
// there is deliberately no input surface for them; `orgId` is likewise
// actor-derived and never accepted from a caller.
// ---------------------------------------------------------------------------

/** Cap on the free-text `query`, in UTF-8 BYTES. A recall query is a question,
 *  not a payload; 1 KiB sits far above every legitimate one. */
export const MEMORY_RECALL_QUERY_MAX_BYTES = 1024;

/** Cap on the `kind` frontmatter-type filter, in UTF-8 bytes. Matches the
 *  envelope's own `okfType`, which is a short type token. */
export const MEMORY_RECALL_KIND_MAX_BYTES = 200;

/** Default number of recall rows when the caller does not ask. */
export const MEMORY_RECALL_DEFAULT_LIMIT = 10;

/** Hard ceiling on recall rows. Lower than `objects_list`'s 500 on purpose: a
 *  recall feeds a model's context window, and the excerpt cap below is only
 *  meaningful against a bounded row count. */
export const MEMORY_RECALL_MAX_LIMIT = 50;

function memoryRecallUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const memoryRecallSchema = z
  .object({
    // REQUIRED. Trimmed and non-empty: a blank query would fall straight
    // through to the degraded path and hand back recent rows, which is exactly
    // the "recent presented as search" outcome this tool exists to prevent.
    query: z
      .string()
      .min(1)
      .refine((q) => q.trim().length > 0, {
        message: "query must not be blank",
      })
      .refine((q) => memoryRecallUtf8Bytes(q) <= MEMORY_RECALL_QUERY_MAX_BYTES, {
        message: `query exceeds the ${MEMORY_RECALL_QUERY_MAX_BYTES}-byte cap`,
      }),
    // Frontmatter type filter — matched against the envelope's `okfType` in
    // JS, on rows already fetched and already `object.read`-gated. It never
    // reaches SQL and never reaches the semantic index, so there is no
    // injection surface to smuggle through; it is capped and non-blank anyway,
    // because an author-controlled string with no ceiling is the surface this
    // repo has now found uncapped three times.
    kind: z
      .string()
      .min(1)
      .refine((k) => k.trim().length > 0, { message: "kind must not be blank" })
      .refine((k) => memoryRecallUtf8Bytes(k) <= MEMORY_RECALL_KIND_MAX_BYTES, {
        message: `kind exceeds the ${MEMORY_RECALL_KIND_MAX_BYTES}-byte cap`,
      })
      .optional(),
    // Project recall. Same three-state semantics as `objects_list.projectId`:
    // omitted / null = no project filter, an id = SEALED to that project.
    //
    // Be precise about what "sealed" costs, because the lane derivation reads
    // like it says otherwise: cinatra#1379 puts BOTH the project lanes and the
    // ambient ones in the search set, so the index ranks against ambient memory
    // too — but the canonical read carries the sealed-room
    // `AND project_id = $projectId`, and an ambient row (`project_id IS NULL`)
    // does not survive it. A project recall therefore RETURNS PROJECT ROWS ONLY.
    //
    // A supplied id is NOT a grant — the handler 404-hides it through
    // `assertProjectReadAccess` and the SQL re-filter lives in
    // `listObjectsByFilter`.
    projectId: z.string().nullish(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_RECALL_MAX_LIMIT)
      .optional()
      .default(MEMORY_RECALL_DEFAULT_LIMIT),
  })
  .strict();
