/**
 * Execution-plane SERVICE WIRE CONTRACT (exec-plane S1 remainder, epic
 * cinatra#1705).
 *
 * The versioned request/response vocabulary for the two hops the managed
 * placement introduces:
 *
 *   app ──▶ broker   openJob | exec | closeJob | terminateJobsForRun |
 *                    sweep | drainAudit | health
 *   broker ──▶ worker runCommand | ensureWorkspace | removeWorkspace |
 *                    stageSkills | removeSkills
 *
 * DOCTRINE, inherited verbatim from `../types.ts`: every field on this wire is
 * a JSON-serializable primitive. No functions, no class instances, no Buffers,
 * no Dates. That is what lets the SAME shapes cross an in-process call, a queue
 * and an mTLS socket without a second vocabulary — the servers in
 * `broker-server.ts` / `worker-server.ts` hand the parsed payloads straight to
 * the already-merged `ExecutionBroker` / `SandboxWorker` contracts.
 *
 * PROTOCOL VERSION IS PART OF THE CONTRACT (ops#517 names
 * `EXEC_PROTOCOL_VERSION` in the exec services' SCOPED env, alongside
 * `EXECUTION_BROKER_URL` and deliberately without the app's secret surface).
 * A request whose `protocolVersion` is not EXACTLY `EXEC_PROTOCOL_VERSION` is
 * REFUSED — not coerced, not best-effort handled, and explicitly not
 * "accept anything lower". Fail-closed in BOTH directions: an older peer must
 * not be silently served a shape it cannot read, and a newer peer must not have
 * its richer payload silently truncated. A version bump is therefore a
 * deliberate, lockstep deploy, and a mid-rollout mismatch degrades to an
 * audited refusal rather than a half-understood command.
 *
 * VALIDATION POSTURE: the parsers below are strict and total — an unknown op,
 * a missing field, a wrong primitive type or a non-finite number is a
 * `malformed_request` refusal, never a coerced value. Two shapes are
 * deliberately validated only STRUCTURALLY:
 *   - `ResolvedEnvironmentMount.provenance` — an HMAC-signed blob whose real
 *     authority is `resolveEnvironmentMount`'s fail-closed verification at the
 *     mount (cinatra#1708 AC4). A field-by-field shape check here would imply
 *     an authority this layer does not have; the signature is the gate.
 *   - the sealed session `carrier` — an opaque string only the broker can open
 *     (`openSealedSession`), which fails closed on its own.
 */

import type { ResolvedEnvironmentMount } from "../environment/mount";
import type {
  ExecResult,
  ExecutionAuditRecord,
  OpenJobResult,
  ResolvedEgress,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxResourceLimits,
  StagedSkillInput,
} from "../types";

// ---------------------------------------------------------------------------
// Version + transport constants
// ---------------------------------------------------------------------------

/**
 * The wire-contract version. Bumped ONLY on an incompatible change to any shape
 * in this module; every peer of a deployment must carry the same number (the
 * ops#517 scoped env sets `EXEC_PROTOCOL_VERSION` on the exec services).
 */
export const EXEC_PROTOCOL_VERSION = 1;

/** Env var the service entrypoints read to assert the deployed version. */
export const EXEC_PROTOCOL_VERSION_ENV = "EXEC_PROTOCOL_VERSION";

/**
 * Redundant transport-level echo of the body's `protocolVersion`. Checked when
 * present (a proxy/misconfigured peer that rewrites one but not the other is a
 * mismatch, not a coin flip); the BODY remains authoritative, so a client that
 * omits the header is not penalised.
 */
export const EXEC_PROTOCOL_HEADER = "x-cinatra-exec-protocol";

/**
 * Header carrying the independently-scoped service token — the SECOND factor.
 * mTLS identity is the first; both must pass (see `mtls.ts` and the servers).
 */
export const EXEC_SERVICE_TOKEN_HEADER = "x-cinatra-exec-service-token";

/** The single RPC route. Everything else 404s — no incidental surface. */
export const EXEC_RPC_PATH = "/exec/v1/rpc";

