"use server";

// This file contains compatibility server actions for campaign-adjacent settings
// and provider connectors.
//
// The file intentionally stays at `src/app/campaigns/actions.ts` so existing
// importers across src/ and packages/ continue to work without path churn.
//
// The OpenAI save/clear actions are connector-owned; this file wraps the
// impls resolved from the openai `llm-provider-surface` capability at
// invocation time so existing callers keep working.

import { redirect } from "next/navigation";
import { z } from "zod";
// Every LLM-connector reader/writer/action below resolves through the
// `llm-provider-surface` capability the connectors register at activation
// (lazy/guarded host-access cutover) — never a named import.
// An absent connector degrades the specific setting with a descriptive error
// (require*) or a silent skip where the legacy behavior was already optional.
import {
  getLlmProviderSurface,
  requireLlmProviderSurface,
} from "@/lib/llm-provider-surfaces";
import { requireAuthSession, requireAdminSession, isPlatformAdmin, getActorContext } from "@/lib/auth-session";
import { updateDefaultLlmProvider } from "@/lib/admin/default-llm-provider-mutation";
import {
  getExternalMcpServerByIdFresh,
  insertExternalMcpServerStrict,
  updateExternalMcpServerGuarded,
  deleteExternalMcpServerGuarded,
  ExternalMcpServerWriteConflictError,
  type ExternalMcpServerScope,
} from "@/lib/external-mcp-registry";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";
import { randomUUID } from "node:crypto";
import { saveEmailSystemDevelopmentSettings } from "@/lib/email-system";
import { saveDevExtensionsSettings } from "@/lib/dev-extensions";
import { clearAllProviderLogEntries, saveAnthropicLoggingSettings } from "@/lib/logging";
import { saveMcpLoggingSettings } from "@/lib/mcp-logging";
import { createNotification } from "@/lib/notifications";
import { syncCatalogSkillsToAnthropic } from "@/lib/anthropic-skill-sync-service";
import { reclaimStaleAnthropicSkills } from "@/lib/anthropic-skill-gc-service";
import {
  isNangoConfigured,
  deleteNangoConnection,
  importNangoConnection,
  ensureNangoIntegration,
  saveNangoConnectionAction as _saveNangoConnectionAction,
} from "@/lib/nango-system";
import {
  listWordPressInstances,
  saveWordPressInstance,
} from "@/lib/wordpress-api";
import {
  writeDefaultImageProviderToDatabase,
  writeObjectsClassificationModelToDatabase,
  writeConnectorConfigToDatabase,
  writeAgentCreationLlmProviderToDatabase,
  writeAgentCreationModelToDatabase,
  writeAnthropicSkillSyncEnabledToDatabase,
} from "@/lib/database";
import { updateOpenAIPromptCaching } from "@/lib/openai-connection-store";

// The OpenAI save/clear/skills actions are connector-owned impls resolved
// from the openai surface's `actions` member at INVOCATION time (the
// connector's register(ctx) builds them on the same gated action cores its
// "use server" exports wrap — permission gating identical). Re-exports are
// not allowed in "use server" files (Turbopack constraint) so we use async
// wrapper functions either way; the wrappers below are the stable action
// references client forms bind.
// Setup-wizard cache invalidation stays host-side; the connector's Nango action
// is reached through the `@/lib/nango` shim (it re-exports the
// connector index), so core never names the extension directly.
import { invalidateSetupWizardCache } from "@/lib/setup-wizard";

export async function saveOpenAIConnectionAction(formData: FormData) {
  // Mirror saveNangoConnectionAction: invalidate the host-owned setup-wizard
  // cache before forwarding so the post-redirect onboarding re-read reflects the
  // freshly-saved OpenAI connection (the IoC-clean connector action never touches
  // `@/lib`). Belt-and-suspenders with isSetupWizardComplete() no longer caching
  // INCOMPLETE results — together they close the /setup redirect loop.
  invalidateSetupWizardCache();
  const save = requireLlmProviderSurface("openai").actions?.saveConnection;
  if (!save) throw new Error("The OpenAI connector exposes no save-connection action.");
  await save(formData);
}

