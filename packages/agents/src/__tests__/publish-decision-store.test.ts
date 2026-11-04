// cinatra#4150: the publish-decision store over a double of the database. The real
// constraints and the single winner of two concurrent answers are proven against
// Postgres in publish-decision-store.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { calls, answers } = vi.hoisted(() => ({
  calls: {
    values: [] as Array<Record<string, unknown>>,
    set: [] as Array<Record<string, unknown>>,
    where: [] as unknown[],
    limit: [] as number[],
    orderBy: 0,
    transactions: 0,
    rollbacks: 0,
    /** Each call by the handle it went through: "db" (the pool) or "tx" (the transaction). */
    via: [] as string[],
    /** The writes that stayed: through "db", or through a "tx" whose transaction returned. */
    committed: [] as Array<Record<string, unknown>>,
  },
  answers: {
    insert: async (): Promise<unknown[]> => [],
    update: async (): Promise<unknown[]> => [],
    select: async (): Promise<unknown[]> => [],
  },
}));

vi.mock("../db", () => {
  // Two distinct handles: the store gets "tx" inside a transaction and "db" outside one. An
  // UPDATE that returns a row is a write; a write through "tx" stays only when the work
  // returns, and a throw out of the work counts as a rollback that drops it, as in drizzle.
  const handle = (name: "db" | "tx", writes: Array<Record<string, unknown>>) => ({
    insert: () => {
      calls.via.push(`${name}.insert`);
      return {
        values: (v: Record<string, unknown>) => {
          calls.values.push(v);
          return { onConflictDoNothing: () => ({ returning: () => answers.insert() }) };
        },
      };
    },
    update: () => {
      calls.via.push(`${name}.update`);
      return {
        set: (v: Record<string, unknown>) => {
          calls.set.push(v);
          return {
            where: (w: unknown) => {
              calls.where.push(w);
              return {
                returning: async () => {
                  const rows = await answers.update();
                  if (rows.length > 0) writes.push(v);
                  return rows;
                },
              };
            },
          };
        },
      };
    },
    select: () => {
      calls.via.push(`${name}.select`);
      const where = (w: unknown) => {
        calls.where.push(w);
        const limit = (n: number) => {
          calls.limit.push(n);
          return answers.select();
        };
        return {
          limit,
          orderBy: () => {
            calls.orderBy += 1;
            return { limit };
          },
        };
      };
      return {
        from: () => ({
          where,
          // cinatra#4150 PR 3a: the one read that joins the run, for its status.
          innerJoin: () => {
            calls.via.push(`${name}.innerJoin`);
            return { where };
          },
        }),
      };
    },
  });
  const db = {
    ...handle("db", calls.committed),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      calls.transactions += 1;
      const pending: Array<Record<string, unknown>> = [];
      try {
        const result = await work(handle("tx", pending));
        calls.committed.push(...pending);
        return result;
      } catch (error) {
        calls.rollbacks += 1;
        throw error;
      }
    },
  };
  return { db };
});

import {
  PUBLISH_DECISION_DEFAULT_TTL_MS,
  PUBLISH_DECISION_MAX_DUE_PAGE,
  PUBLISH_DECISION_MAX_ID_LENGTH,
  PUBLISH_DECISION_MAX_NOTE_LENGTH,
  PUBLISH_DECISION_MAX_SURFACED_BYTES,
  PUBLISH_DECISION_MAX_SURFACED_DEPTH,
  PublishDecisionError,
  decide,
  insertParkedDecision,
  listDueParked,
  listSettledWithWaitingRun,
  readDecisionForRunNode,
  readLatestDecisionForRun,
  readOpenDecisionForRun,
} from "../publish-decision-store";
import { endPublishDecisionSuite } from "./__fixtures__/publish-decision-suite-teardown";

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "publish",
    gateTaskId: "task-1",
    a2aContextId: "ctx-1",
    status: "parked",
    surfacedValues: '{"what":"the post"}',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date("2026-10-31T00:00:00Z"),
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

const PARK = {
  orgId: "org-1",
  runId: "run-1",
  nodeId: "publish",
  gateTaskId: "task-1",
  a2aContextId: "ctx-1",
  surfacedValues: { what: "the post" },
};

function rendered(where: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(where as SQL);
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PublishDecisionError);
  return (error as PublishDecisionError).code;
}

beforeEach(() => {
  calls.values.length = 0;
  calls.set.length = 0;
  calls.where.length = 0;
  calls.limit.length = 0;
  calls.orderBy = 0;
  calls.transactions = 0;
  calls.rollbacks = 0;
  calls.via.length = 0;
  calls.committed.length = 0;
  answers.insert = async () => [stored()];
  answers.update = async () => [stored()];
  answers.select = async () => [];
});

