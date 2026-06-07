import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { dynamicObjectTypes } from "./schema";

/**
 * Derive a kebab-case slug from a fully-qualified type id by stripping
 * the namespace prefix (explicit fallback rule).
 *
 * Algorithm: if the typeId matches @scope/package:local-id, return
 * `local-id`; otherwise, return the full typeId unchanged.
 *
 * Examples:
 *   "@cinatra-ai/dynamic:email-campaign-type" → "email-campaign-type"
 *   "@cinatra-ai/dynamic:competitor-profile"  → "competitor-profile"
 *   "legacy-type-id"                       → "legacy-type-id" (defensive
 *                                            — the namespace regex on
 *                                            registration paths makes this
 *                                            branch unreachable in normal flow)
 */
function deriveSlug(typeId: string): string {
  const colonIdx = typeId.indexOf(":");
  return colonIdx >= 0 ? typeId.slice(colonIdx + 1) : typeId;
}

/**
 * Pull the canonicalKeys array out of the jsonSchema JSONB blob.
 * Returns null when jsonSchema is null OR has no `canonicalKeys` array.
 */
function extractCanonicalKeys(jsonSchema: unknown): string[] | null {
  if (!jsonSchema || typeof jsonSchema !== "object") return null;
  const ck = (jsonSchema as { canonicalKeys?: unknown }).canonicalKeys;
  if (!Array.isArray(ck)) return null;
  return ck.filter((k): k is string => typeof k === "string");
}

export type DynamicObjectTypeRecord = {
  type: string;
  inferredName: string;
  inferredCategory: string;
  createdAt: Date;
  createdBy: string | null;
  promotedToType: string | null;
  status: string;
  source: string | null;
  confidence: string | null;
  canonicalKeys: string[] | null;
  originContext: Record<string, unknown> | null;
  identityKey: string | null;
};

/**
 * Insert a new dynamic object type — idempotent. Safe to call concurrently
 * from two MCP handlers racing to register the same type; whichever wins the
 * primary-key race wins.
 *
 * `status` defaults to 'proposed' for low-confidence new types. Admins
 * confirm/merge proposed types in the /objects UI before they become 'active'.
 * This prevents registry pollution from LLM uncertainty.
 *
 * INSERT-ONLY semantics: on conflict (same `type`), the existing row is NOT
 * updated. Status, source, confidence, originContext, and every other field
 * stay exactly as they were. Status transitions (proposed→active, →archived)
 * live exclusively in `approveDynamicObjectType` and
 * `archiveDynamicObjectType`.
 */
export async function ensureDynamicObjectType(input: {
  type: string;
  inferredName: string;
  inferredCategory: "profile" | "content" | "project" | "idea" | "report";
  createdBy?: string | null;
  /** 'proposed' = needs admin review; 'active' = trusted/high-confidence. Default: 'proposed'. */
  status?: "active" | "proposed";
  //
  // originContext: extensible JSONB provenance bag. Standard shape has
  // well-known fields { agentId?, runId?, source? }. Callers MAY add other
  // keys (e.g., installationId, packageVersion) but the listed three are the
  // canonical, queryable fields.
  originContext?: Record<string, unknown> | null;
  source?: "classifier" | "mcp" | "install" | "admin";
  confidence?: "high" | "low" | null;
  canonicalKeys?: string[] | null;
  /** Data field name used as Graphiti dedup key (e.g. "cinatra_agent_run_id"). */
  identityKey?: string | null;
}): Promise<void> {
  await db
    .insert(dynamicObjectTypes)
    .values({
      type: input.type,
      displayName: input.inferredName,
      inferredCategory: input.inferredCategory,
      createdBy: input.createdBy ?? null,
      status: input.status ?? "proposed",
      source: input.source ?? null,
      confidence: input.confidence ?? null,
      slug: deriveSlug(input.type),
      jsonSchema:
        input.canonicalKeys && input.canonicalKeys.length > 0
          ? { canonicalKeys: input.canonicalKeys }
          : null,
      originContext: input.originContext ?? null,
      identityKey: input.identityKey ?? null,
    })
    .onConflictDoNothing({ target: dynamicObjectTypes.type });
}

/**
 * Transition a dynamic object type's status from "proposed" to "active".
 * Does NOT enforce auth — callers (server actions, MCP handlers) must call
 * `requireAdminSession()` upstream. Idempotent at the DB level: re-applying
 * to an already-active row is a no-op write.
 */
export async function approveDynamicObjectType(typeId: string): Promise<void> {
  await db
    .update(dynamicObjectTypes)
    .set({ status: "active" })
    .where(eq(dynamicObjectTypes.type, typeId));
}

