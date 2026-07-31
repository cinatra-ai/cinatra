/**
 * Execution-plane broker/worker types (exec-plane S1, cinatra#1706).
 *
 * Vocabulary shared by the broker (`broker.ts`), the local-dev sandbox worker
 * (`worker.ts`), the L0 hardened run profile (`l0-profile.ts`), the L2
 * workspace manager (`workspace.ts`) and the egress policy layer (`egress.ts`).
 * All record shapes are JSON-serializable primitives only (mirrors the authz
 * audit-kernel doctrine) so they can cross queue/process boundaries safely.
 */

import type { ExecutionSession } from "@cinatra-ai/llm/execution-plane";

// Exec-plane S3 (cinatra#1708): the resolved L1 environment a command mounts.
// Type-only import — no runtime dependency, so this vocabulary leaf stays free
// of the environment layer at runtime.
import type { ResolvedEnvironmentMount } from "./environment/mount";

// ---------------------------------------------------------------------------
// Egress policy (epic D3)
// ---------------------------------------------------------------------------

/**
 * Per-org / per-agent egress tier. `default_internet` is the D3 default
 * (parity with assistant web access); `allowlist` and `none` are the
 * network-layer restriction tiers. Command allow/block lists are hygiene and
 * deliberately NOT part of this type — the network layer is the boundary.
 */
export type EgressMode = "default_internet" | "allowlist" | "none";

export type EgressPolicy = {
  mode: EgressMode;
  /** Host allowlist (exact or dot-suffix match), only meaningful for `allowlist`. */
  allowlist?: string[];
  /** Per-job egress byte ceiling enforced by the gateway (0/undefined = no cap). */
  maxBytesPerJob?: number;
};

/**
 * Where the attributing egress gateway listens, from the sandbox network's
 * point of view. `none` mode needs no gateway; the other modes REQUIRE one —
 * default-internet egress still transits the gateway (D3: attribution, quotas,
 * audit), it is not a raw NAT route.
 */
export type EgressGatewayEndpoint = {
  /** Hostname of the gateway ON the internal sandbox network (container name). */
  host: string;
  /** Proxy port on the internal network. */
  port: number;
  /** Admin/control/stats endpoint reachable from the WORKER (host side). */
  adminUrl?: string;
  /**
   * Control secret authenticating the broker→gateway control channel
   * (`/__register`, `/__stats`). Held by the broker/worker (host side) and the
   * gateway; NEVER injected into a sandbox. Its presence is what lets the
   * gateway trust a per-job policy registration and reject unregistered tokens.
   */
  controlSecret?: string;
};

/** Resolved, enforceable network configuration for one sandbox command. */
export type ResolvedEgress =
  | { kind: "none" }
  | {
      kind: "gateway";
      mode: "default_internet" | "allowlist";
      /** Docker network the sandbox container attaches to (an --internal network). */
      network: string;
      gateway: EgressGatewayEndpoint;
      /** Opaque per-job attribution token carried in the proxy credentials. */
      jobToken: string;
    };

// ---------------------------------------------------------------------------
// Resource limits (hardened-container contract quotas)
// ---------------------------------------------------------------------------

