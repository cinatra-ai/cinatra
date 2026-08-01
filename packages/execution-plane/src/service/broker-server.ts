/**
 * Broker SERVICE (exec-plane S1 remainder, epic cinatra#1705).
 *
 * A thin mTLS server over the ALREADY-MERGED `ExecutionBroker`. It adds no
 * policy of its own: every refusal a caller can see is either a transport /
 * authorization refusal from `rpc-transport.ts` + `mtls.ts`, or the broker's own
 * fail-closed verdict passed through byte-for-byte. Carrier verification,
 * per-command run-liveness revalidation, quotas, bounded queueing, egress
 * resolution, audit and the teardown hook all stay exactly where they already
 * are — this file is a socket, not a second brain.
 *
 * WHAT IT DOES ADD, and why each is not optional over a wire:
 *
 *  - IDEMPOTENCY. `exec` carries a `commandId` and runs through
 *    `command-ledger.ts`, so a lost RESPONSE cannot become a second execution of
 *    a model-authored command. (Durability of that ledger is a binding — see
 *    that module's header; the default is process-local.)
 *
 *  - AN AUDIT RELAY. A remote broker holds no authz kernel and no stdio store.
 *    Since cinatra#2266 slice 2 the two halves are handled differently on
 *    purpose: AUDIT records go to a DURABLE, ACK-ed spool on the broker's own
 *    volume (`audit-spool.ts`) — read non-destructively, removed only after the
 *    app confirms a durable kernel write, and never dropped for capacity
 *    (a full spool refuses the command's pre-dispatch reservation instead) —
 *    while STDIO stays a bounded, explicitly lossy ring buffer whose drops are
 *    COUNTED and reported. The sinks stay the app's (`toAuthzAuditEventInput`
 *    → the kernel); the broker never grows a second audit implementation.
 *
 *  - TWO INDEPENDENT FACTORS. mTLS role identity AND the pre-existing
 *    `verifyServiceToken`. Both, on every request (see `rpc-transport.ts`).
 *
 * `createBrokerService()` builds the server WITHOUT listening — the
 * `runtime/egress-gateway.cjs` pattern, so in-process tests drive the real
 * request path. The listening entrypoint is `broker-entry.ts`.
 */

import * as https from "node:https";

import type { ResolvedEnvironmentMount } from "../environment/mount";
import type {
  ExecResult,
  ExecutionAuditAdmission,
  ExecutionAuditRecord,
  ExecutionAuditReserver,
  ExecutionAuditSink,
  ExecutionStdioSink,
  OpenJobResult,
  StagedSkillInput,
} from "../types";
import type { AuditSpool, AuditSpoolAckResult } from "./audit-spool";
import {
  createInMemoryCommandLedger,
  type CommandLedger,
} from "./command-ledger";
import {
  EXEC_ERROR_STATUS,
  EXEC_PROTOCOL_VERSION,
  execErrorResponse,
  execOkResponse,
  parseBrokerRequest,
  type AckAuditPayload,
  type AckAuditResultPayload,
  type BrokerRequest,
  type DrainAuditPayload,
  type DrainAuditResultPayload,
  type ExecCompositeHealth,
  type ExecutionStdioEntry,
  type HealthResultPayload,
} from "./protocol";
import {
  createExecRpcListener,
  describeThrown,
  type ExecRpcContext,
  type ExecRpcListenerConfig,
  type ExecRpcReply,
} from "./rpc-transport";
import { execServerTlsOptions, type ExecTlsMaterial } from "./mtls";

// ---------------------------------------------------------------------------
// The broker surface this service needs
// ---------------------------------------------------------------------------

/**
 * The subset of `ExecutionBroker` the service calls, expressed structurally so
 * the merged class satisfies it WITHOUT this module importing it as a value
 * (keeping the service graph free of docker/egress at type-check time) and so a
 * test double is a plain object.
 */
