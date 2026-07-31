import "server-only";

// Boot-only CONSTRUCTION of the REMOTE execution placement (exec-plane L4; epic
// cinatra#1705).
//
// The sibling of `execution-broker-construct.ts`. That module composes a broker
// IN THIS PROCESS; this one composes a CLIENT of a broker that runs somewhere
// else, over the merged HTTP/mTLS service boundary. Everything above the
// executor is identical by construction — `createRemoteSandboxExecutor` returns
// the same `SandboxExecutor` shape `createBrokerSandboxExecutor` does, so no
// surface above this line can tell the two placements apart.
//
// FOUR THINGS ARE GENUINELY DIFFERENT, and each is handled explicitly rather
// than inherited by accident:
//
//  1. THE VOUCHER KEY CANNOT BE EPHEMERAL. In-process, an unset
//     `EXECUTION_VOUCHER_SIGNING_KEY` is answered with a per-process keypair,
//     which is sound because the same process holds both halves. Against a
//     remote broker it is not: the broker verifies against a key an operator
//     provisioned, an app restart would invalidate every outstanding voucher,
//     and a second app replica would sign with a key the broker never trusted.
//     So the remote placement REQUIRES the configured key and refuses without
//     it — the refusal `execution-broker-construct.ts` already documents as
//     owed here.
//
//  2. THE AUDIT KERNEL IS ON THIS SIDE. A remote broker holds no authz kernel,
//     so it BUFFERS its audit records and the app pulls them (`drainAudit`).
//     Without that pull the plane would run commands that are never audited, so
//     the drain is wired at construction, on a timer, into the SAME sink the
//     in-process placement uses. Dropped-record counts are logged, never
//     swallowed: a gap in an audit trail must be visible as a gap.
//
//  3. READINESS IS COMPOSITE. "The broker answered" is not the readiness
//     question — a broker whose worker is gone answers perfectly. The gate is
//     the broker's own composite verdict (worker + gateway + lease), and an
//     ABSENT composite is treated as NOT PROVEN, never as fine.
//
//  4. IDENTITY IS DERIVED, NOT CONFIGURED TWICE. The voucher audience is
//     `execServiceUri(instance, "broker-server")` — computed from the same
//     instance name the mTLS peer check terminates on — because the broker
//     derives ITS `aud` the same way. Two independent settings for one identity
//     is a drift bug waiting for a rotation.
//
// Separated from the boot phase for the same reason the local module is: the
// phase list is imported by unit tests and must stay free of the heavy
// `@cinatra-ai/execution-plane` graph.
//
// The connection inputs and the composite GATE live one module over, in
// `execution-broker-remote-config.ts`: the health phase's live probe needs both
// and needs neither the agent-run store nor the audit kernel, and making a
// deliberately cheap, bounded probe drag this whole graph in would defeat its
// purpose.

