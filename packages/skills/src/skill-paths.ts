// Pure path resolver for the ownership-first skills layout.
//
// Mirror of the SQL helper `cinatra.compute_owner_path_prefix` in
// `src/lib/drizzle-store.ts`. Tests must verify both produce identical paths
// for the same identity.

import "server-only";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";

// Minimal duck-typed Drizzle DB handle. The full PgDatabase generic surface
// is caller-specific schema-typing, and we only need .execute(sql\`...\`).
// Avoid `any` per lint policy by declaring a precise structural type.
// Note: Drizzle's NodePgDatabase.execute returns a pg.QueryResult whose
// `rows` is typed via the generic parameter. We re-declare the minimal
// shape here so our resolver doesn't pin a specific Drizzle schema type.
export type AnyPgDatabase = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute<T extends Record<string, unknown> = Record<string, unknown>>(query: any): Promise<{ rows: T[] }>;
};

// ===========================================================================
// Types
// ===========================================================================

export type OwnerScope = "personal" | "team" | "organization" | "workspace" | "project";
export type BindingScope = "owner" | "agent";
export type SourceKind = "installed" | "bundled" | "user-authored";

/**
 * Legacy `SkillLevel` projection from typed identity columns.
 *
 * UI/access readers (plugin-pages.tsx, skill-access-actions.ts,
 * agents-store.ts, dedup-skills.ts, llm-matching/*) still consume
 * `skill.level` to branch on personal/team/organization/workspace/project/
 * system/agent. Projecting `level` from the identity columns keeps that
 * field meaningful while identity-aware code can read the identity columns
 * directly.
 *
 * Projection map:
 *   (personal, _, _)                  -> "personal"
 *   (team, _, _)                      -> "team"
 *   (organization, _, _)              -> "organization"
 *   (project, _, _)                   -> "team"  [closest legacy proxy]
 *   (workspace, agent, _)             -> "agent"
 *   (workspace, owner, _)             -> "system"
 *   (undefined or other)              -> "system" (safe default for legacy rows)
 */
// Narrow the return type to the set of legacy levels the switch can actually
// emit. `"project"` and `"workspace"` are never returned — `project`
// collapses to `"team"` (closest legacy proxy), and
// `workspace` rows project to `"system"` or `"agent"` depending on binding.
export function projectLevelFromIdentity(input: {
  owner_scope?: OwnerScope | null;
  binding_scope?: BindingScope | null;
  source_kind?: SourceKind | null;
}): "personal" | "team" | "organization" | "system" | "agent" {
  switch (input.owner_scope) {
    case "personal":
      return "personal";
    case "team":
      return "team";
    case "organization":
      return "organization";
    case "project":
      return "team";
    case "workspace":
      if (input.binding_scope === "agent") return "agent";
      return "system";
    default:
      return "system";
  }
}

export interface SkillIdentity {
  owner_scope: OwnerScope;
  owner_id: string | null;            // null iff owner_scope === 'workspace'
  binding_scope: BindingScope;
  vendor: string | null;              // null when binding_scope === 'owner' and source_kind === 'user-authored'
  package: string | null;
  agent_template_id: string | null;   // non-null iff binding_scope === 'agent'
  skill_slug: string;
}

export interface SlugMap {
  /** key: user.id → username (lowercase) */
  users: Map<string, string>;
  /** key: team.id → { slug, organizationId } */
  teams: Map<string, { slug: string; organizationId: string }>;
  /** key: organization.id → slug */
  organizations: Map<string, string>;
  /** key: project.id → { slug, owner_level, owner_id } */
  projects: Map<string, { slug: string; owner_level: string; owner_id: string }>;
  /** key: agent_template.id → { ownerLevel, ownerId, packageName } */
  agentTemplates: Map<string, { ownerLevel: string | null; ownerId: string | null; packageName: string | null }>;
}

