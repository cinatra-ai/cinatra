/**
 * Broker CLIENT (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The app's half of the service boundary. Two layers, deliberately separate:
 *
 *  1. `BrokerServiceClient` — the remote broker. Its methods mirror the merged
 *     `ExecutionBroker` surface the app consumes (`openJob` / `exec` /
 *     `closeJob` / `terminateJobsForRun` / `closeIdleJobs`) plus the two the
 *     remote placement needs (`drainAudit` — the app owns the audit kernel and
 *     the stdio store, so it PULLS what the remote broker buffered; `health`).
 *
 *  2. `createRemoteSandboxExecutor` — a `SandboxExecutor`, the exact shape
 *     `@cinatra-ai/llm`'s injection contract consumes. The app's wiring can swap
 *     `createBrokerSandboxExecutor(inProcessBroker)` for this and nothing above
 *     it changes.
 *
 * WHY THIS IS NOT `executor.ts` WITH A DIFFERENT ARGUMENT. The in-process
 * executor's failure space is exactly two cases: a structured broker refusal, or
 * a throw. A remote executor has a THIRD — the call produced no answer — and
 * that case has to be mapped explicitly, not lumped in:
 *
 *   * `exec` maps a transport failure to `{ ok: false, reason: "worker_error" }`.
 *     That keeps `ExecFailureReason` closed (no new member, no app-side change)
 *     and it is the semantically correct member: from the app's seat the plane
 *     failed to run the command, which is precisely what the merged broker
 *     already reports as `worker_error`.
 *   * `openJob` THROWS `ExecServiceUnavailableError` on a transport failure,
 *     because `OpenJobFailureReason` has no honest member for it and inventing
 *     one would be a lie in the audit vocabulary. The executor below catches it
 *     and turns it into the same model-visible structured refusal every other
 *     open failure produces.
 *
 * Everything else about the executor's contract is preserved verbatim from
 * `executor.ts`: one job per sealed carrier (memoized, LRU-capped, a failed open
 * is never cached), refusals become a non-zero exit code with the reason on
 * stderr AND carry `refusedByPlane` (cinatra#2175 — the surface provenance guard
 * counts a dispatch as executed unless every output is marked refused, so this
 * flag is load-bearing on the remote path exactly as it is in-process), the
 * closure NEVER rejects into the provider tool loop, and the model-supplied
 * `timeoutMs` / `maxOutputLength` hints stay unforwarded because enforced caps
 * must not be model-controlled.
 */

import { randomUUID } from "node:crypto";

import type {
  SandboxExecuteOutput,
  SandboxExecutor,
  SandboxStagedSkill,
} from "@cinatra-ai/llm";

import type { ResolvedEnvironmentMount } from "../environment/mount";
import type { CommandVoucherMinter } from "../executor";
import type { ExecResult, OpenJobResult, StagedSkillInput } from "../types";
import type { ExecTlsMaterial } from "./mtls";
import type {
  CloseJobResultPayload,
  DrainAuditPayload,
  DrainAuditResultPayload,
  HealthResultPayload,
  SweepResultPayload,
  TerminateJobsForRunResultPayload,
} from "./protocol";
import { ExecRpcClient, type ExecRpcCallResult } from "./rpc-transport";

/** Exit code for refused commands — the same value `executor.ts` uses. */
const REFUSED_EXIT_CODE = 126;

/** Raised when a broker call produced no answer at all (connect/TLS/timeout). */
export class ExecServiceUnavailableError extends Error {
  readonly op: string;
  constructor(op: string, detail: string) {
    super(
      `The execution-plane broker service did not answer "${op}": ${detail} ` +
        `(fail-closed — no job is opened).`,
    );
    this.name = "ExecServiceUnavailableError";
    this.op = op;
  }
}

export type BrokerServiceClientConfig = {
  /** Base origin of the broker service (`https://cinatra-exec-broker:<port>`). */
  baseUrl: string;
  /** Deployment identity — must match the broker's. */
  instance: string;
  /** The broker's expected service token (second factor). */
  serviceToken: string;
  /** This client's `app-client` mTLS material. */
  tls: ExecTlsMaterial;
  requestTimeoutMs?: number;
  /** Injectable id minting for hermetic tests. */
  newCommandId?: () => string;
};

function unavailable(op: string, outcome: Extract<ExecRpcCallResult<unknown>, { ok: false }>): Error {
  if (outcome.kind === "transport") {
    return new ExecServiceUnavailableError(op, outcome.error.message);
  }
  return new Error(
    `The execution-plane broker refused "${op}" (${outcome.error.code}): ${outcome.error.message}`,
  );
}

export class BrokerServiceClient {
  private readonly rpc: ExecRpcClient;
  private readonly newCommandId: () => string;