describe("insertParkedDecision", () => {
  it("writes a parked row with the surfaced values as JSON text", async () => {
    const result = await insertParkedDecision(PARK);
    expect(result.inserted).toBe(true);
    expect(result.decision.surfacedValues).toEqual({ what: "the post" });
    expect(calls.values[0]).toMatchObject({
      runId: "run-1",
      nodeId: "publish",
      gateTaskId: "task-1",
      status: "parked",
      surfacedValues: '{"what":"the post"}',
    });
    expect(calls.values[0].id).toEqual(expect.any(String));
  });

  it("expires after 24 hours by default, and after the given time when one is given", async () => {
    expect(PUBLISH_DECISION_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    await insertParkedDecision(PARK);
    expect(rendered(calls.values[0].expiresAt).params).toEqual([PUBLISH_DECISION_DEFAULT_TTL_MS]);
    await insertParkedDecision({ ...PARK, ttlMs: 5 });
    expect(rendered(calls.values[1].expiresAt).params).toEqual([5]);
  });

  it("a re-delivered stop answers the existing row, even a settled one", async () => {
    answers.insert = async () => [];
    answers.select = async () => [stored({ status: "declined", decidedBy: "person-1" })];
    const result = await insertParkedDecision(PARK);
    expect(result.inserted).toBe(false);
    expect(result.decision.status).toBe("declined");
    expect(rendered(calls.where[0]).params).toEqual(["run-1", "publish", "task-1"]);
  });

  it("refuses a conflict that leaves no row", async () => {
    answers.insert = async () => [];
    expect(await codeOf(insertParkedDecision(PARK))).toBe("conflict");
  });

  it.each([
    ["an empty run id", { runId: "" }],
    ["a blank node id", { nodeId: "  " }],
    ["a missing gate task id", { gateTaskId: undefined }],
    ["an array of surfaced values", { surfacedValues: [] }],
    ["null surfaced values", { surfacedValues: null }],
    ["a zero expiry", { ttlMs: 0 }],
    ["a negative expiry", { ttlMs: -1 }],
    ["a non-finite expiry", { ttlMs: Number.POSITIVE_INFINITY }],
    ["a NaN expiry", { ttlMs: Number.NaN }],
  ])("refuses %s before any write", async (_label, patch) => {
    const input = { ...PARK, ...patch } as unknown as Parameters<typeof insertParkedDecision>[0];
    expect(await codeOf(insertParkedDecision(input))).toBe("invalid-input");
    expect(calls.values).toHaveLength(0);
  });

  it("a read error on the conflict path throws", async () => {
    answers.insert = async () => [];
    answers.select = async () => {
      throw new Error("db down");
    };
    await expect(insertParkedDecision(PARK)).rejects.toThrow("db down");
  });
});

describe("decide", () => {
  it("is one UPDATE conditional on the parked status", async () => {
    answers.update = async () => [stored({ status: "released", decidedBy: "person-1" })];
    const result = await decide("d1", { from: "parked", to: "released", actor: "person-1" });
    expect(result).toMatchObject({ outcome: "won", decision: { status: "released" } });
    const where = rendered(calls.where[0]);
    expect(where.sql).toMatch(/"id" = \$1 and .*"status" = \$2/);
    expect(where.params).toEqual(["d1", "parked"]);
    expect(calls.set[0]).toMatchObject({ status: "released", decidedBy: "person-1", decisionNote: null });
    expect(rendered(calls.set[0].decidedAt).sql).toBe("now()");
  });

  it("a winning answer is one UPDATE through the transaction, and it commits", async () => {
    answers.update = async () => [stored({ status: "released", decidedBy: "person-1" })];
    await decide("d1", { from: "parked", to: "released", actor: "person-1" });
    expect(calls.via).toEqual(["tx.update"]);
    expect(calls).toMatchObject({ transactions: 1, rollbacks: 0 });
    expect(calls.committed).toEqual([expect.objectContaining({ status: "released", decidedBy: "person-1" })]);
  });

  it("a lost answer reads the current status through the same transaction, and commits nothing", async () => {
    answers.update = async () => [];
    answers.select = async () => [stored({ status: "released" })];
    expect(await decide("d1", { from: "parked", to: "declined", actor: "person-2" })).toEqual({ outcome: "lost", currentStatus: "released" });
    expect(calls.via).toEqual(["tx.update", "tx.select"]);
    expect(calls).toMatchObject({ transactions: 1, rollbacks: 0 });
    expect(calls.committed).toEqual([]);
  });

  it.each([
    ["unreadable surfaced values", { surfacedValues: "{nope" }],
    ["an unknown status", { status: "approved" }],
  ])("a lost answer whose re-read row has %s throws inside the transaction, and the state is unchanged", async (_label, patch) => {
    answers.update = async () => [];
    answers.select = async () => [stored({ status: "released", ...patch })];
    expect(await codeOf(decide("d1", { from: "parked", to: "declined", actor: "person-2" }))).toBe("malformed-row");
    expect(calls.via).toEqual(["tx.update", "tx.select"]);
    expect(calls).toMatchObject({ transactions: 1, rollbacks: 1 });
    expect(calls.committed).toEqual([]);
  });

  it.each([
    ["unreadable surfaced values", { surfacedValues: "{nope" }],
    ["an unknown status", { status: "approved" }],
  ])("a winning UPDATE whose returned row has %s throws inside the transaction, so the answer rolls back", async (_label, patch) => {
    answers.update = async () => [stored(patch)];
    expect(await codeOf(decide("d1", { from: "parked", to: "released", actor: "person-1" }))).toBe("malformed-row");
    expect(calls.transactions).toBe(1);
    expect(calls.rollbacks).toBe(1);
    expect(calls.via).toEqual(["tx.update"]);
    expect(calls.committed).toEqual([]);
  });

  it("a decline keeps its decider and its note", async () => {
    answers.update = async () => [stored({ status: "declined" })];
    await decide("d1", { from: "parked", to: "declined", actor: "person-1", note: "not this week" });
    expect(calls.set[0]).toMatchObject({ decidedBy: "person-1", decisionNote: "not this week" });
  });

  it.each(["expired", "run_ended"] as const)("%s names no person", async (to) => {
    answers.update = async () => [stored({ status: to })];
    await decide("d1", { from: "parked", to, actor: null });
    expect(calls.set[0]).toMatchObject({ status: to, decidedBy: null, decisionNote: null });
  });

  it.each(["released", "declined", "expired", "run_ended", "parked"] as const)(
    "a late answer loses and learns the current status %s",
    async (currentStatus) => {
      answers.update = async () => [];
      answers.select = async () => [stored({ status: currentStatus })];
      expect(await decide("d1", { from: "parked", to: "declined", actor: "person-1" })).toEqual({
        outcome: "lost",
        currentStatus,
      });
    },
  );

  it("an unknown id is an error, not a lost answer", async () => {
    answers.update = async () => [];
    expect(await codeOf(decide("nope", { from: "parked", to: "expired", actor: null }))).toBe("not-found");
  });

  it.each([
    ["released with no person", { to: "released", actor: null }, "invalid-input"],
    ["declined with a blank person", { to: "declined", actor: " " }, "invalid-input"],
    ["a blank note", { to: "declined", actor: "person-1", note: "  " }, "invalid-input"],
    ["a note that is no text", { to: "declined", actor: "person-1", note: 7 }, "invalid-input"],
    ["a note on a release", { to: "released", actor: "person-1", note: "ok" }, "invalid-transition"],
    ["a person on an expiry", { to: "expired", actor: "person-1" }, "invalid-transition"],
    ["a note on an expiry", { to: "expired", actor: null, note: "late" }, "invalid-transition"],
    ["a person on a run end", { to: "run_ended", actor: "person-1" }, "invalid-transition"],
    ["back to parked", { to: "parked", actor: null }, "invalid-transition"],
    ["an unknown outcome", { to: "approved", actor: "person-1" }, "invalid-transition"],
    ["another start status", { from: "released", to: "declined", actor: "person-1" }, "invalid-transition"],
  ])("refuses %s before any write", async (_label, patch, code) => {
    const input = { from: "parked", ...patch } as unknown as Parameters<typeof decide>[1];
    expect(await codeOf(decide("d1", input))).toBe(code);
    expect(calls.set).toHaveLength(0);
  });

  it("refuses a blank id before any write", async () => {
    expect(await codeOf(decide("", { from: "parked", to: "expired", actor: null }))).toBe("invalid-input");
    expect(calls.set).toHaveLength(0);
  });

  it("a write error throws", async () => {
    answers.update = async () => {
      throw new Error("db down");
    };
    await expect(decide("d1", { from: "parked", to: "expired", actor: null })).rejects.toThrow("db down");
  });

  it("a read error after a lost answer throws", async () => {
    answers.update = async () => [];
    answers.select = async () => {
      throw new Error("db down");
    };
    await expect(decide("d1", { from: "parked", to: "expired", actor: null })).rejects.toThrow("db down");
  });
});

describe("the readers", () => {
  it("readDecisionForRunNode reads the newest row of the step, or null", async () => {
    expect(await readDecisionForRunNode("run-1", "publish")).toBeNull();
    expect(rendered(calls.where[0]).params).toEqual(["run-1", "publish"]);
    expect(calls.orderBy).toBe(1);
    answers.select = async () => [stored({ status: "expired" })];
    expect((await readDecisionForRunNode("run-1", "publish"))?.status).toBe("expired");
  });

  it("readOpenDecisionForRun asks only for the parked status", async () => {
    expect(await readOpenDecisionForRun("run-1")).toBeNull();
    expect(rendered(calls.where[0]).params).toEqual(["run-1", "parked"]);
    answers.select = async () => [stored()];
    expect((await readOpenDecisionForRun("run-1"))?.id).toBe("d1");
  });

  it("listDueParked uses the database clock unless a clock is given", async () => {
    answers.select = async () => [stored(), stored({ id: "d2" })];
    expect((await listDueParked(10)).map((r) => r.id)).toEqual(["d1", "d2"]);
    expect(rendered(calls.where[0]).sql).toContain("now()");
    expect(calls.limit).toEqual([10]);
    const now = new Date("2026-11-02T00:00:00Z");
    await listDueParked(PUBLISH_DECISION_MAX_DUE_PAGE, now);
    const atClock = rendered(calls.where[1]);
    expect(atClock.sql).not.toContain("now()");
    expect(atClock.params[0]).toBe("parked");
    expect(calls.limit[1]).toBe(PUBLISH_DECISION_MAX_DUE_PAGE);
  });

  it.each([0, -1, 1.5, Number.NaN, PUBLISH_DECISION_MAX_DUE_PAGE + 1])(
    "listDueParked refuses the limit %s",
    async (limit) => {
      expect(await codeOf(listDueParked(limit))).toBe("invalid-input");
    },
  );

  it("listDueParked refuses an invalid clock", async () => {
    expect(await codeOf(listDueParked(1, new Date("nonsense")))).toBe("invalid-input");
  });

  it.each([
    ["readDecisionForRunNode", () => readDecisionForRunNode("run-1", "publish")],
    ["readOpenDecisionForRun", () => readOpenDecisionForRun("run-1")],
    ["listDueParked", () => listDueParked(1)],
  ])("%s throws on a read error: an unreadable record never reads as none", async (_label, read) => {
    answers.select = async () => {
      throw new Error("db down");
    };
    await expect(read()).rejects.toThrow("db down");
  });

  it.each([
    ["an unknown status", { status: "approved" }],
    ["surfaced values that are not JSON", { surfacedValues: "{nope" }],
    ["surfaced values that are an array", { surfacedValues: "[]" }],
    ["surfaced values that are null", { surfacedValues: "null" }],
  ])("a stored row with %s throws", async (_label, patch) => {
    answers.select = async () => [stored(patch)];
    expect(await codeOf(readOpenDecisionForRun("run-1"))).toBe("malformed-row");
    expect(await codeOf(readDecisionForRunNode("run-1", "publish"))).toBe("malformed-row");
    expect(await codeOf(listDueParked(1))).toBe("malformed-row");
    answers.update = async () => [];
    expect(await codeOf(decide("d1", { from: "parked", to: "expired", actor: null }))).toBe("malformed-row");
  });
});

describe("cinatra#4150 SC fold: the paths and the inputs the first reading left open", () => {
  const SECRET = "SECRET-SURFACED-4150";
  const NOTE = "SECRET-NOTE-4150";
  const messageOf = async (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );

  it.each([
    ["an unknown status", { status: "approved" }],
    ["surfaced values that are not JSON", { surfacedValues: "{nope" }],
  ])("a re-delivered stop whose existing row has %s throws", async (_label, patch) => {
    answers.insert = async () => [];
    answers.select = async () => [stored(patch)];
    expect(await codeOf(insertParkedDecision(PARK))).toBe("malformed-row");
  });

  it.each([
    ["readDecisionForRunNode, a blank run id", () => readDecisionForRunNode("  ", "publish")],
    ["readDecisionForRunNode, an empty node id", () => readDecisionForRunNode("run-1", "")],
    ["readOpenDecisionForRun, an empty run id", () => readOpenDecisionForRun("")],
    ["readOpenDecisionForRun, a non-string run id", () => readOpenDecisionForRun(7 as unknown as string)],
  ])("%s is refused before any read", async (_label, read) => {
    expect(await codeOf(read())).toBe("invalid-input");
    expect(calls.where).toHaveLength(0);
  });

  it("org id and context id: null is written as null, a string is written as given", async () => {
    await insertParkedDecision({ ...PARK, orgId: null, a2aContextId: null });
    expect(calls.values[0]).toMatchObject({ orgId: null, a2aContextId: null });
    await insertParkedDecision({ ...PARK, orgId: " org-1 ", runId: " run-1 " });
    expect(calls.values[1]).toMatchObject({ orgId: " org-1 ", runId: " run-1 " });
  });

  it.each([
    ["an empty org id", { orgId: "" }],
    ["a blank context id", { a2aContextId: "   " }],
    ["an undefined org id", { orgId: undefined }],
    ["a numeric context id", { a2aContextId: 7 }],
    ["an org id over the cap", { orgId: "o".repeat(PUBLISH_DECISION_MAX_ID_LENGTH + 1) }],
    ["a run id over the cap", { runId: "r".repeat(PUBLISH_DECISION_MAX_ID_LENGTH + 1) }],
    ["surfaced values over the cap", { surfacedValues: { what: "x".repeat(PUBLISH_DECISION_MAX_SURFACED_BYTES) } }],
  ])("refuses %s before any write", async (_label, patch) => {
    const input = { ...PARK, ...patch } as unknown as Parameters<typeof insertParkedDecision>[0];
    expect(await codeOf(insertParkedDecision(input))).toBe("invalid-input");
    expect(calls.values).toHaveLength(0);
  });

  it("the caps are inclusive: an id of the cap length and surfaced values of the cap size are written", async () => {
    const runId = "r".repeat(PUBLISH_DECISION_MAX_ID_LENGTH);
    const filler = PUBLISH_DECISION_MAX_SURFACED_BYTES - JSON.stringify({ what: "" }).length;
    await insertParkedDecision({ ...PARK, runId, surfacedValues: { what: "x".repeat(filler) } });
    expect(calls.values[0].runId).toBe(runId);
    expect(Buffer.byteLength(calls.values[0].surfacedValues as string)).toBe(PUBLISH_DECISION_MAX_SURFACED_BYTES);
  });

  it("the surfaced-values cap counts bytes, not characters", async () => {
    const filler = Math.ceil(PUBLISH_DECISION_MAX_SURFACED_BYTES / 3);
    expect(await codeOf(insertParkedDecision({ ...PARK, surfacedValues: { what: "\u20ac".repeat(filler) } }))).toBe("invalid-input");
  });

  it("the actor and the note have caps, and a note at the cap is written", async () => {
    const actor = "p".repeat(PUBLISH_DECISION_MAX_ID_LENGTH + 1);
    expect(await codeOf(decide("d1", { from: "parked", to: "released", actor }))).toBe("invalid-input");
    const longNote = "n".repeat(PUBLISH_DECISION_MAX_NOTE_LENGTH + 1);
    expect(await codeOf(decide("d1", { from: "parked", to: "declined", actor: "person-1", note: longNote }))).toBe("invalid-input");
    expect(calls.set).toHaveLength(0);
    const note = "n".repeat(PUBLISH_DECISION_MAX_NOTE_LENGTH);
    await decide("d1", { from: "parked", to: "declined", actor: "person-1", note });
    expect(calls.set[0].decisionNote).toBe(note);
  });

  it("no error message carries a surfaced value or a note", async () => {
    const messages = [
      await messageOf(insertParkedDecision({ ...PARK, surfacedValues: { what: SECRET.repeat(PUBLISH_DECISION_MAX_SURFACED_BYTES) } })),
      await messageOf(decide("d1", { from: "parked", to: "released", actor: "person-1", note: NOTE })),
      await messageOf(decide("d1", { from: "parked", to: "expired", actor: null, note: NOTE })),
      await messageOf(decide("d1", { from: "parked", to: "declined", actor: "person-1", note: NOTE.repeat(PUBLISH_DECISION_MAX_NOTE_LENGTH) })),
    ];
    answers.select = async () => [stored({ surfacedValues: `{${SECRET}` })];
    messages.push(await messageOf(readOpenDecisionForRun("run-1")));
    answers.select = async () => [stored({ status: SECRET })];
    messages.push(await messageOf(readDecisionForRunNode("run-1", "publish")));
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(NOTE);
    }
  });
});