export async function clearOpenAIConnectionAction() {
  invalidateSetupWizardCache();
  const clear = requireLlmProviderSurface("openai").actions?.clearConnection;
  if (!clear) throw new Error("The OpenAI connector exposes no clear-connection action.");
  await clear();
}

// ---------------------------------------------------------------------------
// deleteCampaignAction (stub — legacy campaign pipeline removed)
// ---------------------------------------------------------------------------

/**
 * The campaign delete action is intentionally a stub. Until @cinatra/campaigns
 * grows a native delete endpoint, this action throws a descriptive error so
 * callers get a clear signal instead of silent data loss.
 */
export async function deleteCampaignAction(_formData: FormData) {
  await requireAuthSession();
  throw new Error(
    "Campaign delete is not yet implemented. The legacy campaign pipeline was removed; " +
      "rewire to the @cinatra/campaigns MCP tools once a delete endpoint is added.",
  );
}

// ---------------------------------------------------------------------------
// OpenAI prompt-caching
// ---------------------------------------------------------------------------

export async function saveOpenAIPromptCachingAction(formData: FormData) {
  const enabled = formData.get("enabled") === "on" || formData.get("enabled") === "true";
  await updateOpenAIPromptCaching(enabled);
  redirect("/configuration/llm");
}

// ---------------------------------------------------------------------------
// Nango
// ---------------------------------------------------------------------------