import { readAgentRunById, readAgentTemplateById } from "@cinatra-ai/agents";
import {
  BrokerServiceClient,
  createRemoteSandboxExecutor,
  execServiceUri,
  ExecutionVoucherVerifier,
  type AckAuditPayload,
  type AckAuditResultPayload,
  type CommandVoucherMinter,
  type DrainAuditPayload,
  type DrainAuditResultPayload,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";
import { DEFAULT_CARRIER_TTL_MS } from "@cinatra-ai/llm/execution-plane";
import type { SandboxExecutor } from "@cinatra-ai/llm";

import {
  createDurableExecutionAuditWriter,
  createRunLivenessProbe,
  createVoucherMintAuditSink,
  egressPolicyFromSettings,
  IDLE_JOB_SWEEP_INTERVAL_MS,
  LIVENESS_CACHE_MS,
  runBrokerHandshake,
} from "@/lib/execution/execution-broker-construct";
import {
  checkRemoteComposite,
  describeComposite,
  resolveRemoteBrokerConfig,
  sanitizeOperatorDetail,
} from "@/lib/execution/execution-broker-remote-config";
import {
  createCommandVoucherMinter,
  createEd25519VoucherSigner,
  VoucherSigningKeyError,
} from "@/lib/execution/execution-voucher-mint";
import type {
  ExecutionBrokerComposite,
  ExecutionBrokerHandshake,
  ExecutionBrokerLiveness,
} from "@/lib/execution/execution-broker-slot";
import type { ExecutionPlaneSettings } from "@/lib/execution/execution-plane-settings";

/** How often the app pulls the remote broker's buffered audit records. */
export const AUDIT_DRAIN_INTERVAL_MS = 15_000;

/** Cap on one drain PASS, so a long outage cannot be replayed as one huge batch. */
export const AUDIT_DRAIN_MAX_RECORDS = 512;

/**
 * Passes one drain may make before yielding (Codex convergence, adopted). A
 * single capped pass would strand everything past the cap — and on shutdown
 * that stranded remainder is lost, because the broker's buffer does not
 * outlive it. Bounded rather than "until empty" so a broker producing records
 * faster than the app can write them cannot pin this loop forever.
 */
export const AUDIT_DRAIN_MAX_PASSES = 8;

/**
 * Stdio entries this loop pulls per pass: ZERO, deliberately (cinatra#2266,
 * the #2258 stdio discard).
 *
 * `drainAudit` is DESTRUCTIVE — `drain()` splices what it returns out of the
 * broker's buffers — and `maxStdioEntries` defaults to "all of it". So a drain
 * that asked only for audit records still pulled EVERY retained stdout/stderr
 * entry into `batch.stdio`, and this loop has no stdio consumer to hand them
 * to: no app-side `ExecutionStdioSink` exists on either placement (the local
 * placement wires none at all). Retained remote stdio was therefore destroyed
 * on a 15-second cycle, silently.
 *
 * Asking for ZERO is the fix that the surrounding design supports: the entries
 * stay retained in the broker's own buffer, under the bound that buffer already
 * declares, until a consumer lands. The alternative — keep pulling and write
 * them somewhere — has no somewhere to write to, and inventing one here would
 * put unredacted sandbox output into app logs.
 *
 * THE CONSEQUENCE, stated: the broker's stdio buffer now sits at its bound
 * (`DEFAULT_AUDIT_RELAY_MAX_STDIO` entries, each capped at the per-stream
 * `maxStdioBytes`) instead of being emptied every interval. That bound is the
 * relay's own declared overflow contract — "an app that stops draining is
 * bounded, and the drop is COUNTED" — not a new one, and `droppedStdio` is now
 * logged below so the loss is visible as a gap rather than a reset counter.
 * Giving stdio its own delivery and capacity semantics is #2266 AC9's job.
 */
export const AUDIT_DRAIN_MAX_STDIO_ENTRIES = 0;

/** The voucher SIGNING key. Required for this placement and no other. */
export const VOUCHER_SIGNING_KEY_ENV = "EXECUTION_VOUCHER_SIGNING_KEY";

/** The two ops this loop needs; narrowed so a test drives it with a plain object. */
export type AuditDrainSource = {
  drainAudit(limits?: DrainAuditPayload): Promise<DrainAuditResultPayload>;
  ackAudit(payload: AckAuditPayload): Promise<AckAuditResultPayload>;
};

/** What the loop does with one record. Resolves ⇒ the row is durably in the
 *  kernel (freshly inserted, or already there under the same delivery key). */
export type DurableAuditWriter = (
  record: ExecutionAuditRecord,
) => Promise<{ state: "inserted" | "duplicate"; id: string }>;

/**
 * ONE drain — bounded READ → WRITE → ACK passes over the remote broker's
 * durable audit spool (cinatra#2266 slice 2).
 *
 * THE ORDER IS THE WHOLE CONTRACT, and it is the exact inversion of what this
 * loop used to do. It used to call a DESTRUCTIVE `drainAudit` — the records
 * were spliced out of the broker's buffers as the response was built — and then
 * write them, so an app that died partway through the write loop lost the
 * remainder of a batch that no longer existed anywhere. Now:
 *
 *   1. READ. `drainAudit` removes nothing. Repeat it and the same `head` comes
 *      back, so a crash here loses exactly nothing.
 *   2. WRITE, one record at a time, IN ORDER, through the strict idempotent
 *      kernel path. A failure STOPS the pass at that record. Ordering matters
 *      because the ACK is a prefix: acknowledging past a record that failed
 *      would delete it.
 *   3. ACK the head, and ONLY once every record in the batch is durably
 *      inserted or recognized as a duplicate. That is when the broker is free
 *      to remove them.
 *
 * A re-delivery after a crash is EXPECTED and correct — the spool's delivery
 * key is what makes it harmless (one kernel row per key, however many times it
 * arrives). Exported rather than closed over inside the composition so this
 * posture is testable without mTLS, a handshake and a live broker.
 */
export async function drainAuditPasses(
  source: AuditDrainSource,
  writeRecord: DurableAuditWriter,
  opts?: { maxPasses?: number; onGap?: (message: string) => void },
): Promise<void> {
  const maxPasses = opts?.maxPasses ?? AUDIT_DRAIN_MAX_PASSES;
  const onGap = opts?.onGap ?? ((message: string) => console.error(message));
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const batch = await source.drainAudit({
      maxAuditRecords: AUDIT_DRAIN_MAX_RECORDS,
      maxStdioEntries: AUDIT_DRAIN_MAX_STDIO_ENTRIES,
    });
    if (!batch.relayed) return;
    // A NON-DURABLE spool is a real reduction in the guarantee, so it is
    // reported rather than inferred from a config file nobody reads. The
    // records are still written and acknowledged — the delivery protocol is
    // identical — but they do not survive a broker restart.
    if (!batch.durable) {
      onGap(
        "[execution-plane] the remote broker's audit spool is NOT durable " +
          "(EXEC_AUDIT_SPOOL_DIR=memory-nondurable): buffered records do not survive a broker " +
          "restart",
      );
    }
    if (batch.recoveredUnknown > 0) {
      onGap(
        `[execution-plane] the remote broker recovered ${batch.recoveredUnknown} command(s) as ` +
          "outcome_unknown — it died between dispatching them and learning how they ended",
      );
    }
    if (batch.refusedReservations > 0) {
      onGap(
        `[execution-plane] the remote broker has refused ${batch.refusedReservations} command(s) ` +
          "because its audit spool could not accept a pre-dispatch reservation (fail-closed: " +
          "nothing ran)",
      );
    }
    if (batch.droppedAudit > 0) {
      onGap(
        `[execution-plane] the remote broker dropped ${batch.droppedAudit} audit record(s) ` +
          "before this drain — the audit trail has a gap",
      );
    }
    // Stdio is drained destructively and this loop asks for ZERO of it (see
    // AUDIT_DRAIN_MAX_STDIO_ENTRIES), so its buffer can reach its bound and shed
    // the oldest — that is exactly the event this reports.
    if (batch.droppedStdio > 0) {
      onGap(
        `[execution-plane] the remote broker dropped ${batch.droppedStdio} retained stdio ` +
          "entry(ies) — its stdio buffer is at its bound and no consumer drains it",
      );
    }
    if (batch.audit.length === 0) return;

    for (const record of batch.audit) {
      // NOT wrapped in a try/catch. A write that failed must abort the pass
      // BEFORE the ACK, or the broker would delete a record the kernel never
      // took. The caller's own guard turns this into "retry on the next tick",
      // and the records are still spooled, untouched, on the broker.
      await writeRecord(record);
    }
    await source.ackAudit({ spoolId: batch.spoolId, head: batch.head });

    // `remaining` is the broker's own answer, not an inference from a short
    // batch: the read is capped, so a full batch does not by itself mean more
    // is waiting and a short one does not by itself mean the spool is empty.
    if (batch.remaining === 0) return;
  }
  onGap(
    `[execution-plane] the remote broker still had spooled audit records after ` +
      `${maxPasses} drain passes — the next drain continues from there`,
  );
}

