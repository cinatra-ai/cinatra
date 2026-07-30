/**
 * Worker CLIENT (exec-plane S1 remainder, epic cinatra#1705).
 *
 * `WorkerServiceClient implements SandboxWorker`. That single line is the whole
 * design goal: the merged doctrine says "other placements implement the same
 * contract in the deployment layer — the broker cannot tell the difference"
 * (`worker.ts`), and this class makes that literally true across a socket. An
 * `ExecutionBroker` constructed with `{ worker: new WorkerServiceClient(...) }`
 * behaves exactly as one constructed with a `LocalDevSandboxWorker`, including:
 *
 *  - `SandboxCommandResult` returned verbatim (JSON round-trip only);
 *  - a mount refusal arriving as a REAL `EnvironmentMountRefusedError`, so the
 *    broker's existing `catch (err instanceof EnvironmentMountRefusedError)`
 *    branch fires and audits `environment_untrusted` — not `worker_error`
 *    (cinatra#1708 AC4 stays intact over the wire);
 *  - any other failure arriving as a throw, which the broker already audits as
 *    a structured `worker_error` refusal.
 *
 * IDEMPOTENT RETRIES ARE THE POINT. Over a socket, "no response" does not mean
 * "did not run". Each `runCommand` mints ONE `commandId` and reuses it for every
 * attempt, so the worker's ledger replays the first outcome instead of starting
 * a second container. A `command_in_flight` answer is treated the same way — the
 * first dispatch is still running, so we wait rather than duplicate.
 *
 * The volume lifecycles (`ensureWorkspace` / `removeWorkspace` / `stageSkills` /
 * `removeSkills`) are exposed here as well, and since exec-plane L3 this class
 * satisfies `SandboxVolumeOps` and `SandboxContainerOps` STRUCTURALLY — so a
 * broker configured with `{ volumeOps: workerClient, containerOps: workerClient }`
 * performs every host operation on the worker host and needs no docker of its
 * own. What crosses the wire is a closed vocabulary of typed operations; there
 * is deliberately no remote `DockerCli`, because that would be remote
 * arbitrary-docker-argv execution on the one host that has a socket.
 */

import { randomUUID } from "node:crypto";

import {
  EnvironmentMountRefusedError,
  type EnvironmentMountRefusalReason,
} from "../environment/mount";
import type {
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
  StagedSkillInput,
} from "../types";
import type { SandboxContainerOps, SandboxVolumeOps } from "../volume-ops";
import type { ExecTlsMaterial } from "./mtls";
import type {
  CancelledResultPayload,
  RemovedResultPayload,
  VolumeResultPayload,
} from "./protocol";
import { ExecRpcClient, type ExecRpcCallResult } from "./rpc-transport";

