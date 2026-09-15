import { z } from "zod";

/** UTF-8 byte length of a caller-supplied string. Byte-exact, not code units. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Cap on a caller-supplied `projectId`, in UTF-8 BYTES.
 *
 * A project id is an identifier, not a payload. Uncapped it reaches the derived
 * lane strings, the semantic index `group_ids` and a bound SQL parameter, and a
 * caller the project gate lets through (a grant holder, or a platform admin who
 * needs no grant) can make all three megabytes wide. 200 bytes sits far above a
 * UUID and every slug this repo issues.
 */
export const PROJECT_ID_MAX_BYTES = 200;

/**
 * A caller-supplied `projectId`, validated the same way on every primitive that
 * accepts one. All FOUR of them use it: `objects_save`, `objects_list`,
 * `memory_recall` and `objects_update`.
 *
 * NON-BLANK is the load-bearing half. The READ handlers normalize with
 * `.trim()` and read an empty result as "no project", so a blank id does not
 * refuse there: it silently becomes an AMBIENT call, which is a widening on the
 * field the sealed room is built out of. `.min(1)` alone does not close it
 * (`" "`, `"\t"` and `"\n"` all pass it), so the refinement uses the SAME
 * `String.prototype.trim` those handlers use, which makes the schema and the
 * handler agree on every whitespace form JS recognizes, U+00A0 included.
 *
 * The WRITE handlers (`objects_save`, `objects_update`) deliberately do NOT
 * trim, and this field is why they do not have to: a blank never reaches them,
 * and a padded id is a different id, so trimming one would silently retarget a
 * write rather than refuse it. What arrives is what the project gate is asked
 * about.
 *
 * Callers add `.nullish()` themselves: omitted and explicit `null` stay the two
 * legitimate ambient states and are deliberately NOT narrowed here.
 */