export type SandboxResourceLimits = {
  /** CPU quota, docker `--cpus`. */
  cpus: number;
  /** Memory ceiling in MiB (`--memory`, swap pinned to the same value). */
  memoryMb: number;
  /** `--pids-limit`. */
  pidsLimit: number;
  /** Wall-clock ceiling per command; the worker force-removes on breach. */
  timeoutMs: number;
  /** Per-stream stdout/stderr retention cap in bytes (truncate + flag). */
  maxStdioBytes: number;
  /**
   * L2 workspace disk quota in KiB — ENFORCED (closes the historical
   * `maxFileWriteKilobytes` stored-but-never-enforced gap): a per-file
   * `ulimit -f` cap rides inside the command AND the worker measures the
   * workspace after every command; over-quota terminates the job and the
   * broker refuses further commands on it.
   */
  workspaceQuotaKb: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxResourceLimits = {
  cpus: 1,
  memoryMb: 1024,
  pidsLimit: 256,
  timeoutMs: 120_000,
  maxStdioBytes: 1_048_576,
  workspaceQuotaKb: 262_144, // 256 MiB
};

// ---------------------------------------------------------------------------
// Worker command contract
// ---------------------------------------------------------------------------

export type SandboxCommandSpec = {
  /** Broker job this command belongs to (attribution + container naming). */
  jobId: string;
  /** The shell command to run (executed via `bash -c` inside the sandbox). */
  command: string;
  /** Name of the per-run L2 docker volume mounted at /workspace. */
  workspaceVolume: string;
  /**
   * Name of the per-job READ-ONLY skills volume mounted at /skills (exec-plane
   * S2, cinatra#1707) — staged catalog skill snapshots. Absent ⇒ no /skills
   * mount (byte-identical S1 argv).
   */
  skillsVolume?: string;
  /**
   * The resolved L1 environment layer to run this command over (exec-plane S3,
   * cinatra#1708). When present the sandbox runs over the layer's SIGNED image
   * digest — after the worker re-verifies its provenance (fail-closed, AC4) —
   * instead of the L0 base; absent ⇒ the L0 base (byte-identical S1/S2
   * dispatch). Carries only the signed provenance + a display alias, so every
   * field the worker acts on is signed.
   */
  environment?: ResolvedEnvironmentMount;
  egress: ResolvedEgress;
  limits: SandboxResourceLimits;
};

/**
 * One catalog-resolved skill snapshot to stage read-only under
 * `/skills/<slug>` (exec-plane S2, cinatra#1707). Pure data — file content +
 * sha256 digests the staging layer re-verifies; no host paths.
 */
export type StagedSkillInput = {
  slug: string;
  files: Array<{
    /** Path relative to /skills/<slug> (strictly relative, no traversal). */
    path: string;
    /** Full file content (UTF-8). */
    content: string;
    /** Lowercase hex sha256 of `content`. */
    digest: string;
  }>;
};

export type SandboxTermination =
  | "exited"
  | "timeout"
  | "output_cap_exceeded"
  | "disk_quota_exceeded"
  | "worker_error";

export type SandboxEgressUse = {
  destinations: Array<{
    host: string;
    port: number;
    allowed: boolean;
    bytesIn: number;
    bytesOut: number;
  }>;
  totalBytes: number;
};

export type SandboxCommandResult = {
  /** Process exit code; null when the container was force-terminated. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  termination: SandboxTermination;
  wallMs: number;
  /** Resolved digest (or immutable image ID) of the L0 image that actually ran. */
  imageDigest: string;
  /** Workspace size after the command, KiB (du -sk). */
  workspaceKb: number;
  /** Gateway-attributed egress use, when an egress gateway was in play. */
  egress?: SandboxEgressUse;
};

/**
 * The worker contract the broker dispatches to. S1 ships the local-dev
 * placement (`LocalDevSandboxWorker`, fresh `docker run` per command); other
 * placements implement the same contract in the deployment layer.
 */
export type SandboxWorker = {
  runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult>;
};

// ---------------------------------------------------------------------------
// Broker contracts
// ---------------------------------------------------------------------------

/**
 * Per-command session/run-liveness revalidation probe (host-injected; the app
 * wires it to the run store). Semantics per the epic's lifecycle doctrine:
 *  - `"alive"`    — proceed.
 *  - `"archived"` — proceed (archive does NOT interrupt in-flight jobs; the
 *                   sandbox follows the RUN's lifecycle, not the extension's).
 *  - `"gone"`     — the run's rows were hard-removed (force_delete/purge):
 *                   fail the command closed and TERMINATE the job.
 * Sessions without a runId (chat / deterministic tasks) probe the org+user
 * principal instead; hosts that cannot answer return `"alive"` and rely on
 * carrier expiry.
 */
export type RunLivenessProbe = (
  session: ExecutionSession,
) => Promise<"alive" | "archived" | "gone">;

/**
 * Optional command-hygiene hook (allow/block lists). Hygiene ONLY — never the
 * security boundary (that is the container profile + network layer).
 */
export type CommandPolicyHook = (
  session: ExecutionSession,
  command: string,
) => { allowed: true } | { allowed: false; reason: string };

export type BrokerQuotas = {
  /** Max commands executing concurrently per org. */
  maxConcurrentPerOrg: number;
  /** Max commands executing concurrently across all orgs (worker capacity). */
  maxGlobalConcurrent: number;
  /** Max commands queued (not yet running) per org; beyond ⇒ queue_saturated. */
  maxQueuedPerOrg: number;
  /** Max commands queued globally; beyond ⇒ queue_saturated (host-memory bound). */
  maxQueuedGlobal: number;
  /**
   * Max simultaneously-OPEN jobs per org (bounds carrier-replay volume/memory
   * exhaustion: a valid carrier within its TTL can be opened repeatedly, so the
   * open-job count — and thus L2 volume count — is capped per org).
   */
  maxOpenJobsPerOrg: number;
};

export const DEFAULT_BROKER_QUOTAS: BrokerQuotas = {
  maxConcurrentPerOrg: 2,
  maxGlobalConcurrent: 8,
  maxQueuedPerOrg: 16,
  maxQueuedGlobal: 128,
  maxOpenJobsPerOrg: 32,
};

/**
 * Audit record for ONE broker command ATTEMPT (an execution or a refusal).
 *
 * THE GUARANTEE THIS RECORD ACTUALLY CARRIES (cinatra#2266 AC10 — the docblock
 * is meant to be true, not aspirational):
 *
 *  - BROKER-LOCAL DURABILITY UNTIL ACK, *when a spool is wired*. On the remote
 *    placement the broker's sink is the durable spool (`service/audit-spool.ts`):
 *    the record is `fsync`ed to the broker's own volume before it is considered
 *    emitted, it survives a broker restart, and it leaves the spool only after
 *    the app has acknowledged a durable kernel write. Delivery is therefore
 *    AT-LEAST-ONCE — a re-delivery after a crash is expected and correct — and
 *    `deliveryKey` is what makes it harmless.
 *  - PRODUCER ORDERING. Records are appended in the order the broker produced
 *    them and are read back in that order; `seq` is the per-job attempt
 *    sequence within that stream.
 *  - SPOOL DURABILITY IS NOT KERNEL PERSISTENCE. "The spool holds it" and "the
 *    authz kernel has a row for it" are two different facts. The spool's ACK is
 *    what joins them: the app ACKs only after every record in a batch is
 *    durably inserted (or recognized as an already-inserted duplicate) in
 *    `audit_events`. Until then the broker still holds the record.
 *  - IN-PROCESS PLACEMENT. When the sink writes to the kernel directly (the
 *    local-dev placement) there is no spool and none of the above applies:
 *    delivery is a direct call and the kernel helper's own posture governs.
 *
 * Emitted for every command — allowed, denied, and terminated alike — to the
 * host-injected sink; `toAuthzAuditEventInput` maps it onto the authz
 * audit-kernel vocabulary (`actorPrincipalType: "model"`). stdout/stderr are
 * NEVER part of this record — they go to the separate stdio retention sink
 * (with redaction) per the S1 contract.
 */
export type ExecutionAuditRecord = {
  jobId: string;
  orgId: string;
  userId: string;
  surface: string;
  runId?: string;
  command: string;
  cwd: string;
  /**
   * PER-JOB ATTEMPT SEQUENCE (cinatra#2266 AC2). Allocated once per `exec()`
   * call, BEFORE any refusal path can return — so a pre-dispatch refusal has a
   * real sequence instead of a defaulted one, two identical refusals on one job
   * are distinguishable, and a dispatch failure never reuses a sequence a
   * dispatch already consumed. It is the LOGICAL correlation key's middle term
   * (`jobId + seq + decision`); it is deliberately NOT the delivery key — see
   * `deliveryKey`.
   */
  seq: number;
  /**
   * PHYSICAL DELIVERY IDENTITY (cinatra#2266 G2), `<spoolId>:<recordId>`.
   * Stamped by the spool when the record is appended, so it is unique per
   * physical delivery slot and stable across a re-delivery. This — not
   * `jobId + seq + decision` — is what the ACK protocol and the kernel's
   * idempotent insert key on. Absent on the in-process placement, whose sink
   * reaches the kernel without a spool.
   */
  deliveryKey?: string;
  /**
   * `outcome_unknown` is a THIRD terminal state, not a refusal (cinatra#2266
   * G1): the command passed every authorization gate and was handed to the
   * sandbox, and then the broker died before it learned what happened. It is
   * minted by spool recovery from an unresolved pre-dispatch reservation, and
   * it exists so that a crash mid-command produces a record rather than
   * silence.
   */
  decision: "executed" | "refused" | "outcome_unknown";
  /** Refusal/termination detail, e.g. run_removed, queue_saturated, disk_quota_exceeded. */
  reason?: string;
  exitCode?: number | null;
  termination?: SandboxTermination;
  imageDigest?: string;
  /**
   * The voucher's per-command id, when a voucher was verified for this command.
   * Ties the audit row to the client's own idempotency key. The nonce is never
   * recorded — it is single-use and carries no post-hoc evidentiary value.
   */
  commandId?: string;
  /**
   * Precise voucher rejection (`bad_signature`, `wrong_audience`, …) when the
   * refusal is a voucher refusal. The MODEL only ever sees the coarse
   * `ExecFailureReason`; the operator-grade detail lives here.
   */
  voucherRejection?: string;
  /**
   * Egress axes the broker narrowed against its deployment maximum. Present and
   * non-empty ⇒ the tenant's configured tier did not survive the clamp, which is
   * exactly the fact an egress investigation needs.
   */
  egressClamped?: string[];
  /**
   * True when this job's liveness probe THREW rather than answering. The recorded
   * posture keeps the command running, so the degraded observation is recorded
   * rather than silently equated with a healthy read (same field, same meaning as
   * the mint site's own `livenessDegraded`).
   */
  livenessDegraded?: boolean;
  effectivePolicy: {
    egressMode: EgressMode;
    limits: SandboxResourceLimits;
  };
  egressDestinations?: Array<{ host: string; port: number; allowed: boolean }>;
  egressTotalBytes?: number;
  wallMs?: number;
  workspaceKb?: number;
  atMs: number;
};

export type ExecutionAuditSink = (
  record: ExecutionAuditRecord,
) => void | Promise<void>;

/**
 * The DURABLE PRE-DISPATCH RESERVATION seam (cinatra#2266 G1).
 *
 * Appending the audit record AFTER `worker.runCommand` returns cannot satisfy
 * "no unrecorded execution", however durable the append is: the terminal
 * decision is only known once the command has finished, so a crash in between
 * loses the command entirely. So the broker reserves FIRST — a prepared record
 * plus the capacity its terminal form will need — and only then dispatches.
 *
 * THE CONTRACT THE BROKER RELIES ON, stated so an implementer cannot get it
 * subtly wrong:
 *
 *  - The returned promise settles only when the reservation is DURABLE. A
 *    reserver that resolves before its write is `fsync`ed provides nothing.
 *  - A REJECTION MEANS "DO NOT DISPATCH". The broker refuses the command; it
 *    does not run it and hope. That inverts the pre-#2266 behaviour, in which a
 *    full buffer discarded an old record and ran the command anyway.
 *  - `commit` is called at most once per reservation, with the terminal record
 *    for the same attempt, and MUST NOT fail for capacity — the command has
 *    already run, and a record of a real execution is not droppable.
 *
 * Absent ⇒ no reservation and no behaviour change (the in-process placement,
 * whose sink writes to the kernel directly).
 */
export type ExecutionAuditReservation = {
  /** `<spoolId>:<recordId>` — the delivery identity the terminal record rides. */
  deliveryKey: string;
  commit(record: ExecutionAuditRecord): Promise<void>;
};

export type ExecutionAuditReserver = (
  prepared: ExecutionAuditRecord,
) => Promise<ExecutionAuditReservation>;

/**
 * Separated stdout/stderr retention (S1: "stdout/stderr retained separately
 * with redaction"). The broker passes both streams through the host-injected
 * redactor before handing them to the sink; the default redactor is identity
 * (the sandbox holds no secrets by construction — D5 — so redaction is a
 * defense-in-depth hook, not the boundary).
 */
export type ExecutionStdioSink = (entry: {
  jobId: string;
  seq: number;
  stdout: string;
  stderr: string;
}) => void | Promise<void>;

export type ExecutionStdioRedactor = (text: string) => string;

// ---------------------------------------------------------------------------
// Broker job surface
// ---------------------------------------------------------------------------

export type OpenJobFailureReason =
  | "carrier_malformed"
  | "carrier_bad_signature"
  | "carrier_expired"
  | "carrier_no_secret"
  | "run_removed"
  | "open_jobs_exhausted"
  /** Skill staging refused (digest mismatch / unsafe path / docker failure) — exec-plane S2. */
  | "staging_failed"
  /**
   * The host-scoped precondition for placing work on this execution host does
   * not hold (exec-plane L3): the host-exclusivity lease is absent, expired,
   * unreadable or held by another tenant. No job is opened and no volume is
   * created (fail-closed).
   */
  | "placement_refused";

export type ExecFailureReason =
  | "unknown_job"
  | "job_terminated"
  | "run_removed"
  | "queue_saturated"
  | "command_blocked"
  | "egress_unavailable"
  // --- per-command authorization voucher (epic #1705, the authz boundary) ---
  /**
   * No voucher was presented for the command. The executor also projects a MINT
   * REFUSAL onto this reason — an OBO ceiling mismatch, a hard-removed run — since
   * from the boundary's side the outcome is identical: no authorization exists.
   * The mint's own precise denial rides the message and is audited at the mint site.
   */
  | "voucher_missing"
  /**
   * A voucher was presented and REJECTED: bad signature, wrong audience,
   * malformed claims, a command/job/session binding that is not this command's,
   * or a saturated replay cache. One reason for the whole class deliberately —
   * a caller learns only "not authorized"; the precise `rejection` goes to the
   * audit record, not to the model.
   */
  | "voucher_invalid"
  /** The voucher was already expired when the command was submitted. */
  | "voucher_expired"
  /** The voucher's nonce was already consumed (replay). */
  | "voucher_replayed"
  /**
   * This `commandId` already executed on this broker, or is concurrently in
   * flight on it (idempotency). In-memory, so the guarantee is per broker
   * PROCESS: see the `executedCommandIds` note in broker.ts.
   */
  | "command_replayed"
  /**
   * The voucher expired while the command waited for admission. The permit is
   * released and a fresh nonce is returned: remint ONCE against that nonce.
   */
  | "revalidation_required"
  /** A second post-queue expiry for the same `commandId` — no further remint. */
  | "revalidation_exhausted"
  /**
   * The job's declared L1 environment layer failed provenance verification at
   * mount, or no host key was configured to verify it (exec-plane S3,
   * cinatra#1708 AC4) — a distinct, security-relevant fail-closed refusal, not
   * a generic worker error.
   */
  | "environment_untrusted"
  /**
   * The execution host's host-exclusivity lease no longer holds (exec-plane
   * L3). The command is refused, every open job on this broker is terminated
   * and their containers are cancelled by name — a host that may already be
   * serving another tenant must not keep running ours.
   */
  | "placement_revoked"
  /**
   * The durable audit spool could not accept this command's PRE-DISPATCH
   * reservation — it is at its byte bound, or its `fsync` failed (cinatra#2266
   * G1/AC4). The command is refused and the sandbox is never handed it: an
   * execution the plane cannot account for must not happen. This inverts the
   * pre-#2266 behaviour, in which a full buffer discarded an older record and
   * ran the command anyway.
   *
   * NOT AUDITED, deliberately and only for this reason: the audit path is the
   * thing that just failed, so minting a record per refused attempt is exactly
   * the unbounded write G5 names. The refusal is COUNTED
   * (`AuditSpool.stats().refusedReservations`) and rides the drain response;
   * turning that count into one bounded, durable `audit_spool_full` episode
   * record plus a defined reopen condition is #2266 AC7 (slice 3), not this
   * slice.
   */
  | "audit_spool_unavailable"
  | "worker_error";

/**
 * A host-scoped precondition the broker revalidates before EVERY placement
 * decision (exec-plane L3). The shipped implementation is the host-exclusivity
 * lease (`service/lease.ts`); the broker itself stays free of any filesystem or
 * tenancy knowledge and sees only the verdict.
 *
 * `reason` is an operator-facing token carried into the audit record; `message`
 * is what the caller is told. Neither ever carries a tenant slug or a path.
 */
export type PlacementVerdict =
  | { ok: true }
  | { ok: false; reason: string; message: string };

export type PlacementGuard = () => Promise<PlacementVerdict> | PlacementVerdict;

export type OpenJobResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: OpenJobFailureReason; message: string };

/**
 * The broker's revalidation CHALLENGE, returned with `revalidation_required`.
 * The client remints a voucher for the SAME `commandId` carrying exactly this
 * `nonce` (the broker refuses any other nonce for that command), so the retry
 * answers this broker's challenge and cannot itself be a replay.
 */
export type ExecRevalidationChallenge = {
  commandId: string;
  nonce: string;
  /** The audience the reminted voucher must carry (this broker's identity). */
  aud: string;
};

export type ExecResult =
  | { ok: true; result: SandboxCommandResult }
  | {
      ok: false;
      reason: ExecFailureReason;
      message: string;
      /** Present ONLY with `revalidation_required`. */
      revalidation?: ExecRevalidationChallenge;
    };
