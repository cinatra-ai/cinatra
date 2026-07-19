import "server-only";

import { sql } from "drizzle-orm";
import { betterAuthDb, registerAssistantHandle } from "@/lib/better-auth-db";
import { insertOAuthClientWithTx } from "@/lib/better-auth-oauth-client";
import {
  createAssistantUserWithTx,
  BUILT_IN_CINATRA_ASSISTANT_USERNAME,
  BUILT_IN_WORDPRESS_ASSISTANT_USERNAME,
  BUILT_IN_DRUPAL_ASSISTANT_USERNAME,
} from "@/lib/assistant-users";
import {
  upsertBuiltInAssistantAgentTemplate,
  BUILT_IN_WORDPRESS_ASSISTANT_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_ASSISTANT_PACKAGE_NAME,
  BUILT_IN_DRUPAL_ASSISTANT_TEMPLATE_ID,
  BUILT_IN_DRUPAL_ASSISTANT_PACKAGE_NAME,
} from "@cinatra-ai/agents";
import { serializeAssistantConfig, type AssistantConfig } from "@/lib/assistant-config";
import { cinatraAssistantConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";
import {
  wordpressAssistantConfig,
  drupalAssistantConfig,
} from "@/lib/assistant-runtime/cms-assistant-config";

// ---------------------------------------------------------------------------
// Assistant-agent registration (cinatra-ai/cinatra#1037 P1.3).
//
// The ONE principal-minting path (invariant I3). Registering an assistant agent
// is the ONLY way an assistant `public."user"` principal is minted — there is no
// direct-SQL seed (the former ensureBuiltInCinatraAssistant is deleted) and no
// manual admin "create assistant" action (deleted). A registration:
//
//   1. resolve-or-mints the assistant-user PRINCIPAL (the only caller of the
//      createAssistantUserWithTx mint primitive), serialized under the historical
//      built-in-seed advisory lock on the SAME betterAuthDb connection so two
//      concurrent boots cannot both mint;
//   2. mints the principal's mention HANDLE in the registry (best-effort; the
//      boot backfill self-heals);
//   3. upserts the 1:1-linked `agent_templates` row (agent_kind='assistant' + the
//      validated assistant_config sidecar + assistant_user_id link).
//
// The principal writes live in the Better Auth `public` schema (betterAuthDb) and
// the template write in the `cinatra` schema (agent-builder pool) — NOT one atomic
// cross-DB transaction. Every step is IDEMPOTENT (resolve-before-mint;
// ON CONFLICT upserts) and best-effort at boot, exactly like the seed + handle
// backfill it replaces, so a partial run converges on the next boot.
// ---------------------------------------------------------------------------

type MintedCreds = { clientId: string; clientSecret: string };

/**
 * Register (idempotently) an assistant agent: its assistant-user principal, its
 * mention handle, and its 1:1-linked assistant `agent_templates` row. Returns
 * the principal id + the template id. THE single principal-minting entry point.
 */
export async function registerAssistantAgent(params: {
  username: string;
  config: AssistantConfig;
  name: string;
  /** Stable agent_templates row id for this built-in. Omitted for @cinatra (the
   *  store defaults to the Cinatra id); a sibling built-in (WordPress / Drupal,
   *  cinatra#1823) passes its OWN id so it persists as a distinct 1:1-linked row. */
  templateId?: string;
  /** Reserved (private) package_name for this built-in. Defaults (store-side) to
   *  the Cinatra reserved name when omitted. */
  packageName?: string;
  /** agent_templates description. */
  description?: string;
  /** agent_templates `source_nl` provenance note. Defaults (store-side) to the
   *  historical Cinatra literal when omitted, so @cinatra stays byte-identical. */
  sourceNl?: string;
}): Promise<{ assistantUserId: string; templateId: string }> {
  const { username, config, name, templateId, packageName, description, sourceNl } = params;

  // 1. Advisory-locked resolve-or-mint of the principal. The lock + the mint ride
  //    ONE betterAuthDb transaction/connection (reusing the historical seed key)
  //    so the mint is genuinely serialized.
  const { userId, mintedCreds } = await betterAuthDb.transaction(
    async (tx): Promise<{ userId: string; mintedCreds: MintedCreds | null }> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('cinatra'), hashtext('builtin-assistant-seed'))`,
      );

      const existing = await tx.execute<{ id: string }>(
        sql`SELECT id FROM public."user" WHERE username = ${username} AND "userType" = 'assistant' LIMIT 1`,
      );
      const existingRow = existing.rows[0];

      if (existingRow) {
        // Steady state — the principal exists. Repair the legacy drift where an
        // assistant user has NO matching oauthClient row (a mis-targeted legacy
        // seeder silently dropped the INSERT) by issuing a fresh pair.
        const oauthRow = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text as count FROM public."oauthClient" WHERE "userId" = ${existingRow.id}`,
        );
        if (Number(oauthRow.rows[0]?.count ?? "0") > 0) {
          return { userId: existingRow.id, mintedCreds: null };
        }
        const clientId = crypto.randomUUID();
        const clientSecret = crypto.randomUUID();
        await tx.execute(
          sql`UPDATE public."user" SET "clientId" = ${clientId}, "updatedAt" = ${new Date()} WHERE id = ${existingRow.id}`,
        );
        await insertOAuthClientWithTx(tx, {
          id: existingRow.id,
          userId: existingRow.id,
          clientId,
          clientSecret,
          name: `assistant-${username}`,
        });
        return { userId: existingRow.id, mintedCreds: { clientId, clientSecret } };
      }

      // Fresh install — mint the principal via the sole mint primitive.
      const minted = await createAssistantUserWithTx(tx, { username });
      return {
        userId: minted.id,
        mintedCreds: { clientId: minted.clientId ?? "", clientSecret: minted.clientSecret },
      };
    },
  );

  if (mintedCreds) {
    console.log(`[cinatra-assistant] Registered built-in @${username} assistant agent + principal.`);
    console.log(`  CINATRA_BUILTIN_CLIENT_ID=${mintedCreds.clientId}`);
    console.log(`  CINATRA_BUILTIN_CLIENT_SECRET=${mintedCreds.clientSecret}`);
  }

  // 2. Mint the mention handle (best-effort; boot backfill is the self-healing net).
  try {
    await registerAssistantHandle(userId, { desired: username });
  } catch (err) {
    console.warn(
      `[cinatra-assistant] could not mint handle for ${username}; boot backfill will retry:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Upsert the 1:1-linked assistant agent_templates row (idempotent). The
  //    optional templateId/packageName/description are forwarded ONLY when the
  //    caller supplies them, so the @cinatra registration keeps the store's
  //    Cinatra defaults (a sibling built-in passes its own distinct identity).
  const templateInput: Parameters<typeof upsertBuiltInAssistantAgentTemplate>[0] = {
    assistantUserId: userId,
    name,
    assistantConfigJson: serializeAssistantConfig(config),
  };
  if (templateId !== undefined) templateInput.templateId = templateId;
  if (packageName !== undefined) templateInput.packageName = packageName;
  if (description !== undefined) templateInput.description = description;
  if (sourceNl !== undefined) templateInput.sourceNl = sourceNl;
  const resolvedTemplateId = await upsertBuiltInAssistantAgentTemplate(templateInput);

  return { assistantUserId: userId, templateId: resolvedTemplateId };
}

/**
 * Register "Cinatra" as the first assistant agent (cinatra#1037 P1.3): its
 * assistant_config references the existing chat-assistant-core skill bundle (the
 * runtime parity reference, cinatraAssistantConfig). Best-effort at boot — a
 * failure must not break assistant bootstrap; the next boot converges.
 */
export async function ensureBuiltInCinatraAssistantAgent(): Promise<void> {
  try {
    await registerAssistantAgent({
      username: BUILT_IN_CINATRA_ASSISTANT_USERNAME,
      config: cinatraAssistantConfig,
      name: "Cinatra",
    });
  } catch (err) {
    console.warn(
      "[cinatra-assistant] Could not register the built-in Cinatra assistant agent:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Register the built-in WordPress assistant agent (cinatra#1823, epic #1037
 * P4.1) — a sibling of {@link ensureBuiltInCinatraAssistantAgent}. Mints its OWN
 * distinct principal + handle + 1:1-linked assistant_templates row through the
 * SAME single principal-minting path (I3, `registerAssistantAgent` — NO second
 * mint primitive), with its own distinct `wordpressAssistantConfig`. Best-effort
 * at boot: a failure must not break assistant bootstrap; the next boot converges.
 */
export async function ensureBuiltInWordpressAssistantAgent(): Promise<void> {
  try {
    await registerAssistantAgent({
      username: BUILT_IN_WORDPRESS_ASSISTANT_USERNAME,
      config: wordpressAssistantConfig,
      name: "WordPress",
      templateId: BUILT_IN_WORDPRESS_ASSISTANT_TEMPLATE_ID,
      packageName: BUILT_IN_WORDPRESS_ASSISTANT_PACKAGE_NAME,
      description: "The built-in WordPress conversational authoring assistant.",
      sourceNl: "Built-in WordPress assistant (seeded at boot).",
    });
  } catch (err) {
    console.warn(
      "[cinatra-assistant] Could not register the built-in WordPress assistant agent:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Register the built-in Drupal assistant agent (cinatra#1823, epic #1037 P4.1) —
 * a sibling of {@link ensureBuiltInCinatraAssistantAgent}. See
 * {@link ensureBuiltInWordpressAssistantAgent}; identical shape with the Drupal
 * identity + `drupalAssistantConfig`.
 */
export async function ensureBuiltInDrupalAssistantAgent(): Promise<void> {
  try {
    await registerAssistantAgent({
      username: BUILT_IN_DRUPAL_ASSISTANT_USERNAME,
      config: drupalAssistantConfig,
      name: "Drupal",
      templateId: BUILT_IN_DRUPAL_ASSISTANT_TEMPLATE_ID,
      packageName: BUILT_IN_DRUPAL_ASSISTANT_PACKAGE_NAME,
      description: "The built-in Drupal conversational authoring assistant.",
      sourceNl: "Built-in Drupal assistant (seeded at boot).",
    });
  } catch (err) {
    console.warn(
      "[cinatra-assistant] Could not register the built-in Drupal assistant agent:",
      err instanceof Error ? err.message : err,
    );
  }
}
