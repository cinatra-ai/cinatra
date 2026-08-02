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
 *  - AUTHORIZES EVERY COMMAND against a per-command VOUCHER (epic #1705): an
 *    Ed25519-signed grant, minted per command by the app-layer mint site, that
 *    binds the exact command text, the job, the session identity, the resolved
 *    egress policy, a single-use nonce and a short expiry. The broker holds
 *    VERIFY-ONLY public key material and is structurally incapable of minting
 *    one. Verified BEFORE dispatch and re-checked for FRESHNESS after the
 *    admission wait; a voucher that expired while queued releases its permit and
 *    is answered with a one-shot revalidation challenge. The signed egress policy
 *    is then CLAMPED against this deployment's own maximum on all three axes.
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
// Per-command authorization boundary (epic #1705): the VERIFY-ONLY voucher
// contract + the deployment egress clamp. The broker imports no signing code —
// see the module header of authz/voucher.ts.
import { type ExecutionVoucherVerifier } from "./authz/voucher";
import {
  clampEgressPolicy,
  type EgressClampAxis,
  type EgressDeploymentMaximum,
} from "./authz/egress-clamp";
// Exec-plane L3: the broker no longer touches docker for volume lifecycles —
// it holds a TYPED seam that defaults to the same local docker-backed helpers.
import {
  createLocalDockerContainerOps,
  createLocalDockerVolumeOps,
  type SandboxContainerOps,
  type SandboxVolumeOps,
} from "./volume-ops";
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
  type ExecutionAuditAdmission,
  type ExecutionAuditReservation,
  type ExecutionAuditReserver,
  type ExecutionAuditSink,
  type ExecutionStdioRedactor,
  type ExecutionStdioSink,
  type OpenJobFailureReason,
  type ResolvedEgress,
  type OpenJobResult,
  type PlacementGuard,
  type PlacementVerdict,
  type RunLivenessProbe,
  type SandboxCommandResult,
  type StagedSkillInput,
  type SandboxResourceLimits,
  type SandboxWorker,
} from "./types";
import { SANDBOX_WORKSPACE_DIR } from "./l0-profile";

/** The fields one audit record is built from (`buildAuditRecord`). */
type AuditRecordDetail = {
  decision: "executed" | "refused" | "outcome_unknown";
  reason?: string;
  result?: SandboxCommandResult;
  policy: EgressPolicy;
  commandId?: string;
  voucherRejection?: string;
  egressClamped?: readonly EgressClampAxis[];
};

export type ExecutionBrokerOptions = {
  worker: SandboxWorker;
  auditSink: ExecutionAuditSink;
  /**
   * The DURABLE PRE-DISPATCH RESERVATION seam (cinatra#2266 G1). Present ⇒ the
   * broker reserves an audit record — durably, on the broker's own volume —
   * before it hands a command to the sandbox, and a rejected reservation
   * REFUSES the command (`audit_spool_unavailable`) rather than running one it
   * cannot account for. Absent ⇒ no reservation and the pre-#2266 behaviour,
   * which is what the in-process placement (sink → kernel, no spool) keeps.
   */
  auditReserver?: ExecutionAuditReserver;
  /**
   * THE SATURATION ADMISSION GATE (cinatra#2266 G5). Present ⇒ the broker asks
   * whether the plane can account for ANY new command before it walks a
   * pipeline whose every exit writes a record. A refusal here is fail-closed
   * (`audit_spool_unavailable`) and — this is the point — mints NO record: a
   * spool that cannot store a refusal record must not be asked to store one per
   * attempt. Absent ⇒ no gate, which is the in-process placement's behaviour.
   */
  auditAdmission?: ExecutionAuditAdmission;
  livenessProbe: RunLivenessProbe;
  /**
   * The per-command authorization boundary (epic #1705). REQUIRED, not optional:
   * a broker constructed without one would be a broker that runs commands
   * nobody authorized, and an authorization gate that can be omitted is an
   * authorization gate that WILL be omitted. Holds VERIFY-ONLY public key
   * material and cannot mint.
   */
  voucherVerifier: ExecutionVoucherVerifier;
  /**
   * Ceiling the DEPLOYMENT imposes on the signed egress policy (all three
   * axes). Absent ⇒ no deployment ceiling, and the signed policy stands.
   */
  deploymentEgressMaximum?: EgressDeploymentMaximum;
  /**
   * Resolve the egress policy for a session. Since the voucher carries the
   * policy RESOLVED AT MINT, this is no longer the dispatch input — it is the
   * fallback used only to fill the `effectivePolicy` field of an audit record
   * for a refusal that happened before any voucher was verified (there is no
   * signed policy to report yet, but the row must still be complete).
   */
  egressPolicyResolver: (session: ExecutionSession) => EgressPolicy;
  stdioSink?: ExecutionStdioSink;
  stdioRedactor?: ExecutionStdioRedactor;
  commandPolicy?: CommandPolicyHook;
  quotas?: Partial<BrokerQuotas>;
  limits?: Partial<SandboxResourceLimits>;
  /** Sandbox network + gateway endpoint for gateway egress modes. */
  sandboxNetwork?: string;
  gateway?: EgressGatewayEndpoint;
  /**
   * Injection seam so workspace ops share the worker's docker CLI in tests.
   * Since exec-plane L3 this is the seam the DEFAULT `volumeOps` /
   * `containerOps` are built over — pass `volumeOps` to place those operations
   * off this host entirely.
   */
  docker?: DockerCli;
  /**
   * Where the L2 workspace + read-only skills volume lifecycles are performed
   * (exec-plane L3). Absent ⇒ the local docker-backed implementation over
   * `docker`, byte-identical to the pre-seam behaviour. A managed placement
   * passes its `WorkerServiceClient`, so the broker host needs no docker at all
   * — and, deliberately, gets no remote raw `DockerCli`: the seam is four typed
   * operations whose arguments the worker re-validates.
   */
  volumeOps?: SandboxVolumeOps;
  /**
   * How a revoked host-exclusivity lease drains what is already running
   * (exec-plane L3). Absent ⇒ the local docker-backed implementation. Only ever
   * consulted when `placementGuard` refuses, so a broker without a guard makes
   * no container calls it did not make before.
   */
  containerOps?: SandboxContainerOps;
  /**
   * Fail-closed revalidation run before EVERY placement decision — opening a
   * job (which places a volume) and dispatching a command (which places a
   * container). Absent ⇒ no host-scoped precondition, today's behaviour.
   *
   * The shipped implementation is the host-exclusivity lease
   * (`service/lease.ts`). A refusal STOPS ADMISSION and DRAINS: every open job
   * is terminated and its containers are cancelled by name, because a host we
   * can no longer prove is exclusively ours must not be running our containers
   * next to another tenant's.
   */
  placementGuard?: PlacementGuard;
  /** Injection seam for the gateway control-channel registration call. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for hermetic tests. */
  nowMs?: () => number;
  /** Injectable nonce source for the revalidation challenge (hermetic tests). */
  nonceFactory?: () => string;
};

/**
 * Bound on the per-`commandId` bookkeeping maps (revalidation attempts,
 * outstanding challenges, executed ids). Entries are pruned by age first.
 *
 * At the hard cap the two REVALIDATION maps fail closed — a retry whose cap
 * cannot be tracked is refused rather than granted an untracked challenge. The
 * executed-id map instead evicts its oldest entry (see
 * `recordExecutedCommandId`): refusing there would turn a bookkeeping bound into
 * an execution outage, and that record only has to outlive the voucher that
 * could re-present it.
 */
const MAX_TRACKED_COMMAND_IDS = 20_000;

