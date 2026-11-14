/**
 * cinatra#3745 with cinatra#4312: a resume intent's attempts stay bounded when
 * its delivery claimed the run.
 *
 * Each claim of an intent uses one of its attempts, whatever the delivery then
 * returns (cinatra#4312). The claim leaves out an intent that used them, and the
 * dead-letter pass takes it for ops. This file reads the predicates and the
 * write the real gate store builds, through a double of the database, and
 * proves that none of them makes an exception for an intent whose delivery
 * claimed the run (`run_claimed_at`), and that a deferral does not give its
 * attempt back. The same rules against Postgres:
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
      // The claim's candidates: none, so the claim writes nothing.
      for: async () => [],
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
  deferResumeIntent,
  fenceResumeIntentLeaseInRunTx,
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
});

describe("cinatra#3745: a claimed resume intent keeps the cinatra#4312 attempt bound", () => {
  it("the claim leaves out every intent that used its attempts, a claimed one included", async () => {
    expect(await claimPendingResumeIntents({ limit: 1, leaseMs: 60_000 })).toEqual([]);
    expect(rec.wheres).toHaveLength(1);
    const where = rendered(rec.wheres[0]);
    expect(where).toMatch(ATTEMPTS_BELOW_MAX);
    expect(where).not.toMatch(CLAIM_MARK);
  });

  it("the dead-letter pass takes every intent that used its attempts, a claimed one included", async () => {
    expect(await deadLetterExhaustedResumeIntents()).toBe(0);
    // The eligibility predicate: the candidate read's, then the same one under the UPDATE.
    expect(rec.wheres).toHaveLength(2);
    const eligible = rendered(rec.wheres[0]);
    expect(eligible).toMatch(ATTEMPTS_USED);
    expect(eligible).not.toMatch(CLAIM_MARK);
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
