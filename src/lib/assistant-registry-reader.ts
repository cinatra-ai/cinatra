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
// Assistant DELIVERY channel (cinatra#1875 W2, Epic #1873 — AC#2). The declared
// delivery of an assistant's turns, projected from the persisted
// `installed_extension.assistant_declaration.block.delivery.kind`. Kept as a
// LOCAL closed literal (mirrors the SINGLE source in
// `@cinatra-ai/sdk-extensions/assistant-declaration` — `ASSISTANT_DELIVERY_KINDS`)
// so this DB-layer read leaf never pulls the zod-carrying declaration parser into
// its static import graph. `host-runtime` is the platform default: the builtin
// Cinatra descriptor (no declaration) and any malformed/absent delivery block
// fail SAFE to the local host runtime — never to an external push channel.
// ---------------------------------------------------------------------------

/** The declared delivery channel of an assistant's turns. */
export type AssistantDeliveryKind = "host-runtime" | "webhook" | "mcp-poll";
const DELIVERY_KINDS: ReadonlySet<AssistantDeliveryKind> = new Set([
  "host-runtime",
  "webhook",
  "mcp-poll",
]);
/** The platform default when no (or a malformed) delivery is declared. */
export const DEFAULT_ASSISTANT_DELIVERY: AssistantDeliveryKind = "host-runtime";

/** The only `assistant_declaration.formatVersion` this projection recognizes —
 *  mirrors `ASSISTANT_DECLARATION_FORMAT_VERSION` in the sdk parser (kept local so
 *  this DB-layer leaf never imports the zod-carrying parser). An unrecognized /
 *  absent version fails SAFE (host-runtime), never to an external push channel. */
const RECOGNIZED_DECLARATION_FORMAT_VERSION = 1;

/**
 * Project the delivery channel from a persisted `assistant_declaration` jsonb
 * value. The install-time parser validates + stamps the envelope
 * (`{ formatVersion, block, assistantConfig }`, fail-closed), so an installed row
 * carries a well-formed, versioned declaration. This reader is FAIL-SAFE and
 * DEFENSIVE for the hot read path: it honors an EXTERNAL delivery kind
 * (`webhook` / `mcp-poll`) ONLY when the envelope is a RECOGNIZED-version
 * declaration whose `block.delivery.kind` is a known kind. A builtin (no
 * declaration), a partial/corrupt jsonb, an unsupported future `formatVersion`,
 * or an unknown kind all resolve to the host-runtime default — a schema drift can
 * never silently escalate a turn onto an out-of-band push.
 */
export function projectAssistantDelivery(declaration: unknown): AssistantDeliveryKind {
  const d = declaration as
    | { formatVersion?: unknown; block?: { delivery?: { kind?: unknown } } }
    | null
    | undefined;
  if (!d || d.formatVersion !== RECOGNIZED_DECLARATION_FORMAT_VERSION) {
    return DEFAULT_ASSISTANT_DELIVERY;
  }
  const kind = d.block?.delivery?.kind;
  return typeof kind === "string" && DELIVERY_KINDS.has(kind as AssistantDeliveryKind)
    ? (kind as AssistantDeliveryKind)
    : DEFAULT_ASSISTANT_DELIVERY;
}

// ---------------------------------------------------------------------------
// Assistant LAUNCH topology (cinatra#1878 W3, AC#1/#3/#4). `local` runs on the
// host runtime; `remote` proxies to a first-party `targetProvider` resolver (a
// connected site). This is the DECLARED kind the /chat path codec disambiguates
// the third segment by (instance for `remote`, titleSlug for `local`) — never a
// format-sniff. Projected from `installed_extension.assistant_declaration`,
// FAIL-SAFE to `local` (the builtin Cinatra descriptor + any malformed/absent
// launch block resolve to a host-local assistant, never an accidental remote).
// Kept as LOCAL closed literals so this DB-layer read leaf never pulls the
// zod-carrying declaration parser into its static import graph (mirrors
// ASSISTANT_LAUNCH_KINDS in `@cinatra-ai/sdk-extensions/assistant-declaration`).
// ---------------------------------------------------------------------------

/** The declared launch topology of an assistant. */
export type AssistantLaunchKind = "local" | "remote";
const LAUNCH_KINDS: ReadonlySet<AssistantLaunchKind> = new Set(["local", "remote"]);
/** The platform default when no (or a malformed) launch is declared. */
export const DEFAULT_ASSISTANT_LAUNCH_KIND: AssistantLaunchKind = "local";

/** The projected launch descriptor — the kind plus, for `remote`, the first-party
 *  `targetProvider` id the remote-target resolver keys on (never a manifest URL). */