/** Default body ceiling. Staged skill snapshots are the large payload. */
export const EXEC_DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Op vocabulary
// ---------------------------------------------------------------------------

export const BROKER_OPS = [
  "openJob",
  "exec",
  "closeJob",
  "terminateJobsForRun",
  "sweep",
  "drainAudit",
  "health",
] as const;
export type BrokerOp = (typeof BROKER_OPS)[number];

/**
 * `cancelJobContainers` was ADDED in exec-plane L3 without a version bump, and
 * that is the documented rule applied, not an exception to it: the version
 * covers the SHAPES on this wire, and a new op changes none of them. An older
 * worker answers the new op with its existing `malformed_request` refusal —
 * which is the correct, fail-closed outcome — and both peers of a deployment
 * ship from the same bundle build anyway.
 *
 * `health` (exec-plane L4) is added under that SAME rule. It is what makes the
 * broker's own health answer composite rather than self-referential: a broker
 * that reports itself up while its worker is gone is exactly the lie the
 * app-side activation gate must not be built on. A worker that predates the op
 * answers `malformed_request`, which the composite reads as NOT ok — the
 * fail-closed direction.
 */
export const WORKER_OPS = [
  "runCommand",
  "ensureWorkspace",
  "removeWorkspace",
  "stageSkills",
  "removeSkills",
  "cancelJobContainers",
  "health",
] as const;
export type WorkerOp = (typeof WORKER_OPS)[number];

// ---------------------------------------------------------------------------
// app ──▶ broker payloads
// ---------------------------------------------------------------------------

export type OpenJobPayload = {
  /** Opaque sealed execution-session carrier; only the broker can open it. */
  carrier: string;
  stagedSkills?: StagedSkillInput[];
  environment?: ResolvedEnvironmentMount;
};

export type ExecPayload = {
  jobId: string;
  command: string;
  /**
   * Caller-minted idempotency key for THIS command. A transport retry (socket
   * reset, gateway timeout) must never run a model-authored command twice, so
   * the server records the outcome under this id and replays it on a repeat.
   * See `command-ledger.ts` — the durability of that record is the ledger
   * binding's concern, not this contract's.
   */
  commandId: string;
  /**
   * Per-command authorization voucher (epic #1705 L2). Opaque over the wire —
   * this contract never inspects it, it only carries it byte-exact to
   * `ExecutionBroker.exec`'s own `voucherVerifier`, which is the sole party
   * that verifies it. REQUIRED: a wire contract that let this field be
   * omitted would be a broker that can be asked to run an unauthorized
   * command, which is exactly the outcome the voucher exists to prevent.
   */
  voucher: string;
};

export type CloseJobPayload = { jobId: string; removeWorkspace?: boolean };
export type TerminateJobsForRunPayload = {
  runId: string;
  removeWorkspace?: boolean;
};
export type SweepPayload = { idleMs: number };
export type DrainAuditPayload = {
  maxAuditRecords?: number;
  maxStdioEntries?: number;
};
export type HealthPayload = Record<string, never>;

export type CloseJobResultPayload = { closed: true };
export type TerminateJobsForRunResultPayload = { terminated: number };
export type SweepResultPayload = { closed: number };

/**
 * One retained stdout/stderr pair, mirroring `ExecutionStdioSink`'s entry. The
 * remote broker holds no authz kernel and no stdio store, so both audit records
 * and stdio entries are BUFFERED there and pulled by the app, which owns the
 * sinks (the merged `ExecutionAuditSink` / `ExecutionStdioSink` seams).
 */
export type ExecutionStdioEntry = {
  jobId: string;
  seq: number;
  stdout: string;
  stderr: string;
};

export type DrainAuditResultPayload = {
  audit: ExecutionAuditRecord[];
  stdio: ExecutionStdioEntry[];
  /** Records dropped since the last drain because the ring buffer was full. */
  droppedAudit: number;
  droppedStdio: number;
  /**
   * False when the service was constructed WITHOUT a relay (an in-process
   * placement whose sinks already reach the app directly). Honest emptiness:
   * the caller can tell "nothing buffered" from "nothing buffers here".
   */
  relayed: boolean;
};

