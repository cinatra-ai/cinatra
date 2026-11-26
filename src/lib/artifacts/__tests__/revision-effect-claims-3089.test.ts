/**
 * cinatra#3089 — an effect of one bound revision, at most once per run, and the
 * filed artifacts of a run, on the materialization ledger.
 *
 * The pooled db is mocked as the ledger's other tests mock it; the functions
 * under test run unchanged.
 *
 * Cases:
 *   E1 the claim inserts the claim row FROM the binding row under the SAME
 *      output id and path, its extension and hash the effect's name,
 *      conditionally on the ledger key; the caller whose insert returns a row
 *      wins
 *   E2 a claim that inserts nothing reads the claim row: finalized is "done",
 *      claimed is "in_doubt"
 *   E3 a claim of a revision with no binding row throws
 *   E4 the done mark and the give-back touch only a claimed row of that effect
 *      in the organization; a mark that moves nothing reads the row back
 *   E5 one claim row per effect of one binding output of a run, whatever pack
 *      bound it and whatever revision is bound later (the claim row shares the
 *      binding's output id)
 *   P1-P5 performRevisionEffectOnce: done; already done; held elsewhere; an
 *      `EffectNotStartedError` gives the claim back; any other error leaves it
 *      in doubt; a give-back that fails is in doubt; a done mark that throws is
 *      written again, and one that never lands is performed and in doubt
 *   F1 the filed artifacts of a run are its finalized mid-run rows in the
 *      organization, capped, from the ledger alone
 *   N1 the ledger module reads and writes no objects row
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { poolQueryMock, getObjectByIdMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getObjectByIdMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@/lib/objects-store", () => ({
  getObjectById: getObjectByIdMock,
}));

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  claimRevisionEffect,
  EffectNotStartedError,
  listRunFiledArtifactIds,
  markRevisionEffectDone,
  performRevisionEffectOnce,
  releaseRevisionEffect,
  type RevisionEffectClaimKey,
  type RevisionEffectLedger,
} from "../materialization-ledger";

const KEY: RevisionEffectClaimKey = {
  runId: "run-1",
  path: "email_fanout",
  bindingOutputId: "out-1",
  effect: "effect-a",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
};
const CLAIM = { orgId: "org-a", ...KEY };
const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", orgId: "org-a" };

beforeEach(() => {
  poolQueryMock.mockReset();
  getObjectByIdMock.mockReset();
});

describe("cinatra#3089 — the claim of one effect of a bound revision", () => {
  it("E1 the claim inserts the claim row from the binding row under the same output id", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "claim-row-1" }] });
    expect(await claimRevisionEffect(CLAIM)).toEqual({ kind: "won", ledgerId: "claim-row-1" });
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /WHERE org_id = \$2 AND run_id = \$3 AND output_id = \$4 AND path = \$5\s+AND phase = 'finalized' AND artifact_id = \$6 AND representation_revision_id = \$7\s+AND NOT \(extension = \$8 AND content_hash = \$8\)/,
    );
    expect(sql).toMatch(/SELECT \$1, org_id, run_id, \$4, NULL, \$5, \$8, \$8,\s+artifact_id, representation_revision_id, 'claimed'\s+FROM bound/);
    expect(sql).toMatch(/ON CONFLICT \(run_id, output_id, extension, content_hash\) DO NOTHING\s+RETURNING id/);
    expect(params.slice(1)).toEqual(["org-a", "run-1", "out-1", "email_fanout", "art-1", "rev-1", "effect-a"]);
  });

  it("E2 a claim that inserts nothing reads the claim row: finalized is done, claimed is in doubt", async () => {
    for (const [phase, kind] of [
      ["finalized", "done"],
      ["claimed", "in_doubt"],
    ] as const) {
      poolQueryMock.mockReset();
      poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ phase }] });
      expect(await claimRevisionEffect(CLAIM)).toEqual({ kind });
      const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/WHERE org_id = \$1 AND run_id = \$2 AND output_id = \$3 AND path = \$4\s+AND extension = \$5 AND content_hash = \$5/);
      expect(params).toEqual(["org-a", "run-1", "out-1", "email_fanout", "effect-a"]);
    }
  });

  it("E3 a claim of a revision with no binding row throws", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(claimRevisionEffect(CLAIM)).rejects.toThrow(
      "output out-1 of run run-1 has no binding to revision rev-1 of artifact art-1, so its effect-a cannot be claimed",
    );
  });

  it("E4 the done mark and the give-back touch only a claimed row of the effect in the organization", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "claim-row-1" }] });
    const ref = { orgId: "org-a", ledgerId: "claim-row-1", effect: "effect-a" };
    expect(await markRevisionEffectDone(ref)).toBe(true);
    const [markSql, markParams] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(markSql).toMatch(
      /SET phase = 'finalized'\s+WHERE id = \$1 AND org_id = \$2 AND extension = \$3 AND content_hash = \$3 AND phase = 'claimed'\s+RETURNING id/,
    );
    expect(markParams).toEqual(["claim-row-1", "org-a", "effect-a"]);
    for (const [found, answer] of [
      [[{ phase: "finalized" }], true],
      [[{ phase: "claimed" }], false],
      [[], false],
    ] as const) {
      poolQueryMock.mockReset();
      poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: found });
      expect(await markRevisionEffectDone(ref)).toBe(answer);
      const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/SELECT phase FROM "public"\."artifact_materializations"\s+WHERE id = \$1 AND org_id = \$2 AND extension = \$3 AND content_hash = \$3/);
      expect(params).toEqual(["claim-row-1", "org-a", "effect-a"]);
    }
    poolQueryMock.mockReset();
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await releaseRevisionEffect(ref);
    const [relSql, relParams] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(relSql).toMatch(
      /DELETE FROM "public"\."artifact_materializations"\s+WHERE id = \$1 AND org_id = \$2 AND extension = \$3 AND content_hash = \$3 AND phase = 'claimed'/,
    );
    expect(relParams).toEqual(["claim-row-1", "org-a", "effect-a"]);
  });

  it("E5 one claim row per effect of one binding output, whatever pack bound it and whatever revision is bound later", async () => {
    // A table with the ledger's unique key, running the claim's statements.
    type Row = { id: string; org_id: string; run_id: string; output_id: string; path: string; extension: string; content_hash: string; artifact_id: string; representation_revision_id: string; phase: string };
    const rows: Row[] = [
      { id: "b1", org_id: "org-a", run_id: "run-1", output_id: "out-1", path: "email_fanout", extension: "pack-a", content_hash: "h1", artifact_id: "art-1", representation_revision_id: "rev-1", phase: "finalized" },
      { id: "b2", org_id: "org-a", run_id: "run-1", output_id: "out-1", path: "email_fanout", extension: "pack-b", content_hash: "h2", artifact_id: "art-1", representation_revision_id: "rev-2", phase: "finalized" },
    ];
    poolQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const p = (n: number) => params[n - 1] as string;
      if (/WITH bound AS/.test(sql)) {
        const bound = rows.find((r) => r.org_id === p(2) && r.run_id === p(3) && r.output_id === p(4) && r.path === p(5) && r.phase === "finalized" && r.artifact_id === p(6) && r.representation_revision_id === p(7) && !(r.extension === p(8) && r.content_hash === p(8)));
        if (!bound) return { rows: [] };
        if (rows.some((r) => r.run_id === bound.run_id && r.output_id === p(4) && r.extension === p(8) && r.content_hash === p(8))) return { rows: [] };
        rows.push({ ...bound, id: p(1), output_id: p(4), path: p(5), extension: p(8), content_hash: p(8), phase: "claimed" });
        return { rows: [{ id: p(1) }] };
      }
      if (/SELECT phase FROM/.test(sql)) {
        const row = rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5));
        return { rows: row ? [{ phase: row.phase }] : [] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    });
    const first = await claimRevisionEffect(CLAIM);
    expect(first.kind).toBe("won");
    const later = await claimRevisionEffect({ ...CLAIM, representationRevisionId: "rev-2" });
    expect(later).toEqual({ kind: "in_doubt" });
    const claims = rows.filter((r) => r.extension === "effect-a");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ output_id: "out-1", path: "email_fanout", content_hash: "effect-a", artifact_id: "art-1", representation_revision_id: "rev-1" });
  });
});

/** A ledger stand-in that records its calls; `claim` answers `answer`. */
function recordingLedger(answer: Awaited<ReturnType<RevisionEffectLedger["claim"]>>) {
  const calls: string[] = [];
  const ledger: RevisionEffectLedger = {
    claim: vi.fn(async () => (calls.push("claim"), answer)),
    markDone: vi.fn(async () => (calls.push("markDone"), true)),
    release: vi.fn(async () => {
      calls.push("release");
    }),
  };
  return { ledger, calls };
}

