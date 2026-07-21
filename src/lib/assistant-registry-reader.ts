// Assistant REGISTRY READER (cinatra#1874, Epic #1873 W1 — item 6).
//
// The audience-filtered read side of the assistant registry. It resolves the set
// of assistants a given actor may SEE:
//
//   installed_extension(kind='agent', status ∈ {active,locked}, assistant_declaration
//     NOT NULL)                                        -- the installed assistants
//   ⋈ agent_templates(package_name, agent_kind='assistant')   -- the projected config + 1:1 principal link
//   ⋈ assistant_handles(assistant_user_id)                    -- the mention handle (principal)
//   ⋈ assistant_tag_alias(package_name)                       -- the flat-token aliases (0..n)
//   ∪ the builtin Cinatra descriptor                          -- always present (the platform assistant)
//
// …then filters that set to the actor's AUDIENCE. Every installed assistant is
// gated by its `assistant_audience` rows (W1 persists the grants; the reader is
// the first consumer). The builtin Cinatra descriptor is the platform assistant —
// unioned in UNCONDITIONALLY (it carries no audience rows and is visible to all).
//
// Two invariants the reader enforces (AC#5):
//   * ARCHIVE hides the entry: an `archived` installed_extension drops out of the
//     candidate set (status filter), yet its principal (assistant_handles row) and
//     dormant `agent_templates` row survive untouched for attribution. An
//     uninstalled package is therefore invisible while its principal survives.
//   * BARE-NAME FALLBACK excludes `origin='extension'`: resolving a bare mention
//     name to a principal must NEVER resurrect an uninstalled extension through its
//     surviving handle row — {@link resolveAssistantBareName} filters those out.
//
// This module is a DB-layer leaf: its STATIC imports are ONLY `better-auth-db`
// (the core-store drizzle handles + the team/project predicates) + drizzle, so it
// stays cheap to load and unit-testable. The four membership seams the #1874 spec
// names (admin/organization/team/project) are wired as the DEFAULT deps of
// {@link resolveAssistantAudienceContext}. The `organization` seam uses the EXACT
// spec-named `resolveOrgRoleForUser` (membership ⟺ a DEFINED org role — stricter
// than a bare row-existence check, which would grant membership on an unknown/null
// role); it lives in the heavier `auth-session` graph, so the default imports it
// LAZILY to keep this leaf's static import graph light.

