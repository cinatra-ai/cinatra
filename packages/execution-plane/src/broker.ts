/**
 * Execution broker (exec-plane S1, cinatra#1706).
 *
 * The single trust boundary between the injected `sandbox_execute` capability
 * and a running container. The broker:
 *
 *  - AUTHENTICATES the capability: it is the only party that opens the sealed
 *    execution-session carrier minted by `@cinatra-ai/llm` (HMAC-verified,
 *    expiring, identity-only). A bad carrier fails closed with a precise
 *    structured reason. The broker's own service boundary is guarded by an
 *    independently scoped service token (`verifyServiceToken`, timing-safe) —
 *    the seam the app-layer HTTP/mTLS wiring terminates on.
 *  - REVALIDATES LIVENESS PER COMMAND (not once at job start) via the
 *    host-injected probe: a run hard-removed by extension force_delete/purge
 *    fails the NEXT command closed and terminates the job; archive does NOT
 *    interrupt (the sandbox follows the RUN's lifecycle — the platform's
 *    no-mid-run-re-gating doctrine).
 *  - BOUNDS LOAD: per-org + global concurrency semaphores with FIFO waiting
 *    and a per-org queue ceiling (`queue_saturated` beyond it) — a parallel
 *    burst degrades to bounded queueing, never worker-host exhaustion.
 *  - AUDITS EVERY COMMAND — executed, refused, and terminated alike — to the
 *    injected sink (authz-kernel vocabulary via `toAuthzAuditEventInput`,
 *    `actorPrincipalType: "model"`); stdout/stderr go SEPARATELY through the
 *    redaction hook to the stdio retention sink, never into the audit record.
 */

import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  openSealedSession,
  type ExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { EgressRegistrationError, registerJobEgress, resolveEgress } from "./egress";
import { ensureWorkspaceVolume, removeWorkspaceVolume } from "./workspace";
// Exec-plane S2 (cinatra#1707): read-only skill staging under /skills/<slug>.
import { stageSkillsVolume, removeSkillsVolume } from "./staging";
import { resolveL0ImageRef } from "./l0-profile";
// Exec-plane S3 (cinatra#1708): the resolved L1 environment a job mounts +
// the worker's fail-closed mount-verification refusal.
import {
  EnvironmentMountRefusedError,
  type ResolvedEnvironmentMount,
} from "./environment/mount";
import type { DockerCli } from "./docker-cli";
import {
  DEFAULT_BROKER_QUOTAS,
  DEFAULT_SANDBOX_LIMITS,
  type BrokerQuotas,
  type CommandPolicyHook,
  type EgressGatewayEndpoint,
  type EgressPolicy,
  type ExecFailureReason,
  type ExecResult,
  type ExecutionAuditRecord,
  type ExecutionAuditSink,
  type ExecutionStdioRedactor,
  type ExecutionStdioSink,
  type OpenJobFailureReason,
  type ResolvedEgress,
  type OpenJobResult,
  type RunLivenessProbe,
  type SandboxCommandResult,
  type StagedSkillInput,
  type SandboxResourceLimits,
  type SandboxWorker,
} from "./types";
import { SANDBOX_WORKSPACE_DIR } from "./l0-profile";

export type ExecutionBrokerOptions = {
  worker: SandboxWorker;
  auditSink: ExecutionAuditSink;
  livenessProbe: RunLivenessProbe;
  /** Resolve the effective egress policy for a session (org/agent tiers). */
  egressPolicyResolver: (session: ExecutionSession) => EgressPolicy;
  stdioSink?: ExecutionStdioSink;
  stdioRedactor?: ExecutionStdioRedactor;
  commandPolicy?: CommandPolicyHook;
  quotas?: Partial<BrokerQuotas>;
  limits?: Partial<SandboxResourceLimits>;
  /** Sandbox network + gateway endpoint for gateway egress modes. */
  sandboxNetwork?: string;
  gateway?: EgressGatewayEndpoint;
  /** Injection seam so workspace ops share the worker's docker CLI in tests. */
  docker?: DockerCli;
  /** Injection seam for the gateway control-channel registration call. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for hermetic tests. */
  nowMs?: () => number;
};