describe("cinatra#3089 — performRevisionEffectOnce", () => {
  it("P1 a won claim performs the effect and marks it done; done and held claims perform nothing", async () => {
    const won = recordingLedger({ kind: "won", ledgerId: "l-1" });
    const act = vi.fn(async () => "ok");
    expect(await performRevisionEffectOnce({ claimKey: KEY, actor, act, ledger: won.ledger })).toEqual({ done: true, alreadyDone: false, inDoubt: false });
    expect(won.calls).toEqual(["claim", "markDone"]);
    expect(won.ledger.markDone).toHaveBeenCalledWith("l-1", KEY, actor);
    for (const [answer, outcome] of [
      [{ kind: "done" }, { done: false, alreadyDone: true, inDoubt: false }],
      [{ kind: "in_doubt" }, { done: false, alreadyDone: false, inDoubt: true }],
    ] as const) {
      const other = recordingLedger(answer);
      const idle = vi.fn();
      expect(await performRevisionEffectOnce({ claimKey: KEY, actor, act: idle, ledger: other.ledger })).toEqual(outcome);
      expect(idle).not.toHaveBeenCalled();
    }
  });

  it("P2 EffectNotStartedError gives the claim back; any other error leaves the effect in doubt", async () => {
    const notStarted = recordingLedger({ kind: "won", ledgerId: "l-1" });
    const given = await performRevisionEffectOnce({
      claimKey: KEY,
      actor,
      act: async () => {
        throw new EffectNotStartedError("no mailbox");
      },
      ledger: notStarted.ledger,
    });
    expect(given).toEqual({ done: false, alreadyDone: false, inDoubt: false, failure: { stage: "not_started", reason: "no mailbox" } });
    expect(notStarted.ledger.release).toHaveBeenCalledWith("l-1", KEY, actor);
    const failed = recordingLedger({ kind: "won", ledgerId: "l-2" });
    const doubt = await performRevisionEffectOnce({
      claimKey: KEY,
      actor,
      act: async () => {
        throw new Error("socket hang up");
      },
      ledger: failed.ledger,
    });
    expect(doubt).toEqual({ done: false, alreadyDone: false, inDoubt: true, failure: { stage: "act", reason: "socket hang up" } });
    expect(failed.ledger.release).not.toHaveBeenCalled();
    expect(failed.ledger.markDone).not.toHaveBeenCalled();
  });

  it("P3 a give-back that fails leaves the effect in doubt; a claim that throws performs nothing", async () => {
    const stuck = recordingLedger({ kind: "won", ledgerId: "l-1" });
    vi.mocked(stuck.ledger.release).mockRejectedValueOnce(new Error("db down"));
    const outcome = await performRevisionEffectOnce({
      claimKey: KEY,
      actor,
      act: async () => {
        throw new EffectNotStartedError("no mailbox");
      },
      ledger: stuck.ledger,
    });
    expect(outcome).toEqual({ done: false, alreadyDone: false, inDoubt: true, failure: { stage: "release", reason: "no mailbox; db down" } });
    const broken = recordingLedger({ kind: "won", ledgerId: "l-1" });
    vi.mocked(broken.ledger.claim).mockRejectedValueOnce(new Error("no binding"));
    const act = vi.fn();
    expect(await performRevisionEffectOnce({ claimKey: KEY, actor, act, ledger: broken.ledger })).toEqual({
      done: false,
      alreadyDone: false,
      inDoubt: false,
      failure: { stage: "claim", reason: "no binding" },
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("P4 a done mark that throws is written again; one never written is performed and in doubt", async () => {
    const retried = recordingLedger({ kind: "won", ledgerId: "l-1" });
    vi.mocked(retried.ledger.markDone).mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(true);
    expect(await performRevisionEffectOnce({ claimKey: KEY, actor, act: async () => 1, ledger: retried.ledger })).toEqual({
      done: true,
      alreadyDone: false,
      inDoubt: false,
    });
    expect(retried.ledger.markDone).toHaveBeenCalledTimes(2);
    const refused = recordingLedger({ kind: "won", ledgerId: "l-1" });
    vi.mocked(refused.ledger.markDone).mockResolvedValue(false);
    expect(await performRevisionEffectOnce({ claimKey: KEY, actor, act: async () => 1, ledger: refused.ledger })).toEqual({
      done: true,
      alreadyDone: false,
      inDoubt: true,
      failure: { stage: "mark", reason: "the record was not open" },
    });
    expect(refused.ledger.markDone).toHaveBeenCalledTimes(1);
  });

  it("P5 the shipped ledger records under the actor's organization and refuses an actor without one", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "claim-row-1" }] }).mockResolvedValueOnce({ rows: [{ id: "claim-row-1" }] });
    const outcome = await performRevisionEffectOnce({ claimKey: KEY, actor, act: async () => 1 });
    expect(outcome).toEqual({ done: true, alreadyDone: false, inDoubt: false });
    expect((poolQueryMock.mock.calls[0] as [string, unknown[]])[1].slice(1, 3)).toEqual(["org-a", "run-1"]);
    const orgless = await performRevisionEffectOnce({ claimKey: KEY, actor: { ...actor, orgId: undefined }, act: async () => 1 });
    expect(orgless.failure?.stage).toBe("claim");
  });
});