/**
 * One dependency's health, as the broker sees it (exec-plane L4).
 *
 * THREE-VALUED, and the third value is the point. `not-applicable` is an
 * explicit statement that this deployment has no such dependency — a `none`
 * egress tier genuinely has no gateway, a broker whose workers are not
 * host-exclusive genuinely has no lease — and it is NOT the same claim as
 * `ok`. Collapsing the two would let an unconfigured dependency read as a
 * healthy one, which is the failure this composite exists to prevent.
 *
 * `detail` is operator-facing prose and is subject to the same rule as every
 * other field the services log: NEVER a secret, never a token, never a URL that
 * could carry one.
 */
export type ExecSubsystemHealth = {
  state: "ok" | "unhealthy" | "not-applicable";
  detail: string;
};

/**
 * The broker's COMPOSITE readiness (exec-plane L4): every hop the managed
 * placement actually depends on, answered in one round trip.
 *
 * `ok` is the conjunction over the APPLICABLE subsystems only — a
 * `not-applicable` dependency neither passes nor fails it — and it is computed
 * on the BROKER, next to the things it describes, so the app cannot drift into
 * a different opinion of what "composite" means.
 */
export type ExecCompositeHealth = {
  ok: boolean;
  /** The broker→worker hop: an authorized `health` call over mTLS. */
  worker: ExecSubsystemHealth;
  /** The attributing egress gateway's open `/__health` endpoint. */
  gateway: ExecSubsystemHealth;
  /** The host-exclusivity lease this broker revalidates before placement. */
  lease: ExecSubsystemHealth;
};

export type HealthResultPayload = {
  protocolVersion: number;
  /** Commands executing right now (the broker's global semaphore). */
  executingCount: number;
  atMs: number;
  /**
   * Present when the service was composed with a composite provider
   * (exec-plane L4). ADDITIVE and optional on purpose: a peer that predates it
   * simply omits the field, and the app-side gate treats an ABSENT composite as
   * "not proven", never as "fine" — so the version does not move (see the
   * module header's rule and `WORKER_OPS`).
   */
  composite?: ExecCompositeHealth;
};

export type BrokerRequest =
  | { op: "openJob"; payload: OpenJobPayload }
  | { op: "exec"; payload: ExecPayload }
  | { op: "closeJob"; payload: CloseJobPayload }
  | { op: "terminateJobsForRun"; payload: TerminateJobsForRunPayload }
  | { op: "sweep"; payload: SweepPayload }
  | { op: "drainAudit"; payload: DrainAuditPayload }
  | { op: "health"; payload: HealthPayload };

/** Result type for each broker op (the `result` field of an ok response). */
export type BrokerResultFor<Op extends BrokerOp> = Op extends "openJob"
  ? OpenJobResult
  : Op extends "exec"
    ? ExecResult
    : Op extends "closeJob"
      ? CloseJobResultPayload
      : Op extends "terminateJobsForRun"
        ? TerminateJobsForRunResultPayload
        : Op extends "sweep"
          ? SweepResultPayload
          : Op extends "drainAudit"
            ? DrainAuditResultPayload
            : Op extends "health"
              ? HealthResultPayload
              : never;

// ---------------------------------------------------------------------------
// broker ──▶ worker payloads
// ---------------------------------------------------------------------------

export type RunCommandPayload = {
  /** Idempotency key — same contract as `ExecPayload.commandId`. */
  commandId: string;
  spec: SandboxCommandSpec;
};

export type EnsureWorkspacePayload = { workspaceKey: string };
export type RemoveWorkspacePayload = { volumeName: string };
export type StageSkillsPayload = {
  jobId: string;
  skills: StagedSkillInput[];
  imageRef: string;
};
export type RemoveSkillsPayload = { volumeName: string };
/**
 * The host-exclusivity drain (exec-plane L3). A JOB ID, never a container name
 * and never an argv: the worker derives the container-name prefix itself, so
 * this op cannot be used to remove a container the job does not own.
 */