type BrokerJob = {
  jobId: string;
  jobToken: string;
  session: ExecutionSession;
  workspaceVolume: string;
  /** Per-job read-only staged-skills volume (exec-plane S2), when staged. */
  skillsVolume?: string;
  /**
   * The resolved L1 environment layer every command on this job mounts
   * (exec-plane S3, cinatra#1708). Fixed for the job's lifetime; the worker
   * re-verifies its provenance before each mount.
   */
  environment?: ResolvedEnvironmentMount;
  seq: number;
  /**
   * Epoch ms of the last activity on this job (open, or a dispatched command).
   * Drives `closeIdleJobs` — the app wiring's defense against the open-job
   * ceiling filling up with jobs whose carriers have long expired (exec-plane
   * S1b, cinatra#2138; Codex convergence finding 3).
   */
  lastActivityMs: number;
  /**
   * Commands currently dispatched on this job. `closeIdleJobs` NEVER closes a
   * job with work in flight (Codex convergence round 2): a command that outlives
   * the idle window — a long queue wait plus a long run — must not have its job
   * terminated underneath it.
   */
  inFlightCommands: number;
  terminated: boolean;
  terminationReason?: string;
};

/**
 * Timing-safe service-token check for the broker's OWN service boundary. The
 * token is independently scoped (never the carrier secret): rotating one does
 * not invalidate the other. mTLS termination in managed placements rides the
 * deployment layer; this is the in-process seam it collapses to in local-dev.
 */
export function verifyServiceToken(
  provided: string | undefined,
  expected: string | undefined = process.env.EXECUTION_BROKER_SERVICE_TOKEN,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Map a broker audit record onto the authz audit-kernel input vocabulary. */
export function toAuthzAuditEventInput(record: ExecutionAuditRecord): {
  organizationId: string;
  actorPrincipalId: string;
  actorPrincipalType: "model";
  authSource: "agent";
  resourceType: string;
  resourceId: string;
  operation: string;
  decision: "allowed" | "denied";
  runId?: string;
  metadata: Record<string, unknown>;
} {
  return {
    organizationId: record.orgId,
    actorPrincipalId: record.userId,
    actorPrincipalType: "model",
    authSource: "agent",
    resourceType: "execution_sandbox",
    resourceId: record.jobId,
    operation: "sandbox_execute",
    decision: record.decision === "executed" ? "allowed" : "denied",
    ...(record.runId ? { runId: record.runId } : {}),
    metadata: {
      surface: record.surface,
      cwd: record.cwd,
      reason: record.reason,
      exitCode: record.exitCode,
      termination: record.termination,
      imageDigest: record.imageDigest,
      egressMode: record.effectivePolicy.egressMode,
      egressTotalBytes: record.egressTotalBytes,
      wallMs: record.wallMs,
      workspaceKb: record.workspaceKb,
    },
  };
}

/** A FIFO counting semaphore with a bounded wait queue. */
class BoundedSemaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  tryAcquire(): "acquired" | "queued" | "saturated" {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return "acquired";
    }
    if (this.waiters.length >= this.maxQueued) return "saturated";
    return "queued";
  }

  /** Call only after tryAcquire() returned "queued". Resolves FIFO. */
  waitAcquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  get executing(): number {
    return this.inFlight;
  }
}

export class ExecutionBroker {
  private readonly jobs = new Map<string, BrokerJob>();
  private readonly quotas: BrokerQuotas;
  private readonly limits: SandboxResourceLimits;
  private readonly orgSemaphores = new Map<string, BoundedSemaphore>();
  /** Synchronous per-org open-job reservations held across the async volume
   *  provisioning in openJob, so a concurrent burst cannot race past the
   *  open-job ceiling (the live job count only reflects INSERTED jobs). */
  private readonly orgOpenReservations = new Map<string, number>();
  private readonly globalSemaphore: BoundedSemaphore;
  private readonly opts: ExecutionBrokerOptions;

