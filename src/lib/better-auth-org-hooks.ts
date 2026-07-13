// Better Auth organization-plugin lifecycle hooks (runtime-only, BEHAVIORAL —
// NOT schema-bearing). These are injected at the runtime auth config
// (src/lib/auth.ts) and threaded through the shared plugin factory
// (src/lib/better-auth-plugins.ts). They are deliberately NOT part of the
// plain-Node schema/plugin data the migration runner loads: the migration
// never creates organizations, and hooks do not affect `getSchema()` output
// (the drift-guard test in src/lib/__tests__/better-auth-schema.test.ts).
//
// This module MAY use `@/` aliases (it is only ever loaded by the Next.js
// runtime + vitest, never by scripts/better-auth-migrate.mts). The DB read is
// a lazy dynamic import so unit tests exercising the pure logic never load
// the drizzle/pg module graph.
import type { OrganizationOptions } from "better-auth/plugins";
import { toTeamSlugBase } from "@/app/teams/new/team-slug";
import { slugify } from "@/lib/utils";

type BeforeCreateTeamHook = NonNullable<
  NonNullable<OrganizationOptions["organizationHooks"]>["beforeCreateTeam"]
>;

/**
 * Injectable I/O seam for the hook's per-org slug-collision check. The
 * default is the real drizzle reader below; tests supply a fake (same
 * dependency-composition pattern as src/lib/better-auth-db.ts).
 */
export type BeforeCreateTeamSlugDeps = {
  listTeamSlugsForOrg: (organizationId: string) => Promise<string[]>;
};

// Lazy dynamic import: keeps @/lib/better-auth-db (drizzle + pg pool proxies)
// out of this module's import-time graph — it only loads when the DEFAULT dep
// actually runs (i.e. in the real runtime, never in unit tests that inject a
// fake reader).
async function listTeamSlugsForOrgSql(
  organizationId: string,
): Promise<string[]> {
  const [{ betterAuthDb, betterAuthTeams }, { eq }] = await Promise.all([
    import("@/lib/better-auth-db"),
    import("drizzle-orm"),
  ]);
  const rows = await betterAuthDb
    .select({ slug: betterAuthTeams.slug })
    .from(betterAuthTeams)
    .where(eq(betterAuthTeams.organizationId, organizationId));
  return rows.map((row) => row.slug);
}

/**
 * Disambiguate `base` against the org's already-taken slugs with a `-2`/`-3`…
 * suffix (the same convention as /teams/new's createTeamAction ON CONFLICT
 * retry loop — that helper is inline + transaction-coupled, so it is not
 * directly reusable here). The base is re-trimmed per suffix so every
 * candidate stays within the 63-char CHECK ceiling and still ends in an
 * alphanumeric. Terminates because `taken` is finite. Exported for direct
 * unit testing.
 */
export function ensureUniqueTeamSlug(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const trimmed = base.slice(0, 63 - suffix.length).replace(/-+$/g, "");
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Build the `organizationHooks.beforeCreateTeam` hook for the organization
 * plugin.
 *
 * WHY: with `teams.enabled` on, Better Auth's create-organization path
 * (node_modules/better-auth/.../routes/crud-org) creates a DEFAULT team
 * supplying only `{ name, organizationId }` — no slug. Cinatra's
 * `public.team.slug` is NOT NULL + CHECK-constrained
 * (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`) + UNIQUE per org, so that INSERT
 * violates the not-null constraint, 500s the create-organization request, and
 * leaves a partially-created org (organization row + owner member, but no
 * default team) — the exact failure in cinatra#1494.
 *
 * SCOPE: `beforeCreateTeam` is PLUGIN-WIDE — it also fires on the public
 * `/organization/create-team` endpoint (crud-team), and in BOTH routes the
 * returned `{ data }` is spread AFTER the caller's teamData
 * (`teamData = { ...teamData, ...response.data }`), i.e. it OVERRIDES
 * caller-supplied fields. So this hook is strictly FILL-ONLY-WHEN-ABSENT:
 * when the incoming team already carries a non-empty slug it returns
 * `undefined`, which both routes treat as "leave teamData untouched" (their
 * merge is gated on `"data" in response`). Note the public create-team
 * endpoint's zod body schema already REQUIRES `slug` (the team.slug
 * additionalField is `required: true`, and toZodSchema only relaxes
 * `required: false` fields), so the fill branch is in practice only reachable
 * from the internal default-team path — the slug preservation + uniqueness
 * below are defense-in-depth for that endpoint and any future internal caller.
 *
 * DERIVATION: primarily from `team.name` (for the default team Better Auth
 * sets name = organization.name, so this matches the org's identity); falls
 * back to `organization.slug` only when the name slugifies to nothing (e.g. a
 * punctuation-only or non-latin name), then to `"team"` via the shared
 * `toTeamSlugBase` deriver — the same CHECK-conforming convention as the
 * /teams/new path. (/teams/new itself inserts directly via SQL, so this hook
 * never fires there.)
 *
 * UNIQUENESS: `team.slug` is UNIQUE per org, so the derived slug is
 * disambiguated against the org's existing team slugs (`-2`/`-3`… suffix).
 * The read-then-pick is not race-proof under concurrent creates — the per-org
 * unique index remains the authoritative backstop (a loser fails loudly
 * instead of silently corrupting) — but the only slugless caller today is the
 * default-team creation inside a brand-new org, which has no siblings to race.
 */
export function buildBeforeCreateTeamEnsureSlug(
  deps: BeforeCreateTeamSlugDeps = {
    listTeamSlugsForOrg: listTeamSlugsForOrgSql,
  },
): BeforeCreateTeamHook {
  return async ({ team, organization }) => {
    // Fill-only-when-absent: never override a caller-supplied slug (the
    // routes' merge semantics would let us clobber it otherwise).
    if (typeof team.slug === "string" && team.slug.trim().length > 0) {
      return;
    }
    const name = typeof team.name === "string" ? team.name : "";
    const orgSlug =
      typeof organization.slug === "string" ? organization.slug.trim() : "";
    // Prefer the team name; use the org slug only when the name yields no
    // usable base (mirrors toTeamSlugBase's derivation, which returns the
    // "team" fallback in that case).
    const nameBase = slugify(name).slice(0, 57).replace(/-+$/g, "");
    const source = nameBase.length > 0 ? name : orgSlug;
    const base = toTeamSlugBase(source);
    const taken = new Set(await deps.listTeamSlugsForOrg(team.organizationId));
    return { data: { slug: ensureUniqueTeamSlug(base, taken) } };
  };
}

/** The default-wired hook instance src/lib/auth.ts injects. */
export const beforeCreateTeamEnsureSlug = buildBeforeCreateTeamEnsureSlug();
