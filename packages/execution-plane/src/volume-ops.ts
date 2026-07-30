/**
 * TYPED host-operation seam for the broker (exec-plane L3, epic cinatra#1705).
 *
 * The merged broker provisions its L2 workspace and read-only skills volumes by
 * calling the docker helpers directly with its own `DockerCli`, which is why
 * `broker-entry.ts` has to make the operator acknowledge
 * `EXEC_BROKER_VOLUME_OPS=host-docker`: the broker HOST must genuinely have
 * docker. This module is the seam that lets those operations be performed
 * SOMEWHERE ELSE — on the worker host, which is the only host in the managed
 * topology that is supposed to have a docker socket at all.
 *
 * WHY FOUR TYPED OPERATIONS AND NOT A REMOTE `DockerCli`. Handing a remote
 * `DockerCli` across the broker→worker hop would be a remote
 * arbitrary-docker-argv facility on the worker host: `run --privileged`,
 * `-v /:/host`, `rm -f <anything>`. The whole point of the mTLS boundary is
 * that a compromised broker cannot escalate past the operations it legitimately
 * needs, so the seam is a CLOSED vocabulary of four named operations whose
 * arguments the worker re-validates against its own volume-name policy
 * (`service/volume-guard.ts`). There is deliberately no escape hatch.
 *
 * DEFAULTING IS BYTE-IDENTICAL. `createLocalDockerVolumeOps(docker)` calls the
 * same `workspace.ts` / `staging.ts` helpers with the same `DockerCli` the
 * broker was constructed with, so an in-process local-dev broker that does not
 * configure `volumeOps` emits exactly the docker argv it emitted before this
 * seam existed (pinned by `volume-ops-parity.test.ts`).
 */

import { containerNamePrefixFor } from "./l0-profile";
import { runDocker, type DockerCli } from "./docker-cli";
import { removeSkillsVolume, stageSkillsVolume } from "./staging";
import type { StagedSkillInput } from "./types";
import { ensureWorkspaceVolume, removeWorkspaceVolume } from "./workspace";

/**
 * The volume lifecycles a job needs. Implemented in-process by
 * `createLocalDockerVolumeOps` (local dev / single-host) and over the wire by
 * `WorkerServiceClient` (managed placement) — the broker cannot tell which it
 * holds, exactly as with `SandboxWorker`.
 */
export type SandboxVolumeOps = {
  /** Create (idempotently) the per-run L2 workspace volume; returns its name. */
  ensureWorkspace(workspaceKey: string): Promise<string>;
  /** Best-effort removal of an L2 workspace volume. */
  removeWorkspace(volumeName: string): Promise<void>;
  /** Create + populate the per-job read-only skills volume; returns its name. */
  stageSkills(
    jobId: string,
    skills: StagedSkillInput[],
    imageRef: string,
  ): Promise<string>;
  /** Best-effort removal of a per-job skills volume. */
  removeSkills(volumeName: string): Promise<void>;
};

/**
 * The drain half of host-exclusivity revocation (`service/lease.ts`).
 *
 * Terminating a job is a synchronous flag flip inside the broker — a container
 * that is ALREADY running keeps running, which is precisely the state a revoked
 * host must not be left in. Cancelling by name is therefore a separate,
 * equally-typed operation: it takes a jobId, never a container name or an argv,
 * so a compromised broker cannot use it to remove containers it does not own.
 */
export type SandboxContainerOps = {
  /** Force-remove every container of a job; returns the names removed. */
  cancelJobContainers(jobId: string): Promise<string[]>;
};

/** In-process volume ops over a local docker daemon (the merged behaviour). */
export function createLocalDockerVolumeOps(docker?: DockerCli): SandboxVolumeOps {
  const cli = docker ?? runDocker;
  return {
    ensureWorkspace: (workspaceKey) => ensureWorkspaceVolume(workspaceKey, cli),
    removeWorkspace: (volumeName) => removeWorkspaceVolume(volumeName, cli),
    stageSkills: (jobId, skills, imageRef) =>
      stageSkillsVolume(jobId, skills, imageRef, cli),
    removeSkills: (volumeName) => removeSkillsVolume(volumeName, cli),
  };
}

/**
 * In-process container cancellation over a local docker daemon.
 *
 * The docker `name` filter is a REGEX matched unanchored, and a sanitized jobId
 * may legitimately contain `.` (a regex wildcard), so the filter is only a
 * cheap server-side narrowing: every returned name is re-checked in JS with a
 * literal `startsWith` before anything is removed. A container whose name the
 * daemon returned but that does not literally carry this job's prefix is left
 * alone.
 */
export function createLocalDockerContainerOps(
  docker?: DockerCli,
): SandboxContainerOps {
  const cli = docker ?? runDocker;
  return {
    async cancelJobContainers(jobId: string): Promise<string[]> {
      const prefix = containerNamePrefixFor(jobId);
      const listed = await cli([
        "ps",
        "--all",
        "--filter",
        `name=^${escapeForDockerNameFilter(prefix)}`,
        "--format",
        "{{.Names}}",
      ]);
      if (listed.exitCode !== 0) return [];
      const names = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && name.startsWith(prefix));
      const removed: string[] = [];
      for (const name of names) {
        const outcome = await cli(["rm", "--force", name]);
        if (outcome.exitCode === 0) removed.push(name);
      }
      return removed;
    },
  };
}

/** Escape every RE2/Go-regexp metacharacter so the filter matches literally. */
function escapeForDockerNameFilter(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