  constructor(opts: ExecutionBrokerOptions) {
    this.opts = opts;
    this.quotas = { ...DEFAULT_BROKER_QUOTAS, ...opts.quotas };
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...opts.limits };
    this.globalSemaphore = new BoundedSemaphore(
      this.quotas.maxGlobalConcurrent,
      this.quotas.maxQueuedGlobal,
    );
  }

  private openJobCountForOrg(orgId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!job.terminated && job.session.orgId === orgId) count += 1;
    }
    return count;
  }

  /**
   * Open a job for a sealed session carrier. Verifies the carrier (fail-closed
   * per reason), revalidates liveness once up front, provisions the L2
   * workspace (keyed on runId when present — run-scoped persistence — else on
   * the fresh jobId), stages any skill snapshots read-only under /skills
   * (exec-plane S2 — digest-verified, fail-closed), and mints the per-job
   * egress attribution token.
   */
  async openJob(
    carrier: string,
    openOpts?: {
      stagedSkills?: StagedSkillInput[];
      /**
       * The resolved L1 environment layer to mount for every command on this
       * job (exec-plane S3, cinatra#1708). Projected from a verified cache
       * entry by the app-layer service that resolves the run's declared
       * environment; the worker re-verifies its signed provenance before each
       * mount. Absent ⇒ commands run over the L0 base (byte-identical S1/S2
       * dispatch).
       */
      environment?: ResolvedEnvironmentMount;
    },
  ): Promise<OpenJobResult> {
    const opened = openSealedSession(carrier, {
      nowMs: this.opts.nowMs?.(),
    });
    if (!opened.ok) {
      return {
        ok: false,
        reason: `carrier_${opened.reason}` as OpenJobFailureReason,
        message: `Execution-session carrier rejected (${opened.reason}); the command is refused (fail-closed).`,
      };
    }
    const session = opened.session;
    const liveness = await this.opts.livenessProbe(session);
    if (liveness === "gone") {
      return {
        ok: false,
        reason: "run_removed",
        message:
          "The bound run no longer exists (hard-removed); no job is opened (fail-closed).",
      };
    }
    // Bound carrier-replay volume/memory exhaustion: a valid carrier within its
    // TTL can be presented repeatedly, so cap simultaneously-open jobs per org
    // (each open job holds one L2 volume). Reserve the slot SYNCHRONOUSLY here
    // — before the async volume provisioning — so a concurrent burst of
    // openJob() calls cannot all pass the check (the live job count reflects
    // only inserted jobs; the reservation covers the in-flight gap).
    const orgId = session.orgId;
    const reserved = this.orgOpenReservations.get(orgId) ?? 0;
    if (this.openJobCountForOrg(orgId) + reserved >= this.quotas.maxOpenJobsPerOrg) {
      return {
        ok: false,
        reason: "open_jobs_exhausted",
        message:
          "The org has too many open execution jobs; close some before opening more (bounded, fail-closed).",
      };
    }
    this.orgOpenReservations.set(orgId, reserved + 1);
    const jobId = randomUUID();
    const workspaceKey = session.runId ?? jobId;
    try {
      const workspaceVolume = await ensureWorkspaceVolume(
        workspaceKey,
        this.opts.docker,
      );
      // Exec-plane S2 (cinatra#1707): stage skill snapshots read-only. A
      // staging refusal (digest mismatch / unsafe path / docker failure) fails
      // the OPEN closed — a job must never run with a partial skill set the
      // model was told it has. The workspace volume is left in place: it is
      // run-keyed (possibly shared) and retention GC owns it.
      let skillsVolume: string | undefined;
      if (openOpts?.stagedSkills && openOpts.stagedSkills.length > 0) {
        try {
          skillsVolume = await stageSkillsVolume(
            jobId,
            openOpts.stagedSkills,
            resolveL0ImageRef(),
            this.opts.docker,
          );
        } catch (err) {
          return {
            ok: false,
            reason: "staging_failed",
            message: `Skill staging refused: ${(err as Error).message}`,
          };
        }
      }
      const job: BrokerJob = {
        jobId,
        jobToken: `job-${jobId}`,
        session,
        workspaceVolume,
        ...(skillsVolume ? { skillsVolume } : {}),
        ...(openOpts?.environment ? { environment: openOpts.environment } : {}),
        seq: 0,
        lastActivityMs: this.opts.nowMs?.() ?? Date.now(),
        inFlightCommands: 0,
        terminated: false,
      };
      this.jobs.set(jobId, job);
      return { ok: true, jobId };
    } finally {
      // Release the reservation: the job is now counted in openJobCountForOrg
      // (success) or never existed (failure).
      const current = this.orgOpenReservations.get(orgId) ?? 1;
      if (current <= 1) this.orgOpenReservations.delete(orgId);
      else this.orgOpenReservations.set(orgId, current - 1);
    }
  }

  /**
   * Execute one command on an open job. Per-command pipeline:
   * liveness revalidation → command-hygiene hook → quota/queue admission →
   * hardened dispatch → disk-quota verdict → audit + stdio retention.
   */
  async exec(jobId: string, command: string): Promise<ExecResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        ok: false,
        reason: "unknown_job",
        message: `Unknown execution job "${jobId}".`,
      };
    }
    if (job.terminated) {
      return this.refuse(job, command, "job_terminated",
        `The job was terminated (${job.terminationReason ?? "unspecified"}); no further commands run on it.`);
    }

    // Per-command liveness revalidation (S1 AC6): purge fails the NEXT command
    // closed and terminates the job; archive proceeds.
    const liveness = await this.opts.livenessProbe(job.session);
    if (liveness === "gone") {
      this.terminate(job, "run_removed");
      return this.refuse(job, command, "run_removed",
        "The bound run was hard-removed mid-job; the command is refused and the job is terminated (fail-closed).");
    }

    if (this.opts.commandPolicy) {
      const verdict = this.opts.commandPolicy(job.session, command);
      if (!verdict.allowed) {
        return this.refuse(job, command, "command_blocked", verdict.reason);
      }
    }

    const orgSem = this.orgSemaphore(job.session.orgId);
    const orgAdmission = orgSem.tryAcquire();
    if (orgAdmission === "saturated") {
      return this.refuse(job, command, "queue_saturated",
        "The org's execution queue is full; retry later (bounded queueing).");
    }
    if (orgAdmission === "queued") await orgSem.waitAcquire();
    const globalAdmission = this.globalSemaphore.tryAcquire();
    if (globalAdmission === "saturated") {
      orgSem.release();
      return this.refuse(job, command, "queue_saturated",
        "The global execution queue is full; retry later (bounded queueing).");
    }
    if (globalAdmission === "queued") await this.globalSemaphore.waitAcquire();

    try {
      // Resolve the egress policy INSIDE the protected boundary: a throwing
      // resolver must neither leak the acquired semaphore permits (the finally
      // releases them) nor throw an unaudited error into the caller. Fall back
      // to a `none` policy solely for the audit record on that failure.
      let policy: EgressPolicy;
      try {
        policy = this.opts.egressPolicyResolver(job.session);
      } catch (err) {
        return await this.refuse(job, command, "egress_unavailable",
          `Failed to resolve the egress policy: ${(err as Error).message}`, { mode: "none" });
      }

      // Re-authorize AFTER the (possibly unbounded) queue wait — a job purged or
      // terminated while queued must not execute (finding: queued commands
      // authorized too early). Re-check termination and re-probe liveness here.
      if (job.terminated) {
        return await this.refuse(job, command, "job_terminated",
          `The job was terminated (${job.terminationReason ?? "unspecified"}) while queued; the command is refused.`, policy);
      }
      const postQueueLiveness = await this.opts.livenessProbe(job.session);
      if (postQueueLiveness === "gone") {
        this.terminate(job, "run_removed");
        return await this.refuse(job, command, "run_removed",
          "The bound run was hard-removed while the command was queued; refused and the job is terminated (fail-closed).", policy);
      }

      // resolveEgress can throw (e.g. a gateway-requiring mode with no gateway
      // configured) — convert that into an AUDITED structured refusal rather
      // than an unhandled throw that would leak state.
      let egress: ResolvedEgress;
      try {
        egress = resolveEgress(policy, {
          jobToken: job.jobToken,
          network: this.opts.sandboxNetwork,
          gateway: this.opts.gateway,
        });
      } catch (err) {
        return await this.refuse(job, command, "egress_unavailable",
          `Failed to resolve egress for the command: ${(err as Error).message}`, policy);
      }
      // Register the per-job token + policy at the gateway BEFORE the sandbox
      // runs (unregistered tokens are refused by the gateway; this is what makes
      // attribution unforgeable and per-job policy enforceable). Fail-closed.
      if (egress.kind === "gateway" && this.opts.gateway) {
        try {
          await registerJobEgress(
            this.opts.gateway,
            job.jobToken,
            policy,
            this.opts.fetchImpl,
          );
        } catch (err) {
          if (err instanceof EgressRegistrationError) {
            return await this.refuse(job, command, "egress_unavailable",
              `Egress gateway registration failed (${err.message}); the command is refused (fail-closed).`, policy);
          }
          throw err;
        }
      }

      const seq = job.seq++;
      job.lastActivityMs = this.opts.nowMs?.() ?? Date.now();
      job.inFlightCommands += 1;
      let result: SandboxCommandResult;
      try {
        try {
          result = await this.opts.worker.runCommand({
            jobId: job.jobId,
            command,
            workspaceVolume: job.workspaceVolume,
            ...(job.skillsVolume ? { skillsVolume: job.skillsVolume } : {}),
            ...(job.environment ? { environment: job.environment } : {}),
            egress,
            limits: this.limits,
          });
        } finally {
          // Always released, on EVERY path out of the dispatch — the idle sweep
          // must never see a phantom in-flight command (nor miss a real one).
          job.inFlightCommands = Math.max(0, job.inFlightCommands - 1);
        }
      } catch (err) {
        // A worker/dispatch failure must NOT throw into the caller (an
        // unaudited error encourages unsafe retries). Audit a structured
        // refusal and return it (finding: fail-closed auditing incomplete).
        // A refused L1 environment mount (unverifiable provenance / no host
        // key) is a distinct, security-relevant fail-closed event
        // (cinatra#1708 AC4) — surfaced with its OWN audited reason, never
        // masked as a generic worker error.
        if (err instanceof EnvironmentMountRefusedError) {
          return await this.refuse(job, command, "environment_untrusted",
            `The job's declared execution environment could not be trusted (${err.reason}); the command is refused (fail-closed).`, policy);
        }
        return await this.refuse(job, command, "worker_error",
          `The sandbox worker failed to run the command: ${(err as Error).message}`, policy);
      }

      if (result.termination === "disk_quota_exceeded") {
        this.terminate(job, "disk_quota_exceeded");
      }

      await this.retainStdio(job, seq, result);
      await this.audit(job, command, {
        decision: "executed",
        reason:
          result.termination === "exited" ? undefined : result.termination,
        result,
        policy,
      });
      return { ok: true, result };
    } finally {
      this.globalSemaphore.release();
      orgSem.release();
    }
  }

  /** Terminate every open job bound to a run (the hard-removal teardown hook). */
  async terminateJobsForRun(
    runId: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<number> {
    let terminated = 0;
    for (const job of this.jobs.values()) {
      if (job.session.runId !== runId || job.terminated) continue;
      this.terminate(job, "run_removed");
      if (opts?.removeWorkspace) {
        await removeWorkspaceVolume(job.workspaceVolume, this.opts.docker);
      }
      // The skills volume is strictly per-job (never shared): remove eagerly.
      if (job.skillsVolume) {
        await removeSkillsVolume(job.skillsVolume, this.opts.docker);
      }
      terminated += 1;
    }
    return terminated;
  }

  async closeJob(
    jobId: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.terminate(job, "closed");
    if (opts?.removeWorkspace) {
      await removeWorkspaceVolume(job.workspaceVolume, this.opts.docker);
    }
    // The skills volume is strictly per-job (never shared): remove eagerly.
    if (job.skillsVolume) {
      await removeSkillsVolume(job.skillsVolume, this.opts.docker);
    }
    this.jobs.delete(jobId);
  }

  /**
   * Close every open job whose last activity is older than `idleMs`.
   *
   * The executor memoizes ONE job per sealed carrier and reuses it across the
   * steps/turns of a request (the L2 workspace-persistence contract), but a
   * request has no "turn finished" signal it can hand back — so without this
   * sweep a long-lived app-wired broker accumulates one open job per carrier
   * until the per-org open-job ceiling refuses all further execution until the
   * process restarts (exec-plane S1b, cinatra#2138; Codex convergence finding
   * 3). The app wiring runs this on a timer with the carrier TTL as `idleMs`:
   * past that, no valid carrier can reach the job anyway.
   *
   * A job with a command IN FLIGHT is never closed, so the sweep can never
   * terminate a job underneath a running command; `closeJob` is idempotent
   * (unknown job ⇒ no-op), so overlapping sweeps cannot double-close.
   *
   * The WORKSPACE is deliberately left in place — an L2 volume is run-keyed and
   * possibly shared, and the retention GC owns it; a later command on the same
   * run re-opens onto the same workspace. Returns the number closed.
   */
  async closeIdleJobs(idleMs: number): Promise<number> {
    const cutoff = (this.opts.nowMs?.() ?? Date.now()) - idleMs;
    const reapable = (job: BrokerJob): boolean =>
      // Work in flight ⇒ never a reap candidate, whatever the idle clock says.
      !job.terminated && job.inFlightCommands === 0 && job.lastActivityMs <= cutoff;
    const candidates: string[] = [];
    for (const job of this.jobs.values()) {
      if (reapable(job)) candidates.push(job.jobId);
    }
    let closed = 0;
    for (const jobId of candidates) {
      // RE-CHECK AND CLAIM SYNCHRONOUSLY, immediately before the awaited close
      // (Codex convergence round 3). Between building the candidate list and
      // reaching this job, an await may have let a new command open on it — or
      // an overlapping sweep may already have claimed it. `terminate` is a
      // synchronous flag flip, so the claim cannot interleave: a concurrent
      // `exec` sees `terminated` and refuses fail-closed, and a second sweep
      // sees it too and skips.
      const job = this.jobs.get(jobId);
      if (!job || !reapable(job)) continue;
      this.terminate(job, "closed");
      await this.closeJob(jobId);
      closed += 1;
    }
    return closed;
  }

  /** Currently-executing command count (observability / load tests). */
  get executingCount(): number {
    return this.globalSemaphore.executing;
  }

  // -------------------------------------------------------------------------

  private orgSemaphore(orgId: string): BoundedSemaphore {
    let sem = this.orgSemaphores.get(orgId);
    if (!sem) {
      sem = new BoundedSemaphore(
        this.quotas.maxConcurrentPerOrg,
        this.quotas.maxQueuedPerOrg,
      );
      this.orgSemaphores.set(orgId, sem);
    }
    return sem;
  }

  private terminate(job: BrokerJob, reason: string): void {
    job.terminated = true;
    job.terminationReason = reason;
  }

  private async retainStdio(
    job: BrokerJob,
    seq: number,
    result: SandboxCommandResult,
  ): Promise<void> {
    if (!this.opts.stdioSink) return;
    const redact = this.opts.stdioRedactor ?? ((text: string) => text);
    await this.opts.stdioSink({
      jobId: job.jobId,
      seq,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    });
  }

  private async refuse(
    job: BrokerJob,
    command: string,
    reason: ExecFailureReason,
    message: string,
    policy?: EgressPolicy,
  ): Promise<ExecResult> {
    await this.audit(job, command, {
      decision: "refused",
      reason,
      policy: policy ?? this.opts.egressPolicyResolver(job.session),
    });
    return { ok: false, reason, message };
  }

  private async audit(
    job: BrokerJob,
    command: string,
    detail: {
      decision: "executed" | "refused";
      reason?: string;
      result?: SandboxCommandResult;
      policy: EgressPolicy;
    },
  ): Promise<void> {
    const record: ExecutionAuditRecord = {
      jobId: job.jobId,
      orgId: job.session.orgId,
      userId: job.session.userId,
      surface: job.session.surface,
      ...(job.session.runId ? { runId: job.session.runId } : {}),
      command,
      cwd: SANDBOX_WORKSPACE_DIR,
      decision: detail.decision,
      ...(detail.reason ? { reason: detail.reason } : {}),
      ...(detail.result
        ? {
            exitCode: detail.result.exitCode,
            termination: detail.result.termination,
            imageDigest: detail.result.imageDigest,
            wallMs: detail.result.wallMs,
            workspaceKb: detail.result.workspaceKb,
            ...(detail.result.egress
              ? {
                  egressDestinations: detail.result.egress.destinations.map(
                    (d) => ({ host: d.host, port: d.port, allowed: d.allowed }),
                  ),
                  egressTotalBytes: detail.result.egress.totalBytes,
                }
              : {}),
          }
        : {}),
      effectivePolicy: {
        egressMode: detail.policy.mode,
        limits: this.limits,
      },
      atMs: this.opts.nowMs?.() ?? Date.now(),
    };
    await this.opts.auditSink(record);
  }
}
