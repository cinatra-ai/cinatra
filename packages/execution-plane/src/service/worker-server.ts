/**
 * Worker SERVICE (exec-plane S1 remainder, epic cinatra#1705).
 *
 * A thin mTLS server over the already-merged `SandboxWorker` contract plus the
 * two volume lifecycles the worker host owns (`workspace.ts`, `staging.ts`).
 * It adds no enforcement of its own — the hardened run profile, the host-side
 * timeout, the stdio caps, the disk-quota measurement over the TRUSTED L0 base,
 * the no-bind-mount assertion and the fail-closed L1 provenance re-verification
 * all stay in `worker.ts` / `l0-profile.ts` where they already are.
 *
 * ONE THING IS PRESERVED WITH CARE. `worker.runCommand` throws
 * `EnvironmentMountRefusedError` when a job's declared L1 layer cannot be
 * verified (cinatra#1708 AC4), and the broker maps that specific throw to its
 * audited `environment_untrusted` refusal. A generic error body would collapse
 * that into `worker_error` and silently lose a security-relevant distinction, so
 * the refusal travels as its OWN wire code and `worker-client.ts` rethrows the
 * real error class. That is what makes "the broker cannot tell the difference"
 * literally true across a socket.
 *
 * IDEMPOTENCY. `runCommand` carries a `commandId` and goes through
 * `command-ledger.ts` for exactly the reason the broker's `exec` does: over a
 * wire, a lost response is indistinguishable from a lost command, and running a
 * container twice is not an acceptable resolution of that ambiguity.
 *
 * Like `broker-server.ts`, `createWorkerService()` builds but does not listen.
 */

import * as https from "node:https";

import { runDocker, type DockerCli } from "../docker-cli";
import { EnvironmentMountRefusedError } from "../environment/mount";
import { removeSkillsVolume, skillsVolumeName, stageSkillsVolume } from "../staging";
import type { SandboxCommandResult, SandboxWorker } from "../types";
import {
  createLocalDockerContainerOps,
  type SandboxContainerOps,
} from "../volume-ops";
import {
  ensureWorkspaceVolume,
  removeWorkspaceVolume,
  workspaceVolumeName,
} from "../workspace";
import {
  ExecVolumeNameRefusedError,
  assertDrainJobId,
  assertExecVolumeName,
  assertExecVolumeOwnership,
  assertStagingJobId,
  assertWorkspaceKey,
} from "./volume-guard";
import {
  createInMemoryCommandLedger,
  type CommandLedger,
} from "./command-ledger";
import { execServerTlsOptions, type ExecTlsMaterial } from "./mtls";
import {
  EXEC_ERROR_STATUS,
  execErrorResponse,
  execOkResponse,
  parseWorkerRequest,
  type WorkerRequest,
} from "./protocol";
import {
  createExecRpcListener,
  describeThrown,
  type ExecRpcContext,
  type ExecRpcListenerConfig,
  type ExecRpcReply,
} from "./rpc-transport";

export type WorkerServiceConfig = {
  /** The merged worker placement (`LocalDevSandboxWorker` or another). */
  worker: SandboxWorker;
  /** Docker seam for the volume lifecycles; defaults to the real CLI. */
  docker?: DockerCli;
  /**
   * Container cancellation for the host-exclusivity drain (exec-plane L3);
   * defaults to the local docker-backed implementation over `docker`.
   */
  containerOps?: SandboxContainerOps;
  instance: string;
  serviceToken: string;
  /** mTLS material for the `worker-server` identity. Required. */
  tls: ExecTlsMaterial;
  ledger?: CommandLedger;
  maxBodyBytes?: number;
  onRefusal?: ExecRpcListenerConfig["onRefusal"];
};

export type WorkerService = {
  /** Built, configured, NOT listening (`worker-entry.ts` listens). */
  server: https.Server;
  dispatch: (raw: unknown, ctx: ExecRpcContext) => Promise<ExecRpcReply>;
  ledger: CommandLedger;
  close(): Promise<void>;
};

function environmentUntrustedReply(reason: string): ExecRpcReply {
  return {
    status: EXEC_ERROR_STATUS.environment_untrusted,
    body: execErrorResponse(
      "environment_untrusted",
      // The reason token (`no_provenance_key` / `unverifiable_provenance`) is
      // the payload the client rebuilds the real error class from.
      reason,
    ),
  };
}

