import "server-only";

// Assistant ADMIN REGISTRY read (cinatra#1880, Epic #1873 W5). The platform-admin
// view backing `/configuration/assistants`. Unlike the audience-filtered
// `readAssistantRegistryForActor` (the enforcement reader — hides out-of-audience
// AND paused assistants), this read is DELIBERATELY unfiltered: an admin manages
// EVERY assistant principal, including a paused one (to resume it) and one whose
// audience the admin is not personally in (to edit its audience). It is
// platform-admin gated at the call site (`requireAdminSession`).
//
// It starts from the assistant PRINCIPALS (`public."user".userType='assistant'`)
// — so standalone principals with no installed_extension row still appear and stay
// manageable — and LEFT-enriches each with its registry facets: the canonical
// resolving handle (AC#5: rows show the tag, never the raw username), origin,
// owning package, install status, declared launch/delivery, delivery-readiness,
// the manifest preferredTag + its claim state, the platform-global aliases, the
// audience grants, and the installation-wide pause flag.

import { and, eq, inArray } from "drizzle-orm";
import { pgSchema, text, jsonb } from "drizzle-orm/pg-core";
import {
  betterAuthDb,
  assistantHandles,
  assistantTagAlias,
  assistantAudience,
  listPausedAssistantIds,
  type AssistantHandleOrigin,
} from "@/lib/better-auth-db";
import {
  projectAssistantDelivery,
  type AssistantDeliveryKind,
} from "@/lib/assistant-registry-reader";
import { listAssistantUsers } from "@/lib/assistant-users";
import { readAssistantProfile } from "@/lib/assistant-profiles";
import { BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";
import { BUILT_IN_CINATRA_ASSISTANT_USERNAME } from "@/lib/assistant-users";

const CORE_STORE_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const coreStoreSchema = pgSchema(CORE_STORE_SCHEMA);

const agentTemplates = coreStoreSchema.table("agent_templates", {
  id: text("id").primaryKey(),
  name: text("name"),
  packageName: text("package_name"),
  agentKind: text("agent_kind"),
  assistantUserId: text("assistant_user_id"),
});

const installedExtension = coreStoreSchema.table("installed_extension", {
  id: text("id").primaryKey(),
  packageName: text("package_name").notNull(),
  kind: text("kind"),
  status: text("status"),
  assistantDeclaration: jsonb("assistant_declaration"),
});

const projectInstances = coreStoreSchema.table("project_instances", {
  id: text("id").primaryKey(),
  templatePackage: text("template_package"),
});

/** Launch topology of an assistant (mirrors sdk `ASSISTANT_LAUNCH_KINDS`; kept a
 *  local literal so this leaf never imports the zod-carrying parser). */
export type AssistantLaunchKind = "local" | "remote";

/** The manifest preferredTag claim state (cinatra#1880 W5). */
export type AssistantPreferredTagState =
  | "none" // no preferredTag declared (builtin / standalone with no declaration)
  | "claimed" // the alias table maps preferredTag → this package
  | "collision"; // preferredTag is owned by ANOTHER package/handle (or unclaimed) — "unclaimed — collision"

/** One admin registry row. */
export type AssistantAdminRow = {
  assistantUserId: string;
  username: string | null;
  email: string | null;
  clientId: string | null;
  /** The canonical resolving handle (AC#5 — displayed instead of the username). */
  handle: string | null;
  origin: AssistantHandleOrigin | null;
  packageName: string | null;
  displayName: string;
  isBuiltin: boolean;
  /** origin==='extension' — non-deletable (its lifecycle is package install/archive). */
  isExtensionOwned: boolean;
  /** installed_extension.status ('active'|'locked'|'archived'), or null when the
   *  principal has no install row (a standalone principal). */
  installStatus: string | null;
  launchKind: AssistantLaunchKind | null;
  /** Best-effort project-instance count for a remote assistant (else null). */
  instanceCount: number | null;
  delivery: AssistantDeliveryKind;
  /** False iff delivery is 'webhook' and no webhook URL is configured. */
  deliveryReady: boolean;
  webhookConfigured: boolean;
  preferredTag: string | null;
  preferredTagState: AssistantPreferredTagState;
  aliases: Array<{ alias: string; source: string }>;
  audience: Array<{ subjectKind: string; subjectId: string | null }>;
  paused: boolean;
};

/**
 * PURE classifier for the manifest preferredTag claim state (cinatra#1880 W5).
 * Given the declared `preferredTag`, the assistant's owning `packageName` +
 * `principalId`, and the CURRENT owners of that token across both namespace tables
 * (`aliasOwnerPackage` / `handleOwnerPrincipal`, undefined when unowned):
 *   - `none`     — no preferredTag / no package to attach it to;
 *   - `claimed`  — the alias table maps the token → THIS package;
 *   - `collision`— the token is owned by ANOTHER package's alias, or a handle of
 *                  ANOTHER principal, or is not claimed at all ("unclaimed —
 *                  collision"): the manifest's preferred tag is not this
 *                  assistant's to use.
 * Exported for unit testing without a DB.
 */
export function classifyPreferredTagState(
  preferredTag: string | null,
  packageName: string | null,
  principalId: string,
  aliasOwnerPackage: string | undefined,
  handleOwnerPrincipal: string | undefined,
): AssistantPreferredTagState {
  if (!preferredTag || !packageName) return "none";
  if (aliasOwnerPackage === packageName) return "claimed";
  if (
    (aliasOwnerPackage && aliasOwnerPackage !== packageName) ||
    (handleOwnerPrincipal && handleOwnerPrincipal !== principalId) ||
    (!aliasOwnerPackage && !handleOwnerPrincipal)
  ) {
    return "collision";
  }
  // The token is a handle of THIS principal (its own canonical tag) with no alias
  // row — treat as claimed (the principal already owns the token).
  return "claimed";
}

/** Defensively project `block.launch.kind` from a persisted declaration envelope
 *  (fail-safe: an unrecognized/absent value → null). */
export function projectLaunchKind(declaration: unknown): AssistantLaunchKind | null {
  const d = declaration as { block?: { launch?: { kind?: unknown } } } | null | undefined;
  const k = d?.block?.launch?.kind;
  return k === "local" || k === "remote" ? k : null;
}

/** Defensively project `block.preferredTag` from a persisted declaration envelope. */
export function projectPreferredTag(declaration: unknown): string | null {
  const d = declaration as { block?: { preferredTag?: unknown } } | null | undefined;
  const t = d?.block?.preferredTag;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** Defensively project `block.displayName` from a persisted declaration envelope. */
export function projectDisplayName(declaration: unknown): string | null {
  const d = declaration as { block?: { displayName?: unknown } } | null | undefined;
  const n = d?.block?.displayName;
  return typeof n === "string" && n.length > 0 ? n : null;
}

/**
 * Read the platform-admin assistant registry (all assistant principals, enriched).
 * Sorted by handle for a stable render. Platform-admin gated at the call site.
 */
export async function readAssistantAdminRegistry(): Promise<AssistantAdminRow[]> {
  const principals = await listAssistantUsers();
  if (principals.length === 0) return [];
  const principalIds = principals.map((p) => p.id);

  // Facets keyed by principal / package.
  const [handleRows, templateRows, pausedIds] = await Promise.all([
    betterAuthDb
      .select({
        assistantUserId: assistantHandles.assistantUserId,
        handle: assistantHandles.handle,
        origin: assistantHandles.origin,
        packageName: assistantHandles.packageName,
      })
      .from(assistantHandles)
      .where(inArray(assistantHandles.assistantUserId, principalIds)),
    betterAuthDb
      .select({
        assistantUserId: agentTemplates.assistantUserId,
        name: agentTemplates.name,
        packageName: agentTemplates.packageName,
      })
      .from(agentTemplates)
      .where(
        and(
          inArray(agentTemplates.assistantUserId, principalIds),
          eq(agentTemplates.agentKind, "assistant"),
        ),
      ),
    listPausedAssistantIds(principalIds),
  ]);

  const handleByPrincipal = new Map(handleRows.map((r) => [r.assistantUserId, r]));
  const templateByPrincipal = new Map(
    templateRows.filter((r) => r.assistantUserId).map((r) => [r.assistantUserId as string, r]),
  );

  // Resolve each principal's owning package: the template package (authoritative,
  // the registry projection link) else the handle package.
  const packageByPrincipal = new Map<string, string>();
  for (const p of principals) {
    const pkg =
      templateByPrincipal.get(p.id)?.packageName ?? handleByPrincipal.get(p.id)?.packageName ?? null;
    if (pkg) packageByPrincipal.set(p.id, pkg);
  }
  const packageNames = Array.from(new Set(packageByPrincipal.values()));

  // Package-keyed facets: install rows, aliases, audience grants.
  const [installRows, aliasRows, audienceRows] =
    packageNames.length === 0
      ? [[], [], []]
      : await Promise.all([
          betterAuthDb
            .select({
              packageName: installedExtension.packageName,
              status: installedExtension.status,
              declaration: installedExtension.assistantDeclaration,
            })
            .from(installedExtension)
            .where(
              and(
                inArray(installedExtension.packageName, packageNames),
                eq(installedExtension.kind, "agent"),
              ),
            ),
          betterAuthDb
            .select({
              packageName: assistantTagAlias.packageName,
              alias: assistantTagAlias.alias,
              source: assistantTagAlias.source,
            })
            .from(assistantTagAlias)
            .where(inArray(assistantTagAlias.packageName, packageNames)),
          betterAuthDb
            .select({
              packageName: assistantAudience.packageName,
              subjectKind: assistantAudience.subjectKind,
              subjectId: assistantAudience.subjectId,
            })
            .from(assistantAudience)
            .where(inArray(assistantAudience.packageName, packageNames)),
        ]);

  const installByPkg = new Map(installRows.map((r) => [r.packageName, r]));
  const aliasesByPkg = new Map<string, Array<{ alias: string; source: string }>>();
  for (const r of aliasRows) {
    const list = aliasesByPkg.get(r.packageName) ?? [];
    list.push({ alias: r.alias, source: r.source });
    aliasesByPkg.set(r.packageName, list);
  }
  const audienceByPkg = new Map<string, Array<{ subjectKind: string; subjectId: string | null }>>();
  for (const r of audienceRows) {
    const list = audienceByPkg.get(r.packageName) ?? [];
    list.push({ subjectKind: r.subjectKind, subjectId: r.subjectId });
    audienceByPkg.set(r.packageName, list);
  }

  // preferredTag claim resolution: gather declared preferredTags, then look up
  // their current owners across BOTH namespace tables to classify claim state.
  const preferredByPrincipal = new Map<string, string>();
  for (const p of principals) {
    const install = packageByPrincipal.get(p.id)
      ? installByPkg.get(packageByPrincipal.get(p.id) as string)
      : undefined;
    const pref = projectPreferredTag(install?.declaration);
    if (pref) preferredByPrincipal.set(p.id, pref);
  }
  const preferredTokens = Array.from(new Set(preferredByPrincipal.values()));
  const [aliasOwners, handleOwners] =
    preferredTokens.length === 0
      ? [[], []]
      : await Promise.all([
          betterAuthDb
            .select({ alias: assistantTagAlias.alias, packageName: assistantTagAlias.packageName })
            .from(assistantTagAlias)
            .where(inArray(assistantTagAlias.alias, preferredTokens)),
          betterAuthDb
            .select({ handle: assistantHandles.handle, assistantUserId: assistantHandles.assistantUserId })
            .from(assistantHandles)
            .where(inArray(assistantHandles.handle, preferredTokens)),
        ]);
  const aliasOwnerByToken = new Map(aliasOwners.map((r) => [r.alias, r.packageName]));
  const handleOwnerByToken = new Map(handleOwners.map((r) => [r.handle, r.assistantUserId]));

  // Best-effort project-instance count per remote package.
  const remotePackages = new Set<string>();
  for (const pkg of packageByPrincipal.values()) {
    const install = installByPkg.get(pkg);
    if (projectLaunchKind(install?.declaration) === "remote") remotePackages.add(pkg);
  }
  const instanceCountByPkg = new Map<string, number>();
  if (remotePackages.size > 0) {
    const rows = await betterAuthDb
      .select({ templatePackage: projectInstances.templatePackage })
      .from(projectInstances)
      .where(inArray(projectInstances.templatePackage, [...remotePackages]));
    for (const r of rows) {
      if (!r.templatePackage) continue;
      instanceCountByPkg.set(r.templatePackage, (instanceCountByPkg.get(r.templatePackage) ?? 0) + 1);
    }
  }

  const rows: AssistantAdminRow[] = principals.map((p) => {
    const h = handleByPrincipal.get(p.id);
    const tpl = templateByPrincipal.get(p.id);
    const packageName = packageByPrincipal.get(p.id) ?? null;
    const install = packageName ? installByPkg.get(packageName) : undefined;
    const origin: AssistantHandleOrigin | null =
      h?.origin === "extension" ? "extension" : h?.origin === "standalone" ? "standalone" : null;
    const isBuiltin =
      p.username === BUILT_IN_CINATRA_ASSISTANT_USERNAME ||
      packageName === BUILTIN_ASSISTANT_ALIAS.packageName;
    const declaration = install?.declaration ?? null;
    const delivery = projectAssistantDelivery(declaration);
    const launchKind = projectLaunchKind(declaration);
    const preferredTag = preferredByPrincipal.get(p.id) ?? null;

    const preferredTagState = classifyPreferredTagState(
      preferredTag,
      packageName,
      p.id,
      preferredTag ? aliasOwnerByToken.get(preferredTag) : undefined,
      preferredTag ? handleOwnerByToken.get(preferredTag) : undefined,
    );

    const profile = readAssistantProfile(p.id);
    const webhookConfigured = !!profile?.webhookUrl;
    const deliveryReady = delivery === "webhook" ? webhookConfigured : true;

    return {
      assistantUserId: p.id,
      username: p.username,
      email: p.email,
      clientId: p.clientId,
      handle: h?.handle ?? null,
      origin,
      packageName,
      displayName: projectDisplayName(declaration) ?? tpl?.name ?? h?.handle ?? p.username ?? p.id,
      isBuiltin,
      isExtensionOwned: origin === "extension",
      installStatus: install?.status ?? null,
      launchKind,
      instanceCount:
        launchKind === "remote" && packageName ? instanceCountByPkg.get(packageName) ?? 0 : null,
      delivery,
      deliveryReady,
      webhookConfigured,
      preferredTag,
      preferredTagState,
      aliases: (aliasesByPkg.get(packageName ?? "") ?? []).sort((a, b) => a.alias.localeCompare(b.alias)),
      audience: audienceByPkg.get(packageName ?? "") ?? [],
      paused: pausedIds.has(p.id),
    };
  });

  return rows.sort((a, b) => (a.handle ?? a.username ?? "").localeCompare(b.handle ?? b.username ?? ""));
}
