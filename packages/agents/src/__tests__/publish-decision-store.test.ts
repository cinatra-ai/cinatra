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
  },
  answers: {
    insert: async (): Promise<unknown[]> => [],
    update: async (): Promise<unknown[]> => [],
    select: async (): Promise<unknown[]> => [],
  },
}));

vi.mock("../db", () => {
  const db: Record<string, unknown> = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        calls.values.push(v);
        return { onConflictDoNothing: () => ({ returning: () => answers.insert() }) };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        calls.set.push(v);
        return {
          where: (w: unknown) => {
            calls.where.push(w);
            return { returning: () => answers.update() };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
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
        },
      }),
    }),
  };
  // The double's transaction runs the work on the same double and counts a throw out of it
  // as a rollback, the way drizzle's transaction rolls back on a throw.
  db.transaction = async (work: (tx: unknown) => Promise<unknown>) => {
    calls.transactions += 1;
    try {
      return await work(db);
    } catch (error) {
      calls.rollbacks += 1;
      throw error;
    }
  };
  return { db };
});

import {
  PUBLISH_DECISION_DEFAULT_TTL_MS,
  PUBLISH_DECISION_MAX_DUE_PAGE,
  PUBLISH_DECISION_MAX_ID_LENGTH,
  PUBLISH_DECISION_MAX_NOTE_LENGTH,
  PUBLISH_DECISION_MAX_SURFACED_BYTES,
  PublishDecisionError,
  decide,
  insertParkedDecision,
  listDueParked,
  readDecisionForRunNode,
  readOpenDecisionForRun,
} from "../publish-decision-store";

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

  it("the conditional UPDATE and the read after a lost answer run in one transaction", async () => {
    await decide("d1", { from: "parked", to: "released", actor: "person-1" });
    answers.update = async () => [];
    answers.select = async () => [stored({ status: "released" })];
    await decide("d1", { from: "parked", to: "declined", actor: "person-2" });
    expect(calls.transactions).toBe(2);
    expect(calls.rollbacks).toBe(0);
  });

  it.each([
    ["unreadable surfaced values", { surfacedValues: "{nope" }],
    ["an unknown status", { status: "approved" }],
  ])("a winning UPDATE whose returned row has %s throws inside the transaction, so the answer rolls back", async (_label, patch) => {
    answers.update = async () => [stored(patch)];
    expect(await codeOf(decide("d1", { from: "parked", to: "released", actor: "person-1" }))).toBe("malformed-row");
    expect(calls.transactions).toBe(1);
    expect(calls.rollbacks).toBe(1);
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
