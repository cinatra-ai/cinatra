/**
 * cinatra#4245 (A2): the pause claim rules of the status seam, the claim
 * clears of the other status writers, and the claim module's pure parts.
 *
 * No Postgres: the status compare-and-set runs on a recording fake tx, and its
 * SET and WHERE are rendered with drizzle's PgDialect, so the rules are read as
 * the SQL the database would get. The claim statements against a real database
 * are in run-pause-claim.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import {
  wrapTxWithOrgWriteKernel,
  type KernelQueryAnswers,
} from "@cinatra-ai/org-write-kernel/testing";
import type { OrgWriteDb, OrgWriteTx } from "@cinatra-ai/org-write-kernel";

const shared = vi.hoisted(() => ({
  kernelAnswers: {
    organization: { archivedAt: null as string | null, archiveEpoch: 0 },
    leaseHeld: false,
  },
  returningRows: [] as Array<Array<{ id: string }>>,
  setPayloads: [] as Array<Record<string, unknown>>,
  whereConds: [] as unknown[],
  executed: [] as unknown[],
  executeRows: [] as Array<Record<string, unknown>>,
  updateCalls: 0,
}));

vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel: wrap } = await import("@cinatra-ai/org-write-kernel/testing");
  const update = () => {
    shared.updateCalls += 1;
    return {
      set: (payload: Record<string, unknown>) => {
        shared.setPayloads.push(payload);
        return {
          where: (cond: unknown) => {
            shared.whereConds.push(cond);
            const rows = shared.returningRows.length > 0 ? shared.returningRows.shift()! : [{ id: "run-1" }];
            return Object.assign(Promise.resolve(undefined), { returning: async () => rows });
          },
        };
      },
    };
  };
  const insert = () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) });
  const tx = wrap(
    {
      update,
      insert,
      // The park clear on a pending_approval exit reads the row: no park here.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      execute: async (q: unknown) => {
        shared.executed.push(q);
        return { rows: shared.executeRows };
      },
    },
    shared.kernelAnswers,
  );
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    agentBuilderPool: { end: vi.fn() },
  };
});

vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = await orig<typeof import("@cinatra-ai/a2a")>();
  return { ...actual, expireRunStream: vi.fn(async () => undefined) };
});
vi.mock("../run-wait-notifier", async (orig) => {
  const actual = await orig<typeof import("../run-wait-notifier")>();
  return { ...actual, dispatchRunWaitTransition: vi.fn(async () => undefined) };
});

import { transitionRunStatus } from "../store";
import { updateAgentRunStatusConditional } from "../run-transition";
import { PAUSE_CLAIM_LEASE_SECONDS, PAUSE_SEND_LEASE_SECONDS } from "../run-status";
import { WAYFLOW_A2A_TIMEOUT_MS } from "../wayflow-url";
import { PauseClaimReleaseError } from "../run-pause-claim";
import { resumeRunFromSetupApproval } from "../resume-run-from-setup-approval";

const ORG = "org-1";
const RUN = "run-1";
const SESSION = { orgId: ORG, can: () => true };
const dialect = new PgDialect();

/** Render a WHERE condition the way the database receives it. */
function render(cond: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
}

/** Render one SET value: a SQL expression as text, any other value as itself. */
function setValue(payload: Record<string, unknown>, key: string): unknown {
  const v = payload[key];
  return v instanceof SQL ? render(v).sql : v;
}

/** A fake guarded tx for a direct call of the status compare-and-set. */
function casTx(rows: Array<{ id: string }> = [{ id: RUN }]) {
  const rec = { set: [] as Array<Record<string, unknown>>, where: [] as unknown[] };
  const tx = {
    update: () => ({
      set: (p: Record<string, unknown>) => {
        rec.set.push(p);
        return {
          where: (c: unknown) => {
            rec.where.push(c);
            return { returning: async () => rows };
          },
        };
      },
    }),
  } as unknown as OrgWriteTx;
  return { tx, rec };
}

