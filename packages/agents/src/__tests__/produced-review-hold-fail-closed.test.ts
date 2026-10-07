/**
 * cinatra#3007 — a fail-closed hold is PERSISTED, not merely returned.
 *
 * THE DEFECT these proofs are written against. Every unanswerable question in
 * `holdRunForProducedReview` resolved toward "do not write a terminal status",
 * which is right — but the hold itself lived only in the return value. The run
 * row stayed `running`, the execution job returned normally (a successful
 * completion), and nothing durable recorded that the run still owed a review, so
 * no later pass could converge it and the lease-expiry finalizer would eventually
 * write `failed` over it.
 *
 * So every fail-closed branch now PARKS the run: the park row is the durable
 * record, and the release drain performs the withheld terminal write once the
 * question can be answered — including when the answer turns out to be "nothing
 * held it", which is why the candidate predicate does not require production to
 * exist. The ONE branch that can persist nothing is a park write that itself
 * fails, and that returns the distinguished outcome the executor turns into a
 * retryable job failure instead of a silent success.
 *
 * Harness: `../db` and `../run-transition` are mocked, so what is pinned here is
 * the DECISION each fault leads to. The row-grounded behaviour of the park and
 * of the release is proved against a real database in
 * `produced-review-ordering.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const shared = vi.hoisted(() => ({
  selectQueue: [] as Array<() => unknown>,
  transition: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  updates: [] as unknown[],
  /** What the already-parked update reports it MATCHED. Empty = the row already
   *  carried a withheld terminal write and the first-writer-wins predicate
   *  refused this one. */
  parkUpdateRows: [{ id: "run-3007" }] as Array<{ id: string }>,
}));

/** A drizzle-shaped query builder: awaitable, and `.limit()`-able, answering
 *  from the queue this suite arms per case. */
function query() {
  let promise: Promise<unknown> | null = null;
  const get = () =>
    (promise ??= Promise.resolve().then(() => {
      const next = shared.selectQueue.shift();
      if (!next) throw new Error("[test] an unexpected extra select was issued");
      return next();
    }));
  return {
    limit: () => get(),
    then: (res: unknown, rej: unknown) =>
      get().then(res as never, rej as never) as unknown,
    catch: (rej: unknown) => get().catch(rej as never) as unknown,
    finally: (f: () => void) => get().finally(f) as unknown,
  };
}

vi.mock("../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => query() }) }),
    update: () => ({
      set: (payload: unknown) => ({
        where: () => ({
          // The already-parked write is first-writer-wins, so it reads back the
          // rows it actually matched; `parkUpdateRows` is what this double says
          // the predicate matched.
          returning: async () => {
            shared.updates.push(payload);
            return shared.parkUpdateRows;
          },
        }),
      }),
    }),
  },
  agentBuilderPool: { query: vi.fn(), end: vi.fn() },
}));

vi.mock("../run-transition", () => ({ transitionRunStatus: shared.transition }));

import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { RunTransitionError } from "../run-status";
import {
  holdRunForProducedReview,
  isUnpersistedHold,
  UNPERSISTED_HOLD_REASON,
  readWithheldTerminal,
  WITHHELD_TERMINAL_KEY,
} from "../run-produced-review-hold";

const AUTHORITY = { orgId: "org-3007", can: () => true };
const previousFence = process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];

function input(over: Record<string, unknown> = {}) {
  return {
    runId: "run-3007",
    orgId: "org-3007",
    fromStatus: "running" as const,
    stepResults: [{ kind: "wayflow_response", output: "the draft" }],
    withheld: { status: "completed" as const },
    ...over,
  };
}

/** The step-results payload the park attempted to write. */
function parkedPayload(): unknown[] {
  const call = shared.transition.mock.calls.at(-1) as unknown as [
    string,
    string,
    string,
    { stepResults?: unknown[] } | undefined,
    unknown,
  ];
  return call?.[3]?.stepResults ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.selectQueue.length = 0;
  shared.updates.length = 0;
  shared.parkUpdateRows = [{ id: "run-3007" }];
  shared.transition.mockReset();
  shared.transition.mockResolvedValue(undefined);
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
});

afterAll(() => {
  if (previousFence === undefined) delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  else process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = previousFence;
});