export type WorkerServiceClientConfig = {
  /** Base origin of the worker service (`https://cinatra-exec-worker:<port>`). */
  baseUrl: string;
  /** Deployment identity — must match the worker's. */
  instance: string;
  /** The worker's expected service token (second factor). */
  serviceToken: string;
  /** This client's `broker-client` mTLS material. */
  tls: ExecTlsMaterial;
  requestTimeoutMs?: number;
  /** Attempts per command, INCLUDING the first. Same `commandId` throughout. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Injectable id minting + sleep for hermetic tests. */
  newCommandId?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_WORKER_CLIENT_MAX_ATTEMPTS = 2;
export const DEFAULT_WORKER_CLIENT_RETRY_DELAY_MS = 250;

const MOUNT_REFUSAL_REASONS: readonly EnvironmentMountRefusalReason[] = [
  "no_provenance_key",
  "unverifiable_provenance",
];

function toMountRefusalReason(message: string): EnvironmentMountRefusalReason {
  const trimmed = message.trim() as EnvironmentMountRefusalReason;
  // Fail-closed on an unrecognized token: an unverifiable layer is the safe
  // interpretation, never "probably fine".
  return MOUNT_REFUSAL_REASONS.includes(trimmed) ? trimmed : "unverifiable_provenance";
}

export class WorkerServiceClient
  implements SandboxWorker, SandboxVolumeOps, SandboxContainerOps
{
  private readonly rpc: ExecRpcClient;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly newCommandId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: WorkerServiceClientConfig) {
    this.rpc = new ExecRpcClient({
      baseUrl: config.baseUrl,
      serviceToken: config.serviceToken,
      tls: {
        instance: config.instance,
        role: "broker-client",
        peerRole: "worker-server",
        material: config.tls,
      },
      ...(config.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.requestTimeoutMs }),
    });
    this.maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_WORKER_CLIENT_MAX_ATTEMPTS);
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_WORKER_CLIENT_RETRY_DELAY_MS;
    this.newCommandId = config.newCommandId ?? (() => randomUUID());
    this.sleep =
      config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  close(): void {
    this.rpc.close();
  }

  /**
   * The `SandboxWorker` contract. Throws on failure — exactly what the broker's
   * merged `exec` pipeline already expects and audits.
   */
  async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
    const commandId = this.newCommandId();
    let last: Extract<ExecRpcCallResult<SandboxCommandResult>, { ok: false }> | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const outcome = await this.rpc.call<SandboxCommandResult>("runCommand", {
        commandId,
        spec,
      });
      if (outcome.ok) return outcome.result;
      last = outcome;
      if (outcome.error.code === "environment_untrusted") {
        // A security refusal, not a transport hiccup — never retried, and
        // rethrown as the REAL error class so the broker audits it precisely.
        throw new EnvironmentMountRefusedError(toMountRefusalReason(outcome.error.message));
      }
      const retryable =
        outcome.kind === "transport" || outcome.error.code === "command_in_flight";
      if (!retryable || attempt === this.maxAttempts) break;
      await this.sleep(this.retryDelayMs);
    }
    throw new Error(
      `The remote sandbox worker did not run the command for job "${spec.jobId}" ` +
        `(${last?.error.code ?? "internal_error"}): ${last?.error.message ?? "no answer"}`,
    );
  }

  /** Provision the per-run L2 workspace volume on the worker host. */
  async ensureWorkspace(workspaceKey: string): Promise<string> {
    const outcome = await this.rpc.call<VolumeResultPayload>("ensureWorkspace", {
      workspaceKey,
    });
    if (!outcome.ok) throw workerCallError("ensureWorkspace", outcome);
    return outcome.result.volumeName;
  }

  async removeWorkspace(volumeName: string): Promise<void> {
    const outcome = await this.rpc.call<RemovedResultPayload>("removeWorkspace", {
      volumeName,
    });
    if (!outcome.ok) throw workerCallError("removeWorkspace", outcome);
  }

  /** Stage read-only skill snapshots; a refusal FAILS the job open, as merged. */
  async stageSkills(
    jobId: string,
    skills: StagedSkillInput[],
    imageRef: string,
  ): Promise<string> {
    const outcome = await this.rpc.call<VolumeResultPayload>("stageSkills", {
      jobId,
      skills,
      imageRef,
    });
    if (!outcome.ok) throw workerCallError("stageSkills", outcome);
    return outcome.result.volumeName;
  }

  async removeSkills(volumeName: string): Promise<void> {
    const outcome = await this.rpc.call<RemovedResultPayload>("removeSkills", {
      volumeName,
    });
    if (!outcome.ok) throw workerCallError("removeSkills", outcome);
  }

  /**
   * Force-remove every container of a job on the worker host (the
   * host-exclusivity drain, exec-plane L3). A JOB ID crosses the wire — never a
   * container name — and the worker derives and validates the prefix itself.
   */
  async cancelJobContainers(jobId: string): Promise<string[]> {
    const outcome = await this.rpc.call<CancelledResultPayload>(
      "cancelJobContainers",
      { jobId },
    );
    if (!outcome.ok) throw workerCallError("cancelJobContainers", outcome);
    return outcome.result.cancelled;
  }
}

function workerCallError(
  op: string,
  outcome: Extract<ExecRpcCallResult<unknown>, { ok: false }>,
): Error {
  return new Error(
    `The remote sandbox worker refused "${op}" (${outcome.error.code}): ${outcome.error.message}`,
  );
}
