// ---------------------------------------------------------------------------
// Built-in assistant-agent registration (cinatra#1037 P1.3)
// ---------------------------------------------------------------------------
//
// Extracted from store.ts as a thin vertical slice (the file-size ratchet keeps
// store.ts from growing further). Behavior-preserving: the constants + the two
// functions are re-exported from ./store, so every existing importer is
// unchanged.

import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { agentTemplates } from "./schema";

/** Stable id of the seeded built-in Cinatra assistant agent_templates row. Fixed
 *  (not random) so the registration bootstrap is idempotent across boots via
 *  ON CONFLICT (id), and a re-minted principal re-links the SAME template row. */
export const BUILT_IN_CINATRA_ASSISTANT_TEMPLATE_ID = "agt_builtin_cinatra_assistant";

/** Reserved package identity of the built-in Cinatra assistant. `package_name` is
 *  NOT NULL on agent_templates (bootstrap backfills NULLs then SET NOT NULL), so
 *  a built-in assistant must declare one; this reserved name is never published
 *  and carries a PRIVATE origin (below), so it stays out of marketplace listings. */
export const BUILT_IN_CINATRA_ASSISTANT_PACKAGE_NAME = "@cinatra-ai/cinatra-assistant";

/** Stable id + reserved (private) package identity of the built-in WordPress
 *  assistant agent_templates row (cinatra#1823, epic #1037 P4.1). DISTINCT from
 *  the Cinatra ids so the three built-in assistants persist as three distinct
 *  1:1-linked rows (each keyed on its own principal); ON CONFLICT (id) keeps the
 *  boot registration idempotent per assistant. */
export const BUILT_IN_WORDPRESS_ASSISTANT_TEMPLATE_ID = "agt_builtin_wordpress_assistant";
export const BUILT_IN_WORDPRESS_ASSISTANT_PACKAGE_NAME = "@cinatra-ai/wordpress-assistant";

/** Stable id + reserved (private) package identity of the built-in Drupal
 *  assistant agent_templates row (cinatra#1823, epic #1037 P4.1). See the
 *  WordPress constants above. */
export const BUILT_IN_DRUPAL_ASSISTANT_TEMPLATE_ID = "agt_builtin_drupal_assistant";
export const BUILT_IN_DRUPAL_ASSISTANT_PACKAGE_NAME = "@cinatra-ai/drupal-assistant";

/**
 * Idempotently upsert the agent_templates row for a built-in assistant agent and
 * link it 1:1 to its assistant-user PRINCIPAL (cinatra#1037 P1.3). Written as a
 * raw parameterized upsert (not the ORM insert path) deliberately: it sets the
 * interaction-axis columns (`agent_kind='assistant'`, `assistant_config`,
 * `assistant_user_id`) that serializeTemplate does not carry (those are enforced
 * by the DB CHECK + the write-time twin normalizeAgentKindConfig, not the
 * executor-shaped ORM insert).
 *
 * NOT a marketplace/installed extension: the built-in Cinatra assistant is a
 * SEEDED principal-linked instance. It carries a reserved `package_name` (the
 * column is NOT NULL) but a PRIVATE `origin` (visibility:'private') + `status`
 * 'draft' + NO installed_extension row, so it never surfaces in the marketplace,
 * the installed-extension readers (which join installed_extension on
 * package_name), the published-template readers, or the origin grandfather
 * backfill (which only touches origin IS NULL rows).
 *
 * ON CONFLICT (id) DO UPDATE re-links the (possibly re-minted) principal + the
 * current config. The caller (assistant-agent-registration) passes the already-
 * validated, serialized sidecar so the DB CHECK is satisfied.
 *
 * `templateId` + `packageName` default to the Cinatra built-in identity so the
 * @cinatra registration is unchanged; a sibling built-in assistant (WordPress /
 * Drupal, cinatra#1823) passes its OWN distinct pair so the three built-ins
 * persist as three distinct 1:1-linked rows rather than colliding on one id.
 */
export async function upsertBuiltInAssistantAgentTemplate(input: {
  assistantUserId: string;
  name: string;
  /** Canonical JSON-as-text assistant_config (validated + serialized by the caller). */
  assistantConfigJson: string;
  description?: string;
  /** Stable agent_templates row id (the ON CONFLICT idempotency key). Defaults
   *  to the Cinatra built-in id. */
  templateId?: string;
  /** Reserved (private) package_name. Defaults to the Cinatra built-in name. */
  packageName?: string;
  /** `source_nl` provenance note. Defaults to the historical Cinatra literal so
   *  the @cinatra row stays byte-identical; a sibling built-in passes its own. */
  sourceNl?: string;
}): Promise<string> {
  const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const table = sql.raw(`"${schemaName.replaceAll('"', '""')}"."agent_templates"`);
  const templateId = input.templateId ?? BUILT_IN_CINATRA_ASSISTANT_TEMPLATE_ID;
  const packageName = input.packageName ?? BUILT_IN_CINATRA_ASSISTANT_PACKAGE_NAME;
  const description = input.description ?? "The built-in Cinatra conversational assistant.";
  const sourceNl = input.sourceNl ?? "Built-in Cinatra assistant (seeded at boot).";
  const originJson = JSON.stringify({
    packageName,
    version: "0.0.0",
    destinationId: null,
    scope: "@cinatra-ai",
    visibility: "private",
    registryUrl: "",
  });
  await db.execute(sql`
    INSERT INTO ${table}
      (id, name, description, source_nl, compiled_plan, input_schema, approval_policy,
       status, type, agent_kind, assistant_config, assistant_user_id, package_name, origin,
       execution_provider, source_type, created_at, updated_at)
    VALUES
      (${templateId}, ${input.name}, ${description},
       ${sourceNl}, '[]', '{}', '{"steps":[]}',
       'draft', 'leaf', 'assistant', ${input.assistantConfigJson}, ${input.assistantUserId},
       ${packageName}, ${originJson}::jsonb,
       'default', 'internal', now(), now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      assistant_config = EXCLUDED.assistant_config,
      assistant_user_id = EXCLUDED.assistant_user_id,
      updated_at = now()
  `);
  return templateId;
}

/**
 * Resolve the persisted `assistant_config` (JSON-as-text) for the assistant
 * template linked 1:1 to a principal id (cinatra#1037 P1.3). This is the lookup
 * behind the generalized assistant-MCP surface's handle-generic config
 * resolution (resolveTemplateLinkedAssistantConfig) — a principal with no linked
 * assistant template returns null (the surface then fails closed for a non-
 * built-in principal, or falls back to the built-in reference config for the
 * built-in handle). Returns the RAW column string; the caller validates it
 * (safeParseAssistantConfig) so a malformed persisted row can fail closed.
 */
export async function readAssistantConfigByPrincipalId(
  assistantUserId: string,
): Promise<string | null> {
  const rows = await db
    .select({ assistantConfig: agentTemplates.assistantConfig })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.assistantUserId, assistantUserId),
        eq(agentTemplates.agentKind, "assistant"),
      ),
    )
    .limit(1);
  return rows[0]?.assistantConfig ?? null;
}