export interface SlugRefs {
  userIds?: string[];
  teamIds?: string[];
  organizationIds?: string[];
  projectIds?: string[];
  agentTemplateIds?: string[];
}

// ===========================================================================
// Reserved name sets — invariants enforced by the scanner and install paths
// ===========================================================================

/** Top-level directories under `data/skills/`. Anything else is rejected. */
export const RESERVED_TOP_LEVEL: ReadonlySet<string> = new Set([
  "personal",
  "organization",
  "workspace",
]);

/**
 * Sub-bucket directory names that appear at any owner-level depth. Children of
 * an owner directory starting with `~` MUST belong to this set; anything else
 * starting with `~` is rejected as an unknown reserved bucket.
 */
export const RESERVED_SUBBUCKETS: ReadonlySet<string> = new Set([
  "~agents",
  "~teams",
  "~projects",
]);

/** Vendor name format: lowercase alphanum + dot/dash, must NOT start with `~`. */
const VENDOR_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function assertValidVendor(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`vendor name must be a non-empty string (got ${typeof name})`);
  }
  if (name.startsWith("~")) {
    throw new Error(`vendor name must not start with '~' (got "${name}")`);
  }
  if (!VENDOR_NAME_RE.test(name)) {
    throw new Error(`vendor name must match ${VENDOR_NAME_RE} (got "${name}")`);
  }
}

// ===========================================================================
// Path composition (mirrors SQL helper cinatra.compute_owner_path_prefix)
// ===========================================================================

/**
 * Compose the owner-prefix segment for a given scope + id, joining slugs from
 * the supplied SlugMap. Returns null if the chain cannot be resolved (missing
 * row, no slug, etc.).
 *
 * Workspace is asserted singleton: callers must NOT supply an id; returns
 * "workspace" with no segment.
 */