/**
 * Transition a dynamic object type's status to "archived". The row is
 * preserved for audit history.
 *
 * Archive is a UI-only state change with NO side-effects on the classifier or
 * on objects_save:
 *   - The classifier still has the type in its catalog and may legitimately
 *     propose it again (the resulting ensureDynamicObjectType call is a
 *     no-op against the archived row per onConflictDoNothing — the row
 *     stays archived).
 *   - objects_save does NOT block saves of objects whose `type` is archived.
 *     The archived state is purely for the operator surface — it hides the
 *     row from default views and signals "do not surface as a recommended
 *     type." Classifier filtering by status may be added later, but the
 *     lifecycle is intentionally not coupled to runtime behavior.
 *   - Admins can re-archive a row that the classifier proposes again; there
 *     is no auto-unarchive path.
 *
 * Same auth-callsite contract as approveDynamicObjectType.
 */
export async function archiveDynamicObjectType(typeId: string): Promise<void> {
  await db
    .update(dynamicObjectTypes)
    .set({ status: "archived" })
    .where(eq(dynamicObjectTypes.type, typeId));
}

/**
 * Read all dynamic types — used by admin UI that needs to show proposed types
 * for review alongside active ones.
 */
export async function readDynamicObjectTypes(): Promise<DynamicObjectTypeRecord[]> {
  const rows = await db
    .select()
    .from(dynamicObjectTypes)
    .orderBy(sql`${dynamicObjectTypes.createdAt} ASC`);
  return rows.map((r) => ({
    type: r.type,
    inferredName: r.displayName,
    inferredCategory: r.inferredCategory,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    promotedToType: r.promotedToType,
    status: r.status ?? "proposed",
    source: r.source,
    confidence: r.confidence,
    canonicalKeys: extractCanonicalKeys(r.jsonSchema),
    originContext: r.originContext as Record<string, unknown> | null,
    identityKey: r.identityKey ?? null,
  }));
}

/**
 * Read only admin-approved ('active') dynamic types.
 *
 * Used by the LLM classifier and the objects_types_list MCP primitive so that
 * proposed (unreviewed) types are never fed to the LLM as valid classification
 * targets — that would bypass the admin review gate.
 */
export async function readActiveDynamicObjectTypes(): Promise<DynamicObjectTypeRecord[]> {
  const rows = await db
    .select()
    .from(dynamicObjectTypes)
    .where(eq(dynamicObjectTypes.status, "active"))
    .orderBy(sql`${dynamicObjectTypes.createdAt} ASC`);
  return rows.map((r) => ({
    type: r.type,
    inferredName: r.displayName,
    inferredCategory: r.inferredCategory,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    promotedToType: r.promotedToType,
    status: r.status ?? "active",
    source: r.source,
    confidence: r.confidence,
    canonicalKeys: extractCanonicalKeys(r.jsonSchema),
    originContext: r.originContext as Record<string, unknown> | null,
    identityKey: r.identityKey ?? null,
  }));
}

/**
 * Look up a single dynamic type by its primary key. Returns null when not found.
 * Used by objects_save to resolve the identityKey field for dynamic types at
 * save time (Layer 3 dedup).
 */
export async function readDynamicObjectTypeByType(
  type: string,
): Promise<DynamicObjectTypeRecord | null> {
  const rows = await db
    .select()
    .from(dynamicObjectTypes)
    .where(eq(dynamicObjectTypes.type, type))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    type: r.type,
    inferredName: r.displayName,
    inferredCategory: r.inferredCategory,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    promotedToType: r.promotedToType,
    status: r.status ?? "proposed",
    source: r.source,
    confidence: r.confidence,
    canonicalKeys: extractCanonicalKeys(r.jsonSchema),
    originContext: r.originContext as Record<string, unknown> | null,
    identityKey: r.identityKey ?? null,
  };
}

// Returns both active and proposed types — used by objects_types_list so admins
// can see proposed types awaiting review. Classifier still uses readActiveDynamicObjectTypes
// (active only) to enforce the admin review gate.
export async function readAllDynamicObjectTypes(): Promise<DynamicObjectTypeRecord[]> {
  const rows = await db
    .select()
    .from(dynamicObjectTypes)
    .orderBy(sql`${dynamicObjectTypes.createdAt} ASC`);
  return rows.map((r) => ({
    type: r.type,
    inferredName: r.displayName,
    inferredCategory: r.inferredCategory,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    promotedToType: r.promotedToType,
    status: r.status ?? "proposed",
    source: r.source,
    confidence: r.confidence,
    canonicalKeys: extractCanonicalKeys(r.jsonSchema),
    originContext: r.originContext as Record<string, unknown> | null,
    identityKey: r.identityKey ?? null,
  }));
}
