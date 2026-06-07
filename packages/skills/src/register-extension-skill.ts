import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./skills-registry";
import { upsertSkill } from "./skills-store";

/**
 * Derive a source-mirroring storage path from the absolute SKILL.md path.
 * Mirrors EVERYTHING above the final `<slug>/SKILL.md`, so the on-disk
 * layout under `data/skills/workspace/` is a 1:1 mirror of the source package
 * structure under `extensions/`:
 *
 *   src:     <repo>/extensions/<vendorDir>/<pkgDir>/skills/<slug>/SKILL.md
 *   storage: data/skills/workspace/<vendorDir>/<pkgDir>/skills/<slug>/SKILL.md
 *
 *   src:     <repo>/extensions/<vendorDir>/<agentDir>/skills/<sub>/SKILL.md
 *   storage: data/skills/workspace/<vendorDir>/<agentDir>/skills/<sub>/SKILL.md
 *
 *   src:     <repo>/extensions/<vendorDir>/<pkgDir>/skills/<cat>/<slug>/SKILL.md
 *   storage: data/skills/workspace/<vendorDir>/<pkgDir>/skills/<cat>/<slug>/SKILL.md
 *
 * Strategy: split the post-`extensions/` rel-path, drop the LAST TWO
 * segments (`<slug>/SKILL.md`), and join the rest with `/`. This naturally
 * preserves the `skills/` intermediate (and any deeper grouping) without
 * hard-coding it. The leaf `<slug>` is added by `getSkillDiskDir` per
 * its `skillSlug` argument so the full path comes out right.
 *
 * The skillId namespace (e.g. `@cinatra-ai/chat:<slug>`) is independent of
 * this storage path — that's why a special-cased package like
 * `assistant-skills` (registered under `@cinatra-ai/chat` for runtime auth
 * carve-out reasons) still lands under `cinatra-ai/assistant-skills/` on
 * disk, mirroring its source dir.
 *
 * Returns null when the SKILL.md does not live under an
 * `extensions/<v>/<p>/.../SKILL.md` tree (e.g. legacy or test fixtures);
 * the caller falls back to the packageName-derived path (existing behavior).
 */
export function deriveStoragePackagePathFromSkillMd(
  skillMdPath: string,
): string | null {
  const normalized = path.resolve(skillMdPath);
  const sep = path.sep;
  const marker = `${sep}extensions${sep}`;
  const ix = normalized.indexOf(marker);
  if (ix < 0) return null;
  const rel = normalized.slice(ix + marker.length);
  const parts = rel.split(sep);
  // Need at least <vendor>/<pkg>/<slug>/SKILL.md = 4 segments. Drop the
  // last two (<slug>/SKILL.md) and keep every prefix segment so the
  // intermediate `skills/` (and any deeper grouping) is preserved.
  if (parts.length < 4) return null;
  const prefix = parts.slice(0, -2);
  if (prefix.some((p) => !p)) return null;
  return prefix.join("/");
}

/**
 * Register a package-bundled SYSTEM skill (e.g. the chat assistant at
 * `packages/chat/skills/chat-assistant/SKILL.md`) into the skills layer.
 *
 * Why this exists: the skills layer is the ONLY supported skill-consumption
 * path. `buildSkillTools` delivers a skill to the LLM via the shell tool
 * iff the resolved skill has an on-disk `sourcePath` (otherwise it falls
 * back to the disallowed `read_skill` function tool). Skill discovery only
 * scans `agents/<slug>/skills/` and the GitHub data root (`data/skills/`);
 * a package-bundled system skill lives in neither, so it must be explicitly
 * registered to resolve with a `sourcePath`.
 *
 * `upsertSkill` is the canonical registration API — it writes the SKILL.md
 * into the skills data root and records a real `sourcePath`. This helper
 * mirrors `compileAndRegisterAgentSkillsForRepo`'s `upsertSkill` call shape
 * but with package-bundled system-skill inputs.
 *
 * Idempotent: `upsertSkill` upserts by `skillId`. Safe to call on every
 * boot / chat preflight; cheap and self-healing for existing DBs.
 */