export type CancelJobContainersPayload = { jobId: string };

export type VolumeResultPayload = { volumeName: string };
export type RemovedResultPayload = { removed: true };
export type CancelledResultPayload = { cancelled: string[] };
/**
 * The worker's liveness answer (exec-plane L4). Deliberately minimal: reaching
 * this reply already proves mTLS, the URI-SAN/EKU authorization, the service
 * token and the protocol version all hold on the broker→worker hop, which is
 * exactly the claim the composite makes for `worker`. It runs NO container and
 * touches NO volume, so a health poll can never be a load generator.
 */
export type WorkerHealthResultPayload = {
  protocolVersion: number;
  atMs: number;
};

export type WorkerRequest =
  | { op: "runCommand"; payload: RunCommandPayload }
  | { op: "ensureWorkspace"; payload: EnsureWorkspacePayload }
  | { op: "removeWorkspace"; payload: RemoveWorkspacePayload }
  | { op: "stageSkills"; payload: StageSkillsPayload }
  | { op: "removeSkills"; payload: RemoveSkillsPayload }
  | { op: "cancelJobContainers"; payload: CancelJobContainersPayload }
  | { op: "health"; payload: HealthPayload };

export type WorkerResultFor<Op extends WorkerOp> = Op extends "runCommand"
  ? SandboxCommandResult
  : Op extends "ensureWorkspace"
    ? VolumeResultPayload
    : Op extends "removeWorkspace"
      ? RemovedResultPayload
      : Op extends "stageSkills"
        ? VolumeResultPayload
        : Op extends "removeSkills"
          ? RemovedResultPayload
          : Op extends "cancelJobContainers"
            ? CancelledResultPayload
            : Op extends "health"
              ? WorkerHealthResultPayload
              : never;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type ExecRequestEnvelope = {
  protocolVersion: number;
  op: string;
  payload: unknown;
};

/**
 * Transport/authorization failure vocabulary. Every one of these is a REFUSAL —
 * none is a retry-until-it-works hint except `command_in_flight`.
 *
 * Note what is NOT here: a refused command is not a transport error. The
 * broker's own `ExecResult`/`OpenJobResult` refusals ride an `ok: true`
 * response carrying `{ ok: false, reason }` — the merged fail-closed vocabulary
 * reaches the app UNCHANGED, so the client is never tempted to reinterpret a
 * `run_removed` as a network blip.
 */
export type ExecErrorCode =
  /** `protocolVersion` was not exactly `EXEC_PROTOCOL_VERSION`. */
  | "protocol_version_mismatch"
  /** Envelope/payload failed strict validation. */
  | "malformed_request"
  /** Op is not in this service's vocabulary. */
  | "unknown_op"
  /** mTLS peer identity (URI-SAN / EKU) not authorized. */
  | "unauthorized_peer"
  /** Service token absent or wrong (the independent second factor). */
  | "unauthorized_token"
  /** Body exceeded the configured ceiling. */
  | "payload_too_large"
  /** Same `commandId` is currently executing; the caller may poll/retry. */
  | "command_in_flight"
  /**
   * The worker refused to mount the job's declared L1 environment
   * (cinatra#1708 AC4). Carried as its OWN code so `worker-client.ts` can
   * rethrow `EnvironmentMountRefusedError` and the broker's existing
   * `environment_untrusted` audit path fires identically to in-process.
   */
  | "environment_untrusted"
  /** The underlying broker/worker call threw. */
  | "op_failed"
  | "internal_error";

export type ExecErrorBody = { code: ExecErrorCode; message: string };

export type ExecResponseEnvelope<Result> =
  | { protocolVersion: number; ok: true; result: Result }
  | { protocolVersion: number; ok: false; error: ExecErrorBody };