export type AssistantLaunch = {
  kind: AssistantLaunchKind;
  targetProvider: string | null;
};

/**
 * Project the launch topology from a persisted `assistant_declaration` jsonb
 * value. FAIL-SAFE + defensive for the hot read path: a builtin (no
 * declaration), a partial/corrupt jsonb, an unsupported future `formatVersion`,
 * or an unknown kind all resolve to `{ kind: "local", targetProvider: null }` —
 * a schema drift can never silently turn a thread into a remote proxy.
 */
export function projectAssistantLaunch(declaration: unknown): AssistantLaunch {
  const d = declaration as
    | { formatVersion?: unknown; block?: { launch?: { kind?: unknown; targetProvider?: unknown } } }
    | null
    | undefined;
  if (!d || d.formatVersion !== RECOGNIZED_DECLARATION_FORMAT_VERSION) {
    return { kind: DEFAULT_ASSISTANT_LAUNCH_KIND, targetProvider: null };
  }
  const kind = d.block?.launch?.kind;
  const resolvedKind =
    typeof kind === "string" && LAUNCH_KINDS.has(kind as AssistantLaunchKind)
      ? (kind as AssistantLaunchKind)
      : DEFAULT_ASSISTANT_LAUNCH_KIND;
  const tp = d.block?.launch?.targetProvider;
  return {
    kind: resolvedKind,
    // targetProvider is only meaningful for a remote launch.
    targetProvider: resolvedKind === "remote" && typeof tp === "string" && tp.length > 0 ? tp : null,
  };
}

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
  /** The declared delivery channel of this assistant's turns (cinatra#1875 W2,
   *  AC#2). Projected from `installed_extension.assistant_declaration`; the
   *  builtin Cinatra descriptor (no declaration) is the host-runtime default. The
   *  dispatch planner reads THIS to choose the delivery path (host stream vs
   *  webhook/mcp-poll); transport (API vs local-CLI) stays the connector's
   *  concern, never the planner's. */
  delivery: AssistantDeliveryKind;
  /** The declared LAUNCH topology (cinatra#1878 W3): `local` (host runtime) vs
   *  `remote` (proxies to a first-party `targetProvider`). The /chat codec
   *  disambiguates the third path segment by this kind (instance for `remote`,
   *  titleSlug for `local`); the /assistants directory + "Remote chat" flyout use
   *  it (and `targetProvider`) for the remote destination. FAIL-SAFE to `local`. */
  launch: AssistantLaunch;
};

type CandidateRow = {
  packageName: string;
  templateId: string;
  displayName: string | null;
  assistantUserId: string | null;
  handle: string;
  origin: string | null;
  /** Raw persisted `assistant_declaration` jsonb (null for the builtin). */
  declaration: unknown;
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
    delivery: projectAssistantDelivery(row.declaration),
    launch: projectAssistantLaunch(row.declaration),
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
      declaration: installedExtension.assistantDeclaration,
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
    // The builtin Cinatra descriptor has no installed_extension row → no
    // declaration; it resolves to the host-runtime default in `toEntry`.
    declaration: null,
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
// First-party BUILT-IN recognition by reserved package (cinatra#2031).
// ---------------------------------------------------------------------------

/**
 * Is `assistantUserId` the FIRST-PARTY boot-seeded BUILT-IN assistant registered
 * under `builtinPackageName`? The three built-in assistants (@cinatra, WordPress,
 * WordPress' Drupal sibling — cinatra#1823) are minted by the boot seeder
 * (`registerAssistantAgent`) with their OWN 1:1-linked `agent_templates` row
 * carrying the RESERVED (private, first-party) package name; they have NO
 * `installed_extension` row and NO `assistant_audience` grants, so
 * {@link readAssistantRegistryForActor} — which lists installed-extension
 * assistants + the single @cinatra builtin — never returns the WordPress/Drupal
 * siblings. This is the narrow recognition primitive the widget audience closure
 * uses to admit a bound built-in without widening any audience globally.
 *
 * True IFF an `agent_kind='assistant'` template row exists linking THIS principal
 * to THIS reserved package. The reserved package names are private first-party
 * constants an installed extension can never claim, so a match is proof of
 * first-party built-in provenance. Fail-closed: an empty id/package returns
 * false; no match returns false (the caller then applies the audience gate).
 */
export async function isBuiltinAssistantByPackage(
  assistantUserId: string,
  builtinPackageName: string,
  db: ReaderDb = betterAuthDb,
): Promise<boolean> {
  if (!assistantUserId || !builtinPackageName) return false;
  const rows = await db
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.assistantUserId, assistantUserId),
        eq(agentTemplates.packageName, builtinPackageName),
        eq(agentTemplates.agentKind, "assistant"),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
