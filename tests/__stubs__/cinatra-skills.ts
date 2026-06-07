// Minimal stub for @cinatra-ai/skills.
// src/app/settings/agents/actions.ts imports `listInstalledSkills` from this
// package; the real entry point pulls in @cinatra-ai/llm and
// other modules that are not resolvable in the vitest sandbox. We export
// only what the actions module references so module load succeeds.

export async function listInstalledSkills(): Promise<
  Array<{ id: string; name?: string; description?: string }>
> {
  return [];
}

// src/lib/mcp-instructions.ts + src/lib/openai-builder.ts import these from the
// bare specifier at module-load time (the MCP autodiscovery SKILL.md reader).
// Faithful minimal re-implementation so dependent modules load in the sandbox.
export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

type ReadLocalPackageSkillInput = {
  packageDir?: string;
  extensionDir?: string;
  skillSlug: string;
  stripFrontmatter?: boolean;
};

export function readLocalPackageSkillContent(
  input: ReadLocalPackageSkillInput,
): string | null {
  const {
    packageDir,
    extensionDir,
    skillSlug,
    stripFrontmatter: doStrip = false,
  } = input;

  const { readFileSync, existsSync } = require("node:fs");
  const path = require("node:path");

  const candidates = extensionDir
    ? [
        path.join(
          process.cwd(),
          "extensions",
          "cinatra-ai",
          extensionDir,
          "skills",
          skillSlug,
          "SKILL.md",
        ),
      ]
    : packageDir
      ? [
          path.join(
            process.cwd(),
            "packages",
            packageDir,
            "skills",
            skillSlug,
            "SKILL.md",
          ),
        ]
      : [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf8");
      return doStrip ? stripSkillFrontmatter(raw) : raw;
    } catch {
      continue;
    }
  }

  return null;
}
