/**
 * Command idempotency ledger (exec-plane S1 remainder, epic cinatra#1705).
 *
 * THE PROBLEM THE WIRE CREATES. In-process, `broker.exec(jobId, command)` runs
 * exactly once: the caller either gets a result or an exception, and there is no
 * third outcome. Over a socket there IS a third outcome — the command ran and
 * the RESPONSE was lost (socket reset, gateway timeout, worker restart between
 * dispatch and reply). A client that retries then runs a model-authored command
 * a second time: a duplicated write, a duplicated install, a duplicated
 * side effect, and a second audit row that looks like the model asked twice.
 *
 * THE CONTRACT. Every `exec` / `runCommand` carries a caller-minted
 * `commandId`. The service claims that id BEFORE dispatch and records the
 * outcome under it, so:
 *   - a repeat of a COMPLETED id replays the recorded response (no second run);
 *   - a repeat of an IN-FLIGHT id is refused `command_in_flight` (a 409 the
 *     caller may poll on) rather than dispatched concurrently;
 *   - a NEW id runs.
 *
 * A THROW COUNTS AS AN OUTCOME. The subtle failure is not the lost response —
 * it is the dispatch that THREW, because a throw does not say whether the
 * command ran first. Treating that as "nothing happened" and releasing the claim
 * is what turns a retry into a second execution, so an ambiguous throw is
 * recorded as a terminal `failed` outcome and the retry replays it. A caller who
 * genuinely wants another attempt mints a new id — deliberately, not by accident.
 *
 * THE REPLAY GUARANTEE HAS A MINIMUM DURATION. A record cap alone gave the
 * guarantee no floor: enough newer completions could evict a record immediately
 * after it was written, so a retry inside its own retry budget would find nothing
 * and re-run. `minReplayMs` is that floor — a record younger than it is never
 * evicted to make room — bounded by a hard ceiling so the map still cannot grow
 * without limit, and any eviction that does breach the floor is COUNTED
 * (`droppedReplayGuarantees`) rather than degraded in silence.
 *
 * DURABILITY IS A BINDING, NOT AN ASSUMPTION. This module defines the SEAM
 * (`CommandLedger`) and ships one in-memory implementation. The in-memory
 * ledger is honest about its limit: it survives socket retries within a process
 * — which is the failure mode that actually produces double-execution today —
 * and it does NOT survive a service restart. A restart-crossing retry is
 * therefore still capable of a second run, and closing that requires a DURABLE
 * ledger (a Postgres row keyed on `commandId`, the same shape as this
 * interface). The interface is deliberately async and single-purpose so that
 * binding is a constructor argument, not a refactor: nothing above this module
 * knows which implementation it holds.
 *
 * Everything here is JSON-serializable state (`../types.ts` doctrine), so a
 * durable implementation can persist a record verbatim.
 */

import type { ExecResult, SandboxCommandResult } from "../types";

/** The recordable outcome of one claimed command. */
export type CommandOutcome =
  /** The broker's `exec` verdict (already includes its own fail-closed refusals). */
  | { kind: "exec"; result: ExecResult }
  /** The worker's `runCommand` result. */
  | { kind: "runCommand"; result: SandboxCommandResult }
  /**
   * The worker refused to mount the job's declared L1 environment. Recorded so
   * a retry of the same id refuses IDENTICALLY instead of re-attempting a mount
   * that is already known untrusted (cinatra#1708 AC4).
   */
  | { kind: "environmentUntrusted"; reason: string }
  /**
   * The dispatch THREW, at an unknown point.
   *
   * This is the outcome that must not be confused with "nothing happened". A
   * throw out of `broker.exec` / `worker.runCommand` can come from before the
   * command was dispatched OR from after it already ran (an audit/stdio sink
   * rejecting, a placement failing while tearing down) — and the caller cannot
   * tell which. Releasing the claim on that ambiguity would let a retry start a
   * SECOND container for a model-authored command, which is the one outcome this
   * whole module exists to prevent. So the failure is RECORDED: the retry replays
   * this same failure instead of re-running. A caller that genuinely wants a
   * fresh attempt mints a fresh `commandId` — which is an explicit decision, not
   * an accident of a lost socket.
   */
  | { kind: "failed"; message: string };

export type CommandLedgerRecord = {
  commandId: string;
  jobId: string;
  outcome: CommandOutcome;
  completedAtMs: number;
};

