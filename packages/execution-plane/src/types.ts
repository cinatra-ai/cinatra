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
 * Durable audit record for ONE broker-dispatched command (or a refusal).
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
  decision: "executed" | "refused";
  /** Refusal/termination detail, e.g. run_removed, queue_saturated, disk_quota_exceeded. */
  reason?: string;
  exitCode?: number | null;
  termination?: SandboxTermination;
  imageDigest?: string;
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
  | "staging_failed";

export type ExecFailureReason =
  | "unknown_job"
  | "job_terminated"
  | "run_removed"
  | "queue_saturated"
  | "command_blocked"
  | "egress_unavailable"
  /**
   * The job's declared L1 environment layer failed provenance verification at
   * mount, or no host key was configured to verify it (exec-plane S3,
   * cinatra#1708 AC4) — a distinct, security-relevant fail-closed refusal, not
   * a generic worker error.
   */
  | "environment_untrusted"
  | "worker_error";

export type OpenJobResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: OpenJobFailureReason; message: string };

export type ExecResult =
  | { ok: true; result: SandboxCommandResult }
  | { ok: false; reason: ExecFailureReason; message: string };