type Env = Record<string, string | undefined>;

export type ConstructedRemoteExecutionBroker = {
  executor: SandboxExecutor;
  handshake: ExecutionBrokerHandshake;
  composite: ExecutionBrokerComposite;
  probeLiveness: () => Promise<ExecutionBrokerLiveness>;
  stop: () => Promise<void>;
};

export type ConstructRemoteExecutionBrokerResult =
  | { ok: true; value: ConstructedRemoteExecutionBroker }
  /**
   * A failure CARRIES the composite whenever the broker produced one. The
   * per-subsystem breakdown is most valuable exactly when the placement did NOT
   * come up: "unavailable" tells an operator to look, "worker unhealthy,
   * gateway ok, lease ok" tells them where. Absent when the broker never
   * answered or answered without a composite — which is itself the diagnosis.
   */
  | { ok: false; reason: string; composite?: ExecutionBrokerComposite };

/**
 * Bring up the remote placement and prove it works.
 *
 * THE READINESS CONDITION, stated exactly, and it is the local placement's AC3
 * discipline with one extra rung: this returns `ok` — and therefore the boot
 * phase registers an executor factory — ONLY when
 *   (a) the app can reach the broker over mutual TLS at all,
 *   (b) the broker reports a COMPOSITE verdict in which no subsystem is
 *       unhealthy (worker hop, attributing gateway, host-exclusivity lease),
 *   (c) a real handshake command ran end-to-end: a freshly sealed carrier, a
 *       minted per-command voucher, a real container on the remote worker, exit
 *       0 and the expected stdout.
 * Anything else returns `ok: false`, NOTHING registers, and every declared-
 * environment run keeps refusing — the merged fail-closed posture, untouched.
 *
 * (b) precedes (c) on purpose: when the worker is gone, (b) says "worker
 * unhealthy" and (c) would say "the plane could not run a command". The first
 * is a diagnosis, the second is a symptom.
 */