beforeEach(() => {
  shared.returningRows = [];
  shared.setPayloads.length = 0;
  shared.whereConds.length = 0;
  shared.executed.length = 0;
  shared.executeRows = [];
  shared.updateCalls = 0;
});

describe("the lease constants", () => {
  it("the send lease covers the A2A timeout plus five minutes; the claim lease is two minutes", () => {
    expect(PAUSE_SEND_LEASE_SECONDS).toBe(WAYFLOW_A2A_TIMEOUT_MS / 1000 + 300);
    expect(PAUSE_CLAIM_LEASE_SECONDS).toBe(120);
  });
});

describe("rule 1: every status change clears the claim", () => {
  it("an ordinary edge NULLs token, phase and expiry and leaves the generation alone", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_input", "queued", undefined, ORG, tx);
    expect(rec.set[0]).toMatchObject({ pauseClaimToken: null, pauseClaimPhase: null, pauseClaimExpiresAt: null });
    expect(rec.set[0]).not.toHaveProperty("pauseGeneration");
  });

  it("the derivation-outbox delegate (→ completed) clears the claim in its own write", async () => {
    await transitionRunStatus(
      RUN,
      "running",
      "completed",
      {
        derivationOutbox: {
          orgId: ORG,
          templateId: "tmpl-1",
          packageVersion: null,
          createdBy: "user-1",
          content: "final output",
          contentIsJson: false,
          contentHash: "abc123",
        },
      },
      SESSION,
    );
    expect(shared.setPayloads[0]).toMatchObject({
      status: "completed",
      pauseClaimToken: null,
      pauseClaimPhase: null,
      pauseClaimExpiresAt: null,
    });
  });
});

describe("rule 2: every entry into pending_approval raises the generation", () => {
  it("raises pause_generation by 1 and clears the claim", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "running", "pending_approval", undefined, ORG, tx);
    expect(setValue(rec.set[0]!, "pauseGeneration")).toBe('"agent_runs"."pause_generation" + 1');
    expect(rec.set[0]).toMatchObject({ pauseClaimToken: null, pauseClaimPhase: null, pauseClaimExpiresAt: null });
    expect(rec.set[0]).not.toHaveProperty("a2aTaskId");
  });

  it("writes the pause's task id when the caller names it", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "running", "pending_approval", undefined, ORG, tx, {
      pauseTaskId: "task-7",
    });
    expect(rec.set[0]).toHaveProperty("a2aTaskId", "task-7");
  });

  it("refuses a task id on another edge, and an empty one", async () => {
    const { tx } = casTx();
    await expect(
      updateAgentRunStatusConditional(RUN, "running", "completed", undefined, ORG, tx, { pauseTaskId: "t" }),
    ).rejects.toThrow(/pauseTaskId supplied for running→completed/);
    await expect(
      updateAgentRunStatusConditional(RUN, "running", "pending_approval", undefined, ORG, tx, { pauseTaskId: "" }),
    ).rejects.toThrow(/empty pauseTaskId/);
  });
});