describe("cinatra#4150 review fold: surfaced values are plain JSON, errors name no id", () => {
  const ID = "SECRET-ID-4150";
  const messageOf = async (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );
  const nested = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { what: "x" };
    for (let level = 1; level < levels; level += 1) value = { value };
    return value;
  };
  const circular = (): Record<string, unknown> => {
    const value: Record<string, unknown> = { what: "x" };
    value.self = { back: value };
    return value;
  };

  it.each([
    ["a date", () => ({ when: new Date("2026-11-03T00:00:00Z") })],
    ["a date as the whole value", () => new Date("2026-11-03T00:00:00Z")],
    ["a toJSON that returns an array", () => ({ x: { toJSON: () => [1] } })],
    ["a toJSON that returns a number", () => ({ x: { toJSON: () => 5 } })],
    ["a toJSON that returns undefined", () => ({ x: { toJSON: () => undefined } })],
    ["a toJSON on the whole value", () => ({ what: "x", toJSON: () => ({ other: "y" }) })],
    ["an undefined value", () => ({ x: undefined })],
    ["an undefined array item", () => ({ x: [undefined] })],
    ["a hole in an array", () => ({ x: new Array(2) })],
    ["an array with an extra key", () => ({ x: Object.assign([1], { extra: 2 }) })],
    ["a hole and an extra key in an array", () => ({ x: Object.assign(new Array(1), { extra: 1 }) })],
    ["a circular value", circular],
    ["a BigInt", () => ({ n: BigInt(10) })],
    ["NaN", () => ({ n: Number.NaN })],
    ["an infinite number", () => ({ n: Number.NEGATIVE_INFINITY })],
    ["a function", () => ({ f: () => 1 })],
    ["a symbol", () => ({ s: Symbol("s") })],
    ["a symbol key", () => ({ what: "x", [Symbol("k")]: 1 })],
    ["a hidden key", () => Object.defineProperty({ what: "x" }, "hidden", { value: 1, enumerable: false })],
    ["a Map", () => ({ m: new Map([["a", 1]]) })],
    ["a class instance", () => ({ c: new (class Thing { a = 1 })() })],
    ["values nested deeper than the cap", () => nested(PUBLISH_DECISION_MAX_SURFACED_DEPTH + 1)],
    ["a getter that reads as a number first and as undefined after", () => {
      let reads = 0;
      return Object.defineProperty({ what: "x" }, "flip", { get: () => (reads++ === 0 ? 1 : undefined), enumerable: true });
    }],
    ["a getter that throws", () => Object.defineProperty({ what: "x" }, "boom", { get: () => { throw new Error("from the getter"); }, enumerable: true })],
    ["a proxy as the whole value", () => new Proxy({ what: "x" }, {})],
    ["a proxy inside", () => ({ p: new Proxy({ a: 1 }, {}) })],
    ["a revoked proxy", () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return { p: revocable.proxy };
    }],
    ["a revoked proxy as the whole value", () => {
      const revocable = Proxy.revocable({ what: "x" }, {});
      revocable.revoke();
      return revocable.proxy;
    }],
    ["a setter without a getter", () => Object.defineProperty({ what: "x" }, "w", { set: () => undefined, enumerable: true })],
    ["a negative zero", () => ({ n: -0 })],
    ["a negative zero in an array", () => ({ x: [0, -0] })],
  ])("refuses surfaced values with %s before any write, with a typed error", async (_label, make) => {
    const input = { ...PARK, surfacedValues: make() } as unknown as Parameters<typeof insertParkedDecision>[0];
    expect(await codeOf(insertParkedDecision(input))).toBe("invalid-input");
    expect(calls.values).toHaveLength(0);
  });

  it("writes plain JSON as it reads back: nested arrays and objects, a null-prototype object, a shared branch, the depth cap", async () => {
    const shared = { a: 1 };
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { k: "v" });
    const value = { list: [1, "two", true, null, -0.5, { deep: [shared, shared] }], bare, empty: {}, none: [] };
    expect((await insertParkedDecision({ ...PARK, surfacedValues: value })).inserted).toBe(true);
    expect(JSON.parse(calls.values[0].surfacedValues as string)).toEqual(JSON.parse(JSON.stringify(value)));
    await insertParkedDecision({ ...PARK, surfacedValues: nested(PUBLISH_DECISION_MAX_SURFACED_DEPTH) });
    expect(calls.values).toHaveLength(2);
  });

  it("writes a positive zero, the keys in JSON's own order, and the depth cap as the exact same text", async () => {
    await insertParkedDecision({ ...PARK, surfacedValues: { n: 0 } });
    expect(calls.values[0].surfacedValues).toBe('{"n":0}');
    const ordered = { b: 1, a: [1, { z: 1, y: 2 }], "2": "two", "1": "one" };
    await insertParkedDecision({ ...PARK, surfacedValues: ordered });
    expect(calls.values[1].surfacedValues).toBe(JSON.stringify(ordered));
    expect(calls.values[1].surfacedValues).toBe('{"1":"one","2":"two","b":1,"a":[1,{"z":1,"y":2}]}');
    const deepest = nested(PUBLISH_DECISION_MAX_SURFACED_DEPTH);
    await insertParkedDecision({ ...PARK, surfacedValues: deepest });
    expect(calls.values[2].surfacedValues).toBe(JSON.stringify(deepest));
    expect(JSON.parse(calls.values[2].surfacedValues as string)).toEqual(deepest);
  });

  it("refuses an array or object whose prototype is a proxy, and no trap runs", async () => {
    let traps = 0;
    const handler = new Proxy({}, { get: () => { traps += 1; return undefined; } }); // counts every trap looked up
    const values = [
      { x: Object.setPrototypeOf([1], new Proxy(Array.prototype, handler)) as unknown[] },
      { x: Object.setPrototypeOf({ a: 1 }, new Proxy({}, handler)) as Record<string, unknown> },
      Object.setPrototypeOf({ what: "x" }, new Proxy({}, handler)) as Record<string, unknown>,
      new Proxy({ what: "x" }, handler),
    ];
    for (const value of values) expect(await codeOf(insertParkedDecision({ ...PARK, surfacedValues: value }))).toBe("invalid-input");
    expect(traps).toBe(0);
    expect(calls.values).toHaveLength(0);
  });

  it("an error the value or the serializer throws never passes as the store's own, even a PublishDecisionError", async () => {
    const foreign = new PublishDecisionError("conflict", "text-from-the-value");
    const trapped = { x: Object.setPrototypeOf([1], new Proxy(Array.prototype, { has: () => { throw foreign; } })) as unknown[] };
    const fromTrap = insertParkedDecision({ ...PARK, surfacedValues: trapped });
    expect(await codeOf(fromTrap)).toBe("invalid-input");
    expect(await messageOf(fromTrap)).not.toContain("text-from-the-value");
    for (const thrown of [foreign, new Error("text-from-the-serializer")]) {
      const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw thrown; });
      const work = insertParkedDecision({ ...PARK, surfacedValues: { what: "x" } }); // runs to the serializer before its first await
      spy.mockRestore();
      expect(await codeOf(work)).toBe("invalid-input");
      expect(await messageOf(work)).toBe("surfacedValues could not be read as plain data");
    }
    expect(calls.values).toHaveLength(0);
  });

  it("reads no getter, and a getter's error text never reaches the message", async () => {
    let reads = 0;
    const counted = Object.defineProperty({ what: "x" }, "n", { get: () => { reads += 1; return 1; }, enumerable: true });
    expect(await codeOf(insertParkedDecision({ ...PARK, surfacedValues: counted }))).toBe("invalid-input");
    expect(reads).toBe(0);
    const throwing = Object.defineProperty({ what: "x" }, "boom", { get: () => { throw new Error("text-from-the-getter"); }, enumerable: true });
    expect(await messageOf(insertParkedDecision({ ...PARK, surfacedValues: throwing }))).not.toContain("text-from-the-getter");
    expect(calls.values).toHaveLength(0);
  });

  it("no error message carries an id", async () => {
    const messages: string[] = [];
    answers.insert = async () => [];
    messages.push(await messageOf(insertParkedDecision({ ...PARK, runId: ID, nodeId: `${ID}-node`, gateTaskId: `${ID}-task` })));
    messages.push(await messageOf(insertParkedDecision({ ...PARK, runId: ID.repeat(PUBLISH_DECISION_MAX_ID_LENGTH) })));
    answers.select = async () => [stored({ id: ID, status: "approved" })];
    messages.push(await messageOf(insertParkedDecision(PARK)));
    messages.push(await messageOf(readOpenDecisionForRun("run-1")));
    answers.select = async () => [stored({ id: ID, surfacedValues: "{nope" })];
    messages.push(await messageOf(readDecisionForRunNode("run-1", "publish")));
    messages.push(await messageOf(listDueParked(1)));
    answers.update = async () => [stored({ id: ID, surfacedValues: "[]" })];
    messages.push(await messageOf(decide(ID, { from: "parked", to: "released", actor: "person-1" })));
    answers.update = async () => [];
    answers.select = async () => [];
    messages.push(await messageOf(decide(ID, { from: "parked", to: "expired", actor: null })));
    messages.push(await messageOf(decide("d1", { from: "parked", to: "released", actor: ID.repeat(PUBLISH_DECISION_MAX_ID_LENGTH) })));
    expect(messages).toHaveLength(9);
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain(ID);
    }
  });
});