export async function constructRemoteExecutionBroker(input: {
  settings: ExecutionPlaneSettings;
  env?: Env;
}): Promise<ConstructRemoteExecutionBrokerResult> {
  const env = input.env ?? process.env;
  const policy = egressPolicyFromSettings(input.settings);

  const config = resolveRemoteBrokerConfig(env);
  if (!config.ok) return { ok: false, reason: sanitizeOperatorDetail(config.reason) };

  // See header note 1: no ephemeral fallback on this path, ever.
  const configuredKey = env[VOUCHER_SIGNING_KEY_ENV]?.trim();
  if (!configuredKey) {
    return {
      ok: false,
      reason:
        `the remote placement requires ${VOUCHER_SIGNING_KEY_ENV} (the broker verifies every ` +
        `command against a key an operator provisioned; a per-process key would be trusted by ` +
        `nobody and would not survive a restart)`,
    };
  }
  let signer: ReturnType<typeof createEd25519VoucherSigner>;
  try {
    signer = createEd25519VoucherSigner(configuredKey);
  } catch (err) {
    // The key material itself is NEVER interpolated — only the parser's own
    // complaint about it, redacted like every other operator-facing string.
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        err instanceof VoucherSigningKeyError
          ? `per-command voucher key material is unusable: ${err.message}`
          : `per-command voucher key material could not be resolved: ${
              err instanceof Error ? err.message : String(err)
            }`,
      ),
    };
  }

  // The audience the REMOTE broker derives for itself — same input, same
  // function, so the two cannot drift (header note 4).
  const aud = execServiceUri(config.value.instance, "broker-server");
  try {
    // Constructed only to fail fast on unusable key material; the remote broker
    // owns the authoritative verification.
    new ExecutionVoucherVerifier({ publicKey: signer.publicKey, aud });
  } catch (err) {
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        `voucher verification could not be armed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  // OWNERSHIP OF THE CLIENT TRANSFERS ONLY ON SUCCESS (Codex convergence,
  // adopted). Everything from here to the successful return runs inside the
  // guard below: `createCommandVoucherMinter`, the executor factory and the
  // audit sink can all throw, and a throw past this line would strand a
  // keep-alive agent on every failed boot attempt.
  const client = new BrokerServiceClient(config.value);
  try {
    return await composeAgainst(client, { policy, aud, signer });
  } catch (err) {
    client.close();
    return {
      ok: false,
      reason: sanitizeOperatorDetail(
        `the remote placement could not be composed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

/**
 * The composition proper, split out so the caller's `try/catch` owns the client
 * for the whole of it. Returns `ok:false` (client already closed) or `ok:true`
 * (the client's lifetime passes to the returned `stop`).
 */
async function composeAgainst(
  client: BrokerServiceClient,
  ctx: {
    policy: ReturnType<typeof egressPolicyFromSettings>;
    aud: string;
    signer: ReturnType<typeof createEd25519VoucherSigner>;
  },
): Promise<ConstructRemoteExecutionBrokerResult> {
  const { policy, aud, signer } = ctx;

  const composite = await checkRemoteComposite(client);
  if (!composite.ok) {
    client.close();
    return {
      ok: false,
      reason: sanitizeOperatorDetail(composite.reason),
      ...(composite.composite ? { composite: composite.composite } : {}),
    };
  }

  const mintVoucher: CommandVoucherMinter = createCommandVoucherMinter({
    aud,
    signer,
    livenessProbe: createRunLivenessProbe(),
    readRun: async (runId) => {
      const run = await readAgentRunById(runId);
      if (!run) return null;
      return {
        id: run.id,
        orgId: run.orgId ?? null,
        templateId: run.templateId,
        projectId: run.projectId,
        oboCeiling: run.oboCeiling,
        runBy: run.runBy,
      };
    },
    readTemplate: async (templateId) => {
      const template = await readAgentTemplateById(templateId);
      return template
        ? { ownerLevel: template.ownerLevel ?? null, ownerId: template.ownerId ?? null }
        : null;
    },
    resolveEgressPolicy: () => policy,
    audit: createVoucherMintAuditSink(),
  });

  const handshake = await runBrokerHandshake(client, mintVoucher);
  if (!handshake.ok) {
    client.close();
    return { ok: false, reason: sanitizeOperatorDetail(handshake.reason) };
  }

  const executor = createRemoteSandboxExecutor(client, { mintVoucher });

  // Header note 2 — the audit pull.
  //
  // THE DELIVERY POSTURE, stated rather than implied: `drainAudit` is a READ
  // that removes nothing, and `ackAudit` is what commits an exact prefix — so
  // this is AT-LEAST-ONCE. An app that dies mid-batch re-reads the same records
  // with the same delivery keys and the kernel's unique delivery key turns the
  // second write into a recognized duplicate rather than a second row. What
  // must NOT be silent is a gap, so every gap counter the broker reports is
  // logged BEFORE the batch is written (Codex convergence, adopted).
  //
  // SINGLE-FLIGHT (Codex convergence, adopted). The interval is a timer, not a
  // scheduler: a drain slower than the interval would otherwise overlap itself,
  // pull two batches concurrently and write them to the kernel interleaved. One
  // tracked promise makes drains strictly sequential and gives `stop()`
  // something to await instead of racing.
  //
  // The pass loop itself is `drainAuditPasses` above — extracted so the posture
  // it encodes (what it ASKS the broker for, what it writes, what it reports as
  // a gap) is testable without mTLS and a live broker. In particular it asks for
  // ZERO stdio entries, because this side has no stdio consumer to hand them to
  // and a destructive drain would otherwise delete them (cinatra#2266).
  const writeRecord = createDurableExecutionAuditWriter();
  let draining: Promise<void> | null = null;

  const drainOnce = (maxPasses = AUDIT_DRAIN_MAX_PASSES): Promise<void> => {
    if (draining) return draining;
    draining = drainAuditPasses(client, writeRecord, { maxPasses }).finally(() => {
      draining = null;
    });
    return draining;
  };

  const auditDrain = setInterval(() => {
    void drainOnce().catch(() => {
      // A failed drain retries on the next tick; it must never take the app
      // down, and the records it could not pull are still buffered remotely.
    });
  }, AUDIT_DRAIN_INTERVAL_MS);
  auditDrain.unref?.();

  // The same bounded open-job population the local placement keeps: the
  // executor memoizes one job per sealed carrier and a request has no
  // "turn finished" signal to hand back. The IDLE THRESHOLD is the carrier TTL
  // (past it no valid carrier can reach the job anyway); the INTERVAL is how
  // often the sweep runs. They are two different numbers.
  const idleSweep = setInterval(() => {
    void client.closeIdleJobs(DEFAULT_CARRIER_TTL_MS).catch(() => {});
  }, IDLE_JOB_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();

  let cached: { at: number; value: ExecutionBrokerLiveness } | null = null;
  let inFlight: Promise<ExecutionBrokerLiveness> | null = null;

  return {
    ok: true,
    value: {
      executor,
      handshake: handshake.value,
      composite: composite.composite,
      /**
       * The live re-probe. It asks the broker for a FRESH composite rather than
       * running another container: the admin surface loads on every navigation,
       * and the composite already names which hop is broken. Memoized and
       * single-flighted for the same reason the local one is.
       */
      probeLiveness: async (): Promise<ExecutionBrokerLiveness> => {
        const now = Date.now();
        if (cached && now - cached.at < LIVENESS_CACHE_MS) return cached.value;
        if (inFlight) return inFlight;
        inFlight = (async () => {
          const result = await checkRemoteComposite(client);
          const value: ExecutionBrokerLiveness = result.ok
            ? {
                ok: true,
                detail: `The remote broker and its dependencies answered — ${describeComposite(result.composite)}.`,
                atMs: Date.now(),
                composite: result.composite,
              }
            : {
                ok: false,
                detail: sanitizeOperatorDetail(result.reason),
                atMs: Date.now(),
                ...(result.composite ? { composite: result.composite } : {}),
              };
          cached = { at: Date.now(), value };
          return value;
        })();
        try {
          return await inFlight;
        } finally {
          inFlight = null;
        }
      },
      stop: async () => {
        clearInterval(auditDrain);
        clearInterval(idleSweep);
        // AWAIT any in-flight drain before starting the final one (single-flight
        // makes this one call), then close. Closing under a live drain would
        // abort a batch the broker has already handed over — the one moment
        // when a lost record is unrecoverable.
        await drainOnce().catch(() => {});
        client.close();
      },
    },
  };
}
