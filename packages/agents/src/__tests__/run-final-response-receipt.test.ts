import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#3002 — the WRITER itself, at its own seam.
//
// The call-site suite (`wayflow-run-transcript-receipt.test.ts`) pins WHEN the
// terminal path asks for a receipt; it stubs the writer, so it says nothing
// about what the writer does. This suite is the other half: the row it writes,
// and the two races it has to survive on a table it does not own alone.
//
//   * `agent_run_messages` is unique over (run_id, sequence) and carries a
//     SECOND use — the run-window conversation rows — whose writer takes
//     numbers from the same space. A lost number must be retried, not dropped.
//   * A REDELIVERED terminal state can run this same writer concurrently. The
//     existence check before the loop cannot see a row written after it ran, so
//     a collision must be re-read as "the receipt already exists" rather than
//     retried into a SECOND copy of the run's own answer.
//   * drizzle re-throws the driver error sometimes WRAPPED, with the SQLSTATE
//     on `cause` (see `run-window-conversation-store.ts`). Reading only `code`
//     misclassifies that as fatal and the fail-soft caller then completes the
//     run with no receipt — the blank page, restored by a lost race.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/run-final-response-receipt.test.ts

/**
 * The scripted result queue. Each database read in the writer consumes the next
 * entry in call order: the existence check reads rows, the high-water read
 * reads one `{ highWater }` row.
 */
const { dbQueue, appendSpy, selectCalls } = vi.hoisted(() => ({
  dbQueue: [] as unknown[][],
  appendSpy: vi.fn(),
  selectCalls: [] as string[],
}));

vi.mock("../db", () => {
  function nextResult(): unknown[] {
    if (dbQueue.length === 0) throw new Error("test: unscripted database read");
    return dbQueue.shift()!;
  }
  return {
    db: {
      select(fields: Record<string, unknown>) {
        selectCalls.push(Object.keys(fields).join(","));
        const chain = {
          from: () => chain,
          where: () => ({
            limit: () => Promise.resolve(nextResult()),
            then: (
              resolve: (value: unknown[]) => unknown,
              reject: (reason: unknown) => unknown,
            ) => Promise.resolve().then(nextResult).then(resolve, reject),
          }),
        };
        return chain;
      },
    },
  };
});

vi.mock("../store", () => ({ appendAgentRunMessage: appendSpy }));

import {
  recordRunFinalResponseMessage,
  RUN_FINAL_RESPONSE_SEQUENCE_ATTEMPTS,
} from "../run-final-response-receipt";

const TEXT = "Four findings about the flow you handed me.";

/** A unique violation as node-postgres raises it. */
function uniqueViolation() {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

/** The SAME violation as drizzle re-throws it — SQLSTATE on `cause`. */
function wrappedUniqueViolation() {
  return Object.assign(new Error("Failed query"), { cause: uniqueViolation() });
}

function writtenRow(sequence: number) {
  return { id: `msg-${sequence}`, runId: "run-3002", sequence, messageType: "final" };
}

beforeEach(() => {
  dbQueue.length = 0;
  selectCalls.length = 0;
  appendSpy.mockReset();
});

describe("recordRunFinalResponseMessage (cinatra#3002)", () => {
  it("writes nothing for a run that produced no text", async () => {
    await expect(recordRunFinalResponseMessage({ runId: "run-3002", text: "" })).resolves.toBeNull();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(selectCalls).toEqual([]);
  });

  it("refuses a call with no run", async () => {
    await expect(
      recordRunFinalResponseMessage({ runId: "", text: TEXT }),
    ).rejects.toThrow(/runId is required/);
  });

  it("writes the run's produced text as a `final` assistant row at the next sequence", async () => {
    dbQueue.push([]); // no receipt yet
    dbQueue.push([{ highWater: 4 }]); // the run already holds 4 rows
    appendSpy.mockResolvedValueOnce(writtenRow(5));

    const written = await recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT });

    expect(written).toEqual(writtenRow(5));
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith({
      runId: "run-3002",
      sequence: 5,
      body: { messageType: "final", role: "assistant", text: TEXT },
    });
  });

  it("starts at sequence 1 on a run that holds no rows at all", async () => {
    dbQueue.push([]);
    dbQueue.push([{ highWater: null }]);
    appendSpy.mockResolvedValueOnce(writtenRow(1));

    await recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1 }),
    );
  });

  it("writes no second copy when the receipt already exists", async () => {
    dbQueue.push([{ id: "msg-existing" }]);

    await expect(
      recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT }),
    ).resolves.toBeNull();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("retries a lost sequence number, including the WRAPPED unique violation drizzle re-throws", async () => {
    dbQueue.push([]); // no receipt
    dbQueue.push([{ highWater: 4 }]); // first attempt claims 5
    appendSpy.mockRejectedValueOnce(wrappedUniqueViolation());
    dbQueue.push([]); // the collision was a WINDOW turn — still no receipt
    dbQueue.push([{ highWater: 5 }]); // …so the second attempt claims 6
    appendSpy.mockResolvedValueOnce(writtenRow(6));

    const written = await recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT });

    expect(written).toEqual(writtenRow(6));
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ sequence: 6 }),
    );
  });

  it("writes no second copy when a REDELIVERED terminal state won the collision", async () => {
    dbQueue.push([]); // no receipt when we looked
    dbQueue.push([{ highWater: 4 }]);
    appendSpy.mockRejectedValueOnce(uniqueViolation());
    dbQueue.push([{ id: "msg-receipt" }]); // the racer's receipt is there now

    await expect(
      recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT }),
    ).resolves.toBeNull();
    // The run's own answer is NOT appended a second time.
    expect(appendSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of collisions rather than spinning", async () => {
    dbQueue.push([]);
    for (let i = 0; i < RUN_FINAL_RESPONSE_SEQUENCE_ATTEMPTS; i += 1) {
      dbQueue.push([{ highWater: 4 + i }]);
      appendSpy.mockRejectedValueOnce(uniqueViolation());
      dbQueue.push([]); // never a receipt — always a window turn
    }

    await expect(
      recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT }),
    ).rejects.toThrow(/duplicate key/);
    expect(appendSpy).toHaveBeenCalledTimes(RUN_FINAL_RESPONSE_SEQUENCE_ATTEMPTS);
  });

  it("never swallows an error that is not a sequence collision", async () => {
    dbQueue.push([]);
    dbQueue.push([{ highWater: 1 }]);
    appendSpy.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(
      recordRunFinalResponseMessage({ runId: "run-3002", text: TEXT }),
    ).rejects.toThrow(/connection terminated/);
    expect(appendSpy).toHaveBeenCalledTimes(1);
  });
});
