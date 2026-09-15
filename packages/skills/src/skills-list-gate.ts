/**
 * THE SKILLS LIST GATE (cinatra#2810, per-scope surfaces S4).
 *
 * The per-row authorization `/skills` has always applied, lifted out of
 * `SkillsPage` so that the per-scope Skills tab runs the IDENTICAL gate rather
 * than its own approximation of it. The gate itself is unchanged; only its
 * address is.
 *
 * It lives apart from `./skills-catalog-rows` on purpose: the gate needs the
 * registry, the store and the policy engine, and a renderer of the rows must
 * not have to load all three.
 */
import type { ActorContext } from "@/lib/authz/actor-context";
import { requireResourceAccess, buildSkillResourceRef } from "@cinatra-ai/agents/auth-policy";

import { listInstalledSkills, type SkillManifest } from "./skills-registry";
import { readSkillsCatalog, resolveEffectiveSkillAccessPolicy } from "./skills-store";

/**
 * Every installed skill this actor may be shown, with the list's own per-row
 * gate applied.
 *
 * The list must apply per-row authorization. A "filter system only"
 * gate leaks scoped skill metadata (name,
 * description, package, slug, source URL, usedBy) for personal/team/
 * org/project/workspace rows the actor cannot access. Apply per-row
 * `requireResourceAccess` so the rendered list mirrors what
 * `skills_installed_list` returns to MCP callers. platform_admin
 * is short-circuited inside `requireResourceAccess` and continues to
 * see everything.
 */
export async function listAuthorizedInstalledSkills(
  actor: ActorContext,
  allSkills?: readonly SkillManifest[],
): Promise<SkillManifest[]> {
  const skills = allSkills ?? (await listInstalledSkills());
  const listSkillPackages = (await readSkillsCatalog()).skillPackages ?? [];
  return skills.filter((s) => {
    try {
      // Keep the UI authorization shape aligned with auth-policy.ts.
      requireResourceAccess(actor, buildSkillResourceRef({
        id: s.id,
        level: s.level,
        scope: s.scope ?? null,
        // Durable owner identity (cinatra#1416): a shared personal skill stays
        // visible to its owner even when the projected scope names a locus the
        // owner is not a member of.
        ownerUserId: s.ownerUserId ?? null,
        // Canonical effective policy (W4): skill override else parent package's.
        accessPolicy: resolveEffectiveSkillAccessPolicy(s, listSkillPackages),
      }));
      return true;
    } catch {
      return false;
    }
  });
}
