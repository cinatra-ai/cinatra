import "server-only";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Strip a YAML frontmatter block (`---\n...\n---`) from the top of a SKILL.md
 * file body, returning only the markdown body trimmed of whitespace.
 * Safe to call on content that has no frontmatter — returns the trimmed input.
 */
export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export type ReadLocalPackageSkillInput = {
  /**
   * Workspace package directory name under `packages/` — e.g. "skills",
   * "agent-research", "agent-enrichment", "campaigns". This is the folder
   * name on disk, NOT the npm package name. Ignored when `extensionDir`
   * is set.
   */
  packageDir?: string;
  /**
   * Extension directory name under `extensions/cinatra-ai/` — e.g.
   * "assistant-skills". When set, the skill is resolved from
   * `extensions/cinatra-ai/{extensionDir}/skills/{skillSlug}/SKILL.md`
   * instead of the `packages/` tree. Chat assistant skills live here.
   */
  extensionDir?: string;
  /**
   * Slug of the skill directory under the resolved skills root.
   * e.g. "skill-prefill-generation", "research-data", "enrich-data",
   * "chat-hitl-prompt-drive".
   */
  skillSlug: string;
  /**
   * If true, the YAML frontmatter block is removed before returning.
   * Defaults to false (return raw file content).
   */
  stripFrontmatter?: boolean;
};

/**
 * Read the raw text of an in-repo package SKILL.md file from disk.
 *
 * This is the ONLY sanctioned low-level reader for SKILL.md files owned by
 * workspace packages. Callers outside the `@cinatra-ai/skills` package must
 * normally go through the deterministic skills MCP client
 * (`createDeterministicSkillsClient`) — use this reader only when that
 * client is not an option (circular dependency, synchronous module-load
 * prompt loading, CLI bootstrap, etc.).
 *
 * Resolution strategy — for `packages/` skills (packageDir), tries in order:
 *   1. path.join(__dirname, "..", "..", packageDir, "skills", skillSlug, "SKILL.md")
 *      (works when @cinatra-ai/skills is imported from its built location under packages/)
 *   2. path.join(process.cwd(), "packages", packageDir, "skills", skillSlug, "SKILL.md")
 *      (fallback for when cwd is the repo root, e.g. Next.js dev server)
 *
 * For extension skills (extensionDir), resolves under
 * `extensions/cinatra-ai/{extensionDir}/skills/{skillSlug}/SKILL.md` with the
 * analogous __dirname-relative and cwd-relative candidates.
 *
 * Returns null if the file cannot be found at any candidate location.
 */
export function readLocalPackageSkillContent(
  input: ReadLocalPackageSkillInput,
): string | null {
  const {
    packageDir,
    extensionDir,
    skillSlug,
    stripFrontmatter: doStrip = false,
  } = input;

  const candidates = extensionDir
    ? [
        path.join(
          __dirname,
          "..",
          "..",
          "..",
          "extensions",
          "cinatra-ai",
          extensionDir,
          "skills",
          skillSlug,
          "SKILL.md",
        ),
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
          path.join(__dirname, "..", "..", packageDir, "skills", skillSlug, "SKILL.md"),
          path.join(process.cwd(), "packages", packageDir, "skills", skillSlug, "SKILL.md"),
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
