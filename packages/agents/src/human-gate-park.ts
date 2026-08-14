// ---------------------------------------------------------------------------
// human-gate-park — the ONE seam that parks an agent run on a human approval
// gate.
// ---------------------------------------------------------------------------
//
// THE INVARIANT THIS MODULE OWNS
//
//   A run may enter `pending_approval` ONLY when the human-answerable artifact
//   for that gate has been MATERIALIZED AND READ BACK. When the artifact cannot
//   be built, cannot be emitted, or cannot be read back, the run lands `failed`
//   with a NAMED error instead. A run must never sit in `pending_approval` with
//   nothing to approve and no error.
//
// WHY THIS EXISTS
//
// The gate artifact for the setup-interrupt loop and for the legacy WayFlow
// in-panel HITL gate is the AG-UI `INTERRUPT` frame in the durable run event
// log. It is the SAME frame `deriveRunHitlContext` reads back to hydrate the
// approval form on every non-streaming surface (REST poll, A2A snapshot). No
// row is written for these two gates: the frame IS the artifact.
//
// Both call sites used to do this:
//
//     transitionRunStatus(... "pending_approval")   // 1. park
//     adapter.onInterrupt(...)                      // 2. emit, fire-and-forget
//
// which is the wrong order AND an unchecked emit. `AgUiAdapter.onInterrupt` is
// `void publish(...).catch(() => {})` by contract, so EVERY emit failure is
// swallowed; and the payload build in between (schema enrichment) can throw
// after the park already committed. Either way the run is already parked, the
// job returns normally, BullMQ reports the job green, and the run is stranded
// in `pending_approval` forever with zero approval artifacts anywhere.
//
// This module inverts the order and closes the gap:
//
//     build → emit → READ BACK (bounded retry) → park            (verified)
//                                             ↘ fail with a name (unverified)
//
// The read-back deliberately goes through the very reader the UI uses, so
// "verified" means "the human will actually see a gate", not "we called a
// publish function". The emit is fire-and-forget by contract, so the read-back
// is retried a few times rather than awaited once.
//
// Fully dependency-injected and free of DB / Redis / transport imports: the
// seam is a pure decision function over four effects, so the invariant is unit
// testable without a store, a queue, or a running runtime.
// ---------------------------------------------------------------------------

/**
 * Stable prefix of the named failure recorded on `agent_runs.error` when a gate
 * artifact cannot be materialized. Asserted by the regression tests and safe to
 * match on in operator tooling.
 */
export const HUMAN_GATE_ARTIFACT_FAILURE =
  "human approval gate could not be materialized";

/** The human-answerable payload of one approval gate (the AG-UI INTERRUPT frame). */
export type HumanGateArtifact = {
  readonly schema: Record<string, unknown>;
  readonly xRenderer: string;
  readonly values: Record<string, unknown>;
  readonly reviewTaskId: string;
  /** Setup-loop gates only — the single schema property the form writes back. */
  readonly fieldName?: string;
};

/** What a read-back of the run's latest gate returns (shape-compatible with
 *  `readLatestAgUiInterrupt`); `null` when no gate is readable. */
export type ReadBackGate = {
  readonly reviewTaskId: string;
  readonly xRenderer: string;
} | null;