describe("rule 3: the fence", () => {
  it("lands only under the live claimed lease of the token at the generation", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx, {
      pauseFence: { token: "tok-1", generation: 4 },
    });
    const where = render(rec.where[0]);
    expect(where.sql).toContain('"agent_runs"."pause_claim_token" = $');
    expect(where.sql).toContain(`"agent_runs"."pause_claim_phase" = 'claimed'`);
    expect(where.sql).toContain('"agent_runs"."pause_generation" = $');
    expect(where.sql).toContain('"agent_runs"."pause_claim_expires_at" > now()');
    expect(where.params).toEqual(expect.arrayContaining(["tok-1", 4]));
  });

  it("sets the phase sending, raises the generation, sets the send lease and keeps the token", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx, {
      pauseFence: { token: "tok-1", generation: 4 },
    });
    const set = rec.set[0]!;
    expect(set).toHaveProperty("status", "running");
    expect(set).toHaveProperty("pauseClaimPhase", "sending");
    expect(set).not.toHaveProperty("pauseClaimToken");
    expect(setValue(set, "pauseGeneration")).toBe('"agent_runs"."pause_generation" + 1');
    expect(setValue(set, "pauseClaimExpiresAt")).toBe(`now() + make_interval(secs => ${PAUSE_SEND_LEASE_SECONDS})`);
  });

  it("without a fence the edge stays the status-only compare-and-set, and clears the claim", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx);
    expect(render(rec.where[0]).sql).not.toContain("pause_claim_token");
    expect(rec.set[0]).toMatchObject({ pauseClaimToken: null, pauseClaimPhase: null, pauseClaimExpiresAt: null });
  });

  it("refuses a fence on another edge and a malformed fence, before any write", async () => {
    const { tx, rec } = casTx();
    await expect(
      updateAgentRunStatusConditional(RUN, "pending_approval", "queued", undefined, ORG, tx, {
        pauseFence: { token: "tok-1", generation: 1 },
      }),
    ).rejects.toThrow(/pauseFence supplied for pending_approval→queued/);
    await expect(
      updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx, {
        pauseFence: { token: "", generation: 1 },
      }),
    ).rejects.toThrow(/malformed pauseFence/);
    await expect(
      updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx, {
        pauseFence: { token: "tok-1", generation: -1 },
      }),
    ).rejects.toThrow(/malformed pauseFence/);
    expect(rec.set).toHaveLength(0);
  });
});

describe("rule 4: no stop under a live send", () => {
  it("every → stopped compare-and-set refuses a live sending lease (NULL-safe)", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_approval", "stopped", undefined, ORG, tx);
    expect(render(rec.where[0]).sql).toContain(
      `("agent_runs"."pause_claim_phase" IS DISTINCT FROM 'sending' OR "agent_runs"."pause_claim_expires_at" <= now())`,
    );
  });

  it("a lost stop under a live send throws pause_resume_in_flight", async () => {
    shared.returningRows = [[]];
    shared.executeRows = [{ live: true }];
    await expect(transitionRunStatus(RUN, "pending_approval", "stopped", undefined, SESSION)).rejects.toMatchObject({
      name: "RunTransitionError",
      code: "pause_resume_in_flight",
    });
    const probe = render(shared.executed.at(-1)).sql;
    expect(probe).toContain(`"pause_claim_phase" = 'sending'`);
    expect(probe).toContain(`"pause_claim_expires_at" > now()`);
  });

  it("a lost stop without a live send stays stale_from_status", async () => {
    shared.returningRows = [[]];
    shared.executeRows = [{ live: false }];
    await expect(transitionRunStatus(RUN, "pending_approval", "stopped", undefined, SESSION)).rejects.toMatchObject({
      code: "stale_from_status",
    });
  });

  it("a lost compare-and-set of another edge is stale_from_status without the probe", async () => {
    shared.returningRows = [[]];
    shared.executeRows = [{ live: true }];
    const before = shared.executed.length;
    await expect(transitionRunStatus(RUN, "running", "completed", undefined, SESSION)).rejects.toMatchObject({
      code: "stale_from_status",
    });
    const probes = shared.executed.slice(before).filter((q) => q instanceof SQL && render(q).sql.includes(" AS live "));
    expect(probes).toHaveLength(0);
  });
});