export async function saveNangoConnectionAction(formData: FormData) {
  // Host-owned setup-wizard cache invalidation stays here: the connector action
  // is IoC-clean (no `@/lib` edge), and clearing before the save means the
  // post-redirect onboarding re-read reflects the freshly-saved Nango config.
  invalidateSetupWizardCache();
  return _saveNangoConnectionAction(formData);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropicConnectorSchema = z.object({
  apiKey: z.string().optional(),
});

export async function saveAnthropicConnectionAction(formData: FormData) {
  const parsed = anthropicConnectorSchema.parse({
    apiKey: formData.get("apiKey") ?? undefined,
  });
  try {
    const save = requireLlmProviderSurface("anthropic").saveAPISettings;
    if (!save) throw new Error("The Anthropic connector exposes no API-settings writer.");
    await save({ apiKey: parsed.apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save the Anthropic API connection.";
    throw new Error(message);
  }
}

export async function clearAnthropicConnectionAction() {
  await requireLlmProviderSurface("anthropic").clearAPISettings?.();
  redirect("/configuration/llm/initial-setup");
}

// `saveAnthropicSettingsAction` lives in the connector
// (extensions/cinatra-ai/anthropic-connector/src/actions.ts) and is gated with
// `requireExtensionAction("@cinatra-ai/anthropic-connector", "manage")`. The
// connector settings form binds the connector-owned action directly; no host
// wrapper is needed.

// saveAnthropicPromptCachingAction / setDefaultClaudeModelAction /
// setAnthropicMcpModeAction referenced optional fields on
// saveAnthropicAPISettings (defaultModel / promptCachingEnabled / mcpMode)
// that are not exposed by the mcp-client-connector API. Provide stubs
// that preserve the public signature; the underlying persistence layer only
// owns apiKey today.
export async function saveAnthropicPromptCachingAction(_formData: FormData) {
  redirect("/configuration/llm");
}

export async function setDefaultClaudeModelAction(_formData: FormData) {
  redirect("/configuration/llm");
}

export async function setAnthropicMcpModeAction(_formData: FormData) {
  redirect("/configuration/llm");
}

// ---------------------------------------------------------------------------
// Default provider selection
// ---------------------------------------------------------------------------

export async function setDefaultLlmProviderAction(formData: FormData) {
  // Global default LLM provider is platform-level. Route through the shared
  // chokepoint: platform-admin authority + strict-before-mutation audit + the
  // authoritative {openai,gemini} sink. (Previously this action wrote with no
  // authority check and no audit — the operator-mutation chokepoint closes that gap.)
  const provider = z.enum(["openai", "gemini"]).parse(formData.get("provider"));
  const actor = await getActorContext();
  await updateDefaultLlmProvider({ actor, provider });
  redirect("/configuration/llm");
}

export async function setDefaultImageProviderAction(formData: FormData) {
  const provider = z.string().min(1).parse(formData.get("provider"));
  writeDefaultImageProviderToDatabase(provider);
  redirect("/configuration/llm");
}

// Explicit OpenAI allow-list for the agent-creation per-purpose override. Kept
// aligned with the gpt-5 family that `packages/agents/src/agent-creation-review.ts`
// actually runs. Anthropic uses the connector's `CLAUDE_MODELS` allow-list.
const AGENT_CREATION_OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
] as const;

export async function setDefaultProvidersAction(formData: FormData) {
  // This action writes workspace-wide LLM provider/model config and the Anthropic
  // skill-upload governance opt-in (a non-ZDR data residency decision). Require
  // an admin session before any write.
  await requireAdminSession();
  // The DefaultProvidersCard posts `defaultProvider`, while other callers may
  // still post `llmProvider`. Accept both keys and prefer the card's
  // `defaultProvider`. Anthropic can never become the global default regardless
  // of input: `writeDefaultLlmProviderToDatabase` is the authoritative
  // fail-closed chokepoint.
  const llmProvider =
    (formData.get("defaultProvider") as string | null)?.trim() ||
    (formData.get("llmProvider") as string | null)?.trim();
  const imageProvider = (formData.get("imageProvider") as string | null)?.trim();
  const classificationModel = (formData.get("classificationModel") as string | null)?.trim();
  const anthropicDefaultModel = (formData.get("anthropicDefaultModel") as string | null)?.trim();
  const agentCreationProvider = (formData.get("agentCreationLlmProvider") as string | null)?.trim();
  const agentCreationModel = (formData.get("agentCreationModel") as string | null)?.trim();

  if (llmProvider) {
    // Chokepoint refuses anything outside {openai,gemini}; explicit guard kept
    // for reader clarity (the sink is still authoritative). The shared
    // `updateDefaultLlmProvider` adds the strict-before-mutation audit and a
    // defense-in-depth platform-admin re-check on top of `requireAdminSession`.
    if (llmProvider === "openai" || llmProvider === "gemini") {
      const actor = await getActorContext();
      await updateDefaultLlmProvider({ actor, provider: llmProvider });
    }
  }
  if (imageProvider) {
    writeDefaultImageProviderToDatabase(imageProvider);
  }
  if (classificationModel) {
    writeObjectsClassificationModelToDatabase(classificationModel);
  }
  // Connector-default Claude model: distinct scope from the agent-creation
  // per-purpose model below. Validated against the connector's surface
  // allow-list (absent connector → empty list → no save, degraded).
  const anthropicSurface = getLlmProviderSurface("anthropic");
  const claudeModels: readonly string[] = anthropicSurface?.models ?? [];
  if (anthropicDefaultModel && claudeModels.includes(anthropicDefaultModel)) {
    anthropicSurface?.saveDefaultModel?.(anthropicDefaultModel);
  }
  // Explicit per-purpose agent-creation override. Validate the provider and
  // that the model belongs to the chosen provider's family so we never persist
  // poisoned cross-provider config. An invalid model is dropped while the
  // provider is still saved.
  const validAgentCreationProvider =
    agentCreationProvider === "openai" || agentCreationProvider === "anthropic"
      ? agentCreationProvider
      : null;
  if (validAgentCreationProvider) {
    writeAgentCreationLlmProviderToDatabase(validAgentCreationProvider);
    // Validate the model against an explicit per-provider allow-list, not
    // "any non-Claude string", so a crafted POST cannot persist a bogus or
    // cross-provider model id. The OpenAI list is the agent-creation-relevant
    // gpt-5 family.
    //
    // Also: if the submitted model is absent/invalid for the chosen provider,
    // CLEAR the stored model rather than leaving a stale value from a previous
    // provider — otherwise switching provider could persist a mismatched
    // (provider, model) pair.
    const allowed: readonly string[] =
      validAgentCreationProvider === "anthropic"
        ? claudeModels
        : AGENT_CREATION_OPENAI_MODELS;
    if (agentCreationModel && allowed.includes(agentCreationModel)) {
      writeAgentCreationModelToDatabase(agentCreationModel);
    } else {
      // Empty string = "use the provider's adapter default"; never a stale
      // cross-provider id.
      writeAgentCreationModelToDatabase("");
    }
  }
  // The governance Switch always submits an explicit "true"/"false" string,
  // never checkbox absence. Parse exactly: never coerce a missing or garbage
  // value into a silent OFF that would erase an existing opt-in from an
  // unrelated partial post.
  const skillSyncRaw = formData.get("anthropicSkillSyncEnabled");
  if (skillSyncRaw === "true") {
    writeAnthropicSkillSyncEnabledToDatabase(true);
  } else if (skillSyncRaw === "false") {
    writeAnthropicSkillSyncEnabledToDatabase(false);
  } else if (skillSyncRaw === null) {
    // Legacy / partial caller never sent the field — leave the stored value
    // unchanged (do NOT default it OFF here).
  } else {
    throw new Error("Invalid Anthropic skill sync value.");
  }

  // Pre-sync at admin-save time, not lazily on first agent run. The settings
  // write above is already persisted; a sync failure must not roll the save
  // back, but it must be visible through an admin notification rather than
  // silent best-effort. Inert when the opt-in is OFF because the service returns
  // immediately on a non-true global flag.
  try {
    const result = await syncCatalogSkillsToAnthropic();
    if (!result.ok) {
      const detail =
        result.namespaceError ??
        result.preflightError?.message ??
        "Anthropic skill sync reported a configuration error.";
      await createNotification({
        title: "Anthropic skill sync configuration error",
        body: detail,
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill sync failed",
      body:
        "Anthropic skill sync did not complete. The provider settings were " +
        "saved. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }

  // Leased/refcounted remote GC is an explicit maintenance step, not the hot
  // agent-run path. Runs after the pre-sync above: sync marks catalog-removed
  // or excluded rows stale; GC then reclaims remote skills that have aged past
  // the grace window with zero in-flight leases. The same governance opt-in
  // controls it, so it is inert when OFF. A GC failure must not roll the settings
  // save back, but it must be visible through an admin notification.
  try {
    const gc = await reclaimStaleAnthropicSkills();
    if (!gc.ok) {
      const detail =
        gc.namespaceError ??
        (gc.errors.length > 0
          ? gc.errors
              .map((e) => `${e.anthropicSkillId}: ${e.message}`)
              .join("; ")
          : "Anthropic skill GC reported an error.");
      await createNotification({
        title: "Anthropic skill GC error",
        body: detail,
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill GC failed",
      body:
        "Anthropic skill garbage collection did not complete. The provider " +
        "settings were saved and no skill was over-deleted. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }

  redirect("/configuration/llm");
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

export async function clearYouTubeConnectionAction() {
  if (isNangoConfigured()) {
    await deleteNangoConnection("youtube", "cinatra-youtube").catch(() => null);
  }
  writeConnectorConfigToDatabase("youtube_connection", null);
  redirect("/configuration/llm");
}

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------

const wordpressSchema = z.object({
  id: z.string().optional(),
  siteUrl: z.string().min(1),
  username: z.string().min(1),
  applicationPassword: z.string().min(1),
  // Optional vendor-scoped blog-connector binding. When the form field is absent
  // or empty, the save path inherits the existing instance's value (see
  // `saveWordPressInstance`); pass an explicit value ("default" / a named site
  // connector id) to switch the binding.
  blogConnectorId: z.string().optional(),
});

export async function saveWordPressInstanceAction(formData: FormData) {
  // Admin gate + identity capture in one step. The configuring admin's
  // {orgId, runBy} is persisted as the install→org binding (cinatra#274) so a
  // host-initiated content-editor write for THIS install executes as the
  // admin's org/user instead of the single-tenant default.
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId?.trim() || undefined;
  const runBy = session.user.id?.trim() || undefined;
  const parsed = wordpressSchema.parse({
    id: (formData.get("id") as string | null) ?? undefined,
    siteUrl: formData.get("siteUrl"),
    username: formData.get("username"),
    applicationPassword: formData.get("applicationPassword"),
    blogConnectorId: (formData.get("blogConnectorId") as string | null) ?? undefined,
  });
  await saveWordPressInstance({
    id: parsed.id?.trim() || randomUUID(),
    siteUrl: parsed.siteUrl,
    username: parsed.username,
    applicationPassword: parsed.applicationPassword,
    blogConnectorId: parsed.blogConnectorId,
    orgId,
    runBy,
  });
  redirect("/configuration/llm");
}

// `deleteWordPressInstanceAction` lives in the wordpress connector
// (manage-gated) — the legacy host page imports it directly from
// @cinatra-ai/wordpress-mcp-connector/setup-actions. There is no hub forwarder.

// Focused server action for the WordPress connection-UI blog-connector selector.
// Does not require the application password because a connector-only change must
// not force a credential re-entry and network revalidation. Writes the JSON-blob
// binding directly.
const wordpressBlogConnectorSchema = z.object({
  instanceId: z.string().min(1),
  blogConnectorId: z.string().optional(),
});

export async function setWordPressBlogConnectorAction(formData: FormData) {
  // WordPress connector_config is operator/workspace-level config, not per-user.
  // Admin-gate the binding mutation, consistent with the other connector-config
  // mutation actions in this file.
  await requireAdminSession();
  const parsed = wordpressBlogConnectorSchema.parse({
    instanceId: formData.get("instanceId"),
    blogConnectorId: (formData.get("blogConnectorId") as string | null) ?? undefined,
  });
  const { setWordPressInstanceBlogConnector } = await import("@/lib/wordpress-api");
  setWordPressInstanceBlogConnector(parsed.instanceId, parsed.blogConnectorId ?? "");
  redirect("/connectors/wordpress");
}

// ---------------------------------------------------------------------------
// External MCP servers
// ---------------------------------------------------------------------------

// The external-MCP management UI moved to the "MCP Servers" connector's setup
// page (cinatra#612). These host actions still OWN the admin-authorization
// boundary + the post-write redirect; they redirect back to the connector
// setup page (where the saved/deleted banner renders) instead of the retired
// /configuration/llm modal. Falls back to /configuration/llm if the connector
// is somehow absent from the catalog.
function externalMcpRedirectBase(): string {
  return getConnectorSetupHref("mcp-server-connector") ?? "/configuration/llm";
}

const externalMcpSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  serverUrl: z.string().min(1),
  scope: z.enum(["global", "user"]).optional(),
});

export async function createExternalMcpServerAction(formData: FormData) {
  const parsed = externalMcpSchema.parse({
    id: (formData.get("id") as string | null) ?? undefined,
    label: formData.get("label") ?? formData.get("name"),
    serverUrl: formData.get("serverUrl") ?? formData.get("url"),
    scope: (formData.get("scope") as string | null) ?? "global",
  });
  const scope: ExternalMcpServerScope = parsed.scope === "user" ? "user" : "global";

  // Authorization boundary. Global external MCP rows are injected into every LLM call's
  // MCP toolbox with `requireApproval: "never"` — a global write is a
  // platform-wide trust mutation and MUST require platform admin. The default
  // scope is "global", so the unauthenticated/non-admin default path is
  // admin-gated. User-scoped rows only require an authenticated actor, and are
  // bound to that actor's own userId.
  const session =
    scope === "user" ? await requireAuthSession() : await requireAdminSession();

  // ID-overwrite guard. An attacker-supplied existing `id` must not let a
  // user-scoped write overwrite a global row (or another user's row). Re-derive
  // the authority required from the EXISTING row's scope/owner, not just the
  // requested scope, and deny cross-actor / cross-scope id reuse.
  //
  // TOCTOU hardening (Refs cinatra#658): the authorization read is FRESH
  // (`getExternalMcpServerByIdFresh` — bypasses the 30s in-process TTL cache that
  // `getExternalMcpServerById` serves from, which could otherwise return a row
  // whose scope/owner changed on another worker), and the write is CONDITIONAL on
  // the row STILL matching the witnessed scope+owner
  // (`updateExternalMcpServerGuarded` for an existing row;
  // `insertExternalMcpServerStrict` for a new id, which never clobbers a
  // concurrently-created row). A race that flips the row under the actor is
  // refused (fail-closed) rather than applied.
  const requestedId = parsed.id?.trim() || undefined;
  let guard: { scope: ExternalMcpServerScope; userId: string | null } | undefined;
  let preservedUserId: string | null | undefined;
  if (requestedId) {
    const existing = getExternalMcpServerByIdFresh(requestedId);
    if (existing) {
      if (existing.scope === "global") {
        // Touching an existing global row always requires platform admin,
        // regardless of the scope the caller requested.
        await requireAdminSession();
      } else {
        // Non-global existing row: owner (same userId) or platform admin only.
        const actorIsAdmin = isPlatformAdmin(session);
        const actorOwnsRow =
          existing.userId !== null && existing.userId === session.user.id;
        if (!actorIsAdmin && !actorOwnsRow) {
          redirect("/not-authorized");
        }
        // A non-admin must not re-scope an existing user row to global.
        if (scope === "global" && !actorIsAdmin) {
          redirect("/not-authorized");
        }
        // Preserve the existing owner of a user row on overwrite — an admin edit
        // must never silently reassign ownership to the admin (mirrors the
        // connector-setup handler's `preservedUserId`).
        if (existing.scope === "user" && scope === "user") {
          preservedUserId = existing.userId;
        }
      }
      // The compare-and-write guard is the WITNESSED existing scope+owner.
      guard = { scope: existing.scope, userId: existing.userId };
    }
  }

  const row = {
    id: requestedId || randomUUID(),
    label: parsed.label,
    serverUrl: parsed.serverUrl,
    scope,
    nangoConnectionId: null,
    orgId: null,
    userId: scope === "user" ? preservedUserId ?? session.user.id : null,
    enabled: true,
  };
  try {
    if (guard) {
      updateExternalMcpServerGuarded(row, guard);
    } else {
      insertExternalMcpServerStrict(row);
    }
  } catch (err) {
    if (err instanceof ExternalMcpServerWriteConflictError) {
      // The row changed under the authorized operation (TOCTOU race) → deny.
      redirect("/not-authorized");
    }
    throw err;
  }
  redirect(`${externalMcpRedirectBase()}?saved=1`);
}

export async function deleteExternalMcpServerAction(formData: FormData) {
  const id = z.string().min(1).parse(formData.get("id"));
  // Authorization boundary. The delete path had NO authz guard at all. Require platform admin to delete
  // a global row, and owner-or-admin for a user-scoped row. Fail closed.
  //
  // TOCTOU hardening (Refs cinatra#658): authorize against a FRESH read (not the
  // 30s TTL cache) and delete CONDITIONALLY on the witnessed scope+owner so a row
  // promoted/re-owned between read and delete fails closed instead of being
  // deleted under the actor's stale view.
  const session = await requireAuthSession();
  const server = getExternalMcpServerByIdFresh(id);
  if (!server) {
    redirect(externalMcpRedirectBase());
  }
  if (server.scope === "global") {
    await requireAdminSession();
  } else {
    const actorIsAdmin = isPlatformAdmin(session);
    const actorOwnsRow =
      server.userId !== null && server.userId === session.user.id;
    if (!actorIsAdmin && !actorOwnsRow) {
      redirect("/not-authorized");
    }
  }
  try {
    deleteExternalMcpServerGuarded(id, { scope: server.scope, userId: server.userId });
  } catch (err) {
    if (err instanceof ExternalMcpServerWriteConflictError) {
      // The row changed/vanished under the authorized delete (TOCTOU race) → deny.
      redirect("/not-authorized");
    }
    throw err;
  }
  redirect(`${externalMcpRedirectBase()}?deleted=1`);
}

// GitHub connection actions are connector-owned (@cinatra-ai/github-connector/actions),
// imported relative by the connector's own settings-page. There are no host
// forwarders here.

// ---------------------------------------------------------------------------
// Development logging
// ---------------------------------------------------------------------------

export async function saveDevelopmentLoggingAction(formData: FormData) {
  const anthropicLoggingEnabled =
    formData.get("anthropicLoggingEnabled") === "on" ||
    formData.get("anthropicLoggingEnabled") === "true";
  const openAiLoggingEnabled =
    formData.get("openAiLoggingEnabled") === "on" ||
    formData.get("openAiLoggingEnabled") === "true";
  const mcpLoggingEnabled =
    formData.get("mcpLoggingEnabled") === "on" ||
    formData.get("mcpLoggingEnabled") === "true";
  const geminiLoggingEnabled =
    formData.get("geminiLoggingEnabled") === "on" ||
    formData.get("geminiLoggingEnabled") === "true";
  const apolloLoggingEnabled =
    formData.get("apolloLoggingEnabled") === "on" ||
    formData.get("apolloLoggingEnabled") === "true";

  // Connector logging writers resolve from the live surfaces; an absent
  // connector's toggle is skipped (its row is not rendered on the telemetry
  // page either — degraded symmetrically).
  await Promise.all([
    saveAnthropicLoggingSettings(anthropicLoggingEnabled),
    getLlmProviderSurface("openai")?.saveLoggingSettings?.(openAiLoggingEnabled),
    saveMcpLoggingSettings({ serverEnabled: mcpLoggingEnabled, clientEnabled: mcpLoggingEnabled }),
    getLlmProviderSurface("gemini")?.saveLoggingSettings?.(geminiLoggingEnabled),
    getLlmProviderSurface("apollo")?.saveLoggingSettings?.(apolloLoggingEnabled),
  ]);
  redirect("/configuration/development");
}

export async function clearDevelopmentLogEntriesAction() {
  await clearAllProviderLogEntries();
  redirect("/configuration/development");
}

export async function saveEmailSystemDevelopmentSettingsAction(formData: FormData) {
  // The form posts the field name `developmentModeEnabled`, matching the checkbox
  // `name=` attribute in src/app/configuration/development/page.tsx. Read that
  // exact field so the toggle round-trips.
  const enabled =
    formData.get("developmentModeEnabled") === "on" ||
    formData.get("developmentModeEnabled") === "true";
  const overrideRecipientEmail = (formData.get("overrideRecipientEmail") as string | null)?.trim() ?? undefined;
  await saveEmailSystemDevelopmentSettings({
    developmentModeEnabled: enabled,
    overrideRecipientEmail,
  });
  redirect("/configuration/development");
}

// Vendor-delegation instance-side override. Server-side gate by admin and by
// runtime mode; the client UI also disables the form when !isDevMode, but the
// action never trusts the client. Throws (which the form wrapper surfaces as a
// notification toast) on either gate failure.
export async function saveDevExtensionsSettingsAction(formData: FormData) {
  await requireAdminSession();
  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error("Publish scope override can only be changed in development mode.");
  }
  const raw = (formData.get("publishScopeOverride") as string | null)?.trim() ?? null;
  saveDevExtensionsSettings({
    publishScopeOverride: raw && raw.length > 0 ? raw : null,
  });
  redirect("/configuration/development?tab=extensions");
}

// ---------------------------------------------------------------------------
// OpenAI Skills administration
// ---------------------------------------------------------------------------

export async function saveOpenAISkillsSettingsAction(formData: FormData) {
  const save = requireLlmProviderSurface("openai").actions?.saveSkillsSettings;
  if (!save) throw new Error("The OpenAI connector exposes no skills-settings action.");
  await save(formData);
}

// Gmail send-as refresh/clear + Google Calendar appointment-schedule mutations
// are owned by the connectors: the manage-gated extension actions
// (gmail-connector/src/actions.ts +
// google-calendar-connector/src/setup-actions.ts, each
// `requireExtensionAction(pkg,"manage")`-first) are the ONLY path. Likewise the
// Google OAuth client-credential save lives in
// google-oauth-connector/src/actions.ts behind the same manage gate. No
// lower-privilege copies live here, so there is no reach-around to the same
// mutations.

// Silence unused-import warnings for helpers kept as safety shims.
void listWordPressInstances;
void createNotification;
void importNangoConnection;
void ensureNangoIntegration;
