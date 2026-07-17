/**
 * L2 per-run workspace management (exec-plane S1, cinatra#1706).
 *
 * The L2 workspace is a named docker volume mounted read-write at /workspace —
 * the ONLY writable persistence a sandbox has. It follows the RUN: keyed on
 * `runId` when the session carries one (agent runs — installs persist across
 * steps/turns within the run) and on the broker jobId otherwise (chat /
 * deterministic tasks — the assistant runtime holds one job per conversation
 * turn-context). It NEVER leaks into other agents or future runs: a new key is
 * a fresh, empty volume.
 *
 * Volumes are labeled for retention GC — workspace GC is a retention concern,
 * not a lifecycle transition (mirrors the platform's digest-GC doctrine). Hard
 * removal of a run puts its workspace on immediate GC via the broker teardown
 * hook.
 */

import { runDocker, type DockerCli } from "./docker-cli";

export const WORKSPACE_VOLUME_PREFIX = "cinatra-exec-l2-";
export const WORKSPACE_LABEL = "ai.cinatra.execution-plane";

export function workspaceVolumeName(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `${WORKSPACE_VOLUME_PREFIX}${safe}`;
}

export async function ensureWorkspaceVolume(
  key: string,
  docker: DockerCli = runDocker,
): Promise<string> {
  const name = workspaceVolumeName(key);
  const outcome = await docker([
    "volume",
    "create",
    "--label",
    `${WORKSPACE_LABEL}=l2`,
    "--label",
    `${WORKSPACE_LABEL}.createdAt=${Date.now()}`,
    name,
  ]);
  if (outcome.exitCode !== 0) {
    throw new Error(
      `Failed to create L2 workspace volume ${name}: ${outcome.stderr.trim()}`,
    );
  }
  return name;
}

export async function removeWorkspaceVolume(
  volumeName: string,
  docker: DockerCli = runDocker,
): Promise<void> {
  await docker(["volume", "rm", "-f", volumeName]);
}

/**
 * Measure the workspace's total size in KiB with a minimal, network-less,
 * read-only helper container over the L0 image (`du -sk /workspace`). This is
 * the enforcement half of the disk quota that a per-file ulimit cannot cover
 * (many small files): the worker runs it after every command and the broker
 * terminates the job when the total crosses the quota.
 */
export async function measureWorkspaceKb(
  volumeName: string,
  imageRef: string,
  docker: DockerCli = runDocker,
): Promise<number> {
  const outcome = await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--user",
      "10001:10001",
      "--volume",
      `${volumeName}:/workspace:ro`,
      imageRef,
      "du",
      "-sk",
      "/workspace",
    ],
    { timeoutMs: 30_000 },
  );
  if (outcome.exitCode !== 0) {
    throw new Error(
      `Failed to measure workspace ${volumeName}: ${outcome.stderr.trim()}`,
    );
  }
  const kb = Number(outcome.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(kb)) {
    throw new Error(
      `Unparseable du output for workspace ${volumeName}: ${outcome.stdout.trim()}`,
    );
  }
  return kb;
}

/** List execution-plane workspace volumes (name + createdAt label). */
export async function listWorkspaceVolumes(
  docker: DockerCli = runDocker,
): Promise<Array<{ name: string; createdAtMs: number | null }>> {
  const outcome = await docker([
    "volume",
    "ls",
    "--filter",
    `label=${WORKSPACE_LABEL}=l2`,
    "--format",
    "{{.Name}}|{{.Labels}}",
  ]);
  if (outcome.exitCode !== 0) return [];
  return outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, labels = ""] = line.split("|");
      // Docker `{{.Labels}}` renders `key=value,key2=value2` — parse by
      // prefix match instead of a regex built from the label constant
      // (string-built regexes need exhaustive metacharacter escaping;
      // CodeQL js/incomplete-sanitization).
      const createdAtPrefix = `${WORKSPACE_LABEL}.createdAt=`;
      const createdAtEntry = labels
        .split(",")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(createdAtPrefix));
      const raw = createdAtEntry?.slice(createdAtPrefix.length) ?? "";
      const createdAtMs = /^\d+$/.test(raw) ? Number(raw) : null;
      return { name, createdAtMs };
    });
}

/**
 * Retention GC: remove labeled workspace volumes older than `retentionMs`.
 * Volumes still attached to a running container are skipped by docker itself
 * (`volume rm` fails while in use — we tolerate that failure silently).
 */
export async function gcExpiredWorkspaces(
  retentionMs: number,
  docker: DockerCli = runDocker,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const volumes = await listWorkspaceVolumes(docker);
  const removed: string[] = [];
  for (const volume of volumes) {
    if (volume.createdAtMs === null) continue;
    if (nowMs - volume.createdAtMs < retentionMs) continue;
    const outcome = await docker(["volume", "rm", volume.name]);
    if (outcome.exitCode === 0) removed.push(volume.name);
  }
  return removed;
}