export type ParkRunOnHumanGateOptions = {
  readonly runId: string;
  /** Human-readable gate identity used in logs and in the named error. */
  readonly gateLabel: string;
  /**
   * True when the run is ALREADY in `pending_approval` (a multi-gate re-emit).
   * A verified re-emit performs no transition; an UNVERIFIED one still fails the
   * run — a re-emit that lost its artifact strands the run just as hard.
   */
  readonly alreadyParked: boolean;
  /** Builds the gate payload. Awaited INSIDE the seam so a build throw (schema
   *  enrichment, data resolution) becomes a named failure, not a phantom park. */
  readonly buildArtifact: () => Promise<HumanGateArtifact>;
  /** Emits the artifact to the run event log. May be fire-and-forget. */
  readonly emitInterrupt: (artifact: HumanGateArtifact) => void | Promise<void>;
  /** Reads the run's latest readable gate back out of the event log. */
  readonly readBackGate: (runId: string) => Promise<ReadBackGate>;
  /** `from -> pending_approval`. Only ever called after a verified read-back. */
  readonly parkRun: () => Promise<void>;
  /** `from -> failed`, carrying the named error. */
  readonly failRun: (error: string) => Promise<void>;
  /** Read-back attempts (default 6). Tests inject 1. */
  readonly attempts?: number;
  /** Delay between read-back attempts in ms (default 250). Tests inject 0. */
  readonly delayMs?: number;
  /**
   * Per-attempt read-back budget in ms (default 3000). An unreachable event log
   * queues the read behind an indefinite reconnect, so an unbounded read-back
   * would HANG the worker job rather than land the run. A blown budget counts as
   * a miss.
   */
  readonly readBackTimeoutMs?: number;
  /** Injectable sleep so tests never wall-clock. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ParkRunOnHumanGateResult =
  /** Verified artifact; the run was transitioned into `pending_approval`. */
  | { readonly outcome: "parked" }
  /** Verified artifact on a re-emit; the run was already `pending_approval`. */
  | { readonly outcome: "re-emitted" }
  /** No usable artifact; the run was transitioned to `failed` with `error`. */
  | { readonly outcome: "failed"; readonly error: string };

const DEFAULT_ATTEMPTS = 6;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_READ_BACK_TIMEOUT_MS = 3000;

/** Sentinel for a read-back that blew its per-attempt budget. */
const READ_BACK_TIMED_OUT = Symbol("read-back-timed-out");

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Park a run on a human approval gate, or fail it with a named error.
 *
 * Never throws for a materialization problem — it lands the run instead. It DOES
 * propagate whatever `parkRun` / `failRun` throw, so a caller keeps its own
 * stale-CAS handling (a concurrent transition is not this seam's business).
 */
export async function parkRunOnHumanGate(
  options: ParkRunOnHumanGateOptions,
): Promise<ParkRunOnHumanGateResult> {
  const {
    runId,
    gateLabel,
    alreadyParked,
    buildArtifact,
    emitInterrupt,
    readBackGate,
    parkRun,
    failRun,
  } = options;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS);
  const readBackTimeoutMs = Math.max(
    0,
    options.readBackTimeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS,
  );
  const sleep = options.sleep ?? defaultSleep;

  // Bounded read-back: an unreachable event log queues the read behind an
  // indefinite reconnect, and an unbounded wait would hang the worker job — the
  // exact silent stall this seam exists to remove.
  const readBackBounded = async (): Promise<ReadBackGate | typeof READ_BACK_TIMED_OUT> => {
    if (readBackTimeoutMs === 0) return readBackGate(runId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readBackGate(runId),
        new Promise<typeof READ_BACK_TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(READ_BACK_TIMED_OUT), readBackTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const fail = async (reason: string): Promise<ParkRunOnHumanGateResult> => {
    const error = `${HUMAN_GATE_ARTIFACT_FAILURE} for ${gateLabel}: ${reason}`;
    console.error(`[human-gate-park] run=${runId} ${error}`);
    await failRun(error);
    return { outcome: "failed", error };
  };

  let artifact: HumanGateArtifact;
  try {
    artifact = await buildArtifact();
  } catch (err) {
    return fail(`the gate payload could not be built (${describe(err)})`);
  }

  try {
    await emitInterrupt(artifact);
  } catch (err) {
    return fail(`the gate payload could not be emitted (${describe(err)})`);
  }

  // Read-back verification. `emitInterrupt` is fire-and-forget by adapter
  // contract, so a first miss means "not durable YET", not "not durable".
  let lastMiss = "no approval prompt is readable on the run event log";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && delayMs > 0) await sleep(delayMs);
    let seen: ReadBackGate | typeof READ_BACK_TIMED_OUT;
    try {
      seen = await readBackBounded();
    } catch (err) {
      lastMiss = `the run event log could not be read (${describe(err)})`;
      continue;
    }
    if (seen === READ_BACK_TIMED_OUT) {
      lastMiss = `the run event log did not answer within ${readBackTimeoutMs}ms`;
      continue;
    }
    if (!seen) {
      lastMiss = "no approval prompt is readable on the run event log";
      continue;
    }
    // A readable frame for a DIFFERENT gate is not this gate's artifact: the
    // human would be shown the previous gate's form and their answer would be
    // submitted against a stale review-task id.
    if (seen.reviewTaskId !== artifact.reviewTaskId) {
      lastMiss =
        `the readable approval prompt belongs to a different gate ` +
        `(read back '${seen.reviewTaskId}')`;
      continue;
    }
    // An empty renderer is exactly the unanswerable shell this seam exists to
    // prevent — the poll surfaces render no form for it.
    if (!seen.xRenderer) {
      lastMiss = "the readable approval prompt carries no renderer";
      continue;
    }
    if (alreadyParked) {
      console.log(
        `[human-gate-park] run=${runId} re-emitted ${gateLabel} (already pending_approval)`,
      );
      return { outcome: "re-emitted" };
    }
    await parkRun();
    console.log(`[human-gate-park] run=${runId} parked on ${gateLabel}`);
    return { outcome: "parked" };
  }

  return fail(`${lastMiss} after ${attempts} read-back attempt(s)`);
}