export function execOkResponse<Result>(result: Result): ExecResponseEnvelope<Result> {
  return { protocolVersion: EXEC_PROTOCOL_VERSION, ok: true, result };
}

export function execErrorResponse(
  code: ExecErrorCode,
  message: string,
): ExecResponseEnvelope<never> {
  return {
    protocolVersion: EXEC_PROTOCOL_VERSION,
    ok: false,
    error: { code, message },
  };
}

/** The HTTP status each refusal maps to. Kept beside the vocabulary so the
 *  server and the client agree without either owning the mapping alone. */
export const EXEC_ERROR_STATUS: Record<ExecErrorCode, number> = {
  protocol_version_mismatch: 400,
  malformed_request: 400,
  unknown_op: 400,
  unauthorized_peer: 403,
  unauthorized_token: 401,
  payload_too_large: 413,
  command_in_flight: 409,
  environment_untrusted: 422,
  op_failed: 500,
  internal_error: 500,
};

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isOptional(value: unknown, guard: (v: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

type ParseFailure = { ok: false; code: ExecErrorCode; message: string };

function fail(message: string, code: ExecErrorCode = "malformed_request"): ParseFailure {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

export type ProtocolVersionCheck = { ok: true } | ParseFailure;

/**
 * EXACT version equality, fail-closed in both directions. A string `"1"`, a
 * float `1.0000001`, a missing field and a HIGHER version are all refusals —
 * the peer is asked to be exactly this contract, or nothing.
 */
export function checkProtocolVersion(value: unknown): ProtocolVersionCheck {
  if (value === EXEC_PROTOCOL_VERSION) return { ok: true };
  return {
    ok: false,
    code: "protocol_version_mismatch",
    message:
      `Execution-plane wire protocol mismatch: this service speaks exactly ` +
      `version ${EXEC_PROTOCOL_VERSION}, the peer presented ` +
      `${JSON.stringify(value) ?? "undefined"}. The request is refused ` +
      `(fail-closed) — a version bump is a lockstep deploy, never a coercion.`,
  };
}

/**
 * Cross-check the redundant transport header against the body's version.
 * Absent header ⇒ pass (the body is authoritative). Present-but-different ⇒
 * mismatch: something between the peers is rewriting one and not the other.
 */
export function checkProtocolHeader(header: string | undefined): ProtocolVersionCheck {
  if (header === undefined) return { ok: true };
  const trimmed = header.trim();
  if (trimmed === String(EXEC_PROTOCOL_VERSION)) return { ok: true };
  return {
    ok: false,
    code: "protocol_version_mismatch",
    message:
      `The ${EXEC_PROTOCOL_HEADER} header ("${trimmed}") does not match this ` +
      `service's wire protocol version ${EXEC_PROTOCOL_VERSION}; refused ` +
      `(fail-closed).`,
  };
}

// ---------------------------------------------------------------------------
// Envelope + payload parsers
// ---------------------------------------------------------------------------

function parseEnvelope(
  raw: unknown,
  ops: readonly string[],
): { ok: true; op: string; payload: Record<string, unknown> } | ParseFailure {
  if (!isRecord(raw)) return fail("The request body must be a JSON object.");
  const version = checkProtocolVersion(raw.protocolVersion);
  if (!version.ok) return version;
  if (!isNonEmptyString(raw.op)) return fail("The request is missing an `op`.");
  if (!ops.includes(raw.op)) {
    return {
      ok: false,
      code: "unknown_op",
      message: `Unknown execution-plane op "${raw.op}"; this service serves ${ops.join(", ")}.`,
    };
  }
  if (!isRecord(raw.payload)) {
    return fail(`Op "${raw.op}" requires an object \`payload\`.`);
  }
  return { ok: true, op: raw.op, payload: raw.payload };
}

function parseStagedSkills(value: unknown): { ok: true; value: StagedSkillInput[] } | ParseFailure {
  if (!Array.isArray(value)) return fail("`stagedSkills` must be an array.");
  const out: StagedSkillInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return fail("Each staged skill must be an object.");
    if (!isNonEmptyString(entry.slug)) return fail("A staged skill is missing `slug`.");
    if (!Array.isArray(entry.files)) return fail("A staged skill is missing `files`.");
    const files: StagedSkillInput["files"] = [];
    for (const file of entry.files) {
      if (!isRecord(file)) return fail("Each staged-skill file must be an object.");
      if (!isNonEmptyString(file.path)) return fail("A staged-skill file is missing `path`.");
      if (typeof file.content !== "string") {
        return fail("A staged-skill file is missing `content`.");
      }
      if (!isNonEmptyString(file.digest)) {
        return fail("A staged-skill file is missing `digest`.");
      }
      files.push({ path: file.path, content: file.content, digest: file.digest });
    }
    out.push({ slug: entry.slug, files });
  }
  return { ok: true, value: out };
}

/**
 * Structural check only, deliberately (see the module header): the mount's
 * authority is the HMAC signature `resolveEnvironmentMount` verifies before the
 * container starts. This layer confirms the two fields exist and are the right
 * KIND, then gets out of the way — it must not imply a trust it cannot grant.
 */
function parseEnvironmentMount(
  value: unknown,
): { ok: true; value: ResolvedEnvironmentMount } | ParseFailure {
  if (!isRecord(value)) return fail("`environment` must be an object.");
  if (!isNonEmptyString(value.imageRef)) {
    return fail("`environment.imageRef` must be a non-empty string.");
  }
  if (!isRecord(value.provenance)) {
    return fail("`environment.provenance` must be the signed provenance object.");
  }
  return { ok: true, value: value as unknown as ResolvedEnvironmentMount };
}

function parseResolvedEgress(value: unknown): { ok: true; value: ResolvedEgress } | ParseFailure {
  if (!isRecord(value)) return fail("`egress` must be an object.");
  if (value.kind === "none") return { ok: true, value: { kind: "none" } };
  if (value.kind !== "gateway") {
    return fail('`egress.kind` must be "none" or "gateway".');
  }
  if (value.mode !== "default_internet" && value.mode !== "allowlist") {
    return fail('`egress.mode` must be "default_internet" or "allowlist".');
  }
  if (!isNonEmptyString(value.network)) return fail("`egress.network` is required.");
  if (!isNonEmptyString(value.jobToken)) return fail("`egress.jobToken` is required.");
  if (!isRecord(value.gateway)) return fail("`egress.gateway` is required.");
  const gateway = value.gateway;
  if (!isNonEmptyString(gateway.host)) return fail("`egress.gateway.host` is required.");
  if (!isFiniteNumber(gateway.port)) return fail("`egress.gateway.port` is required.");
  if (!isOptional(gateway.adminUrl, isNonEmptyString)) {
    return fail("`egress.gateway.adminUrl` must be a string when present.");
  }
  if (!isOptional(gateway.controlSecret, isNonEmptyString)) {
    return fail("`egress.gateway.controlSecret` must be a string when present.");
  }
  return {
    ok: true,
    value: {
      kind: "gateway",
      mode: value.mode,
      network: value.network,
      jobToken: value.jobToken,
      gateway: {
        host: gateway.host,
        port: gateway.port,
        ...(gateway.adminUrl === undefined ? {} : { adminUrl: gateway.adminUrl as string }),
        ...(gateway.controlSecret === undefined
          ? {}
          : { controlSecret: gateway.controlSecret as string }),
      },
    },
  };
}

const LIMIT_KEYS = [
  "cpus",
  "memoryMb",
  "pidsLimit",
  "timeoutMs",
  "maxStdioBytes",
  "workspaceQuotaKb",
] as const satisfies readonly (keyof SandboxResourceLimits)[];

function parseLimits(value: unknown): { ok: true; value: SandboxResourceLimits } | ParseFailure {
  if (!isRecord(value)) return fail("`limits` must be an object.");
  const out: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const raw = value[key];
    if (!isFiniteNumber(raw) || raw < 0) {
      return fail(`\`limits.${key}\` must be a finite, non-negative number.`);
    }
    out[key] = raw;
  }
  return { ok: true, value: out as unknown as SandboxResourceLimits };
}

function parseCommandSpec(
  value: unknown,
): { ok: true; value: SandboxCommandSpec } | ParseFailure {
  if (!isRecord(value)) return fail("`spec` must be an object.");
  if (!isNonEmptyString(value.jobId)) return fail("`spec.jobId` is required.");
  if (typeof value.command !== "string") return fail("`spec.command` is required.");
  if (!isNonEmptyString(value.workspaceVolume)) {
    return fail("`spec.workspaceVolume` is required.");
  }
  if (!isOptional(value.skillsVolume, isNonEmptyString)) {
    return fail("`spec.skillsVolume` must be a string when present.");
  }
  const egress = parseResolvedEgress(value.egress);
  if (!egress.ok) return egress;
  const limits = parseLimits(value.limits);
  if (!limits.ok) return limits;
  let environment: ResolvedEnvironmentMount | undefined;
  if (value.environment !== undefined) {
    const parsed = parseEnvironmentMount(value.environment);
    if (!parsed.ok) return parsed;
    environment = parsed.value;
  }
  return {
    ok: true,
    value: {
      jobId: value.jobId,
      command: value.command,
      workspaceVolume: value.workspaceVolume,
      ...(value.skillsVolume === undefined
        ? {}
        : { skillsVolume: value.skillsVolume as string }),
      ...(environment ? { environment } : {}),
      egress: egress.value,
      limits: limits.value,
    },
  };
}

/** Strictly parse one app→broker request. */
export function parseBrokerRequest(
  raw: unknown,
): { ok: true; request: BrokerRequest } | ParseFailure {
  const envelope = parseEnvelope(raw, BROKER_OPS);
  if (!envelope.ok) return envelope;
  const p = envelope.payload;
  switch (envelope.op as BrokerOp) {
    case "openJob": {
      if (!isNonEmptyString(p.carrier)) return fail("`carrier` is required.");
      let stagedSkills: StagedSkillInput[] | undefined;
      if (p.stagedSkills !== undefined) {
        const parsed = parseStagedSkills(p.stagedSkills);
        if (!parsed.ok) return parsed;
        stagedSkills = parsed.value;
      }
      let environment: ResolvedEnvironmentMount | undefined;
      if (p.environment !== undefined) {
        const parsed = parseEnvironmentMount(p.environment);
        if (!parsed.ok) return parsed;
        environment = parsed.value;
      }
      return {
        ok: true,
        request: {
          op: "openJob",
          payload: {
            carrier: p.carrier,
            ...(stagedSkills ? { stagedSkills } : {}),
            ...(environment ? { environment } : {}),
          },
        },
      };
    }
    case "exec": {
      if (!isNonEmptyString(p.jobId)) return fail("`jobId` is required.");
      if (typeof p.command !== "string") return fail("`command` is required.");
      if (!isNonEmptyString(p.commandId)) return fail("`commandId` is required.");
      if (!isNonEmptyString(p.voucher)) return fail("`voucher` is required.");
      return {
        ok: true,
        request: {
          op: "exec",
          payload: {
            jobId: p.jobId,
            command: p.command,
            commandId: p.commandId,
            voucher: p.voucher,
          },
        },
      };
    }
    case "closeJob": {
      if (!isNonEmptyString(p.jobId)) return fail("`jobId` is required.");
      if (!isOptional(p.removeWorkspace, (v) => typeof v === "boolean")) {
        return fail("`removeWorkspace` must be a boolean when present.");
      }
      return {
        ok: true,
        request: {
          op: "closeJob",
          payload: {
            jobId: p.jobId,
            ...(p.removeWorkspace === undefined
              ? {}
              : { removeWorkspace: p.removeWorkspace as boolean }),
          },
        },
      };
    }
    case "terminateJobsForRun": {
      if (!isNonEmptyString(p.runId)) return fail("`runId` is required.");
      if (!isOptional(p.removeWorkspace, (v) => typeof v === "boolean")) {
        return fail("`removeWorkspace` must be a boolean when present.");
      }
      return {
        ok: true,
        request: {
          op: "terminateJobsForRun",
          payload: {
            runId: p.runId,
            ...(p.removeWorkspace === undefined
              ? {}
              : { removeWorkspace: p.removeWorkspace as boolean }),
          },
        },
      };
    }
    case "sweep": {
      if (!isNonNegativeInt(p.idleMs)) {
        return fail("`idleMs` must be a non-negative integer.");
      }
      return { ok: true, request: { op: "sweep", payload: { idleMs: p.idleMs } } };
    }
    case "drainAudit": {
      if (!isOptional(p.maxAuditRecords, isNonNegativeInt)) {
        return fail("`maxAuditRecords` must be a non-negative integer.");
      }
      if (!isOptional(p.maxStdioEntries, isNonNegativeInt)) {
        return fail("`maxStdioEntries` must be a non-negative integer.");
      }
      return {
        ok: true,
        request: {
          op: "drainAudit",
          payload: {
            ...(p.maxAuditRecords === undefined
              ? {}
              : { maxAuditRecords: p.maxAuditRecords as number }),
            ...(p.maxStdioEntries === undefined
              ? {}
              : { maxStdioEntries: p.maxStdioEntries as number }),
          },
        },
      };
    }
    case "health":
      return { ok: true, request: { op: "health", payload: {} } };
  }
}

/** Strictly parse one broker→worker request. */
export function parseWorkerRequest(
  raw: unknown,
): { ok: true; request: WorkerRequest } | ParseFailure {
  const envelope = parseEnvelope(raw, WORKER_OPS);
  if (!envelope.ok) return envelope;
  const p = envelope.payload;
  switch (envelope.op as WorkerOp) {
    case "runCommand": {
      if (!isNonEmptyString(p.commandId)) return fail("`commandId` is required.");
      const spec = parseCommandSpec(p.spec);
      if (!spec.ok) return spec;
      return {
        ok: true,
        request: { op: "runCommand", payload: { commandId: p.commandId, spec: spec.value } },
      };
    }
    case "ensureWorkspace": {
      if (!isNonEmptyString(p.workspaceKey)) return fail("`workspaceKey` is required.");
      return {
        ok: true,
        request: { op: "ensureWorkspace", payload: { workspaceKey: p.workspaceKey } },
      };
    }
    case "removeWorkspace": {
      if (!isNonEmptyString(p.volumeName)) return fail("`volumeName` is required.");
      return {
        ok: true,
        request: { op: "removeWorkspace", payload: { volumeName: p.volumeName } },
      };
    }
    case "stageSkills": {
      if (!isNonEmptyString(p.jobId)) return fail("`jobId` is required.");
      if (!isNonEmptyString(p.imageRef)) return fail("`imageRef` is required.");
      const skills = parseStagedSkills(p.skills);
      if (!skills.ok) return skills;
      return {
        ok: true,
        request: {
          op: "stageSkills",
          payload: { jobId: p.jobId, imageRef: p.imageRef, skills: skills.value },
        },
      };
    }
    case "removeSkills": {
      if (!isNonEmptyString(p.volumeName)) return fail("`volumeName` is required.");
      return {
        ok: true,
        request: { op: "removeSkills", payload: { volumeName: p.volumeName } },
      };
    }
    case "cancelJobContainers": {
      if (!isNonEmptyString(p.jobId)) return fail("`jobId` is required.");
      return {
        ok: true,
        request: { op: "cancelJobContainers", payload: { jobId: p.jobId } },
      };
    }
    case "health":
      return { ok: true, request: { op: "health", payload: {} } };
  }
}

/** Build a well-formed request envelope (the clients' single construction site). */
export function execRequestEnvelope(op: string, payload: unknown): ExecRequestEnvelope {
  return { protocolVersion: EXEC_PROTOCOL_VERSION, op, payload };
}
