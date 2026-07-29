import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./skills-registry";
import { upsertSkill } from "./skills-store";

/**
 * Mirror the NON-SKILL.md files of a source bundle dir (references/**, and any
 * other co-shipped assets) into the canonical storage dir beside the stored
 * SKILL.md (cinatra#2090 S3 fold, delivered-surface completeness).
 *
 * Why: `upsertSkill` writes ONLY the SKILL.md body into the canonical copy,
 * but the shell tool serves reads from the canonical dir
 * (`dirname(sourcePath)`), and a router SKILL.md points the model at
 * `references/<slug>.md` one hop away. Without this mirror every consolidated
 * router registers with a body that promises references the canonical dir
 * does not contain (pre-existing for chat-agent-authoring's deep-dives;
 * load-bearing for ALL five successor routers after the fold).
 *
 * Fail-closed on symlinks (same posture as the store's dangling-leaf
 * confinement: nothing outside the source bundle can be pulled in, nothing
 * outside the storage dir can be written through); IO errors throw so the
 * fail-soft per-skill registration loop skips the skill entirely rather than
 * registering a router with missing references.
 */
export async function mirrorSkillBundleAssets(
  sourceBundleDir: string,
  storageBundleDir: string,
): Promise<void> {
  const src = path.resolve(sourceBundleDir);
  const dest = path.resolve(storageBundleDir);
  if (!existsSync(src) || src === dest) return;

  /** lstat that treats ENOENT as "absent" and rethrows anything else. */
  function lstatOrNull(p: string) {
    try {
      return lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function copyDir(fromDir: string, toDir: string, isRoot: boolean): Promise<void> {
    const entries = await readdir(fromDir, { withFileTypes: true });
    for (const entry of entries) {
      // The SKILL.md leaf is owned by `upsertSkill` (it writes the catalog
      // body); never overwrite it from here.
      if (isRoot && entry.name === "SKILL.md") continue;
      const from = path.join(fromDir, entry.name);
      const to = path.join(toDir, entry.name);
      if (entry.isSymbolicLink()) continue; // fail-closed: never follow links
      if (entry.isDirectory()) {
        // Never DESCEND through a pre-existing symlinked directory in the
        // storage tree either — a linked `references/` (or deeper) would
        // redirect every copied leaf outside the canonical dir.
        const destStat = lstatOrNull(to);
        if (destStat?.isSymbolicLink()) {
          throw new Error(
            `mirrorSkillBundleAssets: refusing to write through symlinked directory ${to}`,
          );
        }
        await mkdir(to, { recursive: true });
        await copyDir(from, to, false);
        continue;
      }
      if (!entry.isFile()) continue;
      // Never write THROUGH a pre-existing symlink leaf in the storage dir.
      if (lstatOrNull(to)?.isSymbolicLink()) {
        throw new Error(
          `mirrorSkillBundleAssets: refusing to write through symlink leaf ${to}`,
        );
      }
      await copyFile(from, to);
    }
  }

  await copyDir(src, dest, true);
}

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
 * this storage path — that's why an allowlisted chat successor package like
 * `chat-assistant-core-skill` (registered under `@cinatra-ai/chat` for
 * runtime auth carve-out reasons) still lands under
 * `cinatra-ai/chat-assistant-core-skill/` on disk, mirroring its source dir.
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
  // `data/skills/workspace/cinatra-ai/chat-assistant-core-skill/skills/<slug>/`),
  // not the packageName-slugified flat path (`cinatra-ai-chat/`). The skillId
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

  // Delivered-surface completeness (cinatra#2090 S3): mirror the bundle's
  // references/** beside the stored SKILL.md so a router's one-hop reference
  // reads resolve through the shell tool. Throws on failure — the fail-soft
  // caller then skips the skill instead of registering a broken router.
  await mirrorSkillBundleAssets(path.dirname(input.skillMdPath), path.dirname(sourcePath));

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

  // Do NOT derive a storagePackagePath from the SKILL.md path here. For an
  // AGENT-bound skill the on-disk layout is the FIXED, canonical
  // `workspace/~agents/<vendor>/<package>/<skill>` — the shape the binding
  // resolver (`resolveSkillDir`), the disk scanner (`walkAgentsBucket`), and the
  // SQL relocation trigger all read back. `deriveStoragePackagePathFromSkillMd`
  // mirrors the FULL source tree (e.g. `<vendor>/<agent>/skills` for a
  // co-located `extensions/<vendor>/<agent>/skills/<slug>/SKILL.md` bundle) — a
  // 3-segment slug that is correct for the WORKSPACE mirror
  // (`registerExtensionSkill`) but wrong for the `~agents` layout: its
  // intermediate `skills/` segment makes `getSkillDiskDir`'s agent case split
  // into a multi-segment `pkg` (`<agent>/skills`) that `assertSafePathSegment`
  // rejects, so every co-located agent bundle failed to register (cinatra#1088).
  // Instead, omit storagePackagePath so `upsertSkill` derives the canonical
  // `<vendor>/<package>` from the scoped `packageName` (via
  // `deriveAgentStoragePathFromPackageName`) — collapsing the source `skills/`
  // grouping and matching what the read/scan/relocate side expects.
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