export type BrokerServiceBroker = {
  openJob(
    carrier: string,
    openOpts?: {
      stagedSkills?: StagedSkillInput[];
      environment?: ResolvedEnvironmentMount;
    },
  ): Promise<OpenJobResult>;
  exec(jobId: string, command: string, voucher: string): Promise<ExecResult>;
  closeJob(jobId: string, opts?: { removeWorkspace?: boolean }): Promise<void>;
  terminateJobsForRun(runId: string, opts?: { removeWorkspace?: boolean }): Promise<number>;
  closeIdleJobs(idleMs: number): Promise<number>;
  readonly executingCount: number;
};

// ---------------------------------------------------------------------------
// Audit relay
// ---------------------------------------------------------------------------

export const DEFAULT_AUDIT_RELAY_MAX_STDIO = 1024;

export type ExecAuditRelay = {
  /** Pass to `ExecutionBrokerOptions.auditSink`. */
  auditSink: ExecutionAuditSink;
  /** Pass to `ExecutionBrokerOptions.auditReserver` (cinatra#2266 G1). */
  auditReserver: ExecutionAuditReserver;
  /** Pass to `ExecutionBrokerOptions.auditAdmission` (cinatra#2266 G5). */
  auditAdmission: ExecutionAuditAdmission;
  /** Pass to `ExecutionBrokerOptions.stdioSink`. */
  stdioSink: ExecutionStdioSink;
  /** READ the un-acknowledged prefix. Non-destructive: repeat it and the head
   *  is the same. Nothing leaves the spool until `ack`. */
  read(limits?: DrainAuditPayload): DrainAuditResultPayload;
  /** Commit an exact prefix the app has durably written. */
  ack(payload: AckAuditPayload): Promise<AuditSpoolAckResult>;
  /** The spool behind this relay (its id/durability ride every read). */
  readonly spool: AuditSpool;
};

/**
 * The relay between a REMOTE broker's sinks and the app that owns them.
 *
 * WHAT CHANGED IN cinatra#2266 SLICE 2, and why the two halves are no longer
 * symmetric:
 *
 *  - AUDIT records go to a DURABLE SPOOL (`audit-spool.ts`) on the broker's own
 *    volume, are read non-destructively and leave only on an ACK. There is no
 *    audit ring buffer any more and no `audit.shift()` overflow: an audit
 *    record is never dropped to make room, because the spool refuses the
 *    command's PRE-DISPATCH RESERVATION instead. "Cannot store this" now
 *    refuses the execution rather than discarding the record and running it.
 *
 *  - STDIO stays a bounded in-memory ring buffer with the pre-existing
 *    drop-the-oldest-and-COUNT policy, and it is DESTRUCTIVELY drained. That
 *    is deliberate and stated rather than implied (cinatra#2266 AC9 owns the
 *    full separation): stdout/stderr is observability, it is unbounded in a way
 *    an audit record is not, and giving it the spool's fail-closed backpressure
 *    would let a chatty command refuse an authorized one. The two now have
 *    genuinely separate buffers, bounds and delivery semantics — which is the
 *    property that was missing when they shared one drain.
 */