export function resolveOwnerSegmentPath(
  scope: OwnerScope,
  id: string | null,
  slugs: SlugMap,
): string | null {
  switch (scope) {
    case "workspace":
      // Invariant: exactly one workspace per deployment, no id segment.
      if (id !== null && id !== "") {
        throw new Error(
          `invariant violation: workspace owner_id must be null (got "${id}"). ` +
            `The skills layout assumes one workspace per deployment.`,
        );
      }
      return "workspace";
    case "personal": {
      if (!id) return null;
      const username = slugs.users.get(id);
      return username ? `personal/${username}` : null;
    }
    case "organization": {
      if (!id) return null;
      const orgSlug = slugs.organizations.get(id);
      return orgSlug ? `organization/${orgSlug}` : null;
    }
    case "team": {
      if (!id) return null;
      const team = slugs.teams.get(id);
      if (!team) return null;
      const orgSlug = slugs.organizations.get(team.organizationId);
      return orgSlug ? `organization/${orgSlug}/~teams/${team.slug}` : null;
    }
    case "project": {
      if (!id) return null;
      const project = slugs.projects.get(id);
      if (!project) return null;
      const ownerPrefix = resolveOwnerSegmentPath(
        project.owner_level as OwnerScope,
        project.owner_id || null,
        slugs,
      );
      return ownerPrefix ? `${ownerPrefix}/~projects/${project.slug}` : null;
    }
    default: {
      // exhaustiveness check
      const _exhaustive: never = scope;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Resolve the absolute on-disk directory for a single skill identity.
 *
 * Returns the directory that contains `SKILL.md`. Throws if the ownership
 * chain cannot be resolved or if a vendor/package validation fails.
 *
 * @param root absolute path to the skills data root (e.g. `/.../data/skills`)
 */
export function resolveSkillDir(id: SkillIdentity, slugs: SlugMap, root: string): string {
  const ownerSegment = resolveOwnerSegmentPath(id.owner_scope, id.owner_id, slugs);
  if (!ownerSegment) {
    throw new Error(
      `cannot resolve owner path for skill ` +
        `(scope=${id.owner_scope}, id=${id.owner_id}, slug=${id.skill_slug})`,
    );
  }

  let bindingPath: string;
  if (id.binding_scope === "owner") {
    // installed (marketplace/upload/github): <vendor>/<package>/<skill>
    if (!id.vendor || !id.package) {
      throw new Error(
        `owner-bound skill requires vendor + package ` +
          `(slug=${id.skill_slug}, vendor=${id.vendor}, package=${id.package})`,
      );
    }
    assertValidVendor(id.vendor);
    bindingPath = `${id.vendor}/${id.package}/${id.skill_slug}`;
  } else {
    // agent-bound: ~agents/<package_name>/<skill>
    if (!id.agent_template_id) {
      throw new Error(
        `agent-bound skill requires agent_template_id ` +
          `(slug=${id.skill_slug})`,
      );
    }
    const template = slugs.agentTemplates.get(id.agent_template_id);
    if (!template) {
      throw new Error(
        `agent_template_id ${id.agent_template_id} not found in SlugMap ` +
          `for skill ${id.skill_slug}`,
      );
    }
    if (!template.packageName) {
      throw new Error(
        `agent_template ${id.agent_template_id} has no package_name ` +
          `for skill ${id.skill_slug}`,
      );
    }
    // packageName already encodes <vendor>/<package> as a single string
    // (e.g. "cinatra/email-test-delivery-agent"). Use it directly so the
    // resolver mirrors the SQL trigger output verbatim.
    bindingPath = `~agents/${template.packageName}/${id.skill_slug}`;
  }

  // path.posix.join — paths in DB and outbox are POSIX (cross-platform-safe).
  // Caller passes absolute root; we resolve the combined path through node's path.
  return path.posix.join(root.replace(/\\/g, "/"), ownerSegment, bindingPath);
}

/**
 * Batch variant — resolve N identities with a single SlugMap. No N+1.
 *
 * @returns Map keyed by the identity's `skill_slug` (caller's responsibility
 *          to disambiguate further if multiple identities share a slug).
 *          For controlled callers we recommend using identity-stringification
 *          for the key — see resolveSkillDirsBatchKeyed.
 */
export function resolveSkillDirsBatch(
  ids: SkillIdentity[],
  slugs: SlugMap,
  root: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    result.set(id.skill_slug, resolveSkillDir(id, slugs, root));
  }
  return result;
}

/** Stable string key for a SkillIdentity (used by batch resolver callers). */
export function identityKey(id: SkillIdentity): string {
  return [
    id.owner_scope,
    id.owner_id ?? "_",
    id.binding_scope,
    id.agent_template_id ?? "_",
    id.vendor ?? "_",
    id.package ?? "_",
    id.skill_slug,
  ].join("|");
}

export function resolveSkillDirsBatchKeyed(
  ids: SkillIdentity[],
  slugs: SlugMap,
  root: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    result.set(identityKey(id), resolveSkillDir(id, slugs, root));
  }
  return result;
}

// ===========================================================================
// SlugMap loader
// ===========================================================================

/**
 * Build a Drizzle SQL fragment for a Postgres `ARRAY[...]` literal of text
 * values, with one bind parameter per element.
 *
 * Drizzle's `sql` tag spreads a JS array `${arr}` as a tuple of positional
 * parameters (`($1, $2, ...)`). Inside `ANY(...)` Postgres parses that as a
 * row-expression and rejects with `42809 op ANY/ALL (array) requires array
 * on right side`. Adding a `::text[]` cast does NOT save you — the spread
 * is a record, and records can't be cast to arrays.
 *
 * This helper produces `ARRAY[$1, $2, ..., $N]`: one bind param per id,
 * real Postgres array on the RHS, no injection surface. Use inside `ANY(...)`:
 *
 *   sql`WHERE id = ANY(${buildTextArraySql(ids)})`
 *
 * Empty-array safety: callers MUST guard with `if (ids.length > 0)` because
 * `ARRAY[]` is ambiguous in Postgres (anyarray is non-coercible without an
 * explicit element type). The five call sites in `loadSlugMap` already do
 * this — keep that invariant.
 */
function buildTextArraySql(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]`;
}

/**
 * Load a SlugMap covering the supplied IDs. Each tier is loaded with a single
 * query — no N+1.
 *
 * Tables joined:
 *   public.user (id → username)
 *   public.team (id → slug, organizationId)
 *   public.organization (id → slug)
 *   {schema}.projects (id → slug, owner_level, owner_id)
 *   {schema}.agent_templates (id → owner_level, owner_id, package_name)
 *
 * Caller supplies the Drizzle DB instance.
 */
export async function loadSlugMap(
  db: AnyPgDatabase,
  refs: SlugRefs,
): Promise<SlugMap> {
  const map: SlugMap = {
    users: new Map(),
    teams: new Map(),
    organizations: new Map(),
    projects: new Map(),
    agentTemplates: new Map(),
  };

  const userIds = (refs.userIds ?? []).filter((id) => id);
  const teamIds = (refs.teamIds ?? []).filter((id) => id);
  const orgIds = (refs.organizationIds ?? []).filter((id) => id);
  const projectIds = (refs.projectIds ?? []).filter((id) => id);
  const agentTemplateIds = (refs.agentTemplateIds ?? []).filter((id) => id);

  if (userIds.length > 0) {
    const rows = await db.execute<{ id: string; username: string }>(sql`
      SELECT id, username FROM public."user" WHERE id = ANY(${buildTextArraySql(userIds)})
    `);
    for (const r of rows.rows ?? []) {
      if (r.username) map.users.set(r.id, r.username);
    }
  }

  if (teamIds.length > 0) {
    const rows = await db.execute<{ id: string; slug: string; organizationId: string }>(sql`
      SELECT id, slug, "organizationId" FROM public."team" WHERE id = ANY(${buildTextArraySql(teamIds)})
    `);
    for (const r of rows.rows ?? []) {
      if (r.slug) map.teams.set(r.id, { slug: r.slug, organizationId: r.organizationId });
    }
  }

  if (orgIds.length > 0) {
    const rows = await db.execute<{ id: string; slug: string }>(sql`
      SELECT id, slug FROM public."organization" WHERE id = ANY(${buildTextArraySql(orgIds)})
    `);
    for (const r of rows.rows ?? []) {
      if (r.slug) map.organizations.set(r.id, r.slug);
    }
  }

  // projects + agent_templates live in cinatra schema; use raw sql to honor
  // the SUPABASE_SCHEMA env var by reading it at call time.
  const cinatraSchema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  if (projectIds.length > 0) {
    const rows = await db.execute<{ id: string; slug: string; owner_level: string; owner_id: string }>(sql`
      SELECT id, slug, owner_level, owner_id FROM ${sql.identifier(cinatraSchema)}.projects
       WHERE id = ANY(${buildTextArraySql(projectIds)})
    `);
    for (const r of rows.rows ?? []) {
      if (r.slug) {
        map.projects.set(r.id, { slug: r.slug, owner_level: r.owner_level, owner_id: r.owner_id });
      }
    }
  }
  if (agentTemplateIds.length > 0) {
    const rows = await db.execute<{
      id: string;
      owner_level: string | null;
      owner_id: string | null;
      package_name: string | null;
    }>(sql`
      SELECT id, owner_level, owner_id, package_name FROM ${sql.identifier(cinatraSchema)}.agent_templates
       WHERE id = ANY(${buildTextArraySql(agentTemplateIds)})
    `);
    for (const r of rows.rows ?? []) {
      map.agentTemplates.set(r.id, {
        ownerLevel: r.owner_level,
        ownerId: r.owner_id,
        packageName: r.package_name,
      });
    }
  }

  return map;
}