  constructor(config: BrokerServiceClientConfig) {
    this.rpc = new ExecRpcClient({
      baseUrl: config.baseUrl,
      serviceToken: config.serviceToken,
      tls: {
        instance: config.instance,
        role: "app-client",
        peerRole: "broker-server",
        material: config.tls,
      },
      ...(config.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.requestTimeoutMs }),
    });
    this.newCommandId = config.newCommandId ?? (() => randomUUID());
  }

  close(): void {
    this.rpc.close();
  }

  /**
   * Open a job. A broker VERDICT (bad carrier, removed run, exhausted quota,
   * failed staging) comes back as the merged `OpenJobResult` unchanged; a
   * transport failure throws `ExecServiceUnavailableError` (see the header).
   */
  async openJob(
    carrier: string,
    openOpts?: {
      stagedSkills?: StagedSkillInput[];
      environment?: ResolvedEnvironmentMount;
    },
  ): Promise<OpenJobResult> {
    const outcome = await this.rpc.call<OpenJobResult>("openJob", {
      carrier,
      ...(openOpts?.stagedSkills ? { stagedSkills: openOpts.stagedSkills } : {}),
      ...(openOpts?.environment ? { environment: openOpts.environment } : {}),
    });
    if (!outcome.ok) throw unavailable("openJob", outcome);
    return outcome.result;
  }

  /**
   * Execute one command. `commandId` is the idempotency key: pass a caller-owned
   * one to make a retry provably safe, or let the client mint one per call.
   * `voucher` is the per-command authorization voucher (epic #1705 L2) the
   * broker's `voucherVerifier` checks before dispatch — REQUIRED, mirroring
   * `ExecutionBroker.exec`'s own signature: a client that could omit it would
   * make the wire's authorization boundary optional in practice.
   * A transport failure maps to the merged `worker_error` refusal (header).
   */
  async exec(
    jobId: string,
    command: string,
    voucher: string,
    opts?: { commandId?: string },
  ): Promise<ExecResult> {
    const commandId = opts?.commandId ?? this.newCommandId();
    const outcome = await this.rpc.call<ExecResult>("exec", { jobId, command, commandId, voucher });
    if (outcome.ok) return outcome.result;
    return {
      ok: false,
      reason: "worker_error",
      message:
        `The execution plane could not run the command (${outcome.error.code}): ` +
        `${outcome.error.message}`,
    };
  }

  async closeJob(jobId: string, opts?: { removeWorkspace?: boolean }): Promise<void> {
    const outcome = await this.rpc.call<CloseJobResultPayload>("closeJob", {
      jobId,
      ...(opts?.removeWorkspace === undefined ? {} : { removeWorkspace: opts.removeWorkspace }),
    });
    if (!outcome.ok) throw unavailable("closeJob", outcome);
  }

  async terminateJobsForRun(
    runId: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<number> {
    const outcome = await this.rpc.call<TerminateJobsForRunResultPayload>(
      "terminateJobsForRun",
      {
        runId,
        ...(opts?.removeWorkspace === undefined
          ? {}
          : { removeWorkspace: opts.removeWorkspace }),
      },
    );
    if (!outcome.ok) throw unavailable("terminateJobsForRun", outcome);
    return outcome.result.terminated;
  }

  /** The remote half of the app's idle-job sweep (`sweep` on the wire). */
  async closeIdleJobs(idleMs: number): Promise<number> {
    const outcome = await this.rpc.call<SweepResultPayload>("sweep", { idleMs });
    if (!outcome.ok) throw unavailable("sweep", outcome);
    return outcome.result.closed;
  }

  /**
   * Pull the audit records + stdio entries the remote broker buffered. The app
   * feeds them to the SAME sinks it would have passed in-process
   * (`toAuthzAuditEventInput` → the authz kernel), so the remote placement grows
   * no second audit implementation. `droppedAudit` / `droppedStdio` are a
   * reported gap, never a silent one.
   */
  async drainAudit(limits?: DrainAuditPayload): Promise<DrainAuditResultPayload> {
    const outcome = await this.rpc.call<DrainAuditResultPayload>("drainAudit", limits ?? {});
    if (!outcome.ok) throw unavailable("drainAudit", outcome);
    return outcome.result;
  }

  async health(): Promise<HealthResultPayload> {
    const outcome = await this.rpc.call<HealthResultPayload>("health", {});
    if (!outcome.ok) throw unavailable("health", outcome);
    return outcome.result;
  }
}

/**
 * The subset `createRemoteSandboxExecutor` needs — so a test can drive it with a
 * plain object and the real client satisfies it structurally.
 */
export type RemoteExecutorBroker = Pick<BrokerServiceClient, "openJob" | "exec">;

export type RemoteSandboxExecutorOptions = {
  /**
   * REQUIRED, mirroring `executor.ts`'s `BrokerSandboxExecutorOptions`: an
   * executor with no voucher source could submit no authorized command at
   * all, so making it optional would only turn a compile-time requirement
   * into a runtime refusal of everything.
   */
  mintVoucher: CommandVoucherMinter;
};

async function resolveStagedInputs(
  stagedSkills: SandboxStagedSkill[] | undefined,
): Promise<StagedSkillInput[]> {
  if (!stagedSkills || stagedSkills.length === 0) return [];
  return Promise.all(
    stagedSkills.map(async (skill) => ({
      slug: skill.slug,
      files: (await skill.resolveFiles()).map((f) => ({
        path: f.path,
        content: f.content,
        digest: f.digest,
      })),
    })),
  );
}