function opFailed(op: string, err: unknown): ExecRpcReply {
  return {
    status: EXEC_ERROR_STATUS.op_failed,
    body: execErrorResponse(
      "op_failed",
      `The sandbox worker failed to handle "${op}": ${describeThrown(err)}`,
    ),
  };
}

export function createWorkerDispatch(
  config: WorkerServiceConfig & { ledger: CommandLedger },
): (raw: unknown, ctx: ExecRpcContext) => Promise<ExecRpcReply> {
  const docker = config.docker ?? runDocker;
  const containerOps = config.containerOps ?? createLocalDockerContainerOps(docker);

  async function handle(request: WorkerRequest): Promise<ExecRpcReply> {
    switch (request.op) {
      case "runCommand": {
        const { commandId, spec } = request.payload;
        const claim = await config.ledger.claim(commandId, spec.jobId);
        if (claim.state === "in_flight") {
          return {
            status: EXEC_ERROR_STATUS.command_in_flight,
            body: execErrorResponse(
              "command_in_flight",
              `Command "${commandId}" is already running on job "${spec.jobId}"; the duplicate ` +
                `dispatch is refused (a container must not run twice for one command).`,
            ),
          };
        }
        if (claim.state === "completed") {
          // A replay is only a replay of THIS job — same reasoning as the
          // broker's `exec`: the ledger is keyed on the commandId alone, so a
          // reused id naming a different job must be refused rather than served
          // another job's recorded container output.
          if (claim.record.jobId !== spec.jobId) {
            return {
              status: EXEC_ERROR_STATUS.malformed_request,
              body: execErrorResponse(
                "malformed_request",
                `Command id "${commandId}" is already recorded against a different job; ` +
                  `an idempotency key is scoped to ONE job and is never reused across jobs (refused).`,
              ),
            };
          }
          const outcome = claim.record.outcome;
          if (outcome.kind === "runCommand") {
            return { status: 200, body: execOkResponse(outcome.result) };
          }
          if (outcome.kind === "environmentUntrusted") {
            // A layer already known untrusted stays refused identically — a
            // retry must not become a second mount attempt.
            return environmentUntrustedReply(outcome.reason);
          }
          if (outcome.kind === "failed") {
            // The first dispatch threw at an unknown point — possibly AFTER the
            // container ran. Replay the same failure; never start a second one.
            return {
              status: EXEC_ERROR_STATUS.op_failed,
              body: execErrorResponse(
                "op_failed",
                `Command "${commandId}" already failed and is not retryable under the same id ` +
                  `(the first dispatch may have run); mint a new commandId for a fresh attempt. ` +
                  `Original failure: ${outcome.message}`,
              ),
            };
          }
          return {
            status: EXEC_ERROR_STATUS.malformed_request,
            body: execErrorResponse(
              "malformed_request",
              `Command id "${commandId}" was already recorded for a different operation kind; refused.`,
            ),
          };
        }
        let result: SandboxCommandResult;
        try {
          result = await config.worker.runCommand(spec);
        } catch (err) {
          if (err instanceof EnvironmentMountRefusedError) {
            await config.ledger.complete(commandId, spec.jobId, {
              kind: "environmentUntrusted",
              reason: err.reason,
            });
            return environmentUntrustedReply(err.reason);
          }
          // A THROW IS NOT PROOF THAT NO CONTAINER RAN — a placement can fail
          // while tearing down, after the command already executed. Releasing the
          // claim would let the broker's retry (same commandId, by design) start a
          // second container. Record the failure instead; the retry replays it.
          // describeThrown, never `(err as Error).message`: a non-Error throw
          // would throw AGAIN, skip this write, and wedge the id forever.
          await config.ledger.complete(commandId, spec.jobId, {
            kind: "failed",
            message: describeThrown(err),
          });
          return opFailed("runCommand", err);
        }
        await config.ledger.complete(commandId, spec.jobId, {
          kind: "runCommand",
          result,
        });
        return { status: 200, body: execOkResponse(result) };
      }
      // The four volume ops + the drain all run under `volume-guard.ts`: the
      // worker re-derives what a legitimate name looks like instead of
      // trusting the broker's. See that module's header for why the boundary,
      // not the broker, is where this belongs.
      case "ensureWorkspace": {
        const workspaceKey = assertWorkspaceKey(
          request.payload.workspaceKey,
          workspaceVolumeName,
        );
        // `volume create` ADOPTS an existing name rather than failing, so an
        // ownership check has to happen BEFORE it: otherwise a volume that
        // merely occupies a plane-shaped name would be taken over and later
        // force-removed as if it were ours.
        await assertExecVolumeOwnership(workspaceVolumeName(workspaceKey), "l2", docker);
        const volumeName = await ensureWorkspaceVolume(workspaceKey, docker);
        return { status: 200, body: execOkResponse({ volumeName }) };
      }
      case "removeWorkspace": {
        const volumeName = assertExecVolumeName(request.payload.volumeName, "l2");
        // An ABSENT volume is a no-op, not a refusal — removal is idempotent by
        // contract and the broker retries it on close and on teardown.
        const state = await assertExecVolumeOwnership(volumeName, "l2", docker);
        if (state === "labelled") await removeWorkspaceVolume(volumeName, docker);
        return { status: 200, body: execOkResponse({ removed: true as const }) };
      }
      case "stageSkills": {
        const { skills, imageRef } = request.payload;
        const jobId = assertStagingJobId(request.payload.jobId, skillsVolumeName);
        // Same reason as ensureWorkspace, and sharper: staging COPIES FILES into
        // the volume and its fail-closed cleanup path force-removes it, so
        // adopting a foreign volume here would both write to it and delete it.
        await assertExecVolumeOwnership(skillsVolumeName(jobId), "skills", docker);
        // A staging refusal (digest mismatch / unsafe path / docker failure) is
        // load-bearing: the broker fails the OPEN closed on it. Surface it as a
        // structured op failure carrying the staging message verbatim.
        const volumeName = await stageSkillsVolume(jobId, skills, imageRef, docker);
        return { status: 200, body: execOkResponse({ volumeName }) };
      }
      case "removeSkills": {
        const volumeName = assertExecVolumeName(request.payload.volumeName, "skills");
        const state = await assertExecVolumeOwnership(volumeName, "skills", docker);
        if (state === "labelled") await removeSkillsVolume(volumeName, docker);
        return { status: 200, body: execOkResponse({ removed: true as const }) };
      }
      case "cancelJobContainers": {
        const jobId = assertDrainJobId(request.payload.jobId);
        const cancelled = await containerOps.cancelJobContainers(jobId);
        return { status: 200, body: execOkResponse({ cancelled }) };
      }
    }
  }

  return async (raw: unknown): Promise<ExecRpcReply> => {
    const parsed = parseWorkerRequest(raw);
    if (!parsed.ok) {
      return {
        status: EXEC_ERROR_STATUS[parsed.code],
        body: execErrorResponse(parsed.code, parsed.message),
      };
    }
    try {
      return await handle(parsed.request);
    } catch (err) {
      // A name the worker refuses is a MALFORMED REQUEST, not an op that
      // failed: the broker asked for something outside the vocabulary, and
      // calling that `op_failed` would invite a retry of an argument that can
      // never become legal. The message never echoes the rejected value.
      if (err instanceof ExecVolumeNameRefusedError) {
        return {
          status: EXEC_ERROR_STATUS.malformed_request,
          body: execErrorResponse("malformed_request", err.message),
        };
      }
      return opFailed(parsed.request.op, err);
    }
  };
}

export function createWorkerService(config: WorkerServiceConfig): WorkerService {
  const ledger = config.ledger ?? createInMemoryCommandLedger();
  const dispatch = createWorkerDispatch({ ...config, ledger });
  const listener = createExecRpcListener({
    instance: config.instance,
    // A worker's endpoint accepts exactly ONE role: the broker. The app never
    // reaches a worker directly — the broker stays the single trust boundary.
    peerRole: "broker-client",
    serviceToken: config.serviceToken,
    dispatch,
    ...(config.maxBodyBytes === undefined ? {} : { maxBodyBytes: config.maxBodyBytes }),
    ...(config.onRefusal ? { onRefusal: config.onRefusal } : {}),
  });
  const server = https.createServer(
    execServerTlsOptions({
      instance: config.instance,
      role: "worker-server",
      peerRole: "broker-client",
      material: config.tls,
    }),
    listener,
  );
  return {
    server,
    dispatch,
    ledger,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