/**
 * How long a `commandId` record is retained. Comfortably longer than any voucher
 * TTL (30 s by default), so an executed command cannot be re-presented under a
 * fresh voucher inside the window that matters.
 *
 * Codex round 2, finding 4 — REBUTTED and recorded: past this window the retry
 * bookkeeping ages out, so the same `commandId` could receive a second challenge.
 * That is deliberate. The cap exists to stop a TIGHT remint loop from holding a
 * concurrency permit indefinitely, not to retire a `commandId` forever; a retry
 * spaced 15 minutes apart is not that loop, its voucher must be freshly minted
 * (the mint site re-derives and re-compares the run's OBO ceiling from scratch),
 * and the executed-id record — the one that actually enforces idempotency — is
 * retained for 30x the voucher TTL. A durable, unbounded-lifetime tombstone would
 * need shared storage, which this slice deliberately does not add.
 */
const COMMAND_ID_RETENTION_MS = 15 * 60 * 1000;

/**
 * Bound on the run→workspace-name map that lets hard-removal teardown collect a
 * RETAINED L2 workspace (one whose jobs are all closed). One short string pair
 * per run this process has opened a job for; the eviction posture is documented
 * on `rememberRunWorkspace`.
 */
const MAX_TRACKED_RUN_WORKSPACES = 10_000;

/**
 * Per-destination egress entries one audit record carries (cinatra#2266 slice
 * 2). The gateway attributes one entry per host a command contacted, which is
 * unbounded in the command's own control — and since the durable spool reserves
 * capacity for a record's terminal form BEFORE dispatch, an unbounded list
 * would make that reservation unsound. The true count always rides
 * `egressDestinationsTotal`, so the bound truncates the SAMPLE and never the
 * fact.
 */
const MAX_AUDITED_EGRESS_DESTINATIONS = 32;

/**
 * Per-destination host length carried on an audit record. 253 is the maximum
 * length of a DNS name; the gateway reports what the SANDBOX asked for, which
 * is not obliged to be one (Codex round 3, adopted). Capping it is what makes
 * the spool's terminal-frame headroom a real bound rather than an estimate.
 */
const MAX_AUDITED_EGRESS_HOST_CHARS = 253;

/** Image-digest length carried on an audit record. A sha256 reference is far
 *  shorter; the cap exists so no field of the terminal record is unbounded. */
const MAX_AUDITED_IMAGE_DIGEST_CHARS = 512;

/**
 * Narrow a gateway-reported string to a form whose JSON encoding is EXACTLY one
 * byte per character, then cap its length (cinatra#2266, Codex round 3 —
 * adopted twice).
 *
 * A plain `.slice(n)` is NOT a byte bound: it counts UTF-16 code units, so 253
 * three-byte characters are 759 bytes, and JSON escaping can inflate a single
 * control character to six. Either is enough to push a terminal audit frame
 * past the capacity its pre-dispatch reservation claimed — and that capacity is
 * the whole reason a command that HAS RUN can always be recorded.
 *
 * Restricting to the characters a hostname or an image reference can actually
 * contain fixes both at once: every survivor is ASCII (one byte) and none of
 * them is escaped by `JSON.stringify` (no quote, no backslash, no control
 * character), so `length` IS the encoded byte count. It is also the honest
 * shape — a "host" outside this set is not one — and anything dropped is
 * operator-facing decoration on the record, never a decision.
 */
function boundAuditText(text: string, maxChars: number, allowed: RegExp): string {
  return text.replace(allowed, "").slice(0, maxChars);
}

/** Everything a hostname / IPv4 / bracketed IPv6 literal can contain. */
const NOT_HOST_CHARS = /[^A-Za-z0-9.:_\-[\]]/g;
/** Everything a docker image reference can contain. */
const NOT_DIGEST_CHARS = /[^A-Za-z0-9.:@/_\-]/g;

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
  /**
   * Subscribers to wake when this job is terminated (epic #1705 AC9). Today the
   * only subscribers are commands parked in the admission queue: terminating a
   * job must CANCEL them, not leave them holding a queue slot until an
   * unrelated command frees a permit. Cleared by `terminate`; late subscribers
   * are served synchronously off `job.terminated` (see `cancellationFor`).
   */
  cancelListeners: Set<() => void>;
  /**
   * Set when the injected liveness probe THREW rather than answering. The
   * recorded posture keeps the command running (see `probeLiveness`), but the
   * degraded observation rides every audit record for this job instead of being
   * silently equated with a healthy read.
   */
  livenessDegraded?: boolean;
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

/**
 * This producer's denied-cooldown POSTURE (cinatra#2266 AC1).
 *
 * Every record this mapper emits pins `resourceType` / `operation` to
 * `execution_sandbox` / `sandbox_execute`, and the actor is always the same
 * user, so the kernel's default cooldown key (`actor : resourceType :
 * operation`) is ONE constant string per user. Under that key the kernel
 * recorded the FIRST refusal in a 60 s window and silently discarded every
 * later one — across different jobs, different commands and different reasons.
 * Ten forged vouchers in a minute produced one audit row.
 *
 * `record_every` rather than a finer key, and the reason is not convenience
 * (Codex convergence, adopted over two rounds). A finer key has to be built
 * from something the record carries, and the refusal paths that matter most
 * carry nothing that distinguishes them: a voucher is rejected BEFORE its
 * claims are trusted, so a forged, expired or replayed voucher has no
 * `commandId` at all, and neither does a job-level refusal. Keying on
 * job + reason + rejection collapses exactly the burst an investigation needs
 * to see; adding the record's own `atMs` only shrinks the collision to
 * "inside the same millisecond", which two concurrent refusals on one job can
 * still hit. A refusal is an authorization DECISION, and one that is discarded
 * makes an investigation read "no record" as "it did not happen" — so this
 * producer states plainly that it has no repeat semantics, instead of
 * approximating one it cannot express.
 *
 * ACCEPTED VOLUME: a refusal loop now writes one row per refusal instead of
 * one per minute. That is the point. The rate is bounded by what the app
 * submits — every refusal costs a full app→broker round trip carrying a
 * voucher — not by the audit kernel.
 *
 * The MINT side is deliberately different (`execution-broker-construct.ts`):
 * a mint event carries a REQUIRED `commandId`, so it CAN say what makes two
 * denials the same event, and it opts into the finer key instead.
 */

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
  deniedCooldown: "record_every";
  /**
   * The spool's PHYSICAL delivery identity (cinatra#2266 G2/G4), when this
   * record came off a spool. It is the kernel's idempotent-insert key: a
   * re-delivery after a crash carries the SAME value, so the second insert is
   * reported as a duplicate instead of writing a second row for one execution.
   * Absent on the in-process placement, whose records never enter a spool.
   */
  executionDeliveryKey?: string;
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
    // THE AUTHZ AXIS IS THE AUTHORIZATION DECISION, not the execution outcome
    // — which is what makes `outcome_unknown` map to `allowed` and not to a
    // refusal (cinatra#2266 G1). That record exists because the command passed
    // EVERY authorization gate and was handed to the sandbox; what the broker
    // never learned is how it ended. Projecting it as `denied` would assert an
    // authorization refusal that did not happen and would hide a real
    // execution from a "what did this user actually run" query. The unknown
    // half is not lost: it rides `reason` and `metadata.outcome`, both of which
    // say `outcome_unknown` in as many words.
    decision: record.decision === "refused" ? "denied" : "allowed",
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.deliveryKey ? { executionDeliveryKey: record.deliveryKey } : {}),
    // Cooldown CONTROL field, not audit data: the kernel reads it to decide
    // whether to suppress a denied event and never persists it. Allowed rows
    // are never suppressed and ignore it.
    deniedCooldown: "record_every",
    metadata: {
      surface: record.surface,
      cwd: record.cwd,
      // The LOGICAL correlation key's own terms (`jobId + seq + decision`) —
      // `jobId` already rides `resourceId`. Kept as payload, deliberately NOT
      // as the delivery key: see `executionDeliveryKey` above and #2266 G2.
      seq: record.seq,
      outcome: record.decision,
      reason: record.reason,
      exitCode: record.exitCode,
      termination: record.termination,
      imageDigest: record.imageDigest,
      egressMode: record.effectivePolicy.egressMode,
      egressTotalBytes: record.egressTotalBytes,
      wallMs: record.wallMs,
      workspaceKb: record.workspaceKb,
      // Per-command authorization (epic #1705): the client's idempotency key,
      // the precise voucher rejection when the refusal is an authorization
      // refusal, and which egress axes the deployment clamp narrowed. The nonce
      // is deliberately NOT carried — single-use, no evidentiary value.
      commandId: record.commandId,
      voucherRejection: record.voucherRejection,
      egressClamped: record.egressClamped,
      // The G5 saturation episode this row OPENS, when it is that row. An
      // investigation reading a gap in the trail needs the row that explains
      // it: "the plane stopped admitting commands at T, under episode X".
      spoolEpisodeId: record.spoolEpisode?.id,
      spoolEpisodeOpenedAtMs: record.spoolEpisode?.openedAtMs,
    },
  };
}