export type CommandClaim =
  /** The id is ours to execute; call `complete()` (or `release()`) after. */
  | { state: "claimed" }
  /** The id already completed; replay this outcome, do not dispatch. */
  | { state: "completed"; record: CommandLedgerRecord }
  /** Another dispatch of the same id is running; refuse `command_in_flight`. */
  | { state: "in_flight" };

/**
 * The idempotency seam. Two calls, both async so a durable implementation can
 * be a single INSERT ... ON CONFLICT plus an UPDATE.
 */
export type CommandLedger = {
  /**
   * Atomically claim `commandId` for `jobId`, or report what already holds it.
   * MUST be atomic with respect to concurrent claims of the same id — that
   * atomicity is the whole guarantee.
   */
  claim(commandId: string, jobId: string): Promise<CommandClaim>;
  /** Record the outcome of a claimed id. */
  complete(commandId: string, jobId: string, outcome: CommandOutcome): Promise<void>;
  /**
   * Release a claim WITHOUT recording an outcome, making the id retryable.
   *
   * ONLY legitimate when the caller can PROVE the dispatch never happened. A
   * throw is not such a proof (see `CommandOutcome.kind: "failed"`), so neither
   * shipped server calls this on a dispatch throw — it exists for a future caller
   * that refuses an id before ever handing it to the broker/worker, and for a
   * durable implementation that needs to abandon a claim it has not yet used.
   */
  release(commandId: string): Promise<void>;
};

export type InMemoryCommandLedgerOptions = {
  /** Soft bound on retained COMPLETED records (oldest evicted first). */
  maxRecords?: number;
  /** How long a completed record stays replayable. */
  retentionMs?: number;
  /**
   * The GUARANTEED replay window: a completed record younger than this is never
   * evicted to make room. Without it, `maxRecords` alone gave the replay
   * guarantee no minimum duration at all — a burst of newer completions could
   * evict a record microseconds after it was written, so a retry that arrived
   * well inside its retry budget would find nothing and RE-RUN the command. Must
   * comfortably exceed a client's whole retry schedule.
   */
  minReplayMs?: number;
  nowMs?: () => number;
};

export const DEFAULT_COMMAND_LEDGER_MAX_RECORDS = 4096;
/** Comfortably longer than a command's wall-clock ceiling plus client retries. */
export const DEFAULT_COMMAND_LEDGER_RETENTION_MS = 15 * 60_000;
/** Guaranteed replay window; far longer than any client's retry schedule. */
export const DEFAULT_COMMAND_LEDGER_MIN_REPLAY_MS = 60_000;
/**
 * Absolute ceiling, as a multiple of `maxRecords`. Honouring `minReplayMs` means
 * the map may overshoot the soft bound under load; this caps that overshoot so
 * the ledger can never become an unbounded allocation. Crossing it is a load
 * regime where the replay guarantee genuinely cannot be met, so it is COUNTED
 * (`droppedReplayGuarantees`) rather than degraded silently.
 */
export const COMMAND_LEDGER_HARD_MAX_MULTIPLE = 4;

/**
 * Process-local ledger. Bounded and TTL'd so it can never become an unbounded
 * cache of every command an instance ever ran.
 *
 * NOT DURABLE — by construction, and stated so at every level that can see it
 * (this comment, the module header, `isDurable: false`, and the PR body). The
 * `isDurable` flag exists so a caller/health surface can REPORT the posture
 * instead of assuming it; nothing branches on it here.
 */