describe("the integration file's teardown (publish-decision-suite-teardown)", () => {
  const shared = globalThis as { __cinatraAgentBuilderPool?: unknown; __cinatraPostgresSchemaInitialized?: boolean };

  it.each([
    ["a schema setting that was set", "cinatra_before_4150"],
    ["no schema setting", undefined],
  ])("restores %s, clears the global pool, closes everything and reports a failed drop", async (_label, priorSchema) => {
    const outer = process.env.SUPABASE_SCHEMA;
    const ended: string[] = [];
    try {
      process.env.SUPABASE_SCHEMA = "cinatra_test_publish_decision_4150";
      shared.__cinatraAgentBuilderPool = { ended: true };
      shared.__cinatraPostgresSchemaInitialized = true;
      await expect(
        endPublishDecisionSuite({
          pool: { end: async () => ended.push("pool") },
          admin: {
            query: async () => {
              throw new Error("drop schema failed");
            },
            end: async () => ended.push("admin"),
          },
          dropSchemaSql: "DROP SCHEMA IF EXISTS x CASCADE",
          priorSchema,
        }),
      ).rejects.toThrow("drop schema failed");
      expect(ended).toEqual(["pool", "admin"]);
      expect(process.env.SUPABASE_SCHEMA).toBe(priorSchema);
      expect("SUPABASE_SCHEMA" in process.env).toBe(priorSchema !== undefined);
      expect(shared.__cinatraAgentBuilderPool).toBeUndefined();
      expect(shared.__cinatraPostgresSchemaInitialized).toBeUndefined();
    } finally {
      if (outer === undefined) delete process.env.SUPABASE_SCHEMA;
      else process.env.SUPABASE_SCHEMA = outer;
      delete shared.__cinatraAgentBuilderPool;
      delete shared.__cinatraPostgresSchemaInitialized;
    }
  });

  // Each case below sets the shared state the teardown clears and puts it back after.
  async function withSharedState(run: () => Promise<void>): Promise<void> {
    const outer = process.env.SUPABASE_SCHEMA;
    try {
      process.env.SUPABASE_SCHEMA = "cinatra_test_publish_decision_4150";
      shared.__cinatraAgentBuilderPool = { ended: true };
      shared.__cinatraPostgresSchemaInitialized = true;
      await run();
    } finally {
      if (outer === undefined) delete process.env.SUPABASE_SCHEMA;
      else process.env.SUPABASE_SCHEMA = outer;
      delete shared.__cinatraAgentBuilderPool;
      delete shared.__cinatraPostgresSchemaInitialized;
    }
  }

  it("with no pool (setup failed before the pool), still clears the shared state, drops the schema and closes the admin client", async () => {
    await withSharedState(async () => {
      const done: string[] = [];
      await expect(
        endPublishDecisionSuite({
          pool: undefined,
          admin: {
            query: async (text: string) => done.push(`query ${text}`),
            end: async () => done.push("admin"),
          },
          dropSchemaSql: "DROP SCHEMA IF EXISTS x CASCADE",
          priorSchema: undefined,
        }),
      ).resolves.toBeUndefined();
      expect(done).toEqual(["query DROP SCHEMA IF EXISTS x CASCADE", "admin"]);
      expect("SUPABASE_SCHEMA" in process.env).toBe(false);
      expect(shared.__cinatraAgentBuilderPool).toBeUndefined();
      expect(shared.__cinatraPostgresSchemaInitialized).toBeUndefined();
    });
  });

  it("with no admin client, ends the pool and clears the shared state, then fails because the schema was not dropped", async () => {
    await withSharedState(async () => {
      const done: string[] = [];
      await expect(
        endPublishDecisionSuite({
          pool: { end: async () => done.push("pool") },
          admin: undefined,
          dropSchemaSql: "DROP SCHEMA IF EXISTS x CASCADE",
          priorSchema: "cinatra_before_4150",
        }),
      ).rejects.toThrow("no admin client to drop the schema");
      expect(done).toEqual(["pool"]);
      expect(process.env.SUPABASE_SCHEMA).toBe("cinatra_before_4150");
      expect(shared.__cinatraAgentBuilderPool).toBeUndefined();
      expect(shared.__cinatraPostgresSchemaInitialized).toBeUndefined();
    });
  });

  it("when ending the pool fails, still runs every later step, then fails", async () => {
    await withSharedState(async () => {
      const done: string[] = [];
      await expect(
        endPublishDecisionSuite({
          pool: {
            end: async () => {
              throw new Error("pool end failed");
            },
          },
          admin: {
            query: async (text: string) => done.push(`query ${text}`),
            end: async () => done.push("admin"),
          },
          dropSchemaSql: "DROP SCHEMA IF EXISTS x CASCADE",
          priorSchema: undefined,
        }),
      ).rejects.toThrow("pool end failed");
      expect(done).toEqual(["query DROP SCHEMA IF EXISTS x CASCADE", "admin"]);
      expect("SUPABASE_SCHEMA" in process.env).toBe(false);
      expect(shared.__cinatraAgentBuilderPool).toBeUndefined();
      expect(shared.__cinatraPostgresSchemaInitialized).toBeUndefined();
    });
  });

  it("when restoring the schema setting fails, still drops the schema and closes the admin client, then fails", async () => {
    await withSharedState(async () => {
      const done: string[] = [];
      // process.env turns the value into a string; this one refuses, so the restore step throws.
      const unrestorable = {
        toString(): string {
          throw new Error("restore failed");
        },
      } as unknown as string;
      await expect(
        endPublishDecisionSuite({
          pool: { end: async () => done.push("pool") },
          admin: {
            query: async (text: string) => done.push(`query ${text}`),
            end: async () => done.push("admin"),
          },
          dropSchemaSql: "DROP SCHEMA IF EXISTS x CASCADE",
          priorSchema: unrestorable,
        }),
      ).rejects.toThrow("restore failed");
      expect(done).toEqual(["pool", "query DROP SCHEMA IF EXISTS x CASCADE", "admin"]);
      expect(shared.__cinatraAgentBuilderPool).toBeUndefined();
      expect(shared.__cinatraPostgresSchemaInitialized).toBeUndefined();
    });
  });
});

