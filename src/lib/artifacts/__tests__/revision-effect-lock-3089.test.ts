/**
 * cinatra#3089 — an effect of a bound revision starts only at a moment the
 * revision was verified, under the lock every revision writer takes.
 *
 * Every writer that appends a revision to an existing artifact holds
 * `pg_advisory_xact_lock(hashtext(<artifact id>))` for its transaction. The
 * claim of an effect with a verification runs in ONE transaction that holds the
 * SHARED form of that lock, inserts the claim row, runs the verification and
 * commits only when it passes. An append and a claim therefore never overlap:
 * an append committed first makes the verification refuse (nothing is
 * performed); an append that comes later waits until the claim committed, so
 * the effect started at a moment the verified revision was current.
 *
 * Proven over a small transactional database double: connections with BEGIN,
 * COMMIT and ROLLBACK (writes visible to others only at COMMIT) and advisory
 * locks with Postgres's shared and exclusive compatibility (a waiter blocks
 * until the holder's transaction ends), driving the shipped ledger SQL.
 *
 * Cases:
 *   K1 an append that holds the lock first: the claim waits, then its
 *      verification sees the new revision and refuses; no claim row, nothing
 *      performed
 *   K2 a claim that holds the lock first: the append waits until the claim
 *      committed; the effect is performed with the revision verified current
 *   K3 a verification that throws leaves no claim row and performs nothing
 *   K4 a claim of an effect done earlier answers done without a verification
 */
import { describe, expect, it, vi } from "vitest";

type LedgerRow = { id: string; org_id: string; run_id: string; output_id: string; path: string; extension: string; content_hash: string; artifact_id: string; representation_revision_id: string; phase: string };