import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { pgSchema, text, jsonb } from "drizzle-orm/pg-core";
import {
  betterAuthDb,
  assistantHandles,
  assistantTagAlias,
  assistantAudience,
  normalizeAssistantHandle,
  readTeamsForUser,
  readProjectGrantsForUser,
  type AssistantHandleOrigin,
  type ProjectGrantHints,
} from "@/lib/better-auth-db";
import { BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";

// ---------------------------------------------------------------------------
// Core-store drizzle handles for the two tables the reader joins that are NOT
// already exported by `better-auth-db`. Same schema-name derivation as
// `better-auth-db`'s `coreStoreSchema` (read INLINE from the environment, per that
// module's documented convention) so both resolve to the identical schema-
// qualified names in one query. Only the columns the reader reads are declared.
// ---------------------------------------------------------------------------
const CORE_STORE_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const coreStoreSchema = pgSchema(CORE_STORE_SCHEMA);

const agentTemplates = coreStoreSchema.table("agent_templates", {
  id: text("id").primaryKey(),
  name: text("name"),
  packageName: text("package_name"),
  agentKind: text("agent_kind"),
  assistantConfig: text("assistant_config"),
  assistantUserId: text("assistant_user_id"),
  status: text("status"),
});

const installedExtension = coreStoreSchema.table("installed_extension", {
  id: text("id").primaryKey(),
  packageName: text("package_name").notNull(),
  kind: text("kind"),
  status: text("status"),
  assistantDeclaration: jsonb("assistant_declaration"),
});

/** The install states in which an installed extension is "live" (visible). An
 *  `archived` row is deliberately excluded — archive hides the entry. */
export const VISIBLE_INSTALL_STATUSES = ["active", "locked"] as const;

// ---------------------------------------------------------------------------
// Audience context + matching (pure).
// ---------------------------------------------------------------------------

/** The resolved audience footprint of an actor: the memberships against which an
 *  assistant's `assistant_audience` rows are matched. Sets for O(1) membership. */
export type AssistantAudienceContext = {
  userId: string;
  /** Platform admin (the `admin` audience kind). */
  isPlatformAdmin: boolean;
  /** Organizations the actor is a current member of (the `organization` kind). */
  orgIds: Set<string>;
  /** Teams the actor belongs to within the active org (the `team` kind). */
  teamIds: Set<string>;
  /** Projects the actor has a grant on within the active org (the `project` kind). */
  projectIds: Set<string>;
};

/** One `assistant_audience` grant row (the subset the matcher reads). */
export type AssistantAudienceGrant = {
  subjectKind: string;
  subjectId: string | null;
};

/**
 * Does the actor's audience context satisfy ANY of an assistant's grant rows?
 * `workspace` is the universal grant (every authenticated actor within the
 * workspace/tenant); `admin` requires platform admin; `organization`/`team`/
 * `project` require the subject id to be in the corresponding membership set. An
 * assistant with NO grant rows is invisible to everyone (fail-closed) — except the
 * builtin Cinatra descriptor, which the reader unions in unconditionally.
 */
export function matchesAssistantAudience(
  grants: readonly AssistantAudienceGrant[],
  ctx: AssistantAudienceContext,
): boolean {
  for (const g of grants) {
    switch (g.subjectKind) {
      case "workspace":
        return true;
      case "admin":
        if (ctx.isPlatformAdmin) return true;
        break;
      case "organization":
        if (g.subjectId && ctx.orgIds.has(g.subjectId)) return true;
        break;
      case "team":
        if (g.subjectId && ctx.teamIds.has(g.subjectId)) return true;
        break;
      case "project":
        if (g.subjectId && ctx.projectIds.has(g.subjectId)) return true;
        break;
      // Unknown kinds never grant visibility (fail-closed).
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Audience-context resolution — the four membership seams (#1874 spec).
// ---------------------------------------------------------------------------

/** The membership seams the resolver depends on (injectable for tests). Defaults
 *  wire the four existing predicates the #1874 spec names. */
export type AssistantAudienceContextDeps = {
  /** organization → membership in the actor's active org. */
  isOrgMember(userId: string, orgId: string): Promise<boolean>;
  /** team → the teams the actor belongs to within the active org. */
  readTeamsForUser(userId: string, orgId: string): Promise<Array<{ id: string }>>;
  /** project → the project grants the actor holds within the active org. */
  readProjectGrantsForUser(
    userId: string,
    actorOrgId: string,
    hints: ProjectGrantHints,
  ): Promise<Array<{ projectId: string }>>;
};

export const DEFAULT_AUDIENCE_CONTEXT_DEPS: AssistantAudienceContextDeps = {
  // The #1874-named `organization` seam. Membership ⟺ a DEFINED org role
  // (owner/admin/member) — so an unknown/null role does NOT grant membership.
  // Imported lazily so this DB-layer leaf keeps the auth-session/request graph out
  // of its static import chain.
  isOrgMember: async (userId, orgId) => {
    const { resolveOrgRoleForUser } = await import("@/lib/auth-session");
    return (await resolveOrgRoleForUser(orgId, userId)) !== undefined;
  },
  readTeamsForUser,
  readProjectGrantsForUser,
};

/**
 * Resolve an actor's {@link AssistantAudienceContext} from the four membership
 * seams, scoped to the actor's ACTIVE org (team/project grants are org-anchored;
 * an actor only "sees" audience grants for the org they are currently acting in —
 * consistent with the existing directory tenant-scoping). `isPlatformAdmin` is
 * supplied by the caller (the pure session predicate) so this DB leaf stays free
 * of the request/session graph.
 */
export async function resolveAssistantAudienceContext(
  actor: { userId: string; activeOrgId: string | null; isPlatformAdmin: boolean },
  deps: AssistantAudienceContextDeps = DEFAULT_AUDIENCE_CONTEXT_DEPS,
): Promise<AssistantAudienceContext> {
  const { userId, activeOrgId, isPlatformAdmin } = actor;
  const orgIds = new Set<string>();
  const teamIds = new Set<string>();
  const projectIds = new Set<string>();

  if (activeOrgId && (await deps.isOrgMember(userId, activeOrgId))) {
    orgIds.add(activeOrgId);
    const teams = await deps.readTeamsForUser(userId, activeOrgId);
    for (const t of teams) teamIds.add(t.id);
    const grants = await deps.readProjectGrantsForUser(userId, activeOrgId, {
      teamIds: [...teamIds],
    });
    for (const g of grants) projectIds.add(g.projectId);
  }

  return { userId, isPlatformAdmin, orgIds, teamIds, projectIds };
}

// ---------------------------------------------------------------------------
// The reader.
// ---------------------------------------------------------------------------

/** One visible assistant registry entry. */
export type AssistantRegistryEntry = {
  packageName: string;
  templateId: string;
  assistantUserId: string;
  /** The authoritative mention handle (registry principal). */
  handle: string;
  displayName: string;
  origin: AssistantHandleOrigin;
  /** The flat-token aliases claimed by this package (sorted, deduped). */
  aliases: string[];
  /** True for the boot-seeded builtin Cinatra descriptor (unconditionally visible). */
  isBuiltin: boolean;
};

type CandidateRow = {
  packageName: string;
  templateId: string;
  displayName: string | null;
  assistantUserId: string | null;
  handle: string;
  origin: string | null;
};

/** Minimal drizzle read surface (injectable — the default is `betterAuthDb`). */
type ReaderDb = Pick<typeof betterAuthDb, "select">;

function toEntry(row: CandidateRow, aliases: string[], isBuiltin: boolean): AssistantRegistryEntry {
  return {
    packageName: row.packageName,
    templateId: row.templateId,
    assistantUserId: row.assistantUserId ?? "",
    handle: row.handle,
    displayName: row.displayName ?? row.handle,
    origin: row.origin === "extension" ? "extension" : "standalone",
    aliases: [...aliases].sort(),
    isBuiltin,
  };
}

/**
 * Read the assistant registry for an actor: the installed assistants whose
 * audience the actor satisfies, UNION the always-visible builtin Cinatra
 * descriptor. Deduped by package_name (the builtin never double-counts if it is
 * also, unexpectedly, an installed row). Sorted by handle for a stable result.
 */
export async function readAssistantRegistryForActor(
  ctx: AssistantAudienceContext,
  db: ReaderDb = betterAuthDb,
): Promise<AssistantRegistryEntry[]> {
  // 1. Installed assistant candidates (active|locked, declaration NOT NULL) ⋈
  //    agent_templates(assistant) ⋈ principal handle.
  const installed: CandidateRow[] = await db
    .select({
      packageName: installedExtension.packageName,
      templateId: agentTemplates.id,
      displayName: agentTemplates.name,
      assistantUserId: agentTemplates.assistantUserId,
      handle: assistantHandles.handle,
      origin: assistantHandles.origin,
    })
    .from(installedExtension)
    .innerJoin(
      agentTemplates,
      and(
        eq(agentTemplates.packageName, installedExtension.packageName),
        eq(agentTemplates.agentKind, "assistant"),
      ),
    )
    .innerJoin(
      assistantHandles,
      eq(assistantHandles.assistantUserId, agentTemplates.assistantUserId),
    )
    .where(
      and(
        eq(installedExtension.kind, "agent"),
        inArray(installedExtension.status, [...VISIBLE_INSTALL_STATUSES]),
        isNotNull(installedExtension.assistantDeclaration),
      ),
    );

  // 2. The builtin Cinatra descriptor — ALWAYS visible (no audience gate). Its
  //    principal + template exist (boot-seeded) with the reserved package name;
  //    it has NO installed_extension row, so it is fetched separately.
  const builtinRaw = await db
    .select({
      templateId: agentTemplates.id,
      displayName: agentTemplates.name,
      assistantUserId: agentTemplates.assistantUserId,
      handle: assistantHandles.handle,
      origin: assistantHandles.origin,
    })
    .from(agentTemplates)
    .innerJoin(
      assistantHandles,
      eq(assistantHandles.assistantUserId, agentTemplates.assistantUserId),
    )
    .where(
      and(
        eq(agentTemplates.packageName, BUILTIN_ASSISTANT_ALIAS.packageName),
        eq(agentTemplates.agentKind, "assistant"),
      ),
    );
  // package_name is the reserved builtin constant (the WHERE pins it).
  const builtin: CandidateRow[] = builtinRaw.map((r) => ({
    ...r,
    packageName: BUILTIN_ASSISTANT_ALIAS.packageName,
  }));

  const packageNames = Array.from(
    new Set([...installed, ...builtin].map((r) => r.packageName)),
  );
  if (packageNames.length === 0) return [];

  // 3. Aliases + audience grants for the candidate packages.
  const [aliasRows, audienceRows] = await Promise.all([
    db
      .select({ packageName: assistantTagAlias.packageName, alias: assistantTagAlias.alias })
      .from(assistantTagAlias)
      .where(inArray(assistantTagAlias.packageName, packageNames)),
    db
      .select({
        packageName: assistantAudience.packageName,
        subjectKind: assistantAudience.subjectKind,
        subjectId: assistantAudience.subjectId,
      })
      .from(assistantAudience)
      .where(inArray(assistantAudience.packageName, packageNames)),
  ]);

  const aliasesByPkg = new Map<string, string[]>();
  for (const r of aliasRows) {
    const list = aliasesByPkg.get(r.packageName) ?? [];
    list.push(r.alias);
    aliasesByPkg.set(r.packageName, list);
  }
  const grantsByPkg = new Map<string, AssistantAudienceGrant[]>();
  for (const r of audienceRows) {
    const list = grantsByPkg.get(r.packageName) ?? [];
    list.push({ subjectKind: r.subjectKind, subjectId: r.subjectId });
    grantsByPkg.set(r.packageName, list);
  }

  // 4. Audience-filter the installed set; union the always-visible builtin. Dedupe
  //    by package_name (builtin wins the isBuiltin flag).
  const byPkg = new Map<string, AssistantRegistryEntry>();
  for (const row of installed) {
    if (matchesAssistantAudience(grantsByPkg.get(row.packageName) ?? [], ctx)) {
      byPkg.set(row.packageName, toEntry(row, aliasesByPkg.get(row.packageName) ?? [], false));
    }
  }
  for (const row of builtin) {
    byPkg.set(row.packageName, toEntry(row, aliasesByPkg.get(row.packageName) ?? [], true));
  }

  return Array.from(byPkg.values()).sort((a, b) => a.handle.localeCompare(b.handle));
}

// ---------------------------------------------------------------------------
// Bare-name fallback resolution (EXCLUDES origin='extension').
// ---------------------------------------------------------------------------

/**
 * Resolve a bare mention name to an assistant principal id via its registry
 * handle, EXCLUDING `origin='extension'` rows. An uninstalled extension's handle
 * row survives (for attribution) but must NOT be resolvable by bare name — that
 * would resurrect an uninstalled package through a stale handle. Exact aliases /
 * handles claimed through the namespace primitive resolve elsewhere; THIS is the
 * loose bare-name fallback only. Returns the principal id, or null when nothing
 * matches (or the name normalizes to nothing).
 */
export async function resolveAssistantBareName(
  name: string,
  db: ReaderDb = betterAuthDb,
): Promise<string | null> {
  const normalized = normalizeAssistantHandle(name);
  if (!normalized) return null;
  const rows = await db
    .select({ id: assistantHandles.assistantUserId })
    .from(assistantHandles)
    .where(
      and(
        eq(assistantHandles.handle, normalized),
        ne(assistantHandles.origin, "extension"),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}
