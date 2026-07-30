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

import {
  SANDBOX_CONTAINER_JOB_LABEL,
  containerNamePrefixFor,
  isContainerNameForJob,
} from "./l0-profile";
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
 * TWO INDEPENDENT PROOFS OF OWNERSHIP, because neither alone is one:
 *
 *  - the daemon-side filter selects on the exact `…​.job=<jobId>` LABEL the
 *    hardened run profile stamps, so a container this worker did not start is
 *    never even listed (a name filter would not have proved that — anybody with
 *    the socket can name a container anything);
 *  - every listed name is then re-checked against the ANCHORED shape
 *    `<prefix><digits>`, so a label somebody managed to forge still cannot get
 *    an arbitrarily-named container removed, and the containers of the
 *    different job `foo-bar` are not swept up by a drain of job `foo`.
 *
 * FAILURES ARE NOT SILENCE (Codex round 2, finding E2). A failed enumeration or
 * a removal that did not take means the host is NOT drained, and reporting that
 * as an empty success would let a revoked host keep running our containers
 * forever. Every removal is attempted, then the call THROWS if any step failed;
 * the broker retries every retained job on its next refusal.
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
        `label=${SANDBOX_CONTAINER_JOB_LABEL}=${jobId}`,
        "--format",
        "{{.Names}}",
      ]);
      if (listed.exitCode !== 0) {
        throw new Error(
          `Could not enumerate the containers of job "${jobId}" (docker exit ` +
            `${String(listed.exitCode)}); the host is NOT drained.`,
        );
      }
      const names = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && isContainerNameForJob(name, jobId));
      const removed: string[] = [];
      const failed: string[] = [];
      for (const name of names) {
        const outcome = await cli(["rm", "--force", name]);
        if (outcome.exitCode === 0) removed.push(name);
        else failed.push(name);
      }
      if (failed.length > 0) {
        throw new Error(
          `Could not force-remove ${failed.length} container(s) of job "${jobId}"; ` +
            `the host is NOT fully drained (prefix ${prefix}).`,
        );
      }
      return removed;
    },
  };
}