/** Same bound and rationale as `executor.ts`: the map must not grow with traffic. */
const MAX_TRACKED_CARRIERS = 256;

/** `throw null` / hostile throwables must still become a string (see executor.ts). */
function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Build the `SandboxExecutor` the app injects, backed by a REMOTE broker.
 * Contract-identical to `createBrokerSandboxExecutor` (see the module header for
 * the one deliberate delta: transport failures are mapped, not leaked).
 */
export function createRemoteSandboxExecutor(
  broker: RemoteExecutorBroker,
  opts: RemoteSandboxExecutorOptions,
): SandboxExecutor {
  const jobs = new Map<
    string,
    Promise<{ ok: true; jobId: string } | { ok: false; message: string }>
  >();

  function evictPastCap(): void {
    while (jobs.size > MAX_TRACKED_CARRIERS) {
      const oldest = jobs.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      jobs.delete(oldest); // mapping only — never closeJob (see executor.ts)
    }
  }

  return async (input) => {
    let open = jobs.get(input.sessionCarrier);
    if (!open) {
      open = (async () => {
        try {
          const stagedSkills = await resolveStagedInputs(input.stagedSkills);
          const environment = input.environment as ResolvedEnvironmentMount | undefined;
          const result = await broker.openJob(input.sessionCarrier, {
            stagedSkills,
            ...(environment ? { environment } : {}),
          });
          return result.ok
            ? ({ ok: true, jobId: result.jobId } as const)
            : ({ ok: false, message: `${result.reason}: ${result.message}` } as const);
        } catch (err) {
          // Covers both a staging resolve failure and
          // `ExecServiceUnavailableError` — the model sees a structured
          // refusal either way and the closure never rejects.
          return { ok: false, message: `service_unavailable: ${describeThrown(err)}` } as const;
        }
      })();
      jobs.set(input.sessionCarrier, open);
      const settled = await open;
      if (!settled.ok) jobs.delete(input.sessionCarrier);
      else evictPastCap();
    } else {
      jobs.delete(input.sessionCarrier);
      jobs.set(input.sessionCarrier, open);
    }
    const job = await open;
    if (!job.ok) {
      return input.commands.map(() => ({
        stdout: "",
        stderr: `The execution plane refused to open a job — ${job.message}`,
        outcome: { type: "exit" as const, exitCode: REFUSED_EXIT_CODE },
        // Nothing ran: no sandbox, no audit row (cinatra#2175). MUST be set on
        // the remote path too — `observeSurfaceExecutionDispatches` counts a
        // dispatch as EXECUTED unless every output is marked refused, so
        // omitting this would book a refusal as proof of execution: exactly the
        // provenance fabrication that guard exists to catch.
        refusedByPlane: true as const,
      }));
    }

    const jobId = job.jobId;
    /**
     * Mint an authorization for one command and submit it — the same
     * mint/remint shape as `executor.ts`'s `execWithVoucher` (see that
     * module's header: this executor's contract is preserved verbatim).
     */
    const execWithVoucher = async (
      command: string,
      commandId: string,
      nonce?: string,
    ): Promise<ExecResult> => {
      let minted: Awaited<ReturnType<CommandVoucherMinter>>;
      try {
        minted = await opts.mintVoucher({
          sessionCarrier: input.sessionCarrier,
          jobId,
          command,
          commandId,
          ...(nonce ? { nonce } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "voucher_missing",
          message: `the plane could not authorize this command: ${describeThrown(err)}`,
        };
      }
      if (!minted.ok) {
        return {
          ok: false,
          reason: "voucher_missing",
          message: `the plane declined to authorize this command (${minted.reason}): ${minted.message}`,
        };
      }
      return broker.exec(jobId, command, minted.voucher);
    };

    const outputs: SandboxExecuteOutput[] = [];
    for (const command of input.commands) {
      // ONE commandId per command, stable across the single permitted remint
      // (see `executor.ts`): identity the broker's idempotency and remint cap
      // are keyed on.
      const commandId = randomUUID();
      let result = await execWithVoucher(command, commandId);

      // The broker's one-shot revalidation: remint against its challenge
      // nonce and resubmit exactly once (the cap itself lives in the broker).
      if (!result.ok && result.reason === "revalidation_required" && result.revalidation) {
        result = await execWithVoucher(command, commandId, result.revalidation.nonce);
      }

      if (!result.ok) {
        outputs.push({
          stdout: "",
          stderr: `The execution plane refused the command — ${result.reason}: ${result.message}`,
          outcome: { type: "exit", exitCode: REFUSED_EXIT_CODE },
          // Nothing ran for this command (cinatra#2175) — see the open path.
          refusedByPlane: true,
        });
        continue;
      }
      const r = result.result;
      outputs.push({
        stdout: r.stdout,
        stderr: r.stderr,
        outcome:
          r.termination === "timeout"
            ? { type: "timeout" }
            : { type: "exit", exitCode: r.exitCode ?? REFUSED_EXIT_CODE },
      });
    }
    return outputs;
  };
}