export async function registerExtensionSkill(input: {
  /** Canonical skill id, e.g. "@cinatra-ai/chat:chat-assistant". */
  skillId: string;
  /** Owning package, e.g. "@cinatra-ai/chat". */
  packageName: string;
  /** Absolute path to the package-bundled SKILL.md. */
  skillMdPath: string;
}): Promise<{ id: string; sourcePath: string }> {
  if (!existsSync(input.skillMdPath)) {
    throw new Error(
      `registerExtensionSkill: SKILL.md not found at ${input.skillMdPath}`,
    );
  }
  const content = await readFile(input.skillMdPath, "utf8");
  const { attributes } = parseFrontmatter(content);
  const attrs = attributes as Record<string, string>;
  const name = attrs.name?.trim() || input.skillId;
  const description = attrs.description?.trim() || "";

  // Derive a source-mirroring storage path so the on-disk layout mirrors the
  // source package directory (e.g.
  // `data/skills/workspace/cinatra-ai/assistant-skills/<slug>/`), not the
  // packageName-slugified flat path (`cinatra-ai-chat/`). The skillId
  // namespace stays whatever the caller passed.
  const storagePackagePath =
    deriveStoragePackagePathFromSkillMd(input.skillMdPath) ?? undefined;

  const upserted = await upsertSkill({
    // Register at WORKSPACE level, not "system": system-level rows are
    // admin-visibility-gated, which means non-admin chat users can miss the
    // catalog row and fall back to read_skill. Workspace level plus the
    // requireResourceAccess read/manage split lets every workspace user
    // resolve the chat skill via the catalog and get the shell tool. The
    // function name retains "System" to match its package-bundled role.
    type: "workspace",
    packageName: input.packageName,
    name,
    description,
    content,
    skillId: input.skillId,
    storagePackagePath,
    // Not a user-facing chat skill that needs badge generation.
    prefillText: "-",
  });

  const sourcePath = (upserted as { sourcePath?: string }).sourcePath;
  if (!sourcePath) {
    throw new Error(
      `registerExtensionSkill: ${input.skillId} upserted without a sourcePath — ` +
        `skills-layer invariant violated (shell-tool delivery requires an on-disk path)`,
    );
  }
  return { id: upserted.id, sourcePath };
}

/**
 * Register a package-bundled skill at `level:"agent"` with
 * `agentId:<owningAgent>`. This is the companion to
 * `registerExtensionSkill` for `kind:"agent"` extensions whose
 * `skills/<slug>/SKILL.md` files belong to a SPECIFIC owning agent.
 *
 * Why a separate function: `resolveForAgent`'s **direct self-match** in
 * `agents-store.ts:1075` matches `level:"agent"` + `agentId === <agentId>`
 * (or NPM-suffix match) deterministically — no `skill_matches` row required,
 * no LLM batch matcher run required, no `requireResourceAccess` workspace
 * filtering. This is the only registration shape that reliably delivers a
 * methodology skill to its owning agent on a dev-fresh DB.
 *
 * Idempotent (upsertSkill upserts by `skillId`).
 */
export async function registerPackageAgentSkill(input: {
  /** Canonical skill id, e.g. "@cinatra-ai/security-reviewer-agent:security-review-methodology". */
  skillId: string;
  /** Owning package, e.g. "@cinatra-ai/security-reviewer-agent". */
  packageName: string;
  /** Absolute path to the package-bundled SKILL.md. */
  skillMdPath: string;
  /**
   * The owning agent's packageName (`@cinatra-ai/<slug>-agent`). Wired into
   * the catalog row as `agentId` so `resolveForAgent`'s direct-self-match
   * picks the skill up for THIS agent only.
   */
  agentId: string;
}): Promise<{ id: string; sourcePath: string }> {
  if (!existsSync(input.skillMdPath)) {
    throw new Error(
      `registerPackageAgentSkill: SKILL.md not found at ${input.skillMdPath}`,
    );
  }
  const content = await readFile(input.skillMdPath, "utf8");
  const { attributes } = parseFrontmatter(content);
  const attrs = attributes as Record<string, string>;
  const name = attrs.name?.trim() || input.skillId;
  const description = attrs.description?.trim() || "";

  const storagePackagePath =
    deriveStoragePackagePathFromSkillMd(input.skillMdPath) ?? undefined;

  const upserted = await upsertSkill({
    // level:"agent" + agentId is picked up by the direct-self-match path,
    // bypassing the LLM matcher and workspace visibility filter while still
    // preserving the direct ownership invariants for agent-bundled skills.
    type: "agent",
    agentId: input.agentId,
    packageName: input.packageName,
    name,
    description,
    content,
    skillId: input.skillId,
    storagePackagePath,
    prefillText: "-",
  });

  const sourcePath = (upserted as { sourcePath?: string }).sourcePath;
  if (!sourcePath) {
    throw new Error(
      `registerPackageAgentSkill: ${input.skillId} upserted without a sourcePath — ` +
        `skills-layer invariant violated (shell-tool delivery requires an on-disk path)`,
    );
  }
  return { id: upserted.id, sourcePath };
}