function projectIdField() {
  return z
    .string()
    .min(1)
    .refine((p) => p.trim().length > 0, { message: "projectId must not be blank" })
    .refine((p) => utf8Bytes(p) <= PROJECT_ID_MAX_BYTES, {
      message: `projectId exceeds the ${PROJECT_ID_MAX_BYTES}-byte cap`,
    });
}

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
  projectId: projectIdField().nullish(),
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
  projectId: projectIdField().nullish(),
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
  //
  // Shared `projectIdField()`, the same one the other three primitives use.
  // `null` and omission keep their meanings exactly (unset, and "do not move");
  // what the refinement removes is the BLANK string, which is neither: it is a
  // caller asking to move a row into a project whose id is whitespace. The
  // handler compares `input.projectId ?? null` against the row's current
  // `project_id`, so a blank would reach `assertProjectWritable` as a literal.
  // The byte cap is the other half: an unbounded caller value otherwise reaches
  // the project gate and a bound SQL parameter on this path too.
  projectId: projectIdField().nullish(),
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
      .refine((q) => utf8Bytes(q) <= MEMORY_RECALL_QUERY_MAX_BYTES, {
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
      .refine((k) => utf8Bytes(k) <= MEMORY_RECALL_KIND_MAX_BYTES, {
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
    //
    // Non-blank and byte-capped through the shared `projectIdField()`: a blank
    // id would trim to null in the handler and answer an UNSEALED ambient
    // recall instead of refusing, which is a widening on the one field this
    // whole passage is about.
    projectId: projectIdField().nullish(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_RECALL_MAX_LIMIT)
      .optional()
      .default(MEMORY_RECALL_DEFAULT_LIMIT),
  })
  .strict();

// ---------------------------------------------------------------------------
// The memory_recall RESPONSE, as a schema.
//
// `mode` is the point of this primitive, so it is required by something rather
// than by convention. Two return paths happen to carry it today because the
// author wrote them that way; a third one would compile clean and every test
// would stay green. Both halves are closed here:
//
//   - the handler is annotated `Promise<MemoryRecallResponse>`, so a return
//     that omits `mode` is a TYPE error at the moment it is written;
//   - every return is parsed through `memoryRecallResponseSchema`, so a path
//     that gets past the type system still fails at runtime.
//
// The schema below is a DISCRIMINATED UNION on `mode`, so it asserts what this
// passage claims: not merely that `mode` is present, but that the ordering and
// the degradation metadata AGREE with it. `.strict()` on every object in it:
// a recall answer is a fixed projection, and an extra key riding out of it is
// the leak the projection exists to prevent.
// ---------------------------------------------------------------------------

/** One row of a `memory_recall` response — the FIXED, CAPPED projection. */
export const memoryRecallItemSchema = z
  .object({
    id: z.string(),
    conceptPath: z.string().nullable(),
    title: z.string().nullable(),
    kind: z.string().nullable(),
    scope: z
      .object({
        ownerLevel: z.string(),
        ownerId: z.string().nullable(),
        visibility: z.string(),
        projectId: z.string().nullable(),
      })
      .strict(),
    excerpt: z.string(),
    excerptTruncated: z.boolean(),
  })
  .strict();

/**
 * The aggregate-ceiling report, legal on BOTH answers.
 *
 * It is ORTHOGONAL to degradation and the shape below keeps it that way: a
 * response can be too large to send whether the semantic index answered or not,
 * so binding it to one path would make the union lie in the other direction.
 */
const responseCeilingReport = z.literal("applied");

/**
 * The whole response, as a DISCRIMINATED UNION on `mode`.
 *
 * Two independent enums would have guaranteed only that both keys are present
 * with legal values, not that they AGREE. That admits `semantic` ordered by the
 * lexical fallback, `degraded-recent` claiming semantic rank, and a `semantic`
 * answer carrying `meta.semanticSearch: "unavailable"`. Those are three answers
 * this handler cannot produce and exactly the soft dishonesty the primitive
 * exists to prevent. `mode` is the discriminant, and each arm pins the ordering AND
 * the `meta` vocabulary that belongs to its path:
 *
 *   - `semantic` is ranked by the index, so `ordering` can only be
 *     `semantic-rank` and `meta`, when present, carries the ceiling report and
 *     nothing else. A ranked answer that fits has no `meta` at all, so the arm
 *     admits exactly two shapes and an empty `meta: {}` is not one of them.
 *   - `degraded-recent` is a recent-rows listing, so `ordering` can only be
 *     `lexical-fallback` and `meta` is REQUIRED and must say WHY it degraded.
 *     A degradation that does not name its cause is the same silence one layer
 *     down.
 *
 * `.strict()` on every object: a recall answer is a fixed projection, and an
 * extra key riding out of it is the leak the projection exists to prevent.
 */
export const memoryRecallResponseSchema = z.discriminatedUnion("mode", [
  z
    .object({
      items: z.array(memoryRecallItemSchema),
      mode: z.literal("semantic"),
      ordering: z.literal("semantic-rank"),
      // REQUIRED inside an optional `meta`, which is the whole vocabulary this
      // path has: the ranked answer either carries no `meta` at all or carries
      // the ceiling report. An empty `meta: {}` is a third shape the handler
      // cannot produce (codex convergence round 2 on this change), so the arm
      // refuses it rather than leaving a hole the next field can widen.
      meta: z.object({ responseCeiling: responseCeilingReport }).strict().optional(),
    })
    .strict(),
  z
    .object({
      items: z.array(memoryRecallItemSchema),
      mode: z.literal("degraded-recent"),
      ordering: z.literal("lexical-fallback"),
      meta: z
        .object({
          // `objects_list`'s degradation vocabulary, reused verbatim.
          semanticSearch: z.enum(["unavailable", "no_ids_extracted"]),
          fallback: z.literal("postgres_filter"),
          // Optional HERE, because both shapes are reachable on this path: the
          // degradation is always reported, the ceiling only when it fired.
          responseCeiling: responseCeilingReport.optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type MemoryRecallItem = z.infer<typeof memoryRecallItemSchema>;
export type MemoryRecallResponse = z.infer<typeof memoryRecallResponseSchema>;

/** Distribute `Omit` across a union instead of collapsing it to common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * One recall answer MINUS its rows: everything the serialized envelope is made
 * of. The response ceiling charges the envelope it is about to emit rather than
 * a flat reservation, and this is the type it charges (see
 * `applyMemoryRecallResponseCeiling`). Derived, so a new field cannot be
 * charged for on one side and forgotten on the other.
 */
export type MemoryRecallEnvelope = DistributiveOmit<MemoryRecallResponse, "items">;
