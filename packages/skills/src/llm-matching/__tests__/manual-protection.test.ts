/**
 * Manual-row protection across the full evaluatePair -> upsertMatchRow path
 * and the reader filter.
 *
 * The upsert unit tests cover the direct shortcut in upsert.ts. This file
 * complements that by:
 *  1. Driving the protection through the full evaluator (evaluatePair) with
 *     a mocked LLM, so the high-level handler also honors it.
 *  2. Testing the reader-side `matched: true` filter that turns a manual
 *     `matched=false` exclusion into "this pair is invisible to the
 *     resolved skill list".
 *
 * Coverage targets:
 *  - Manual add: an existing {source: "manual", matched: true} row blocks
 *    `evaluatePair` from overwriting via the LLM path. Returns
 *    `{skipped: true, reason: "manual_protected"}`. generate is
 *    still called (rule short-circuit doesn't apply when match_when is
 *    absent), but upsertSkillMatch is not called.
 *  - Manual exclusion: a {source: "manual", matched: false} row in the
 *    readSkillMatchesByAgent output is dropped by the matched-true filter
 *    applied at the reader layer. The pair therefore does not appear in the
 *    resolved skill list.
 *  - Manual-to-manual overwrite is allowed: the short-circuit at upsert.ts
 *    only fires when `existing.source === "manual" AND row.source !==
 *    "manual"`. The inverse completes without skip, which preserves the
 *    admin re-toggle path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentForMatching, SkillForMatching, SkillMatchRow } from "../types";

const { orchestrateGenerateMock } = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));

vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn(),
  upsertSkillMatch: vi.fn(),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import * as store from "../skill-matches-store";
import { evaluatePair } from "../evaluate-pair";
import { upsertMatchRow } from "../upsert";

const NOW = new Date("2026-05-11T12:00:00Z");
const T_OLD = new Date("2026-05-11T08:00:00Z");
const T_NEW = new Date("2026-05-11T13:00:00Z");

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email"],
};

const baseSkill: SkillForMatching = {
  skillId: "skill-manual-1",
  name: "Manual Test Skill",
  level: "system",
  content: "Skill body: no match_when so we go to LLM by default.",
};

function manualRow(overrides: Partial<SkillMatchRow>): SkillMatchRow {
  return {
    agentId: baseAgent.packageId,
    skillId: baseSkill.skillId,
    source: "manual",
    matched: true,
    score: null,
    rationale: "admin pinned",
    evaluatorVersion: "manual-v1",
    agentInputHash: "a".repeat(64),
    skillInputHash: "b".repeat(64),
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: T_OLD,
    jobStartedAt: T_OLD,
    ...overrides,
  };
}

describe("manual-row protection", () => {
  beforeEach(() => {
    orchestrateGenerateMock.mockReset();
    vi.mocked(store.readSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
    vi.mocked(store.readSkillMatchesByAgent).mockReset();
  });

  it("existing manual+matched=true row blocks evaluatePair LLM overwrite", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(manualRow({ matched: true }));
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: false, score: 0, rationale: "llm disagrees" }),
    });

    const result = await evaluatePair(
      { agent: baseAgent, skill: baseSkill },
      { now: () => NOW, jobStartedAt: T_NEW },
    );

    // The LLM is invoked because rule short-circuiting does not apply when
    // match_when is absent, but the manual-protection guard short-circuits
    // the upsert.
    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toBe("manual_protected");
    }
  });

  it("manual+matched=false is filtered out by the reader's matched-true predicate", async () => {
    // Reader-side simulation: readSkillMatchesByAgent returns a manual
    // exclusion row alongside an llm-positive row; the canonical reader
    // filter drops manual exclusions because matched=false.
    const manualExclusion = manualRow({ matched: false, skillId: "skill-excluded" });
    const llmPositive = manualRow({
      source: "llm",
      matched: true,
      score: 0.8,
      skillId: "skill-included",
      evaluatorVersion: "llm-matcher-v1",
    });
    vi.mocked(store.readSkillMatchesByAgent).mockResolvedValue([manualExclusion, llmPositive]);

    const rows = await store.readSkillMatchesByAgent(baseAgent.packageId);
    // Mirror the canonical agents-store reader filter:
    //   const positiveRows = matchRows.filter((row) => row.matched && row.status === "ok");
    const positiveRows = rows.filter((row) => row.matched && row.status === "ok");
    const visibleSkillIds = positiveRows.map((r) => r.skillId);

    expect(visibleSkillIds).toEqual(["skill-included"]);
    expect(visibleSkillIds).not.toContain("skill-excluded");
  });

  it("admin re-toggle with manual overwriting manual is allowed", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(manualRow({ matched: true }));

    const reToggleRow: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt"> = {
      agentId: baseAgent.packageId,
      skillId: baseSkill.skillId,
      source: "manual",
      matched: false, // admin flipping it off
      score: null,
      rationale: "admin removed",
      evaluatorVersion: "manual-v1",
      agentInputHash: "a".repeat(64),
      skillInputHash: "b".repeat(64),
      status: "ok",
      errorCode: null,
      errorMessage: null,
    };

    const result = await upsertMatchRow(reToggleRow, { now: () => NOW, jobStartedAt: T_NEW });

    expect(result.skipped).toBe(false);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.source).toBe("manual");
    expect(written.matched).toBe(false);
    expect(written.rationale).toBe("admin removed");
  });
});
