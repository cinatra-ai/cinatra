/**
 * Read-only skill staging (exec-plane S2, cinatra#1707).
 *
 * Stages catalog-resolved skill snapshots as an immutable, read-only input
 * under the virtual `/skills/<slug>` paths inside the sandbox:
 *
 *  - content arrives as DATA (file bytes + sha256 digests) from the app layer —
 *    there are NO host bind mounts (the no-bind-mount invariant holds; the
 *    staging volume is a named docker volume like the L2 workspace);
 *  - every file's digest is RE-VERIFIED here before it is written (a corrupted
 *    or tampered descriptor refuses the whole staging, fail-closed);
 *  - staged paths are strictly relative and traversal-free (fail-closed);
 *  - the volume is populated once per job via `docker create` + `docker cp`
 *    from a transient host temp directory (a copy, not a mount), then mounted
 *    READ-ONLY at /skills by the run profile — the sandbox cannot modify a
 *    snapshot;
 *  - volumes carry the same retention label as L2 workspaces (a distinct tier
 *    value) so the existing retention GC reaps strays; the broker removes the
 *    volume on job termination best-effort.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runDocker, type DockerCli } from "./docker-cli";
import { WORKSPACE_LABEL } from "./workspace";
import type { StagedSkillInput } from "./types";

export const SKILLS_VOLUME_PREFIX = "cinatra-exec-skills-";
/** In-sandbox mount point for staged skill snapshots (read-only). */
export const SANDBOX_SKILLS_DIR = "/skills";

export class SkillStagingError extends Error {}

export function skillsVolumeName(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `${SKILLS_VOLUME_PREFIX}${safe}`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Refuse a staged file path that is absolute, traversal-capable, or carries
 * backslashes / NUL — the staged tree must stay strictly under its slug root.
 */
function assertSafeRelativePath(slug: string, filePath: string): void {
  if (
    filePath.length === 0 ||
    path.isAbsolute(filePath) ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath
      .split("/")
      .some((seg) => seg === ".." || seg === "" || seg === ".")
  ) {
    throw new SkillStagingError(
      `Refusing unsafe staged file path "${filePath}" for skill "${slug}".`,
    );
  }
}

/**
 * Create + populate the per-job read-only skills volume. Returns the volume
 * name. Throws `SkillStagingError` (fail-closed — the broker refuses the job)
 * on digest mismatch, unsafe path, or docker failure.
 */
export async function stageSkillsVolume(
  jobId: string,
  skills: StagedSkillInput[],
  imageRef: string,
  docker: DockerCli = runDocker,
): Promise<string> {
  const volumeName = skillsVolumeName(jobId);

  // 1. Validate + digest-verify EVERYTHING before any side effect.
  const seenSlugs = new Set<string>();
  for (const skill of skills) {
    if (!SLUG_RE.test(skill.slug)) {
      throw new SkillStagingError(`Refusing unsafe skill slug "${skill.slug}".`);
    }
    if (seenSlugs.has(skill.slug)) {
      throw new SkillStagingError(
        `Duplicate staged skill slug "${skill.slug}" (staging paths would collide).`,
      );
    }
    seenSlugs.add(skill.slug);
    for (const file of skill.files) {
      assertSafeRelativePath(skill.slug, file.path);
      const actual = createHash("sha256").update(file.content, "utf8").digest("hex");
      if (actual !== file.digest) {
        throw new SkillStagingError(
          `Digest mismatch for staged skill file /skills/${skill.slug}/${file.path} ` +
            `(expected ${file.digest}, computed ${actual}) — refusing to stage (fail-closed).`,
        );
      }
    }
  }

  // 2. Materialize the tree in a transient host temp dir (copied, never mounted).
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "cinatra-skill-stage-"));
  let containerId: string | null = null;
  try {
    for (const skill of skills) {
      for (const file of skill.files) {
        const target = path.join(stagingRoot, skill.slug, file.path);
        // Belt-and-suspenders on top of assertSafeRelativePath.
        if (!target.startsWith(stagingRoot + path.sep)) {
          throw new SkillStagingError(
            `Staged path escaped the staging root for skill "${skill.slug}".`,
          );
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
    }

    // 3. Create the labeled volume.
    const created = await docker([
      "volume",
      "create",
      "--label",
      `${WORKSPACE_LABEL}=skills`,
      "--label",
      `${WORKSPACE_LABEL}.createdAt=${Date.now()}`,
      volumeName,
    ]);
    if (created.exitCode !== 0) {
      throw new SkillStagingError(
        `Failed to create skills volume ${volumeName}: ${created.stderr.trim()}`,
      );
    }

    // 4. Populate via docker create + docker cp (a copy — no bind mount; the
    //    helper container never RUNS, it only anchors the volume for cp).
    const helperName = `cinatra-exec-stage-${randomUUID()}`;
    const create = await docker([
      "create",
      "--name",
      helperName,
      "--network",
      "none",
      "--volume",
      `${volumeName}:${SANDBOX_SKILLS_DIR}`,
      "--",
      imageRef,
      "true",
    ]);
    if (create.exitCode !== 0) {
      throw new SkillStagingError(
        `Failed to create staging helper container: ${create.stderr.trim()}`,
      );
    }
    containerId = helperName;
    const cp = await docker([
      "cp",
      `${stagingRoot}/.`,
      `${helperName}:${SANDBOX_SKILLS_DIR}`,
    ]);
    if (cp.exitCode !== 0) {
      throw new SkillStagingError(
        `Failed to populate skills volume ${volumeName}: ${cp.stderr.trim()}`,
      );
    }
    return volumeName;
  } catch (err) {
    // Fail-closed cleanup: never leave a half-populated skills volume behind.
    // Order matters — the helper container must go BEFORE the volume (docker
    // refuses to remove a volume a container still references; runDocker
    // reports failures via exitCode, it never rejects).
    if (containerId) {
      await docker(["rm", "-f", containerId]);
      containerId = null;
    }
    await docker(["volume", "rm", "-f", volumeName]);
    throw err;
  } finally {
    if (containerId) await docker(["rm", "-f", containerId]);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** Best-effort removal (job termination / teardown). */
export async function removeSkillsVolume(
  volumeName: string,
  docker: DockerCli = runDocker,
): Promise<void> {
  await docker(["volume", "rm", "-f", volumeName]);
}
