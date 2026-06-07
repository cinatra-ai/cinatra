// `listInstalledSkills()` annotates each skill with the names of the installed
// agents it's matched to. The agent list must be the canonical
// installed-runnable-agents reader; otherwise the "matched to:" labels show
// workspace packages.
// No filesystem scanner runs here; the skills store is exclusively populated
// from `cinatra.skills` now.
import {
  readAgentSkillMatches,
  readAgentsForSkillMatching,
} from "@/lib/agents-store";
import { createSkillFromTemplate, readSkillsCatalog, type SkillLevel } from "./skills-store";

export type SkillManifest = {
  id: string;
  name: string;
  slug: string;
  description: string;
  packageId: string;
  packageName: string;
  packageSlug: string;
  sourceUrl?: string;
  content: string;
  usedBy: string[];
  sourcePath?: string;
  basedOnSkillId?: string;
  level?: SkillLevel;
  scope?: string;
  /**
   * packageId of the agent this skill is bundled with or authored for. Set on:
   *   - `level: "agent"` skills (canonical bundled-with-agent case)
   *   - `level: "personal" | "team" | "organization"` custom skills authored
   *     for a specific agent via the Skills UI / `createOrUpdateCustomSkillForAgent`
   * Unset on general-purpose cross-agent skills.
   *
   * Used by `/configuration/skills?tab=matches` to filter the "Add a skill"
   * dropdown — agent-linked skills are not assignable to OTHER agents.
   */
  agentId?: string;
};

export type SkillPackageManifest = {
  packageId: string;
  name: string;
  slug: string;
  description: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  license?: string;
  authors?: string[];
  skillCount: number;
  readmeContent?: string;
  licenseText?: string;
  level?: SkillLevel;
  /**
   * Surface PersistedSkillPackage.isCustom on the read-side manifest so
   * callers can distinguish operator-installed packages without falling back to
   * the `level === "third-party"` predicate.
   */
  isCustom?: boolean;
  skills: SkillManifest[];
};

