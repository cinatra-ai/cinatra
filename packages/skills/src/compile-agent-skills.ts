/**
 * Walks `<repoRoot>/agents/<slug>/skills/<skillSlug>/SKILL.md`, parses each
 * frontmatter, and registers the skill as `level: "agent"` via `upsertSkill`.
 *
 * This is the AGENT-skill compile path — it lives at `agents/<slug>/skills/`
 * NOT at `packages/<slug>/skills/`. The `packages/*` skills-sync path was
 * removed alongside this split (the prior sibling functions
 * `syncSkillPackage` + `syncMonorepoSkillPackages` were deleted with
 * `sync-packages.ts` in the same PR). This file preserves the
 * agent-skill compile pipeline exactly as-is.
 *
 * The `skillId` is derived from the directory slug (e.g. `email-outreach`)
 * not the npm package name, for byte-identical parity with the existing
 * `agent_source_compile` registration in
 * packages/agent-builder/src/mcp/handlers.ts:1446-1448 (Pitfall 4 — DO
 * NOT re-derive from the npm name).
 *
 * Threat-model mitigations:
 *   T-v7n-01 — package.json#name + directory slug are validated.
 *   T-v7n-04 — agent dir count and per-agent skill count are capped.
 *
 * Returns `{ registered, skipped }`. Never throws — per-agent and
 * per-skill failures are collected in `skipped` with a reason.
 */
import { type Dirent, type Stats } from "fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "path";
import { upsertSkill } from "./skills-store";
import { parseFrontmatter } from "./skills-registry";

export type CompileAgentSkillsResult = {
  registered: string[];
  skipped: Array<{ slug: string; reason: string }>;
};

// Validation rules (T-v7n-01): npm-package name shape and dir-slug guard.
// `package.json#name` accepts an optional leading `@scope/`; the unscoped
// half must be plain word characters / dot / dash.
const NPM_PACKAGE_NAME_PATTERN = /^@?[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/;

function isValidPackageName(name: unknown): name is string {
  return typeof name === "string" && NPM_PACKAGE_NAME_PATTERN.test(name);
}

function isValidDirectorySlug(slug: string): boolean {
  // Reject empty, ".", "..", and any slug containing path separators or "..".
  // Mirrors the agent_source_compile defense (handlers.ts:1336-1338).
  if (!slug || slug === "." || slug === "..") return false;
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return false;
  return true;
}

function slugifyForId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// DoS caps (T-v7n-04): bound the number of agents and skills walked per call.
const MAX_AGENT_DIRS = 1000;
const MAX_SKILLS_PER_AGENT = 100;

export async function compileAndRegisterAgentSkillsForRepo(input: {
  repoRoot: string;
}): Promise<CompileAgentSkillsResult> {
  const result: CompileAgentSkillsResult = { registered: [], skipped: [] };
  const agentsDir = path.join(input.repoRoot, "agents");

  // No-op when <repoRoot>/agents does not exist.
  let agentsDirStat: Stats;
  try {
    agentsDirStat = await stat(agentsDir);
  } catch {
    return result;
  }
  if (!agentsDirStat.isDirectory()) return result;

  let agentEntries: Dirent[];
  try {
    agentEntries = (await readdir(agentsDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    return {
      registered: [],
      skipped: [{ slug: "<agents-dir>", reason: err instanceof Error ? err.message : String(err) }],
    };
  }

  let agentsWalked = 0;
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    if (agentsWalked >= MAX_AGENT_DIRS) {
      result.skipped.push({ slug: agentEntry.name, reason: `agent count exceeded MAX_AGENT_DIRS=${MAX_AGENT_DIRS}` });
      continue;
    }
    agentsWalked += 1;

    const dirSlug = agentEntry.name;
    if (!isValidDirectorySlug(dirSlug)) {
      result.skipped.push({ slug: dirSlug, reason: `invalid directory slug "${dirSlug}"` });
      continue;
    }

    const agentDir = path.join(agentsDir, dirSlug);
    const pkgJsonPath = path.join(agentDir, "package.json");
    const skillsDir = path.join(agentDir, "skills");

    let pkgRaw: string;
    try {
      pkgRaw = (await readFile(pkgJsonPath, "utf8")) as string;
    } catch {
      result.skipped.push({ slug: dirSlug, reason: "missing package.json" });
      continue;
    }

    let pkgJson: { name?: unknown };
    try {
      pkgJson = JSON.parse(pkgRaw);
    } catch (err) {
      result.skipped.push({
        slug: dirSlug,
        reason: `package.json parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!isValidPackageName(pkgJson.name)) {
      result.skipped.push({
        slug: dirSlug,
        reason: `invalid package.json#name "${String(pkgJson.name)}" (must match ${NPM_PACKAGE_NAME_PATTERN})`,
      });
      continue;
    }
    const agentPackageName = pkgJson.name;

    let skillEntries: Dirent[];
    try {
      skillEntries = (await readdir(skillsDir, { withFileTypes: true })) as Dirent[];
    } catch {
      result.skipped.push({ slug: dirSlug, reason: "missing or unreadable skills/ directory" });
      continue;
    }

    const skillDirs = skillEntries.filter((e) => e.isDirectory());
    if (skillDirs.length === 0) {
      result.skipped.push({ slug: dirSlug, reason: "skills/ directory is empty" });
      continue;
    }

    let skillsWalked = 0;
    for (const skillEntry of skillDirs) {
      if (skillsWalked >= MAX_SKILLS_PER_AGENT) {
        result.skipped.push({
          slug: `${dirSlug}/${skillEntry.name}`,
          reason: `skill count exceeded MAX_SKILLS_PER_AGENT=${MAX_SKILLS_PER_AGENT}`,
        });
        continue;
      }
      skillsWalked += 1;

      const skillEntryName = skillEntry.name;
      if (!isValidDirectorySlug(skillEntryName)) {
        result.skipped.push({ slug: `${dirSlug}/${skillEntryName}`, reason: `invalid skill slug "${skillEntryName}"` });
        continue;
      }

      const skillMdPath = path.join(skillsDir, skillEntryName, "SKILL.md");
      let skillContent: string;
      try {
        skillContent = (await readFile(skillMdPath, "utf8")) as string;
      } catch {
        result.skipped.push({ slug: `${dirSlug}/${skillEntryName}`, reason: "missing SKILL.md" });
        continue;
      }

      const { attributes } = parseFrontmatter(skillContent);
      const skillName = (attributes as Record<string, string>).name?.trim() || skillEntryName;
      const skillDesc = (attributes as Record<string, string>).description?.trim() || "";

      // Pitfall 4: skillId uses the *directory* slug (e.g. "foo"), NOT the
      // slugified npm name. This matches the existing
      // agent_source_compile convention so an agent compiled
      // via the MCP primitive and an agent auto-registered at setup time
      // produce byte-identical catalog rows.
      const packageId = `custom:${slugifyForId(dirSlug)}`;
      const skillIdSlug = slugifyForId(skillName);
      const skillId = `${packageId}:${skillIdSlug}`;

      try {
        const upserted = await upsertSkill({
          type: "agent",
          packageName: agentPackageName,
          agentId: agentPackageName,
          name: skillName,
          description: skillDesc,
          content: skillContent,
          skillId,
          prefillText: "-",
        });
        result.registered.push(upserted.id);
      } catch (err) {
        result.skipped.push({
          slug: `${dirSlug}/${skillEntryName}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}