/** Total description of any thrown value — a non-Error throw must not re-throw. */
function describeThrownValue(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A cancellation source a queued admission wait can subscribe to.
 *
 * STICKY BY CONTRACT (Codex design round, finding 1): `onCancel` must invoke
 * the callback IMMEDIATELY when cancellation has already happened. A waiter
 * that subscribes after the fact would otherwise never learn about it — the
 * concrete leak being the command that wins the ORG permit, unsubscribes, and
 * only then queues on the GLOBAL semaphore: it would hold that org permit for
 * the rest of the wait even though its job is already dead.
 */
type CancellationSource = {
  /** Subscribe; returns an unsubscribe. Fires SYNCHRONOUSLY if already cancelled. */
  onCancel(callback: () => void): () => void;
};

/**
 * A FIFO counting semaphore with a bounded wait queue and CANCELLABLE waits.
 *
 * Cancellation exists because AC9 (epic #1705) requires hard removal to CANCEL
 * queued-not-started work, not merely to let it discover later that it is dead:
 * `terminate` is a synchronous flag flip, so before this a parked command sat
 * on `waitAcquire()` until some unrelated in-flight command finished, and only
 * then refused. It never dispatched — but it held a queue slot for the whole
 * time, which on a saturated org is indistinguishable from an outage.
 *
 * A cancelled waiter is SPLICED OUT of the queue and never acquires, so no
 * permit is taken and none can leak; `release()` walks past any waiter that
 * settled between being shifted and being invoked, so a permit is never dropped
 * on the floor (which would starve the FIFO permanently).
 */
class BoundedSemaphore {
  private inFlight = 0;
  /** Each waiter returns true when it TOOK the permit it was handed. */
  private readonly waiters: Array<() => boolean> = [];
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

  /**
   * Call only after tryAcquire() returned "queued". Resolves FIFO with
   * `"acquired"` (the permit is HELD by the caller, who must release it) or
   * `"cancelled"` (no permit was taken — the caller must not release).
   */
  waitAcquire(cancel?: CancellationSource): Promise<"acquired" | "cancelled"> {
    return new Promise((resolve) => {
      let settled = false;
      // A holder rather than a bare `let`: `waiter` closes over the
      // unsubscribe BEFORE it can exist (subscription has to happen after the
      // push — see below), and a mutable box makes that ordering explicit.
      const subscription: { off?: () => void } = {};
      const waiter = (): boolean => {
        // Already cancelled ⇒ decline the permit so `release` hands it to the
        // next real waiter instead of losing it.
        if (settled) return false;
        settled = true;
        subscription.off?.();
        this.inFlight += 1;
        resolve("acquired");
        return true;
      };
      this.waiters.push(waiter);
      // Subscribe AFTER the push so an already-cancelled source (the sticky
      // contract above) removes the waiter it can actually find.
      subscription.off = cancel?.onCancel(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve("cancelled");
      });
    });
  }

  release(): void {
    this.inFlight -= 1;
    // Hand the permit to the first waiter that still wants it. A waiter that
    // cancelled after being shifted (JS is single-threaded, so only via the
    // synchronous `settled` flag) declines, and the loop continues.
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next && next()) return;
    }
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
  /**
   * Post-queue revalidation attempts per `commandId` — capped at ONE remint.
   * BROKER-side on purpose: a client-side counter is a client-side promise, and
   * an unbounded remint loop is a free way to hold a semaphore permit forever.
   */
  private readonly revalidationAttempts = new Map<string, { count: number; atMs: number }>();
  /** Outstanding revalidation challenges: the nonce a remint MUST carry. */
  private readonly revalidationChallenges = new Map<string, { nonce: string; atMs: number }>();
  /** `commandId`s already DISPATCHED — per-command idempotency (in-memory). */
  private readonly executedCommandIds = new Map<string, number>();
  /**
   * `commandId`s CONCURRENTLY in the exec pipeline. Closes the window between the
   * idempotency check and the dispatch-time claim (there are awaits in between),
   * so two submissions of the same commandId under two different valid nonces
   * cannot both dispatch. Bounded by the admission ceilings — a claim is held only
   * while a command is in this method, and the semaphores cap that population.
   */
  private readonly inFlightCommandIds = new Set<string>();
  /**
   * runId → the L2 workspace volume name the ops seam RETURNED for it. Survives
   * `closeJob` / `closeIdleJobs` on purpose: those leave the run-keyed volume in
   * place for the retention GC, and this is the only handle by which
   * hard-removal teardown can reach that RETAINED workspace (epic #1705 AC9).
   * Bounded by `MAX_TRACKED_RUN_WORKSPACES`; dropped when the run is torn down.
   */
  private readonly runWorkspaces = new Map<string, string>();
  private readonly opts: ExecutionBrokerOptions;
  /**
   * The typed host-operation seams. Resolved ONCE in the constructor over
   * `opts.docker`, which is exactly what the six call sites used to pass to the
   * `workspace.ts` / `staging.ts` helpers — the argv a default-constructed
   * broker emits is unchanged (`volume-ops-parity.test.ts`).
   */
  private readonly volumeOps: SandboxVolumeOps;
  private readonly containerOps: SandboxContainerOps;

  constructor(opts: ExecutionBrokerOptions) {
    this.opts = opts;
    this.volumeOps = opts.volumeOps ?? createLocalDockerVolumeOps(opts.docker);
    this.containerOps =
      opts.containerOps ?? createLocalDockerContainerOps(opts.docker);
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
    // Same containment as the per-command probe: a THROWING host probe must not
    // escape into the caller (Codex round 2, finding 2). `probeLiveness` takes a
    // job, which does not exist yet here, so inline the identical posture.
    let liveness: "alive" | "archived" | "gone";
    try {
      liveness = await this.opts.livenessProbe(session);
    } catch {
      liveness = "alive";
    }
    if (liveness === "gone") {
      return {
        ok: false,
        reason: "run_removed",
        message:
          "The bound run no longer exists (hard-removed); no job is opened (fail-closed).",
      };
    }
    // Host-exclusivity revalidation BEFORE the first placement of this job: an
    // L2 volume created on a host we no longer hold is a footprint on somebody
    // else's machine. Ordered here — after the carrier/liveness refusals, so an
    // unauthenticated caller never reaches the lease read, and BEFORE the
    // open-job reservation, whose check-and-claim must stay strictly
    // synchronous (an `await` between them reopens the burst race the
    // reservation exists to close).
    const placement = await this.checkPlacement();
    if (!placement.ok) {
      return {
        ok: false,
        reason: "placement_refused",
        message: placement.message,
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
      const workspaceVolume = await this.volumeOps.ensureWorkspace(workspaceKey);
      // Exec-plane S2 (cinatra#1707): stage skill snapshots read-only. A
      // staging refusal (digest mismatch / unsafe path / docker failure) fails
      // the OPEN closed — a job must never run with a partial skill set the
      // model was told it has. The workspace volume is left in place: it is
      // run-keyed (possibly shared) and retention GC owns it.
      let skillsVolume: string | undefined;
      if (openOpts?.stagedSkills && openOpts.stagedSkills.length > 0) {
        // Re-check before the SECOND placement of this open (Codex round 2,
        // finding C1): the workspace provisioning above is an awaited call, and
        // the lease can be reclaimed inside it. Staging places another volume
        // and a helper container, so it is its own placement decision.
        const beforeStaging = await this.checkPlacement();
        if (!beforeStaging.ok) {
          return { ok: false, reason: "placement_refused", message: beforeStaging.message };
        }
        try {
          skillsVolume = await this.volumeOps.stageSkills(
            jobId,
            openOpts.stagedSkills,
            resolveL0ImageRef(),
          );
        } catch (err) {
          return {
            ok: false,
            reason: "staging_failed",
            message: `Skill staging refused: ${(err as Error).message}`,
          };
        }
      }
      // FINAL check, immediately before the job becomes visible (Codex round 2,
      // findings C1/D2). A drain that ran while this open was in flight walked a
      // `jobs` map this job was not yet in, so inserting it now would leave an
      // ACTIVE job on a host that has already been handed over. The per-job
      // skills volume is dropped on the way out; the workspace volume is
      // run-keyed (possibly shared with a live job) and belongs to retention GC
      // — the same posture as the staging-failure path above.
      const beforeInsert = await this.checkPlacement();
      if (!beforeInsert.ok) {
        if (skillsVolume) {
          await this.volumeOps.removeSkills(skillsVolume).catch(() => {});
        }
        return { ok: false, reason: "placement_refused", message: beforeInsert.message };
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
        cancelListeners: new Set(),
      };
      this.jobs.set(jobId, job);
      // Remember the REAL volume name the ops layer returned for this run
      // (never a name this broker re-derives — the seam may be remote and its
      // naming is its own; Codex design round, finding 3). This is what lets
      // hard-removal teardown collect a RETAINED workspace: one whose jobs have
      // all been closed or idle-reaped, both of which deliberately leave the L2
      // volume in place for the retention GC.
      if (session.runId) this.rememberRunWorkspace(session.runId, workspaceVolume);
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
   * VOUCHER VERIFICATION → liveness revalidation → command-hygiene hook →
   * quota/queue admission → POST-QUEUE voucher freshness + liveness →
   * hardened dispatch → disk-quota verdict → audit + stdio retention.
   *
   * The voucher goes FIRST because it is the authorization boundary: an
   * unauthorized command must not reach the run store, the hygiene hook, or the
   * admission queue at all. The POST-QUEUE re-check exists because admission can
   * wait unboundedly — an authorization that was live at submission may not be
   * live at dispatch, and dispatching on it would be exactly the "authorized too
   * early" defect the liveness re-probe already closes.
   */
  async exec(jobId: string, command: string, voucher: string): Promise<ExecResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        ok: false,
        reason: "unknown_job",
        message: `Unknown execution job "${jobId}".`,
      };
    }

    // THE SATURATION ADMISSION GATE (cinatra#2266 G5/AC7), and it is FIRST for
    // a reason that is the whole design: every path below this line ends in a
    // record. Against a spool that is already full, "refuse and audit" is an
    // unbounded write demand on a store that by definition has no room — so a
    // saturated plane must be able to refuse WITHOUT writing anything, and the
    // only place that is true is before the first refusal path.
    //
    // NO SEQUENCE IS ALLOCATED EITHER. `seq` is the per-job attempt sequence of
    // the RECORDED stream; burning numbers on attempts that produce no record
    // would put unexplained holes in it.
    //
    // The refusal is fail-closed and model-visible under the same reason a
    // failed reservation uses — from the caller's seat both mean "the plane
    // cannot account for this command, so it did not run it". The finer
    // distinction (saturated vs. a reservation that threw) is the audit trail's,
    // and it rides the episode record's own `audit_spool_full`.
    const admission = this.opts.auditAdmission?.();
    if (admission && !admission.admitted) {
      return { ok: false, reason: "audit_spool_unavailable", message: admission.message };
    }

    // THE ATTEMPT SEQUENCE, allocated HERE and not at dispatch (cinatra#2266
    // AC2). It used to be `const seq = job.seq++` immediately before
    // `worker.runCommand`, which is after every pre-dispatch refusal path has
    // already returned — so refusals carried no sequence at all, two identical
    // refusals on one job were indistinguishable, and a dispatch failure
    // consumed a sequence the refusal path never saw. One sequence per exec()
    // attempt, allocated before the first path that can refuse, fixes all
    // three. It is the LOGICAL correlation key; the physical delivery key is
    // the spool's (see `ExecutionAuditRecord.deliveryKey`).
    const seq = job.seq++;
    if (job.terminated) {
      return this.refuse(job, seq, command, "job_terminated",
        `The job was terminated (${job.terminationReason ?? "unspecified"}); no further commands run on it.`);
    }

    // Host-exclusivity gate, admission half. A revoked lease must stop new work
    // entering the pipeline BEFORE the (potentially unbounded) admission wait,
    // not only at dispatch — otherwise a queue full of already-admitted
    // commands would keep placing containers on a host that is no longer ours.
    const admissionPlacement = await this.checkPlacement();
    if (!admissionPlacement.ok) {
      return this.refuse(job, seq, command, "placement_revoked", admissionPlacement.message);
    }

    // --- the authorization boundary ----------------------------------------
    const now = this.opts.nowMs?.() ?? Date.now();
    this.pruneCommandBookkeeping(now);
    const verified = this.opts.voucherVerifier.verify(voucher, {
      jobId: job.jobId,
      command,
      session: {
        orgId: job.session.orgId,
        userId: job.session.userId,
        surface: job.session.surface,
        ...(job.session.runId ? { runId: job.session.runId } : {}),
      },
      nowMs: now,
      requiredNonceForCommandId: (commandId) =>
        this.revalidationChallenges.get(commandId)?.nonce,
    });
    if (!verified.ok) {
      const reason: ExecFailureReason =
        verified.rejection === "missing"
          ? "voucher_missing"
          : verified.rejection === "expired"
            ? "voucher_expired"
            : verified.rejection === "replayed"
              ? "voucher_replayed"
              : "voucher_invalid";
      // The MODEL sees only the coarse reason; the precise rejection is audited.
      return this.refuse(
        job,
        seq,
        command,
        reason,
        "The command is not authorized: its per-command authorization voucher was " +
          `rejected (${verified.rejection}). The command is refused (fail-closed).`,
        undefined,
        { voucherRejection: verified.rejection },
      );
    }
    const claims = verified.claims;

    // Clamp the SIGNED egress policy against this deployment's own maximum on
    // all three axes. From here on `policy` — not the resolver — is what the
    // command runs under, and any narrowing is audited (`egressClamped` rides
    // EVERY record written from here on, executed and refused alike: an operator
    // asking "why did egress fail" must see the narrowing even when the command
    // was refused for an unrelated reason before it ever reached the sandbox).
    const { policy: clampedPolicy, clamped } = clampEgressPolicy(
      claims.egressPolicy,
      this.opts.deploymentEgressMaximum,
    );
    const detail = { commandId: claims.commandId, egressClamped: clamped };

    // Per-command idempotency, in TWO parts because `executedCommandIds` is only
    // written at dispatch and there are awaits (the liveness probe, the admission
    // wait) between here and there:
    //   - `executedCommandIds` refuses a commandId that ALREADY reached the
    //     sandbox, even under a freshly minted voucher;
    //   - `inFlightCommandIds` refuses a commandId that is CONCURRENTLY in this
    //     pipeline. Without it, two submissions carrying the same commandId under
    //     two different (individually valid, individually un-replayed) nonces
    //     would both pass the executed-check and both dispatch.
    // The claim below is taken SYNCHRONOUSLY — no await between the check and the
    // add — so a second submission cannot interleave into the gap. It is released
    // in the `finally` on every path, so a refusal the client may legitimately
    // retry (including the revalidation remint, which reuses the commandId by
    // design) is never permanently blocked.
    if (
      this.executedCommandIds.has(claims.commandId) ||
      this.inFlightCommandIds.has(claims.commandId)
    ) {
      return this.refuse(job, seq, command, "command_replayed",
        `Command ${claims.commandId} already executed (or is in flight) on this broker; the repeat is refused (idempotency).`,
        clampedPolicy, detail);
    }
    this.inFlightCommandIds.add(claims.commandId);

    // The challenge (if any) is ANSWERED the moment `verify` accepted a voucher
    // carrying it — `verify` consumed that nonce, so it can never be presented
    // again. Clearing the pin HERE rather than after the admission wait matters
    // (Codex round 2, finding 3): a remint that answers the challenge and is then
    // refused early — hygiene hook, queue saturation — would otherwise leave the
    // commandId pinned to an already-consumed nonce, i.e. permanently unusable.
    // The ATTEMPT COUNT deliberately survives, so the one-remint cap still holds.
    this.revalidationChallenges.delete(claims.commandId);

    // Permit + claim accounting. The post-queue revalidation path must release
    // the permits BEFORE it answers (see below), and the `finally` must neither
    // double-release them nor leak the in-flight claim on any exit.
    const orgSem = this.orgSemaphore(job.session.orgId);
    let permitsHeld = false;
    const releasePermits = (): void => {
      if (!permitsHeld) return;
      permitsHeld = false;
      this.globalSemaphore.release();
      orgSem.release();
    };

    try {
      // Per-command liveness revalidation (S1 AC6): purge fails the NEXT command
      // closed and terminates the job; archive proceeds.
      const liveness = await this.probeLiveness(job);
      if (liveness === "gone") {
        this.terminate(job, "run_removed");
        return await this.refuse(job, seq, command, "run_removed",
          "The bound run was hard-removed mid-job; the command is refused and the job is terminated (fail-closed).",
          clampedPolicy, detail);
      }

      if (this.opts.commandPolicy) {
        const verdict = this.opts.commandPolicy(job.session, command);
        if (!verdict.allowed) {
          return await this.refuse(job, seq, command, "command_blocked", verdict.reason,
            clampedPolicy, detail);
        }
      }

      const orgAdmission = orgSem.tryAcquire();
      if (orgAdmission === "saturated") {
        return await this.refuse(job, seq, command, "queue_saturated",
          "The org's execution queue is full; retry later (bounded queueing).",
          clampedPolicy, detail);
      }
      // The admission wait is the ONE unbounded pause in this pipeline, so it is
      // where hard-removal cancellation has to land (epic #1705 AC9): a job
      // terminated while its command is parked wakes it IMMEDIATELY, releases
      // whatever it held, and refuses — the command never dispatches and never
      // keeps a queue slot warm on a saturated org. `cancellationFor` is sticky,
      // so a job terminated between the two waits cancels the second one too.
      const cancellation = this.cancellationFor(job);
      if (orgAdmission === "queued") {
        // Nothing acquired on the cancelled path, so nothing to release here.
        if ((await orgSem.waitAcquire(cancellation)) === "cancelled") {
          return await this.refuse(job, seq, command, "job_terminated",
            `The job was terminated (${job.terminationReason ?? "unspecified"}) while the command was queued; the command is cancelled and never runs.`,
            clampedPolicy, detail);
        }
      }
      const globalAdmission = this.globalSemaphore.tryAcquire();
      if (globalAdmission === "saturated") {
        orgSem.release();
        return await this.refuse(job, seq, command, "queue_saturated",
          "The global execution queue is full; retry later (bounded queueing).",
          clampedPolicy, detail);
      }
      if (globalAdmission === "queued") {
        if ((await this.globalSemaphore.waitAcquire(cancellation)) === "cancelled") {
          // The ORG permit IS held here (won above) and `permitsHeld` is still
          // false, so the `finally` will not release it — release it explicitly.
          orgSem.release();
          return await this.refuse(job, seq, command, "job_terminated",
            `The job was terminated (${job.terminationReason ?? "unspecified"}) while the command was queued; the command is cancelled and never runs.`,
            clampedPolicy, detail);
        }
      }
      permitsHeld = true;

      // The signed, deployment-clamped policy IS the dispatch policy. The
      // resolver is no longer consulted here: a policy the model's own broker
      // re-resolved at dispatch time could differ from the one the mint site
      // authorized, and the authorized one is the only one that may run.
      const policy: EgressPolicy = clampedPolicy;

      // Re-authorize AFTER the (possibly unbounded) queue wait — a job purged or
      // terminated while queued must not execute (finding: queued commands
      // authorized too early). Re-check termination, the voucher's freshness, and
      // re-probe liveness here.
      if (job.terminated) {
        return await this.refuse(job, seq, command, "job_terminated",
          `The job was terminated (${job.terminationReason ?? "unspecified"}) while queued; the command is refused.`,
          policy, detail);
      }

      // VOUCHER FRESHNESS, checked at every point where time may have passed. An
      // authorization that expired while the command waited is not an
      // authorization. Release the permit FIRST — a command that is going nowhere
      // must not keep a concurrency slot warm across the audit write and the
      // client's remint round-trip — then answer with a challenge the remint has
      // to carry. Returns null when the voucher is still live.
      const requireFreshVoucher = async (): Promise<ExecResult | null> => {
        const atMs = this.opts.nowMs?.() ?? Date.now();
        const fresh = this.opts.voucherVerifier.checkFreshness(claims, atMs);
        if (fresh.ok) return null;
        releasePermits();
        const attempts = this.revalidationAttempts.get(claims.commandId)?.count ?? 0;
        if (attempts >= 1) {
          this.revalidationChallenges.delete(claims.commandId);
          return await this.refuse(job, seq, command, "revalidation_exhausted",
            "The command's authorization expired again before it could run; it will not " +
              "be revalidated a second time (fail-closed). Resubmit as a new command.",
            policy, { ...detail, voucherRejection: fresh.rejection });
        }
        if (
          this.revalidationAttempts.size >= MAX_TRACKED_COMMAND_IDS ||
          this.revalidationChallenges.size >= MAX_TRACKED_COMMAND_IDS
        ) {
          // Cannot track the retry ⇒ cannot cap it ⇒ refuse rather than issue an
          // untracked challenge.
          return await this.refuse(job, seq, command, "revalidation_exhausted",
            "The broker cannot track another revalidation; the command is refused (fail-closed).",
            policy, { ...detail, voucherRejection: fresh.rejection });
        }
        this.revalidationAttempts.set(claims.commandId, { count: attempts + 1, atMs });
        const nonce = this.opts.nonceFactory?.() ?? randomUUID();
        this.revalidationChallenges.set(claims.commandId, { nonce, atMs });
        await this.audit(job, seq, command, {
          decision: "refused",
          reason: "revalidation_required",
          policy,
          ...detail,
          voucherRejection: fresh.rejection,
        });
        return {
          ok: false,
          reason: "revalidation_required",
          message:
            "The command's authorization expired before it could run. Remint the " +
            "voucher for this commandId carrying the returned nonce and resubmit once.",
          revalidation: {
            commandId: claims.commandId,
            nonce,
            aud: this.opts.voucherVerifier.aud,
          },
        };
      };

      // Check 1 — right out of the admission queue, which is the unbounded wait.
      const afterQueue = await requireFreshVoucher();
      if (afterQueue) return afterQueue;

      const postQueueLiveness = await this.probeLiveness(job);
      if (postQueueLiveness === "gone") {
        this.terminate(job, "run_removed");
        return await this.refuse(job, seq, command, "run_removed",
          "The bound run was hard-removed while the command was queued; refused and the job is terminated (fail-closed).",
          policy, detail);
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
        return await this.refuse(job, seq, command, "egress_unavailable",
          `Failed to resolve egress for the command: ${(err as Error).message}`, policy,
          detail);
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
            return await this.refuse(job, seq, command, "egress_unavailable",
              `Egress gateway registration failed (${err.message}); the command is refused (fail-closed).`, policy,
              detail);
          }
          throw err;
        }
      }

      // Check 2 — IMMEDIATELY before dispatch (Codex round 2, finding 1). The
      // post-queue check above is not sufficient on its own: the liveness re-probe
      // and the gateway registration are both awaited network/store calls, and a
      // slow one could carry the voucher past its expiry between "still fresh" and
      // "running". The authorization must be live at the instant the sandbox is
      // handed the command, not merely at the instant admission was won.
      // Host-exclusivity gate, DISPATCH half — the actual placement decision.
      // Same reasoning as the voucher's check 2: the admission wait, the
      // liveness re-probe and the gateway registration are all awaited, and the
      // lease can be reclaimed inside any of them. The host must be provably
      // ours at the instant a container is placed on it, not merely when the
      // command was admitted.
      //
      // Ordered BEFORE the final freshness check, not after (Codex round 2,
      // finding C2): the merged contract is that authorization is live at the
      // instant the sandbox is handed the command, so the VOUCHER check has to
      // stay the last awaited gate. Nothing this guard learned can go stale in
      // between — it reads the lease on every call.
      const dispatchPlacement = await this.checkPlacement();
      if (!dispatchPlacement.ok) {
        return await this.refuse(job, seq, command, "placement_revoked",
          dispatchPlacement.message, policy, detail);
      }

      const beforeDispatch = await requireFreshVoucher();
      if (beforeDispatch) return beforeDispatch;

      // Claim the commandId at the LAST point before dispatch: everything above
      // is a refusal the client may legitimately retry, everything below has
      // (or may have) touched the sandbox.
      this.recordExecutedCommandId(claims.commandId, this.opts.nowMs?.() ?? Date.now());

      // THE DURABLE PRE-DISPATCH RESERVATION (cinatra#2266 G1/AC4). The last
      // thing before the sandbox is handed the command, and the first thing
      // that can stop it from being handed at all.
      //
      // WHY IT CANNOT BE AN APPEND AFTER THE RUN. The terminal decision is only
      // known once `runCommand` returns, so a crash in between loses the
      // command entirely — however durable the append would have been. The
      // reservation writes the prepared record (and claims the capacity its
      // terminal form needs) BEFORE dispatch, and spool recovery converts an
      // unresolved one into an explicit `outcome_unknown` record.
      //
      // A REJECTION REFUSES THE COMMAND. Not "log and run anyway": an execution
      // the plane cannot account for must not happen, which is the exact
      // inversion of the pre-#2266 relay (it discarded an older record and ran
      // the command). NOT ITSELF AUDITED — the audit path is what just failed,
      // and minting a record per refused attempt is the unbounded write G5
      // names; the spool counts them instead (slice 3 turns that count into one
      // bounded, durable episode record).
      let reservation: ExecutionAuditReservation | undefined;
      if (this.opts.auditReserver) {
        try {
          reservation = await this.opts.auditReserver(
            this.buildAuditRecord(job, seq, command, {
              decision: "outcome_unknown",
              reason: "outcome_unknown",
              policy,
              ...detail,
            }),
          );
        } catch (err) {
          return {
            ok: false,
            reason: "audit_spool_unavailable",
            message:
              "The command was not dispatched: the execution plane could not durably reserve " +
              `an audit record for it (${describeThrownValue(err)}). The sandbox is never ` +
              "handed a command the plane cannot account for (fail-closed).",
          };
        }
      }
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
          return await this.refuse(job, seq, command, "environment_untrusted",
            `The job's declared execution environment could not be trusted (${err.reason}); the command is refused (fail-closed).`, policy,
            { ...detail, ...(reservation ? { reservation } : {}) });
        }
        return await this.refuse(job, seq, command, "worker_error",
          `The sandbox worker failed to run the command: ${(err as Error).message}`, policy,
          { ...detail, ...(reservation ? { reservation } : {}) });
      }

      if (result.termination === "disk_quota_exceeded") {
        this.terminate(job, "disk_quota_exceeded");
      }

      // The command HAS RUN. A retention or audit transport failure from here on
      // must not turn a completed execution into a thrown error the caller would
      // read as "it did not run" and retry (Codex round 2, finding 2). Both sinks
      // are best-effort at this point; the decision was enforced before dispatch.
      try {
        await this.retainStdio(job, seq, result);
      } catch {
        // stdio retention is observability, never the decision.
      }
      try {
        const terminal = this.buildAuditRecord(job, seq, command, {
          decision: "executed",
          reason:
            result.termination === "exited" ? undefined : result.termination,
          result,
          policy,
          ...detail,
        });
        // The reservation OWNS this attempt's delivery slot: committing through
        // it upgrades the prepared record to the terminal one under the same
        // delivery key, so a crash after this point re-delivers ONE record, not
        // an `outcome_unknown` beside an `executed` (cinatra#2266 G1/G2).
        if (reservation) await reservation.commit(terminal);
        else await this.opts.auditSink(terminal);
      } catch {
        // Same posture as the host sink's own guard.
      }
      return { ok: true, result };
    } finally {
      releasePermits();
      // Release the concurrency claim on EVERY exit. `executedCommandIds` is
      // what keeps a DISPATCHED commandId from running twice; this set only ever
      // bounds concurrent submissions of the same id.
      this.inFlightCommandIds.delete(claims.commandId);
    }
  }

  /**
   * The HARD-REMOVAL teardown seam (epic #1705 AC9). Called by the app's
   * extension data-teardown participant for every run of a package that was
   * force-deleted or purged. Returns the number of jobs terminated by THIS
   * call. Idempotent: a re-fire terminates nothing new and re-attempts the
   * volume removals, which is exactly the retry a best-effort teardown wants.
   *
   * Three duties, in the AC's own words:
   *
   *  - "cancels queued jobs" — `terminate` fires the job's cancel listeners, so
   *    a command parked in the admission queue wakes IMMEDIATELY, releases
   *    whatever it held and refuses `job_terminated`. It never dispatches, and
   *    it stops occupying a queue slot.
   *  - "fails the next in-flight command closed" — the pre-existing termination
   *    flag, unchanged. A container already mid-run is NOT killed here (that is
   *    the placement-drain path's job, and killing a tenant's running command on
   *    a lifecycle event is not this seam's contract).
   *  - "GCs retained workspaces" — with `removeWorkspace`, the run's L2 volume
   *    goes NOW rather than waiting out the retention window, including the
   *    RETAINED case where no job is open any more (`closeJob` /
   *    `closeIdleJobs` deliberately leave the run-keyed volume behind).
   *
   * WHY REMOVING A RETAINED WORKSPACE IS SOUND HERE, precisely (Codex design
   * round, finding 2 — the general "no local job ⇒ unused" inference is NOT
   * sound, so the argument is scoped to this caller): hard removal has already
   * deleted the run row, so (a) `openJob` for this run is refused at its
   * liveness gate BEFORE it provisions any volume, and (b) every job still open
   * on any broker fails its next command closed on the same probe — no new
   * writer can appear. The only remaining holder is a container already running,
   * and docker refuses to remove a volume that is attached; that failure is
   * tolerated and the retention GC retries. The name removed is the one the
   * volume-ops seam RETURNED at open, never a name re-derived here.
   *
   * LIMITATION, on record: `runWorkspaces` is process-local, so a workspace
   * retained by a PREVIOUS process lifetime is not reachable by name here and
   * stays with the retention GC. Making that durable needs shared state this
   * slice deliberately does not add.
   */
  async terminateJobsForRun(
    runId: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<number> {
    // PHASE 1 — TERMINATE EVERYTHING FIRST, synchronously, with no await in the
    // loop (Codex review, finding 2). Cancelling the run's work is the duty that
    // must not be delayed or skipped: an awaited volume removal in this loop
    // would let one slow (or rejecting) docker call postpone — or, on a
    // rejection, entirely skip — the cancellation of every later job of the same
    // run. Cleanup is phase 2, and it cannot hold cancellation hostage.
    let terminated = 0;
    const workspaces = new Set<string>();
    const skillsVolumes: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.session.runId !== runId) continue;
      // A job terminated by an EARLIER fire (or by a purged-liveness refusal)
      // is not re-terminated or re-counted, but its volumes are still swept:
      // the previous fire's removal may have failed while a container held it.
      if (!job.terminated) {
        this.terminate(job, "run_removed");
        terminated += 1;
      }
      // Deduped by NAME: every job of a run shares one run-keyed workspace.
      if (opts?.removeWorkspace) workspaces.add(job.workspaceVolume);
      // The skills volume is strictly per-job (never shared).
      if (job.skillsVolume) skillsVolumes.push(job.skillsVolume);
    }
    // The RETAINED workspace: a run whose jobs are all closed still has its
    // volume, because `closeJob` / `closeIdleJobs` leave it to the retention GC.
    const retained = opts?.removeWorkspace
      ? this.runWorkspaces.get(runId)
      : undefined;
    if (retained !== undefined) workspaces.add(retained);

    // PHASE 2 — best-effort cleanup, each attempt ISOLATED so one failure never
    // strands the rest. A failed removal is not lost work: the mapping is only
    // forgotten on success, so the next fire retries it, and the retention GC is
    // the backstop under that.
    for (const volumeName of workspaces) {
      try {
        await this.volumeOps.removeWorkspace(volumeName);
        if (retained === volumeName) this.runWorkspaces.delete(runId);
      } catch {
        // Tolerated: docker refuses a volume an attached container still holds.
      }
    }
    for (const volumeName of skillsVolumes) {
      try {
        await this.volumeOps.removeSkills(volumeName);
      } catch {
        // Same posture — per-volume containment, retried on the next fire.
      }
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
      await this.volumeOps.removeWorkspace(job.workspaceVolume);
      // FORGET the run→workspace mapping when the volume it names is gone
      // (Codex review, finding 1). A name left behind after its volume was
      // removed is a name a later `ensureWorkspace` could legitimately hand to
      // a DIFFERENT run — and hard-removal teardown would then delete that
      // run's workspace. Conditioned on the name still matching, so a mapping
      // already re-pointed by a newer open is never dropped.
      this.forgetRunWorkspace(job.session.runId, job.workspaceVolume);
    }
    // The skills volume is strictly per-job (never shared): remove eagerly.
    if (job.skillsVolume) {
      await this.volumeOps.removeSkills(job.skillsVolume);
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

  /**
   * A STICKY cancellation source for a job (Codex design round, finding 1).
   *
   * "Sticky" is the whole point: `terminate` clears the listener set, so a
   * subscriber that arrives afterwards would otherwise wait forever. Subscribing
   * to an ALREADY-terminated job therefore fires synchronously — which is
   * exactly the case a command hits when it wins the org permit, unsubscribes,
   * and only then queues on the global semaphore.
   */
  private cancellationFor(job: BrokerJob): CancellationSource {
    return {
      onCancel: (callback: () => void): (() => void) => {
        if (job.terminated) {
          callback();
          return () => {};
        }
        job.cancelListeners.add(callback);
        return () => job.cancelListeners.delete(callback);
      },
    };
  }

  /**
   * Record the REAL L2 volume name the ops seam returned for a run, so
   * hard-removal teardown can collect a RETAINED workspace by name instead of
   * re-deriving one (the seam may be remote and owns its own naming).
   *
   * Bounded like the other per-command bookkeeping: at the cap the OLDEST entry
   * is evicted rather than refusing an open — losing a name only costs the
   * retention GC one more sweep, whereas refusing would turn a bookkeeping bound
   * into an execution outage.
   */
  private rememberRunWorkspace(runId: string, volumeName: string): void {
    if (
      !this.runWorkspaces.has(runId) &&
      this.runWorkspaces.size >= MAX_TRACKED_RUN_WORKSPACES
    ) {
      const oldest = this.runWorkspaces.keys().next().value as string | undefined;
      if (oldest !== undefined) this.runWorkspaces.delete(oldest);
    }
    this.runWorkspaces.set(runId, volumeName);
  }

  /** Drop a run→workspace mapping IFF it still names the volume just removed. */
  private forgetRunWorkspace(runId: string | undefined, volumeName: string): void {
    if (!runId) return;
    if (this.runWorkspaces.get(runId) === volumeName) {
      this.runWorkspaces.delete(runId);
    }
  }

  private terminate(job: BrokerJob, reason: string): void {
    job.terminated = true;
    job.terminationReason = reason;
    // Wake anything parked on this job's behalf, SYNCHRONOUSLY and before any
    // await, so a concurrent `exec` can never slip past the flag. The set is
    // drained first so a listener that re-enters cannot be run twice, and a
    // throwing listener cannot stop the others (termination is a decision that
    // has already been made — it must not be undone by a notification bug).
    if (job.cancelListeners.size === 0) return;
    const listeners = [...job.cancelListeners];
    job.cancelListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Notification is best-effort; the termination stands either way.
      }
    }
  }

  /**
   * Revalidate the host-scoped precondition for placing work here, and DRAIN on
   * any refusal.
   *
   * FAIL-CLOSED ON A THROWING GUARD — deliberately the opposite of
   * `probeLiveness`. That probe stays permissive because killing every
   * in-flight sandbox on a transient store blip is the worse failure for ONE
   * run. This guard is a TENANCY boundary: a host we cannot prove is
   * exclusively ours is a host that may already be running another tenant's
   * workers, and "the check errored" is not evidence that it is not.
   */
  private async checkPlacement(): Promise<PlacementVerdict> {
    if (!this.opts.placementGuard) return { ok: true };
    let verdict: PlacementVerdict;
    try {
      verdict = await this.opts.placementGuard();
    } catch (err) {
      verdict = {
        ok: false,
        reason: "placement_guard_error",
        message:
          "The execution host's placement precondition could not be evaluated; " +
          // A TOTAL formatter (Codex round 2, finding D3): `(err as Error).message`
          // on a non-Error throw (`throw null`) throws again INSIDE this catch,
          // escapes `checkPlacement`, and skips the drain entirely — turning the
          // most alarming failure mode into the one that drains nothing.
          `placement is refused (fail-closed): ${describeThrownValue(err)}`,
      };
    }
    if (!verdict.ok) await this.drainRevokedPlacement(verdict.reason);
    return verdict;
  }

  /**
   * Stop admitting AND cancel what is already running.
   *
   * `terminate` is a synchronous flag flip: it closes the job to further
   * commands but does not touch a container that is mid-run. On a revoked host
   * that is precisely the state that must not persist, so every terminated
   * job's containers are force-removed BY NAME through the typed container
   * seam. Per-job and best-effort: one job whose cancellation fails must not
   * abort the drain of the others.
   *
   * TERMINATED IS NOT DRAINED (Codex round 2, finding D1). Cancellation is
   * attempted for EVERY job this broker still retains, not only the ones this
   * pass terminated: a job terminated by an earlier drain whose cancellation
   * failed — or by an unrelated path while its container was mid-run — would
   * otherwise never be retried, and its container would outlive the host
   * handover. `closeJob` deletes from the map, so the retained set is exactly
   * the work whose containers this broker is still answerable for, and every
   * subsequent refusal retries it.
   *
   * Volumes are deliberately NOT removed here. Reclaiming the host is the
   * provisioning side's decision and the retention GC's job; destroying a
   * tenant's workspace because a lease read failed would turn a refusal into
   * data loss.
   */
  private async drainRevokedPlacement(reason: string): Promise<string[]> {
    // Terminate synchronously FIRST — no await in this loop — so a concurrent
    // `exec` cannot slip a command onto a job between the decision and the flag.
    for (const job of this.jobs.values()) {
      if (job.terminated) continue;
      this.terminate(job, `placement_revoked:${reason}`);
    }
    const cancelled: string[] = [];
    for (const jobId of [...this.jobs.keys()]) {
      try {
        cancelled.push(...(await this.containerOps.cancelJobContainers(jobId)));
      } catch {
        // Per-job containment, not silence: `cancelJobContainers` THROWS on an
        // incomplete drain, and swallowing it here only keeps one unreachable
        // job from aborting the others. The retry is the next refusal, which
        // walks this same retained set.
      }
    }
    return cancelled;
  }

  /**
   * Liveness with a THROWING host probe contained (Codex round 2, finding 2).
   *
   * The injected probe's recorded contract already answers `alive` on a store
   * READ ERROR — killing every in-flight sandbox on a transient blip is the worse
   * failure — so a probe that THROWS is the same class of event reaching the seam
   * a different way, and gets the same posture rather than an exception escaping
   * `exec`. It is a HOST BUG either way, so it is not silently equated with a
   * healthy read: the audit record carries `livenessDegraded`, exactly as the
   * mint site records its own degraded probe.
   */
  private async probeLiveness(job: BrokerJob): Promise<"alive" | "archived" | "gone"> {
    try {
      return await this.opts.livenessProbe(job.session);
    } catch {
      job.livenessDegraded = true;
      return "alive";
    }
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

  /**
   * Age out the per-`commandId` bookkeeping. Called on every exec so the maps
   * track only what is still meaningful; the hard caps in the paths that WRITE
   * them are the second, fail-closed bound.
   */
  private pruneCommandBookkeeping(nowMs: number): void {
    const cutoff = nowMs - COMMAND_ID_RETENTION_MS;
    for (const [id, at] of this.executedCommandIds) {
      if (at <= cutoff) this.executedCommandIds.delete(id);
    }
    for (const [id, entry] of this.revalidationAttempts) {
      if (entry.atMs <= cutoff) this.revalidationAttempts.delete(id);
    }
    for (const [id, entry] of this.revalidationChallenges) {
      if (entry.atMs <= cutoff) this.revalidationChallenges.delete(id);
    }
  }

  /**
   * Claim a `commandId` as dispatched. At the hard cap the OLDEST record is
   * dropped: the alternative — refusing the dispatch — would turn a bookkeeping
   * bound into an execution outage, and the record only needs to outlive the
   * voucher that could re-present it (COMMAND_ID_RETENTION_MS ≫ any voucher TTL).
   * The pruning above keeps this eviction unreachable in practice.
   */
  private recordExecutedCommandId(commandId: string, nowMs: number): void {
    if (this.executedCommandIds.size >= MAX_TRACKED_COMMAND_IDS) {
      const oldest = this.executedCommandIds.keys().next().value as string | undefined;
      if (oldest !== undefined) this.executedCommandIds.delete(oldest);
    }
    this.executedCommandIds.set(commandId, nowMs);
    this.revalidationAttempts.delete(commandId);
    this.revalidationChallenges.delete(commandId);
  }

  /** Audit-only egress tier for a refusal with no signed policy. Never throws. */
  private resolvePolicyForAudit(job: BrokerJob): EgressPolicy {
    try {
      return this.opts.egressPolicyResolver(job.session);
    } catch {
      return { mode: "none" };
    }
  }

  private async refuse(
    job: BrokerJob,
    seq: number,
    command: string,
    reason: ExecFailureReason,
    message: string,
    policy?: EgressPolicy,
    voucherDetail?: {
      commandId?: string;
      voucherRejection?: string;
      egressClamped?: readonly EgressClampAxis[];
      /**
       * A POST-DISPATCH refusal (the two `runCommand` throw paths) resolves the
       * pre-dispatch reservation instead of appending a second record: the
       * reservation already owns this attempt's delivery slot, and leaving it
       * open would have spool recovery mint a spurious `outcome_unknown` for a
       * command whose real outcome is right here (cinatra#2266 G1).
       */
      reservation?: ExecutionAuditReservation;
    },
  ): Promise<ExecResult> {
    const record = this.buildAuditRecord(job, seq, command, {
      decision: "refused",
      reason,
      // No signed policy yet (a pre-voucher refusal) ⇒ fall back to the resolver
      // purely so the audit row carries an egress tier at all. A THROWING
      // resolver must not turn a refusal into an unhandled rejection — the
      // refusal is the decision, the tier is only decoration on the record.
      policy: policy ?? this.resolvePolicyForAudit(job),
      ...(voucherDetail ?? {}),
    });
    if (voucherDetail?.reservation) await voucherDetail.reservation.commit(record);
    else await this.opts.auditSink(record);
    return { ok: false, reason, message };
  }

  private async audit(
    job: BrokerJob,
    seq: number,
    command: string,
    detail: AuditRecordDetail,
  ): Promise<void> {
    await this.opts.auditSink(this.buildAuditRecord(job, seq, command, detail));
  }

  /**
   * Build one attempt's audit record. Split out from the emit so the PREPARED
   * record a pre-dispatch reservation carries is built by exactly the same code
   * as the terminal one it is later upgraded to (cinatra#2266 G1) — two
   * builders would drift, and the reservation is the record an investigation
   * reads when the broker died mid-command.
   */
  private buildAuditRecord(
    job: BrokerJob,
    seq: number,
    command: string,
    detail: AuditRecordDetail,
  ): ExecutionAuditRecord {
    const record: ExecutionAuditRecord = {
      jobId: job.jobId,
      orgId: job.session.orgId,
      userId: job.session.userId,
      surface: job.session.surface,
      ...(job.session.runId ? { runId: job.session.runId } : {}),
      // NOTE (Codex round 2, finding 5 — REBUTTED): `command` is the raw command
      // text and is PRE-EXISTING on this record. It never reaches an audit row:
      // `toAuthzAuditEventInput` above deliberately omits it (and the whole
      // per-destination egress list), the host sink is that projection, and the
      // authz kernel additionally strips its own sensitive-key blocklist on write.
      // The field stays because the in-process record is also what the stdio
      // retention/redaction seam is correlated against. Do not add it to the
      // projection.
      command,
      cwd: SANDBOX_WORKSPACE_DIR,
      seq,
      decision: detail.decision,
      ...(detail.reason ? { reason: detail.reason } : {}),
      ...(detail.commandId ? { commandId: detail.commandId } : {}),
      ...(job.livenessDegraded ? { livenessDegraded: true } : {}),
      ...(detail.voucherRejection ? { voucherRejection: detail.voucherRejection } : {}),
      ...(detail.egressClamped && detail.egressClamped.length > 0
        ? { egressClamped: [...detail.egressClamped] }
        : {}),
      ...(detail.result
        ? {
            exitCode: detail.result.exitCode,
            termination: detail.result.termination,
            imageDigest: boundAuditText(
              detail.result.imageDigest,
              MAX_AUDITED_IMAGE_DIGEST_CHARS,
              NOT_DIGEST_CHARS,
            ),
            wallMs: detail.result.wallMs,
            workspaceKb: detail.result.workspaceKb,
            ...(detail.result.egress
              ? {
                  // BOUNDED (cinatra#2266, Codex round 2 — adopted). This list
                  // is one entry per host the sandbox contacted, so it is
                  // bounded only by what a command chose to do. That was fine
                  // while the record lived in a ring buffer; it is not fine now
                  // that the record's TERMINAL form has to fit inside capacity
                  // reserved before the command ran — an unbounded list makes
                  // the reservation's headroom unsound and lets one chatty
                  // command push the spool past its byte bound.
                  //
                  // The count is never hidden: `egressDestinationsTotal` always
                  // carries the true number, and `egressTotalBytes` is
                  // unaffected, so an egress investigation sees that it is
                  // looking at a sample and how large the sample is of.
                  egressDestinations: detail.result.egress.destinations
                    .slice(0, MAX_AUDITED_EGRESS_DESTINATIONS)
                    .map((d) => ({
                      host: boundAuditText(
                        d.host,
                        MAX_AUDITED_EGRESS_HOST_CHARS,
                        NOT_HOST_CHARS,
                      ),
                      port: d.port,
                      allowed: d.allowed,
                    })),
                  egressDestinationsTotal: detail.result.egress.destinations.length,
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
    return record;
  }
}
