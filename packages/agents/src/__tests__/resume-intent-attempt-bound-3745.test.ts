/**
 * cinatra#3745 with cinatra#4312: a resume intent's attempts stay bounded when
 * its delivery claimed the run.
 *
 * Each claim of an intent uses one of its attempts, whatever the delivery then
 * returns (cinatra#4312). The claim leaves out an intent that used them, and the
 * dead-letter pass takes it for ops. This file reads the predicates and the
 * write the real gate store builds, through a double of the database, and
 * proves that the claim makes no exception for an intent whose delivery
 * claimed the run (`run_claimed_at`), that a deferral does not give its
 * attempt back, and that such an intent, once it used its attempts with its
 * mark still set, is settled under its own lease (the run goes back on its
 * gate first) instead of a bare dead letter. The same rules against Postgres:
 * resume-intent-run-edge-claim-3745.integration.test.ts and
 * resume-delivery-claim-3745.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const rec = vi.hoisted(() => ({
  /** Every `where` the store passed, in call order. */
  wheres: [] as unknown[],
  /** Every `set` the store passed, in call order. */
  sets: [] as Array<Record<string, unknown>>,
  /** The rows an UPDATE ... RETURNING answers. */
  updated: [] as unknown[],
  /** The candidate rows a locking read (`FOR UPDATE SKIP LOCKED`) answers. */
  candidates: [] as unknown[],
}));

vi.mock("../db", () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: (w: unknown) => {
        rec.wheres.push(w);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      // The candidates of a locking read: none unless a case names them.
      for: async () => rec.candidates,
    });
    return chain;
  };
  const update = () => ({
    set: (v: Record<string, unknown>) => {
      rec.sets.push(v);
      return {
        where: (w: unknown) => {
          rec.wheres.push(w);
          return { returning: async () => rec.updated };
        },
      };
    },
  });
  const handle = { select, update };
  return {
    db: { ...handle, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(handle) },
    agentBuilderPool: {},
  };
});
vi.mock("../store", () => ({ readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn(), readRunCoOwners: vi.fn() }));
vi.mock("../run-transition", () => ({ transitionRunStatus: () => { throw new Error("no run transition in this test"); } }));
vi.mock("../auth-policy", () => ({ enforceRunAccess: () => { throw new Error("no access check in this test"); }, resolveEffectivePolicy: () => { throw new Error("no policy read in this test"); } }));

import {
  claimPendingResumeIntents,
  deadLetterExhaustedResumeIntents,
  deadLetterResumeIntentUnderLease,
  deferResumeIntent,
  fenceResumeIntentLeaseInRunTx,
  leaseExhaustedResumeClaims,
} from "../artifact-review-gate-store";
import { db } from "../db";

const dialect = new PgDialect();
function rendered(where: unknown): string {
  return dialect.sqlToQuery(sql`${where as SQL}`).sql;
}

/** `attempts` against `max_attempts`, whatever schema and table name the columns render with. */
const ATTEMPTS_BELOW_MAX = /"attempts" < (?:"[^"]+"\.)*"max_attempts"/;
const ATTEMPTS_USED = /"attempts" >= (?:"[^"]+"\.)*"max_attempts"/;
const CLAIM_MARK = /"run_claimed_at" is (?:not )?null/;

beforeEach(() => {
  rec.wheres.length = 0;
  rec.sets.length = 0;
  rec.updated = [];
  rec.candidates = [];
});

