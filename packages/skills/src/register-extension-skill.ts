import { existsSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./skills-registry";
import { upsertSkill } from "./skills-store";
// The CANONICAL bundle walker — the SAME function `captureSkillBundleFromDisk`
// reads a skill directory with (cinatra#2274). Reused rather than twinned on
// purpose: the writer's recorded manifest and the capture's recomputed one have
// to agree over the same directory, and calling one function is the only way to
// make the skip rules (symlinks, `.git`/`node_modules`) agree by construction
// instead of by a drift test. `@cinatra-ai/skills` already reaches this module
// through `@/lib/database`, so the direct edge adds no route-graph module.
import {
  bundleDigestForFiles,
  materializeRevisionBundleToDirectory,
  readAuthorityBundleHeadState,
  readSkillDirectoryAsBundleFiles,
  type BundleFileInput,
} from "@/lib/skill-bundle-store";
import { resolveUpsertBundleFiles } from "./skill-source";

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
 * ONE SNAPSHOT of the source bundle directory, feeding BOTH the catalog payload
 * and the recorded content authority (cinatra#2274; the same discipline
 * cinatra#2265's CLI writer adopted).
 *
 * Reading `SKILL.md` a second time for the payload would let a concurrent edit
 * commit an immutable revision whose stored content disagreed with its own
 * manifest — and `skill_revisions` is append-only, so nothing could heal that
 * pairing afterwards. Deriving both from the same bytes makes them agree by
 * construction: the router body handed to `upsertSkill` as `content` IS the
 * router entry the manifest is framed from.
 *
 * Fails CLOSED (the walker throws on an absent router or an unreadable file), so
 * the fail-soft per-skill registration loop skips the skill rather than
 * recording a partial bundle as its authority.
 */
async function readSourceBundleSnapshot(
  skillMdPath: string,
): Promise<{ content: string; bundleFiles: BundleFileInput[] }> {
  const bundleFiles = await readSkillDirectoryAsBundleFiles(skillMdPath);
  const router =
    bundleFiles.find((f) => f.isRouter) ?? bundleFiles.find((f) => f.path === "SKILL.md");
  if (!router) {
    // Unreachable — the walker already throws on a router-less directory. Kept
    // as a fail-closed assertion rather than a non-null assertion.
    throw new Error(`readSourceBundleSnapshot: no SKILL.md router under ${skillMdPath}`);
  }
  return { content: router.bytes.toString("utf8"), bundleFiles };
}

/**
 * IN-PROCESS SERIALIZATION per skill id (codex round-1 finding #4).
 *
 * Five call sites reach this writer — the dev boot/watcher scan, the
 * artifact-extension branch, the lazy matcher-skill healer, the two lazy
 * resolvers (one of them from `ensureAssistantSkillsRegistered` on a chat turn)
 * — plus the `llm-bridge` route. Two of them overlapping on the SAME skill would
 * interleave a DB transaction against a directory materialization belonging to a
 * different snapshot, so the last catalog write need not be the one whose bytes
 * ended up on disk.
 *
 * A promise chain keyed by skill id makes every registration of one skill run to
 * completion before the next starts, which removes the realistic interleaving
 * (all of the above run in ONE Node process). It is NOT a cross-process lock —
 * two app instances sharing a storage volume are still unserialized; the
 * post-condition below is what makes that case LOUD rather than silent.
 */
const registrationChains = new Map<string, Promise<unknown>>();
function serializeBySkillId<T>(skillId: string, run: () => Promise<T>): Promise<T> {
  const prior = registrationChains.get(skillId) ?? Promise.resolve();
  const next = prior.then(run, run);
  // Never rejects: the chain link only ORDERS the next call. The caller still
  // sees `next`'s rejection, and `.then(run, run)` above runs the successor
  // either way, so one failed registration cannot wedge the skill's queue.
  const link = next.then(
    () => undefined,
    () => undefined,
  );
  registrationChains.set(skillId, link);
  // Drop the entry once this link is still the TAIL, so the map does not grow
  // one entry per skill for the process lifetime (codex round-2 finding #3).
  void link.then(() => {
    if (registrationChains.get(skillId) === link) registrationChains.delete(skillId);
  });
  return next;
}

/**
 * DELIVER the recorded bundle to the canonical directory, then PROVE the whole
 * registration.
 *
 * Why the delivered copy is materialized FROM THE AUTHORITY rather than copied
 * out of the source tree (codex round-1 #2/#5/#7 and round-2 #1/#2/#5 — closed
 * by construction rather than narrowed):
 *
 *   - the bytes come from the CONTENT-ADDRESSED BLOBS the transaction just
 *     committed, so the delivered directory cannot disagree with the manifest —
 *     not even when the SOURCE tree changed between the snapshot and now, which
 *     a re-reading copy could never rule out;
 *   - `materializeRevisionBundleToDirectory` stages into a sibling temp dir and
 *     RENAMES it into place, so a reader never observes a half-written bundle and
 *     the directory is REPLACED rather than accumulated into — which is what
 *     makes a `references/*` dropped upstream leave no residue;
 *   - it never walks a hostile destination tree: the old directory goes through
 *     one `rm -r` (which lstats and unlinks a symlink instead of descending
 *     through it) rather than a hand-rolled recursive traversal whose `Dirent`
 *     kinds go stale across awaits.
 *
 * The catalog + lifecycle transaction still commits BEFORE anything reaches
 * disk (the storage path is derived inside `upsertSkill`, and the filesystem is
 * not transactional), and the redundancy check reads the head one statement
 * earlier than the write that acts on its answer. Neither is closable here — so
 * the writer PROVES its result instead and refuses to claim a success it did not
 * achieve: the head must be its own authority carrying exactly this bundle
 * identity, with the lifecycle pointer on the same revision (codex round-2
 * finding #4), and the canonical directory must WALK BACK to that identity.
 *
 * A mismatch throws, so the fail-soft per-skill loop reports the skill as NOT
 * registered (and the lazy resolver's id check fails) rather than leaving a head
 * that describes bytes nobody can read. Registration is idempotent, so the next
 * boot / lazy resolve / watcher event re-drives it.
 */
async function deliverAndVerifyRecordedBundle(
  who: string,
  skillId: string,
  sourcePath: string,
  content: string,
  bundleFiles: BundleFileInput[],
): Promise<void> {
  const expected = bundleDigestForFiles(resolveUpsertBundleFiles(content, bundleFiles));
  /** Throws unless the skill's head is THIS registration's authority. */
  const assertHead = (when: string) => {
    const head = readAuthorityBundleHeadState(skillId);
    if (
      !head ||
      !head.isAuthorityOwned ||
      head.headBundleDigest !== expected ||
      head.activeRevisionId !== head.headRevisionId
    ) {
      throw new Error(
        `${who}: ${skillId} ${when} not under its own authority head (expected bundle ${expected}, ` +
          `found ${head ? `${head.headRevisionId}/${head.headBundleDigest} active=${head.activeRevisionId}` : "no head"}) — ` +
          `refusing to report a registration whose content authority is not the bundle just read`,
      );
    }
    return head;
  };
  // BEFORE: fail fast, and never materialize over a head that is already
  // somebody else's.
  const head = assertHead("was");
  const skillDir = path.dirname(sourcePath);
  // Steady state — the overwhelmingly common boot path — is a pure READ: the
  // canonical directory already IS the recorded bundle, so nothing is rewritten
  // and no blob is fetched. Only real drift pays for the materialization.
  if (!(await canonicalDirMatches(sourcePath, expected))) {
    await materializeRevisionBundleToDirectory(skillId, head.headRevisionId, skillDir);
    if (!(await canonicalDirMatches(sourcePath, expected))) {
      throw new Error(
        `${who}: ${skillId} recorded bundle ${expected} but its canonical directory ${skillDir} ` +
          `does not walk back to it after materialization — the delivered surface and the ` +
          `content authority disagree, so a later capture would report an unresolvable divergence`,
      );
    }
  }
  // AFTER: re-read the head (codex round-3 finding #1). A CROSS-PROCESS writer —
  // the one case `serializeBySkillId` cannot order — could have committed its own
  // authority while this one was materializing, leaving the head on its revision
  // and the directory on ours. Re-asserting here means such a run REFUSES rather
  // than reporting a success whose disk copy the authority does not describe.
  //
  // Stated honestly: this makes the losing writer loud, it does not make the
  // interleaving impossible. The winner may already have returned, so the shared
  // volume can still hold the loser's bytes for a moment; the next registration
  // (boot re-scan, watcher event, lazy resolve) re-materializes from the head,
  // and until then `captureSkillBundleFromDisk` reports the divergence rather
  // than advancing anything. Closing it outright needs a cross-process lock,
  // which this writer does not have.
  assertHead("ended");
}

/** Whether walking the canonical skill dir reproduces `expected`. A directory
 * that cannot be walked at all (no router yet, an unreadable leaf) counts as NOT
 * matching, so the caller materializes rather than raising. */
async function canonicalDirMatches(sourcePath: string, expected: string): Promise<boolean> {
  try {
    return bundleDigestForFiles(await readSkillDirectoryAsBundleFiles(sourcePath)) === expected;
  } catch {
    return false;
  }
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
 * boot / chat preflight; cheap and self-healing for existing DBs — and since
 * cinatra#2274 idempotent in the CONTENT AUTHORITY too: a re-registration whose
 * bundle bytes already match records no fresh revision and leaves the head where
 * it stands.
 */
export async function registerExtensionSkill(input: {
  /** Canonical skill id, e.g. "@cinatra-ai/chat:chat-assistant". */
  skillId: string;
  /** Owning package, e.g. "@cinatra-ai/chat". */
  packageName: string;
  /** Absolute path to the package-bundled SKILL.md. */
  skillMdPath: string;
}): Promise<{ id: string; sourcePath: string }> {
  return serializeBySkillId(input.skillId, () => registerExtensionSkillUnserialized(input));
}

async function registerExtensionSkillUnserialized(input: {
  skillId: string;
  packageName: string;
  skillMdPath: string;
}): Promise<{ id: string; sourcePath: string }> {
  if (!existsSync(input.skillMdPath)) {
    throw new Error(
      `registerExtensionSkill: SKILL.md not found at ${input.skillMdPath}`,
    );
  }
  const { content, bundleFiles } = await readSourceBundleSnapshot(input.skillMdPath);
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
    // CONTENT AUTHORITY for the REAL bundle (cinatra#2274). Without this the
    // recorded revision is a bundle of ONE with a non-NULL `bundle_digest` and an
    // authority-owned head over it, while the package ships a router PLUS its
    // one-hop `references/*` — so every later capture returns
    // `authorityOwnedDivergence` and can never advance the head, S2's fail-closed
    // one-hop lint refuses the skill as an upload candidate, and cinatra#2254's
    // honesty rule turns that into a FAILED `initial-sync` on a fresh instance.
    bundleFiles,
  });

  const sourcePath = (upserted as { sourcePath?: string }).sourcePath;
  if (!sourcePath) {
    throw new Error(
      `registerExtensionSkill: ${input.skillId} upserted without a sourcePath — ` +
        `skills-layer invariant violated (shell-tool delivery requires an on-disk path)`,
    );
  }

  // Delivered-surface completeness (cinatra#2090 S3): the bundle's
  // `references/**` must sit beside the stored SKILL.md, because the shell tool
  // serves a router's one-hop reference reads from the CANONICAL dir. Since
  // cinatra#2274 that copy is materialized from the AUTHORITY the write above
  // just recorded — and the result is PROVEN, not assumed. Throws on any
  // mismatch, so the fail-soft caller skips the skill rather than reporting a
  // registration whose delivered surface is broken.
  await deliverAndVerifyRecordedBundle(
    "registerExtensionSkill",
    upserted.id,
    sourcePath,
    content,
    bundleFiles,
  );

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
 *
 * SHARES the cinatra#2274 defect and therefore the fix. cinatra#2274 flagged
 * this writer as "adjacent, same shape, not measured" and asked for it to be
 * CHECKED rather than assumed either way: re-read, it handed `upsertSkill` the
 * router body alone in exactly the same way, so an agent package shipping
 * `references/*` would get the same bundle-of-one authority head and the same
 * permanent refusal. It gets the same whole-bundle record — and, newly, the same
 * asset mirror, because recording a multi-file manifest without materializing
 * those files beside the stored SKILL.md would diverge the skill on the very
 * next capture (and leave the router's one-hop reads dead for the shell tool).
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
  return serializeBySkillId(input.skillId, () => registerPackageAgentSkillUnserialized(input));
}

async function registerPackageAgentSkillUnserialized(input: {
  skillId: string;
  packageName: string;
  skillMdPath: string;
  agentId: string;
}): Promise<{ id: string; sourcePath: string }> {
  if (!existsSync(input.skillMdPath)) {
    throw new Error(
      `registerPackageAgentSkill: SKILL.md not found at ${input.skillMdPath}`,
    );
  }
  const { content, bundleFiles } = await readSourceBundleSnapshot(input.skillMdPath);
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
    // Same content authority as the workspace writer (cinatra#2274).
    bundleFiles,
  });

  const sourcePath = (upserted as { sourcePath?: string }).sourcePath;
  if (!sourcePath) {
    throw new Error(
      `registerPackageAgentSkill: ${input.skillId} upserted without a sourcePath — ` +
        `skills-layer invariant violated (shell-tool delivery requires an on-disk path)`,
    );
  }
  // Same delivery + proof as the workspace writer. A pure read for the
  // single-file agent bundles that ship today (their canonical dir already IS
  // the recorded bundle), so nothing on disk changes for them.
  await deliverAndVerifyRecordedBundle(
    "registerPackageAgentSkill",
    upserted.id,
    sourcePath,
    content,
    bundleFiles,
  );
  return { id: upserted.id, sourcePath };
}