const { db } = vi.hoisted(() => {
  type Tx = { ledger: LedgerRow[]; reps: Array<{ artifactId: string; id: string }>; locks: string[] };
  const state = {
    ledger: [] as LedgerRow[],
    reps: new Map<string, string[]>(),
    locks: new Map<string, { mode: "S" | "X"; holders: Set<object> }>(),
    waiters: [] as Array<() => void>,
    events: [] as string[],
  };
  const wake = () => state.waiters.splice(0).forEach((w) => w());
  async function acquire(owner: object, key: string, mode: "S" | "X") {
    for (;;) {
      const held = state.locks.get(key);
      const others = held ? [...held.holders].filter((h) => h !== owner) : [];
      if (others.length === 0 || (mode === "S" && held!.mode === "S")) {
        if (!held || others.length === 0) state.locks.set(key, { mode, holders: new Set([owner]) });
        else held.holders.add(owner);
        return;
      }
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
  }
  function releaseAll(owner: object) {
    for (const [key, held] of state.locks) {
      held.holders.delete(owner);
      if (held.holders.size === 0) state.locks.delete(key);
    }
    wake();
  }
  const key = (r: Pick<LedgerRow, "run_id" | "output_id" | "extension" | "content_hash">) => [r.run_id, r.output_id, r.extension, r.content_hash].join("|");
  function run(owner: object, tx: Tx | null, sql: string, p: unknown[]) {
    const v = (n: number) => p[n - 1] as string;
    const ledger = tx ? [...state.ledger, ...tx.ledger] : state.ledger;
    if (/WITH bound AS/.test(sql)) {
      const bound = state.ledger.find(
        (r) => r.org_id === v(2) && r.run_id === v(3) && r.output_id === v(4) && r.path === v(5) && r.phase === "finalized" && r.artifact_id === v(6) && r.representation_revision_id === v(7) && !(r.extension === v(8) && r.content_hash === v(8)),
      );
      if (!bound) return { rows: [] };
      const row = { ...bound, id: v(1), extension: v(8), content_hash: v(8), phase: "claimed" };
      if (ledger.some((r) => key(r) === key(row))) return { rows: [] };
      (tx ? tx.ledger : state.ledger).push(row);
      return { rows: [{ id: v(1) }] };
    }
    if (/^SELECT phase FROM/.test(sql.trim()) && /output_id = \$3/.test(sql)) {
      const row = ledger.find((r) => r.org_id === v(1) && r.run_id === v(2) && r.output_id === v(3) && r.path === v(4) && r.extension === v(5) && r.content_hash === v(5));
      return { rows: row ? [{ phase: row.phase }] : [] };
    }
    if (/SET phase = 'finalized'/.test(sql)) {
      const row = state.ledger.find((r) => r.id === v(1) && r.phase === "claimed");
      if (!row) return { rows: [] };
      row.phase = "finalized";
      return { rows: [{ id: row.id }] };
    }
    if (/^DELETE FROM/.test(sql.trim())) {
      state.ledger = state.ledger.filter((r) => !(r.id === v(1) && r.phase === "claimed"));
      return { rows: [] };
    }
    if (/^SELECT latest FROM revisions/.test(sql)) {
      const committed = state.reps.get(v(1)) ?? [];
      return { rows: [{ latest: committed.at(-1) ?? null }] };
    }
    if (/^INSERT INTO revisions/.test(sql)) {
      tx!.reps.push({ artifactId: v(1), id: v(2) });
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
  function client() {
    const owner = {};
    let tx: Tx | null = null;
    return {
      async query(sql: string, p: unknown[] = []) {
        const text = sql.trim();
        if (text === "BEGIN") {
          tx = { ledger: [], reps: [], locks: [] };
          return { rows: [] };
        }
        if (text === "COMMIT" || text === "ROLLBACK") {
          if (tx && text === "COMMIT") {
            state.ledger.push(...tx.ledger);
            for (const r of tx.reps) state.reps.set(r.artifactId, [...(state.reps.get(r.artifactId) ?? []), r.id]);
            state.events.push(`commit ${tx.reps.length ? "append" : tx.ledger.length ? "claim" : "empty"}`);
          }
          tx = null;
          releaseAll(owner);
          return { rows: [] };
        }
        const lock = /pg_advisory_xact_lock(_shared)?\(hashtext\(\$1\)\)/.exec(text);
        if (lock) {
          await acquire(owner, p[0] as string, lock[1] ? "S" : "X");
          return { rows: [] };
        }
        return run(owner, tx, sql, p);
      },
      release() {},
    };
  }
  return {
    db: {
      state,
      client,
      pool: { query: (sql: string, p: unknown[]) => Promise.resolve(run({}, null, sql, p)), connect: async () => client() },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => db.pool,
}));
vi.mock("@/lib/postgres-config", () => ({ getPostgresConnectionString: () => "postgres://test", postgresSchema: "public" }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));

import { performRevisionEffectOnce, type RevisionEffectClaimKey } from "../materialization-ledger";

const KEY: RevisionEffectClaimKey = {
  runId: "run-1",
  path: "email_fanout",
  bindingOutputId: "out-1",
  effect: "message-send",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
};
const actor = { actorType: "human", source: "route", userId: "u", sessionId: "s", orgId: "org-1" } as never;

function reset() {
  db.state.ledger = [
    { id: "bind-1", org_id: "org-1", run_id: "run-1", output_id: "out-1", path: "email_fanout", extension: "@cinatra-ai/pack", content_hash: "h", artifact_id: "art-1", representation_revision_id: "rev-1", phase: "finalized" },
  ];
  db.state.reps = new Map([["art-1", ["rev-1"]]]);
  db.state.locks.clear();
  db.state.events.length = 0;
}

/** The verification: the artifact's newest revision must be the one bound. */
const stillCurrent = async (query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => {
  const { rows } = await query("SELECT latest FROM revisions WHERE artifact_id = $1", [KEY.artifactId]);
  return rows[0]?.latest === KEY.representationRevisionId ? null : `revision ${KEY.representationRevisionId} is not current (${String(rows[0]?.latest)})`;
};

/** An appender: the exclusive lock, a new revision, held until `commit`. */
async function beginAppend(revisionId: string) {
  const c = db.client();
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["art-1"]);
  await c.query("INSERT INTO revisions VALUES ($1, $2)", ["art-1", revisionId]);
  return { commit: () => c.query("COMMIT") };
}

const turns = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("cinatra#3089 — the claim of an effect is verified under the revision writers' lock", () => {
  it("K1 an append holding the lock first makes the waiting claim refuse; nothing is performed", async () => {
    reset();
    const append = await beginAppend("rev-2");
    const act = vi.fn(async () => "mailed");
    const outcome = performRevisionEffectOnce({ claimKey: KEY, actor, act, verifyUnderLock: stillCurrent });
    await turns();
    expect(act).not.toHaveBeenCalled();
    await append.commit();
    const result = await outcome;
    expect(act).not.toHaveBeenCalled();
    // red-first-expect: performRevisionEffectOnce is not a function
    expect(result).toMatchObject({ done: false, alreadyDone: false, failure: { stage: "refused" } });
    expect(result.failure?.reason).toContain("is not current (rev-2)");
    expect(db.state.ledger.filter((r) => r.extension === "message-send")).toEqual([]);
  });

  it("K2 a claim holding the lock first makes the append wait; the effect starts with the verified revision current", async () => {
    reset();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const verify = async (query: Parameters<typeof stillCurrent>[0]) => {
      const answer = await stillCurrent(query);
      await paused;
      return answer;
    };
    const act = vi.fn(async () => {
      db.state.events.push("act");
      return "mailed";
    });
    const outcome = performRevisionEffectOnce({ claimKey: KEY, actor, act, verifyUnderLock: verify });
    await turns();
    let appended = false;
    const append = beginAppend("rev-2").then(async (a) => {
      await a.commit();
      appended = true;
    });
    await turns();
    // The append waits on the lock the claim holds.
    // red-first-expect: performRevisionEffectOnce is not a function
    expect(appended).toBe(false);
    resume();
    const result = await outcome;
    await append;
    expect(result).toMatchObject({ done: true, alreadyDone: false });
    expect(act).toHaveBeenCalledTimes(1);
    expect(db.state.events.slice(0, 2)).toEqual(["commit claim", "act"]);
    expect(db.state.events).toContain("commit append");
    expect(db.state.ledger.find((r) => r.extension === "message-send")?.phase).toBe("finalized");
  });

  it("K3 a verification that throws leaves no claim row and performs nothing", async () => {
    reset();
    const act = vi.fn(async () => "mailed");
    const result = await performRevisionEffectOnce({
      claimKey: KEY,
      actor,
      act,
      verifyUnderLock: async () => {
        throw new Error("the decision state could not be read");
      },
    });
    expect(act).not.toHaveBeenCalled();
    // red-first-expect: performRevisionEffectOnce is not a function
    expect(result).toMatchObject({ done: false, failure: { stage: "claim" } });
    expect(db.state.ledger.filter((r) => r.extension === "message-send")).toEqual([]);
    expect(db.state.locks.size).toBe(0);
  });

  it("K4 a claim of an effect done earlier answers done and runs no verification", async () => {
    reset();
    await performRevisionEffectOnce({ claimKey: KEY, actor, act: async () => "mailed", verifyUnderLock: stillCurrent });
    const verify = vi.fn(stillCurrent);
    db.state.reps.set("art-1", ["rev-1", "rev-2"]);
    const again = await performRevisionEffectOnce({ claimKey: KEY, actor, act: async () => "mailed", verifyUnderLock: verify });
    // red-first-expect: performRevisionEffectOnce is not a function
    expect(again).toMatchObject({ done: false, alreadyDone: true });
    expect(verify).not.toHaveBeenCalled();
  });
});