describe("cinatra#3745: a claimed resume intent keeps the cinatra#4312 attempt bound", () => {
  it("the claim leaves out every intent that used its attempts, a claimed one included", async () => {
    expect(await claimPendingResumeIntents({ limit: 1, leaseMs: 60_000 })).toEqual([]);
    expect(rec.wheres).toHaveLength(1);
    const where = rendered(rec.wheres[0]);
    expect(where).toMatch(ATTEMPTS_BELOW_MAX);
    expect(where).not.toMatch(CLAIM_MARK);
  });

  it("S1 the dead-letter pass takes every intent that used its attempts, but one whose delivery still holds the run", async () => {
    expect(await deadLetterExhaustedResumeIntents()).toBe(0);
    // The eligibility predicate: the candidate read's, then the same one under the UPDATE.
    expect(rec.wheres).toHaveLength(2);
    for (const where of rec.wheres.map(rendered)) {
      expect(where).toMatch(ATTEMPTS_USED);
      // The settle leases a claimed one and dead-letters it after it put the run back.
      expect(where).toMatch(/"run_claimed_at" is null/);
    }
  });

  it("a deferral keeps the claim's attempt used: it writes no attempt count", async () => {
    rec.updated = [{ gateId: "gate-1" }];
    expect(await deferResumeIntent("gate-1", "lease-1")).toBe(true);
    expect(rec.sets).toHaveLength(1);
    expect(Object.keys(rec.sets[0]!)).not.toContain("attempts");
    // Only under the held lease.
    const where = rendered(rec.wheres[0]);
    expect(where).toMatch(/"lease_token" = \$\d+/);
    expect(where).toMatch(/"dead_lettered_at" is null/);
  });

  it("a deferral whose lease is gone writes nothing and reports false", async () => {
    rec.updated = [];
    expect(await deferResumeIntent("gate-1", "lease-gone")).toBe(false);
  });
});

describe("cinatra#3745: a release under the lease needs the claim mark still set", () => {
  const fence = (claimMark: "claim" | "release" | "none") =>
    fenceResumeIntentLeaseInRunTx(db as never, { runId: "run-1", gateId: "gate-1", leaseToken: "lease-1", claimMark });

  it("F1 the release fences on run_claimed_at being set; the claim and a fence-only edge do not", async () => {
    rec.updated = [{ gateId: "gate-1" }];
    expect(await fence("release")).toBe(true);
    expect(await fence("claim")).toBe(true);
    expect(await fence("none")).toBe(true);
    expect(rec.wheres).toHaveLength(3);
    const [release, claim, none] = rec.wheres.map(rendered);
    expect(release).toMatch(/"run_claimed_at" is not null/);
    expect(release).toMatch(/"lease_token" = \$\d+/);
    expect(claim).not.toMatch(CLAIM_MARK);
    expect(none).not.toMatch(CLAIM_MARK);
  });
});

describe("cinatra#3745: a claimed intent that used its attempts is settled under its own lease", () => {
  const ROW = {
    gateId: "gate-1", runId: "run-1", reviewTaskId: "wayflow-task-1", kind: "approve", responseText: "{}",
    status: "delivering", attempts: 20, maxAttempts: 20, leaseToken: "lease-new", leaseExpiresAt: new Date(),
    runClaimedAt: new Date(), resumeTaskResult: null,
  };

  it("S1 the settle lease takes only a claimed, exhausted, delivering intent with no live lease, and uses no attempt", async () => {
    rec.candidates = [{ gateId: "gate-1" }];
    rec.updated = [ROW];
    const rows = await leaseExhaustedResumeClaims({ limit: 5, leaseMs: 60_000 });
    expect(rows.map((r) => [r.gateId, r.leaseToken, r.finalAttempt])).toEqual([["gate-1", "lease-new", true]]);
    const where = rendered(rec.wheres[0]);
    expect(where).toMatch(/"run_claimed_at" is not null/);
    expect(where).toMatch(ATTEMPTS_USED);
    expect(where).toMatch(/"dead_lettered_at" is null/);
    expect(where).toMatch(/"status" = \$\d+/);
    expect(where).toMatch(/"lease_expires_at" is null or .*"lease_expires_at" <= now\(\)/);
    expect(rec.sets).toHaveLength(1);
    expect(Object.keys(rec.sets[0]!).sort()).toEqual(["leaseExpiresAt", "leaseToken", "updatedAt"]);
  });

  it("S1 the settle's dead letter writes only under the held lease", async () => {
    rec.updated = [{ gateId: "gate-1" }];
    expect(await deadLetterResumeIntentUnderLease("gate-1", "lease-1", "why")).toBe(true);
    expect(Object.keys(rec.sets[0]!).sort()).toEqual(["deadLetteredAt", "lastError", "updatedAt"]);
    const where = rendered(rec.wheres[0]);
    expect(where).toMatch(/"lease_token" = \$\d+/);
    expect(where).toMatch(/"dead_lettered_at" is null/);
    rec.updated = [];
    expect(await deadLetterResumeIntentUnderLease("gate-1", "lease-gone", "why")).toBe(false);
  });
});