export function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { attributes: {} as Record<string, string>, body: content };
  }

  const attributes: Record<string, string> = {};
  let lastKey: string | null = null;
  const listAccumulatorByKey: Record<string, string[]> = {};

  for (const rawLine of match[1].split("\n")) {
    // BLOCKER-2 fix: detect YAML block-sequence continuation lines (`  - <value>`)
    // before trimming, so the leading whitespace signals list membership.
    const blockSequenceContinuation = /^[ \t]+-[ \t]+/.test(rawLine);
    if (blockSequenceContinuation && lastKey !== null) {
      const itemValue = rawLine.replace(/^[ \t]+-[ \t]+/, "").trim().replace(/^["']|["']$/g, "");
      if (!listAccumulatorByKey[lastKey]) {
        listAccumulatorByKey[lastKey] = [];
      }
      listAccumulatorByKey[lastKey].push(itemValue);
      continue;
    }

    const line = rawLine.trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      lastKey = line;
      attributes[line] = "";
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    lastKey = key;
    attributes[key] = value;
  }

  // Serialize collected lists as JSON strings so the Record<string, string> type is preserved.
  for (const [key, items] of Object.entries(listAccumulatorByKey)) {
    attributes[key] = JSON.stringify(items);
  }

  return {
    attributes,
    body: content.slice(match[0].length),
  };
}


export async function listInstalledSkills(): Promise<SkillManifest[]> {
  const [catalog, agentCatalog, matchState] = await Promise.all([readSkillsCatalog(), readAgentsForSkillMatching(), readAgentSkillMatches()]);

  const agentNameById = new Map(agentCatalog.map((agent) => [agent.id, agent.humanReadableName]));
  const matchedUsageBySkillId = new Map<string, string[]>();

  for (const match of matchState.matches) {
    const agentName = agentNameById.get(match.agentId) ?? match.agentId;
    const current = matchedUsageBySkillId.get(match.skillId) ?? [];
    if (!current.includes(agentName)) {
      current.push(agentName);
      matchedUsageBySkillId.set(match.skillId, current);
    }
  }

  // No filesystem merge with `packages/*/skills/` runs here. The skills store
  // is exclusively populated from `cinatra.skills` (which is in turn populated
  // from `data/skills/` installed via the GitHub-extension upload + the
  // agent-skill compile pipeline). Anything sitting in `packages/*/skills/` is
  // build-time workspace source, not a runtime installable skill.
  return catalog.skills.map((skill) => ({
    ...skill,
    usedBy: matchedUsageBySkillId.get(skill.id) ?? skill.usedBy,
  }));
}

// `dedupSkillsByName` lives in its own file (`dedup-skills.ts`) to keep it
// importable without dragging skills-registry's heavy transitive deps.
// Re-exported from the barrel.
export { dedupSkillsByName } from "./dedup-skills";

export async function listInstalledSkillPackages(): Promise<SkillPackageManifest[]> {
  const catalog = await readSkillsCatalog();
  const catalogPackages: SkillPackageManifest[] = catalog.skillPackages.map((skillPackage) => ({
    packageId: skillPackage.packageId,
    name: skillPackage.name,
    slug: skillPackage.slug,
    description: skillPackage.description,
    sourceUrl: skillPackage.sourceUrl,
    repositoryUrl: skillPackage.repositoryUrl,
    license: skillPackage.license,
    authors: skillPackage.authors,
    readmeContent: skillPackage.readmeContent,
    licenseText: skillPackage.licenseText,
    level: skillPackage.level,
    // Surface isCustom so callers can distinguish operator-installed packages
    // without keying on the "third-party" SkillLevel value.
    isCustom: skillPackage.isCustom,
    skillCount: catalog.skills.filter((skill) => skill.packageId === skillPackage.packageId).length,
    skills: catalog.skills.filter((skill) => skill.packageId === skillPackage.packageId),
  }));

  // The package list comes exclusively from `cinatra.skill_packages`.
  return catalogPackages;
}

export async function getInstalledSkillPackageBySlug(packageSlug: string) {
  const packages = await listInstalledSkillPackages();
  return packages.find((entry) => entry.slug === packageSlug) ?? null;
}

// Security-sensitive helper that filters package data through the same
// per-skill `requireResourceAccess` gate the MCP `skills_packages_list`
// handler applies. Use this from any server-rendered page that displays
// installed skill packages — for the MCP `skills_packages_*` primitives and
// the unified `/skills` list.
//
//   - Each package's embedded `skills` array is filtered per-row.
//   - `skillCount` is recomputed to reflect visible skills.
//   - Packages with zero visible skills are dropped, matching the MCP handler:
//     bare metadata like name/description/repositoryUrl/readmeContent/
//     licenseText/authors still leaks existence and must be dropped.
//   - platform_admin is short-circuited inside `requireResourceAccess`
//     and continues to see everything.
export async function listVisibleInstalledSkillPackages(
  actor: import("@/lib/authz").ActorContext,
): Promise<SkillPackageManifest[]> {
  const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");
  const packages = await listInstalledSkillPackages();
  return packages
    .map((pkg) => {
      const visibleSkills = (pkg.skills ?? []).filter((s) => {
        try {
          // Use the canonical skill resource ref builder so checks match auth-policy.ts.
          requireResourceAccess(actor, buildSkillResourceRef({
            id: s.id,
            level: s.level,
            scope: s.scope ?? null,
          }));
          return true;
        } catch {
          return false;
        }
      });
      return {
        ...pkg,
        skills: visibleSkills,
        skillCount: visibleSkills.length,
      };
    })
    .filter((pkg) => (pkg.skills?.length ?? 0) > 0);
}

export async function getVisibleInstalledSkillPackageBySlug(
  packageSlug: string,
  actor: import("@/lib/authz").ActorContext,
) {
  const packages = await listVisibleInstalledSkillPackages(actor);
  return packages.find((entry) => entry.slug === packageSlug) ?? null;
}

export async function getInstalledSkillById(skillId: string) {
  const skills = await listInstalledSkills();
  return skills.find((entry) => entry.id === skillId) ?? null;
}

export async function getInstalledSkillBySlug(skillSlug: string, packageSlug?: string) {
  const skills = await listInstalledSkills();
  return skills.find((entry) => entry.slug === skillSlug && (!packageSlug || entry.packageSlug === packageSlug)) ?? null;
}

export { createSkillFromTemplate };