describe("cinatra#4150 PR 3a: the newest decision of a run, the one every resume road reads", () => {
  it("asks for the run only, newest first, one row, and answers it whatever its status", async () => {
    expect(await readLatestDecisionForRun("run-1")).toBeNull();
    expect(rendered(calls.where[0]).params).toEqual(["run-1"]);
    expect(calls.orderBy).toBe(1);
    expect(calls.limit).toEqual([1]);
    for (const status of ["parked", "released", "declined", "expired", "run_ended"]) {
      answers.select = async () => [stored({ status })];
      expect((await readLatestDecisionForRun("run-1"))?.status).toBe(status);
    }
  });

  it("refuses an empty run id, throws on a read error and on a malformed row", async () => {
    expect(await codeOf(readLatestDecisionForRun(""))).toBe("invalid-input");
    answers.select = async () => [stored({ status: "approved" })];
    expect(await codeOf(readLatestDecisionForRun("run-1"))).toBe("malformed-row");
    answers.select = async () => {
      throw new Error("db down");
    };
    await expect(readLatestDecisionForRun("run-1")).rejects.toThrow("db down");
  });
});

describe("cinatra#4150 PR 3a: the stops a decline or an expiry decided but did not make", () => {
  it("joins the run and asks for declined or expired decisions whose run is in pending_approval", async () => {
    answers.select = async () => [{ decision: stored({ id: "d1", status: "declined" }) }, { decision: stored({ id: "d2", status: "expired" }) }];
    const rows = await listSettledWithWaitingRun(50);
    expect(rows.map((r) => [r.id, r.status])).toEqual([["d1", "declined"], ["d2", "expired"]]);
    expect(rows[0]!.surfacedValues).toEqual({ what: "the post" });
    expect(calls.via).toEqual(["db.select", "db.innerJoin"]);
    expect(rendered(calls.where[0]).params).toEqual(["declined", "expired", "pending_approval"]);
    expect(calls.orderBy).toBe(1);
    expect(calls.limit).toEqual([50]);
  });

  it.each([0, PUBLISH_DECISION_MAX_DUE_PAGE + 1, 1.5])("refuses the limit %s before any read", async (limit) => {
    expect(await codeOf(listSettledWithWaitingRun(limit))).toBe("invalid-input");
    expect(calls.via).toEqual([]);
  });

  it("throws on a malformed row and on a read error", async () => {
    answers.select = async () => [{ decision: stored({ status: "approved" }) }];
    expect(await codeOf(listSettledWithWaitingRun(1))).toBe("malformed-row");
    answers.select = async () => {
      throw new Error("db down");
    };
    await expect(listSettledWithWaitingRun(1)).rejects.toThrow("db down");
  });
});