export function createInMemoryCommandLedger(
  opts: InMemoryCommandLedgerOptions = {},
): CommandLedger & {
  readonly isDurable: false;
  size(): number;
  /**
   * Claims currently outstanding. Exposed because it is NOT evicted on a timer
   * (see below) — a caller/health surface must be able to see it rather than
   * assume it is empty.
   */
  inFlightSize(): number;
  /** Records evicted while still inside `minReplayMs` (a replay guarantee lost). */
  readonly droppedReplayGuarantees: number;
} {
  const maxRecords = opts.maxRecords ?? DEFAULT_COMMAND_LEDGER_MAX_RECORDS;
  const retentionMs = opts.retentionMs ?? DEFAULT_COMMAND_LEDGER_RETENTION_MS;
  const minReplayMs = opts.minReplayMs ?? DEFAULT_COMMAND_LEDGER_MIN_REPLAY_MS;
  // VALIDATE, rather than silently ship a ledger that cannot keep its promise.
  // A non-finite `maxRecords` disables capacity eviction outright (unbounded
  // growth), and `retentionMs < minReplayMs` means the TTL deletes records the
  // replay window promised to keep — a contradiction that would otherwise be
  // invisible AND uncounted. Both are configuration errors, so they fail loudly
  // at construction instead of at 3am.
  for (const [name, value] of [
    ["maxRecords", maxRecords],
    ["retentionMs", retentionMs],
    ["minReplayMs", minReplayMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `createInMemoryCommandLedger: ${name} must be a finite positive number (got ${String(value)}).`,
      );
    }
  }
  if (retentionMs < minReplayMs) {
    throw new Error(
      `createInMemoryCommandLedger: retentionMs (${retentionMs}) must be >= minReplayMs ` +
        `(${minReplayMs}); a shorter TTL would silently expire records the guaranteed ` +
        `replay window promises to keep.`,
    );
  }
  const hardMax = maxRecords * COMMAND_LEDGER_HARD_MAX_MULTIPLE;
  const now = opts.nowMs ?? (() => Date.now());
  const completed = new Map<string, CommandLedgerRecord>();
  // IN-FLIGHT CLAIMS ARE NEVER EVICTED ON A TIMER, deliberately: dropping one
  // would let a concurrent retry of that exact id start a second run, which is
  // strictly worse than the alternative it prevents. Both servers reach
  // `complete()` on the success AND the failure path of every dispatch, and every
  // dispatch sits under a wall-clock ceiling (the docker timeout host-side, the
  // request timeout client-side), so an entry clears in practice. A dispatch that
  // never settles at all does hold its id forever — bounded in blast radius to
  // that one command, never the service — and `inFlightSize()` makes that
  // observable rather than a silent leak.
  const inFlight = new Map<string, string>();
  let droppedReplayGuarantees = 0;

  function evict(): void {
    const at = now();
    const cutoff = at - retentionMs;
    for (const [id, record] of completed) {
      if (record.completedAtMs <= cutoff) completed.delete(id);
    }
    // Capacity eviction, oldest first — but never inside the guaranteed replay
    // window, or the guarantee would have no minimum duration.
    const youngestEvictableAt = at - minReplayMs;
    while (completed.size > maxRecords) {
      const oldestId = completed.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = completed.get(oldestId);
      if (oldest === undefined) break;
      const tooYoung = oldest.completedAtMs > youngestEvictableAt;
      if (tooYoung && completed.size <= hardMax) break;
      if (tooYoung) droppedReplayGuarantees += 1;
      completed.delete(oldestId);
    }
  }

  return {
    isDurable: false,
    size: () => completed.size,
    inFlightSize: () => inFlight.size,
    get droppedReplayGuarantees() {
      return droppedReplayGuarantees;
    },
    // Synchronous body inside an async signature: the whole map mutation
    // happens in one microtask-free block, so two concurrent claims of the same
    // id cannot interleave. A durable implementation gets the same atomicity
    // from the database.
    claim: async (commandId, jobId): Promise<CommandClaim> => {
      evict();
      const record = completed.get(commandId);
      if (record) return { state: "completed", record };
      if (inFlight.has(commandId)) return { state: "in_flight" };
      inFlight.set(commandId, jobId);
      return { state: "claimed" };
    },
    complete: async (commandId, jobId, outcome): Promise<void> => {
      // BUILD THE RECORD FIRST, then swap. Reading the clock can throw (`nowMs`
      // is an injectable seam), and clearing the in-flight claim before the
      // record exists would leave the id CLAIMABLE again after a command that may
      // already have run — the exact double-execution this module prevents.
      // Nothing is mutated until the record is fully constructed.
      const record: CommandLedgerRecord = {
        commandId,
        jobId,
        outcome,
        completedAtMs: now(),
      };
      inFlight.delete(commandId);
      // Re-insert so the map's iteration order is completion order (the
      // eviction above pops the oldest first).
      completed.delete(commandId);
      completed.set(commandId, record);
      evict();
    },
    release: async (commandId): Promise<void> => {
      inFlight.delete(commandId);
    },
  };
}