describe("rule 5: the change-request end mark", () => {
  it("→ stopped with pauseEndMark lands only at that generation's end mark", async () => {
    const { tx, rec } = casTx();
    await updateAgentRunStatusConditional(RUN, "pending_approval", "stopped", undefined, ORG, tx, {
      pauseEndMark: { generation: 6 },
    });
    const where = render(rec.where[0]);
    expect(where.sql).toContain(`"agent_runs"."pause_claim_phase" = 'changes_requested'`);
    expect(where.params).toContain(6);
  });

  it("refuses an end mark on another edge", async () => {
    const { tx } = casTx();
    await expect(
      updateAgentRunStatusConditional(RUN, "pending_approval", "running", undefined, ORG, tx, {
        pauseEndMark: { generation: 6 },
      }),
    ).rejects.toThrow(/pauseEndMark supplied for pending_approval→running/);
  });
});

describe("transitionRunStatus: the control fields", () => {
  it("passes the fence to the compare-and-set and writes no control key as a column", async () => {
    await transitionRunStatus(
      RUN,
      "pending_approval",
      "running",
      { pauseFence: { token: "tok-1", generation: 2 } },
      SESSION,
    );
    expect(shared.setPayloads).toHaveLength(1);
    expect(shared.setPayloads[0]).toHaveProperty("pauseClaimPhase", "sending");
    for (const p of shared.setPayloads) {
      expect(p).not.toHaveProperty("pauseFence");
      expect(p).not.toHaveProperty("pauseEndMark");
      expect(p).not.toHaveProperty("pauseTaskId");
    }
  });

  it("refuses a pause field together with the derivation outbox", async () => {
    await expect(
      transitionRunStatus(
        RUN,
        "running",
        "completed",
        {
          pauseTaskId: "task-1",
          derivationOutbox: {
            orgId: ORG,
            templateId: "tmpl-1",
            packageVersion: null,
            createdBy: "user-1",
            content: "x",
            contentIsJson: false,
            contentHash: "h",
          },
        },
        SESSION,
      ),
    ).rejects.toThrow(/pause claim fields supplied with derivationOutbox/);
    expect(shared.updateCalls).toBe(0);
  });
});

describe("the setup resume (a direct status writer)", () => {
  function setupDb(answers: KernelQueryAnswers) {
    const rec = { set: [] as Array<Record<string, unknown>>, where: [] as unknown[] };
    const update = () => ({
      set: (p: Record<string, unknown>) => {
        rec.set.push(p);
        return {
          where: (c: unknown) => {
            rec.where.push(c);
            return { returning: async () => [{ id: RUN }] };
          },
        };
      },
    });
    const tx = wrapTxWithOrgWriteKernel({ update, execute: async () => ({ rows: [] }) }, answers);
    const db = { transaction: async <R,>(fn: (t: typeof tx) => Promise<R>) => fn(tx) } as unknown as OrgWriteDb<OrgWriteTx>;
    return { db, rec };
  }

  it("clears the claim and lands only on a free pause", async () => {
    const { db, rec } = setupDb({ organization: { archivedAt: null, archiveEpoch: 0 } });
    await resumeRunFromSetupApproval(RUN, null, SESSION, { db });
    expect(rec.set[0]).toMatchObject({
      status: "queued",
      pauseClaimToken: null,
      pauseClaimPhase: null,
      pauseClaimExpiresAt: null,
    });
    expect(render(rec.where[0]).sql).toContain(
      `("agent_runs"."pause_claim_token" IS NULL OR ("agent_runs"."pause_claim_phase" IN ('claimed', 'sending') AND "agent_runs"."pause_claim_expires_at" <= now()))`,
    );
  });
});

describe("PauseClaimReleaseError", () => {
  it("names both failures and when the lease frees itself", () => {
    const at = new Date("2026-10-30T01:02:03.000Z");
    const e = new PauseClaimReleaseError({
      stepError: new Error("prompt insert failed"),
      releaseError: new Error("connection reset"),
      expiresAt: at,
    });
    expect(e.name).toBe("PauseClaimReleaseError");
    expect(e.message).toContain("prompt insert failed");
    expect(e.message).toContain("connection reset");
    expect(e.message).toContain("2026-10-30T01:02:03.000Z");
    expect(e.expiresAt).toBe(at);
  });
});
