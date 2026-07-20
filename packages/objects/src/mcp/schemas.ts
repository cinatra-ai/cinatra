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