describe("cinatra#3089 — the review filings of a run", () => {
  type FiledRow = { org_id: string; run_id: string; path: string; phase: string; artifact_id: string | null };
  function filings(rows: FiledRow[]) {
    poolQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const [runId, orgId, limit] = params as [string, string, number];
      expect(sql).toMatch(/WHERE run_id = \$1 AND org_id = \$2 AND path IN \('materialize_tool', 'end_node_binding'\)\s+AND phase = 'finalized' AND artifact_id IS NOT NULL/);
      const ids = [...new Set(rows.filter((r) => r.run_id === runId && r.org_id === orgId && ["materialize_tool", "end_node_binding"].includes(r.path) && r.phase === "finalized" && r.artifact_id).map((r) => r.artifact_id!))].sort();
      return { rows: ids.slice(0, limit).map((artifact_id) => ({ artifact_id })) };
    });
  }
  it("F1 the filed artifacts of a run are its finalized mid-run rows in the organization, capped", async () => {
    filings([
      { org_id: "org-a", run_id: "run-1", path: "materialize_tool", phase: "finalized", artifact_id: "art-2" },
      { org_id: "org-a", run_id: "run-1", path: "end_node_binding", phase: "finalized", artifact_id: "art-1" },
      { org_id: "org-a", run_id: "run-1", path: "email_fanout", phase: "finalized", artifact_id: "art-3" },
      { org_id: "org-a", run_id: "run-1", path: "materialize_tool", phase: "claimed", artifact_id: "art-4" },
    ]);
    expect(await listRunFiledArtifactIds({ orgId: "org-a", runId: "run-1", cap: 5 })).toEqual({ artifactIds: ["art-1", "art-2"], overCap: false });
    expect(await listRunFiledArtifactIds({ orgId: "org-a", runId: "run-1", cap: 1 })).toEqual({ artifactIds: ["art-1"], overCap: true });
    const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$3/);
    expect(params).toEqual(["run-1", "org-a", 2]);
  });

  it("N1 the ledger module reads and writes no objects row", () => {
    const source = readFileSync(join(__dirname, "..", "materialization-ledger.ts"), "utf8");
    expect(/\."objects"|\bobjects\s+o\b|JOIN\s+"[^"]*"\.objects/i.test(source)).toBe(false);
  });
});