describe("cinatra#3007 — an unanswerable question parks the run", () => {
  it("the PRODUCTION PROBE failing parks the run, carrying the withheld terminal write", async () => {
    shared.selectQueue.push(() => {
      throw new Error("the produced-outbox probe is unreadable");
    });

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: "hold-check-failed" });
    // The park was WRITTEN — the whole point. running -> the parked status.
    expect(shared.transition).toHaveBeenCalledTimes(1);
    const call = shared.transition.mock.calls[0] as unknown as [string, string, string];
    expect([call[0], call[1], call[2]]).toEqual(["run-3007", "running", "pending_approval"]);
    // ...and it carries the terminal write the executor is withholding, so the
    // release can perform it.
    expect(readWithheldTerminal(parkedPayload())).toEqual({ status: "completed" });
  });

  it("the PREDICATE READ failing after the drain parks the run too", async () => {
    // The probe answers (production exists), then the hold predicate's own read
    // fails. Unknown is not "no", and the hold is recorded rather than returned.
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => {
      throw new Error("the hold predicate is unreadable");
    });

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: "hold-check-failed" });
    expect(shared.transition).toHaveBeenCalledTimes(1);
    expect(readWithheldTerminal(parkedPayload())).toEqual({ status: "completed" });
  });

  it("an ALREADY-PARKED run records the withheld write in place, with no status edge", async () => {
    shared.selectQueue.push(() => {
      throw new Error("the produced-outbox probe is unreadable");
    });

    const outcome = await holdRunForProducedReview(
      input({ fromStatus: "pending_approval" }),
      AUTHORITY,
    );

    expect(outcome).toEqual({ held: true, reason: "hold-check-failed" });
    // No transition: `pending_approval -> pending_approval` is not an edge.
    expect(shared.transition).not.toHaveBeenCalled();
    expect(shared.updates).toHaveLength(1);
    const written = (shared.updates[0] as { stepResults: string }).stepResults;
    expect(written).toContain(WITHHELD_TERMINAL_KEY);
  });

  it("an already-parked run whose marker the predicate REFUSES is still held, and writes no terminal status", async () => {
    // The row already carries another chain's withheld terminal write, so the
    // first-writer-wins predicate matches nothing.
    shared.parkUpdateRows = [];
    shared.selectQueue.push(() => {
      throw new Error("the produced-outbox probe is unreadable");
    });

    const outcome = await holdRunForProducedReview(
      input({ fromStatus: "pending_approval", withheld: { status: "failed", error: "the later chain" } }),
      AUTHORITY,
    );

    // Refused is NOT a fault: the run stays parked, still owes exactly one
    // terminal write, and this attempt takes no status edge of its own.
    expect(outcome).toEqual({ held: true, reason: "hold-check-failed" });
    expect(shared.transition).not.toHaveBeenCalled();
  });
});

describe("cinatra#3007 — the one hold that persists nothing", () => {
  it("a PARK WRITE that keeps failing returns the unpersisted outcome, after retrying", async () => {
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    // The event is still pending, so the run genuinely holds...
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    // ...and the park write is the thing that fails, every time.
    shared.transition.mockRejectedValue(new Error("the park write failed"));

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: UNPERSISTED_HOLD_REASON });
    expect(isUnpersistedHold(outcome)).toBe(true);
    // The park is the ONLY durable record of a fail-closed hold, so a transient
    // write fault must not be what turns the hold into nothing.
    expect(shared.transition).toHaveBeenCalledTimes(3);
  });

  it("a TRANSIENT park-write fault converges inside the same attempt", async () => {
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.transition
      .mockRejectedValueOnce(new Error("write blip"))
      .mockResolvedValueOnce(undefined);

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: "awaiting-orchestration" });
    expect(shared.transition).toHaveBeenCalledTimes(2);
  });

  it("a STALE compare-and-swap is a decision, not a fault — it is never retried", async () => {
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.transition.mockRejectedValue(
      new RunTransitionError({ code: "stale_from_status", runId: "run-3007", from: "running", to: "pending_approval" }),
    );

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: "stale-from-status" });
    expect(shared.transition).toHaveBeenCalledTimes(1);
  });

  it("a park with NO payload of its own keeps the run's recorded step results", async () => {
    // The failure edges carry no payload; their immediate transitions omit
    // `stepResults` and so preserve the column. The park WRITES that column, so
    // it has to park on top of what the row already holds.
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => [
      { stepResults: JSON.stringify([{ kind: "wayflow_response", output: "the draft" }]) },
    ]);

    await holdRunForProducedReview(
      input({ stepResults: [], withheld: { status: "failed", error: "the flow failed" } }),
      AUTHORITY,
    );

    const written = parkedPayload() as Array<Record<string, unknown>>;
    expect(written).toHaveLength(1);
    expect(written[0]?.output).toBe("the draft");
    expect(readWithheldTerminal(written)).toEqual({
      status: "failed",
      error: "the flow failed",
    });
  });

  it("every OTHER held outcome is persisted, so the job is genuinely done", async () => {
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);
    shared.selectQueue.push(() => [{ eventId: "ev-1" }]);

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: true, reason: "awaiting-orchestration" });
    expect(isUnpersistedHold(outcome)).toBe(false);
  });

  it("the unpersisted reason is the literal the executor's seam recognises", () => {
    // The executor may not import this module statically (route-graph ratchet),
    // so it compares against the bare string. This pins the two together.
    expect(UNPERSISTED_HOLD_REASON).toBe("hold-unpersisted");
  });
});

describe("cinatra#3007 — the fence is still the one exception", () => {
  it("with the slice switched off nothing parks and nothing is read", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";

    const outcome = await holdRunForProducedReview(input(), AUTHORITY);

    expect(outcome).toEqual({ held: false, reason: "review-inactive" });
    expect(shared.transition).not.toHaveBeenCalled();
    expect(shared.selectQueue).toHaveLength(0);
  });
});
