/**
 * Staleness-sweep unit tests (cinatra #1365 / S7, acceptance criterion 1).
 *
 * Drives `sweepStaleMatches` with inline fakes for the row reader, the catalog
 * seam, and the evaluator. No real DB, no real LLM. Proves:
 *   - AC1: an out-of-band skill content edit (stored fingerprint != current) is
 *     detected and re-evaluated WITHOUT any install/save event.
 *   - a fresh row (fingerprint matches) is NOT re-evaluated.
 *   - a manual row whose inputs changed is FLAGGED, never re-evaluated.
 *   - an evaluator-version mismatch counts as stale.
 *   - the per-tick re-eval cap defers the remainder (forward progress).
 *   - a row whose pair left the catalog is left to the GC (not re-evaluated).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../skill-matches-store", () => ({
  readAllRows: vi.fn().mockResolvedValue([]),
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  deleteOrphanRowIfStale: vi.fn().mockResolvedValue(0),
}));

import { sweepStaleMatches } from "../drift-sampler";
import { computeInputHashes } from "../hashes";
import { adaptAgentForMatching, adaptSkillForMatching } from "../adapters";
import { LLM_MATCHER_VERSION, RULE_MATCHER_VERSION, MANUAL_VERSION } from "../constants";
import type {
  CatalogAgent,
  CatalogProvider,
  CatalogSkill,
  SkillMatchRow,
  MatchSource,
} from "../types";

const NOW = new Date("2026-05-12T03:00:00Z");

function agent(i: number): CatalogAgent {
  return {
    packageId: `@cinatra/agent-${i}`,
    packageName: `@cinatra/agent-${i}`,
    humanReadableName: `Agent ${i}`,
    description: `Description ${i}`,
    keywords: ["x"],
  };
}
function skill(i: number, content: string): CatalogSkill {
  return { id: `skill-${i}`, name: `Skill ${i}`, level: "third-party", content };
}

function currentHashes(a: CatalogAgent, s: CatalogSkill) {
  return computeInputHashes(
    adaptAgentForMatching(a),
    adaptSkillForMatching({ id: s.id, name: s.name, level: s.level, content: s.content ?? "", agentId: undefined }),
  );
}

function row(opts: {
  a: CatalogAgent;
  s: CatalogSkill;
  source?: MatchSource;
  agentInputHash: string;
  skillInputHash: string;
  evaluatorVersion?: string;
}): SkillMatchRow {
  const source = opts.source ?? "llm";
  return {
    agentId: opts.a.packageId,
    skillId: opts.s.id,
    source,
    matched: true,
    score: source === "manual" ? null : 0.9,
    rationale: "r",
    evaluatorVersion:
      opts.evaluatorVersion ??
      (source === "llm" ? LLM_MATCHER_VERSION : source === "rule" ? RULE_MATCHER_VERSION : MANUAL_VERSION),
    agentInputHash: opts.agentInputHash,
    skillInputHash: opts.skillInputHash,
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: NOW,
    jobStartedAt: NOW,
  };
}

function catalogOf(agents: CatalogAgent[], skills: CatalogSkill[]): CatalogProvider {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    readAgents: async () => agents,
    listSkills: async () => skills,
    getSkillById: async (id) => byId.get(id) ?? null,
  };
}

describe("sweepStaleMatches", () => {
  it("AC1: re-evaluates a row whose skill content changed out of band", async () => {
    const a = agent(1);
    const sOld = skill(1, "# Skill 1\nold content\n");
    const sNew = skill(1, "# Skill 1\nNEW content after an out-of-band edit\n");
    // The stored row carries the fingerprint of the OLD content.
    const oldHashes = currentHashes(a, sOld);
    const stored = row({ a, s: sNew, agentInputHash: oldHashes.agentInputHash, skillInputHash: oldHashes.skillInputHash });

    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const res = await sweepStaleMatches({
      catalog: catalogOf([a], [sNew]), // catalog serves the NEW content
      readAllRows: async () => [stored],
      evaluate: evaluate as never,
      now: () => NOW,
    });

    expect(res.stale).toBe(1);
    expect(res.reevaluated).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // Every upsert in the run shares one anchor = sweepStartedAt.
    expect(evaluate.mock.calls[0][1].jobStartedAt).toEqual(NOW);
  });

  it("does not re-evaluate a fresh row (fingerprint matches current)", async () => {
    const a = agent(2);
    const s = skill(2, "# Skill 2\nstable\n");
    const h = currentHashes(a, s);
    const stored = row({ a, s, agentInputHash: h.agentInputHash, skillInputHash: h.skillInputHash });

    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const res = await sweepStaleMatches({
      catalog: catalogOf([a], [s]),
      readAllRows: async () => [stored],
      evaluate: evaluate as never,
      now: () => NOW,
    });
    expect(res.stale).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("flags a manual row whose inputs changed but never re-evaluates it", async () => {
    const a = agent(3);
    const s = skill(3, "# Skill 3\nnew\n");
    const stale = { agentInputHash: "stale-a", skillInputHash: "stale-s" };
    const stored = row({ a, s, source: "manual", ...stale });

    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const recordManualStale = vi.fn().mockResolvedValue(undefined);
    const res = await sweepStaleMatches({
      catalog: catalogOf([a], [s]),
      readAllRows: async () => [stored],
      evaluate: evaluate as never,
      recordManualStale,
      now: () => NOW,
    });
    expect(res.manualFlagged).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
    expect(recordManualStale).toHaveBeenCalledWith([{ agentId: a.packageId, skillId: s.id }]);
  });

  it("treats an evaluator-version mismatch as stale (fingerprint unchanged)", async () => {
    const a = agent(4);
    const s = skill(4, "# Skill 4\nx\n");
    const h = currentHashes(a, s);
    // Fingerprint matches current, but the evaluator version is old.
    const stored = row({
      a,
      s,
      agentInputHash: h.agentInputHash,
      skillInputHash: h.skillInputHash,
      evaluatorVersion: "llm-matcher-v0",
    });
    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const res = await sweepStaleMatches({
      catalog: catalogOf([a], [s]),
      readAllRows: async () => [stored],
      evaluate: evaluate as never,
      now: () => NOW,
    });
    expect(res.stale).toBe(1);
    expect(res.reevaluated).toBe(1);
  });

  it("defers stale rows beyond the per-tick cap (forward progress)", async () => {
    const rows: SkillMatchRow[] = [];
    const skills: CatalogSkill[] = [];
    const agents: CatalogAgent[] = [];
    for (let i = 0; i < 5; i += 1) {
      const a = agent(100 + i);
      const s = skill(100 + i, `# S${i}\nc\n`);
      agents.push(a);
      skills.push(s);
      rows.push(row({ a, s, agentInputHash: "stale", skillInputHash: "stale" }));
    }
    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const res = await sweepStaleMatches({
      catalog: catalogOf(agents, skills),
      readAllRows: async () => rows,
      evaluate: evaluate as never,
      now: () => NOW,
      maxReevals: 2,
    });
    expect(res.stale).toBe(5);
    expect(res.reevaluated).toBe(2);
    expect(res.deferredOverCap).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("the per-tick cap bounds re-eval ATTEMPTS even when upserts are skipped", async () => {
    const rows: SkillMatchRow[] = [];
    const skills: CatalogSkill[] = [];
    const agents: CatalogAgent[] = [];
    for (let i = 0; i < 3; i += 1) {
      const a = agent(200 + i);
      const s = skill(200 + i, `# S${i}\nc\n`);
      agents.push(a);
      skills.push(s);
      rows.push(row({ a, s, agentInputHash: "stale", skillInputHash: "stale" }));
    }
    // Every re-eval reports skipped (e.g. stale-write guard) — it still cost an
    // LLM call, so it must consume the cap.
    const evaluate = vi.fn().mockResolvedValue({ skipped: true });
    const res = await sweepStaleMatches({
      catalog: catalogOf(agents, skills),
      readAllRows: async () => rows,
      evaluate: evaluate as never,
      now: () => NOW,
      maxReevals: 2,
    });
    expect(evaluate).toHaveBeenCalledTimes(2); // bounded by attempts, not successes
    expect(res.reevaluated).toBe(0);
    expect(res.deferredOverCap).toBe(1);
  });

  it("leaves a row whose pair is absent from the catalog to the GC", async () => {
    const a = agent(5);
    const s = skill(5, "# S\nc\n");
    const stored = row({ a, s, agentInputHash: "stale", skillInputHash: "stale" });
    const evaluate = vi.fn().mockResolvedValue({ skipped: false });
    const res = await sweepStaleMatches({
      catalog: catalogOf([], []), // pair no longer installed
      readAllRows: async () => [stored],
      evaluate: evaluate as never,
      now: () => NOW,
    });
    expect(res.absent).toBe(1);
    expect(res.stale).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed: a row-read error propagates (never a false-empty sweep)", async () => {
    await expect(
      sweepStaleMatches({
        catalog: catalogOf([], []),
        readAllRows: async () => {
          throw new Error("db down");
        },
        now: () => NOW,
      }),
    ).rejects.toThrow("db down");
  });
});