export function createAuditRelay(opts: {
  spool: AuditSpool;
  maxStdioEntries?: number;
}): ExecAuditRelay {
  const maxStdio = opts.maxStdioEntries ?? DEFAULT_AUDIT_RELAY_MAX_STDIO;
  const spool = opts.spool;
  const stdio: ExecutionStdioEntry[] = [];
  let droppedStdio = 0;

  return {
    spool,
    auditSink: async (record: ExecutionAuditRecord): Promise<void> => {
      await spool.append(record);
    },
    auditReserver: async (prepared: ExecutionAuditRecord) => {
      const reservation = await spool.reserve(prepared);
      return {
        deliveryKey: reservation.deliveryKey,
        commit: (record: ExecutionAuditRecord) => reservation.commit(record),
      };
    },
    auditAdmission: () => {
      const verdict = spool.admission();
      return verdict.admitted
        ? { admitted: true as const }
        : { admitted: false as const, message: verdict.message };
    },
    stdioSink: (entry: ExecutionStdioEntry): void => {
      stdio.push(entry);
      while (stdio.length > maxStdio) {
        stdio.shift();
        droppedStdio += 1;
      }
    },
    read: (limits?: DrainAuditPayload): DrainAuditResultPayload => {
      const batch = spool.read(limits?.maxAuditRecords);
      const stdioTake = limits?.maxStdioEntries ?? stdio.length;
      const takenStdio = stdio.splice(0, stdioTake);
      const stats = spool.stats();
      const result: DrainAuditResultPayload = {
        audit: batch.entries,
        stdio: takenStdio,
        head: batch.head,
        spoolId: spool.spoolId,
        remaining: batch.remaining,
        durable: spool.durable,
        refusedReservations: stats.refusedReservations,
        recoveredUnknown: stats.recoveredUnknown,
        saturation: stats.saturation,
        // Audit records are never dropped for capacity any more; the field
        // stays on the wire (and stays 0) so a reader that checks it keeps
        // working and a future producer of a real gap has somewhere to say so.
        droppedAudit: 0,
        droppedStdio,
        relayed: true,
      };
      droppedStdio = 0;
      return result;
    },
    ack: (payload: AckAuditPayload) => spool.ack(payload),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type BrokerServiceConfig = {
  broker: BrokerServiceBroker;
  /** Deployment identity; half of every authorized URI SAN. */
  instance: string;
  /** Expected service token — the second factor. */
  serviceToken: string;
  /** mTLS material for the `broker-server` identity. REQUIRED: the service
   *  boundary is mutual TLS, so there is no plaintext construction path. */
  tls: ExecTlsMaterial;
  /**
   * The audit relay whose sinks were handed to the broker. Omit for an
   * in-process placement whose sinks already reach the app — `drainAudit` then
   * answers honestly with `relayed: false` instead of a misleading empty batch,
   * and `ackAudit` refuses instead of confirming a commit that never happened.
   */
  relay?: ExecAuditRelay;
  /** Idempotency ledger; defaults to the process-local one. */
  ledger?: CommandLedger;
  maxBodyBytes?: number;
  onRefusal?: ExecRpcListenerConfig["onRefusal"];
  nowMs?: () => number;
  /**
   * COMPOSITE health provider (exec-plane L4) — the broker's own view of the
   * dependencies BELOW it: the worker hop, the attributing egress gateway and
   * the host-exclusivity lease. Supplied by the composition site
   * (`broker-entry.ts`), which is the only place that holds all three.
   *
   * Optional so an in-process placement, and every merged test that builds this
   * service without one, keeps the exact answer it has today. Absent ⇒ the
   * reply carries NO `composite` field, and the app-side gate reads that as
   * "not proven" rather than as an all-clear.
   *
   * MUST NOT THROW to be correct: the dispatcher wraps it anyway and degrades a
   * thrown provider to an `unhealthy` composite, because a health endpoint that
   * 500s when a dependency is down tells an operator strictly less than one
   * that names which dependency is down.
   */
  composite?: () => Promise<ExecCompositeHealth>;
};

export type BrokerService = {
  /** Built, configured, NOT listening (`broker-entry.ts` listens). */
  server: https.Server;
  /** The dispatcher, exposed for in-process op-level tests. */
  dispatch: (raw: unknown, ctx: ExecRpcContext) => Promise<ExecRpcReply>;
  ledger: CommandLedger;
  close(): Promise<void>;
};

function opFailed(op: string, err: unknown): ExecRpcReply {
  return {
    status: EXEC_ERROR_STATUS.op_failed,
    body: execErrorResponse(
      "op_failed",
      `The broker failed to handle "${op}": ${describeThrown(err)}`,
    ),
  };
}

/**
 * Dispatch one parsed app→broker request. Total: every path returns a reply,
 * and a throw from the broker becomes a structured `op_failed` rather than a
 * dropped socket.
 */
export function createBrokerDispatch(
  config: BrokerServiceConfig & { ledger: CommandLedger },
): (raw: unknown, ctx: ExecRpcContext) => Promise<ExecRpcReply> {
  const now = config.nowMs ?? (() => Date.now());

  async function handle(request: BrokerRequest): Promise<ExecRpcReply> {
    switch (request.op) {
      case "openJob": {
        const { carrier, stagedSkills, environment } = request.payload;
        const result = await config.broker.openJob(carrier, {
          ...(stagedSkills ? { stagedSkills } : {}),
          ...(environment ? { environment } : {}),
        });
        // A carrier refusal is the BROKER's verdict, not a transport failure:
        // it rides an ok envelope so the app sees the merged vocabulary
        // (`carrier_expired`, `run_removed`, `staging_failed`, …) unchanged.
        return { status: 200, body: execOkResponse(result) };
      }
      case "exec": {
        const { jobId, command, commandId, voucher } = request.payload;
        const claim = await config.ledger.claim(commandId, jobId);
        if (claim.state === "in_flight") {
          return {
            status: EXEC_ERROR_STATUS.command_in_flight,
            body: execErrorResponse(
              "command_in_flight",
              `Command "${commandId}" is already executing on job "${jobId}"; the duplicate ` +
                `dispatch is refused (a retry must not run a command twice).`,
            ),
          };
        }
        if (claim.state === "completed") {
          // A replay is only a replay of THIS job. The ledger is keyed on the
          // commandId alone (that is what makes the claim atomic), so without
          // this check a repeated id naming a DIFFERENT jobId would be answered
          // with the first job's recorded stdout — one job's output attributed to
          // another. Refuse instead of guessing.
          if (claim.record.jobId !== jobId) {
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
          if (outcome.kind === "exec") {
            return { status: 200, body: execOkResponse(outcome.result) };
          }
          if (outcome.kind === "failed") {
            // The first dispatch threw at an unknown point, so this id is spent:
            // replay the SAME failure rather than risk a second run.
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
          // A ledger record of a different kind under an app-facing commandId
          // means the id was reused across hops — refuse rather than guess.
          return {
            status: EXEC_ERROR_STATUS.malformed_request,
            body: execErrorResponse(
              "malformed_request",
              `Command id "${commandId}" was already recorded for a different operation kind; refused.`,
            ),
          };
        }
        let result: ExecResult;
        try {
          result = await config.broker.exec(jobId, command, voucher);
        } catch (err) {
          // A THROW IS NOT PROOF THAT NOTHING RAN. `broker.exec` converts almost
          // everything into a structured refusal, so a throw that gets here comes
          // from an unknown point in the pipeline — possibly AFTER the container
          // already ran (a host-injected audit or stdio sink rejecting does
          // exactly that). Releasing the claim here would let the caller's retry
          // start a SECOND run of a model-authored command. So the failure is
          // RECORDED under this id: the retry replays this same failure, and a
          // genuinely fresh attempt requires a fresh commandId — an explicit
          // decision rather than an accident of a lost socket.
          // describeThrown, never `(err as Error).message`: a non-Error throw
          // (`throw null`) would throw AGAIN here, skip the ledger write, and
          // leave this commandId claimed forever.
          const message = describeThrown(err);
          await config.ledger.complete(commandId, jobId, { kind: "failed", message });
          return opFailed("exec", err);
        }
        await config.ledger.complete(commandId, jobId, { kind: "exec", result });
        return { status: 200, body: execOkResponse(result) };
      }
      case "closeJob": {
        const { jobId, removeWorkspace } = request.payload;
        await config.broker.closeJob(jobId, {
          ...(removeWorkspace === undefined ? {} : { removeWorkspace }),
        });
        return { status: 200, body: execOkResponse({ closed: true as const }) };
      }
      case "terminateJobsForRun": {
        const { runId, removeWorkspace } = request.payload;
        const terminated = await config.broker.terminateJobsForRun(runId, {
          ...(removeWorkspace === undefined ? {} : { removeWorkspace }),
        });
        return { status: 200, body: execOkResponse({ terminated }) };
      }
      case "sweep": {
        const closed = await config.broker.closeIdleJobs(request.payload.idleMs);
        return { status: 200, body: execOkResponse({ closed }) };
      }
      case "drainAudit": {
        if (!config.relay) {
          const empty: DrainAuditResultPayload = {
            audit: [],
            stdio: [],
            head: 0,
            spoolId: "",
            remaining: 0,
            durable: false,
            refusedReservations: 0,
            recoveredUnknown: 0,
            saturation: { state: "open", episodes: 0 },
            droppedAudit: 0,
            droppedStdio: 0,
            relayed: false,
          };
          return { status: 200, body: execOkResponse(empty) };
        }
        return {
          status: 200,
          body: execOkResponse(config.relay.read(request.payload)),
        };
      }
      case "ackAudit": {
        if (!config.relay) {
          // Nothing here spools, so nothing here can be acknowledged. Refused
          // rather than answered with a cheerful `acked: true`, which would
          // tell an app its records are committed somewhere they never were.
          return {
            status: EXEC_ERROR_STATUS.audit_ack_refused,
            body: execErrorResponse(
              "audit_ack_refused",
              "This broker was composed without an audit relay, so it holds no spool to " +
                "acknowledge (an in-process placement's sinks already reach the app).",
            ),
          };
        }
        const outcome = await config.relay.ack(request.payload);
        if (!outcome.ok) {
          return {
            status: EXEC_ERROR_STATUS.audit_ack_refused,
            body: execErrorResponse(
              "audit_ack_refused",
              `${outcome.reason}: ${outcome.message}`,
            ),
          };
        }
        const result: AckAuditResultPayload = {
          acked: true,
          head: outcome.head,
          removed: outcome.removed,
          remaining: outcome.remaining,
        };
        return { status: 200, body: execOkResponse(result) };
      }
      case "health": {
        const composite = config.composite
          ? await config.composite().catch(
              (err): ExecCompositeHealth => ({
                ok: false,
                worker: { state: "unhealthy", detail: describeThrown(err) },
                gateway: { state: "unhealthy", detail: "not evaluated" },
                lease: { state: "unhealthy", detail: "not evaluated" },
              }),
            )
          : undefined;
        const result: HealthResultPayload = {
          protocolVersion: EXEC_PROTOCOL_VERSION,
          executingCount: config.broker.executingCount,
          atMs: now(),
          ...(composite ? { composite } : {}),
          // G3: the per-VOLUME spool identity, so a fleet router can tell one
          // replica from another behind one logical mTLS identity without
          // draining anything.
          ...(config.relay ? { spoolId: config.relay.spool.spoolId } : {}),
        };
        // 200 EVEN WHEN THE COMPOSITE IS NOT OK. The broker answered, and that
        // answer carries the diagnosis; collapsing it into a transport-level
        // failure would leave the caller unable to tell "the broker is gone"
        // from "the broker is up and its worker is gone" — the exact
        // distinction the activation gate needs.
        return { status: 200, body: execOkResponse(result) };
      }
    }
  }

  return async (raw: unknown): Promise<ExecRpcReply> => {
    const parsed = parseBrokerRequest(raw);
    if (!parsed.ok) {
      return {
        status: EXEC_ERROR_STATUS[parsed.code],
        body: execErrorResponse(parsed.code, parsed.message),
      };
    }
    try {
      return await handle(parsed.request);
    } catch (err) {
      return opFailed(parsed.request.op, err);
    }
  };
}

/**
 * Build the broker service: TLS options + the authorized request listener +
 * an `https.Server` that is NOT listening. `broker-entry.ts` (the bundled
 * entrypoint) is what listens.
 */
export function createBrokerService(config: BrokerServiceConfig): BrokerService {
  const ledger = config.ledger ?? createInMemoryCommandLedger();
  const dispatch = createBrokerDispatch({ ...config, ledger });
  const listener = createExecRpcListener({
    instance: config.instance,
    // The broker's endpoint accepts exactly ONE role: the app.
    peerRole: "app-client",
    serviceToken: config.serviceToken,
    dispatch,
    ...(config.maxBodyBytes === undefined ? {} : { maxBodyBytes: config.maxBodyBytes }),
    ...(config.onRefusal ? { onRefusal: config.onRefusal } : {}),
  });
  const server = https.createServer(
    execServerTlsOptions({
      instance: config.instance,
      role: "broker-server",
      peerRole: "app-client",
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
