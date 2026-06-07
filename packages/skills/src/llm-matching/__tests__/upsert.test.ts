import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillMatchRow } from "../types";

// Mock the store BEFORE importing upsert.
vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn(),
  upsertSkillMatch: vi.fn(),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import * as store from "../skill-matches-store";
import { upsertMatchRow, redactErrorMessage } from "../upsert";

const NOW = new Date("2026-05-11T12:00:00Z");
const T0 = new Date("2026-05-11T10:00:00Z"); // earliest
const T1 = new Date("2026-05-11T11:00:00Z"); // earlier
const T2 = new Date("2026-05-11T13:00:00Z"); // later

const baseRow: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt"> = {
  agentId: "@cinatra/email-agent",
  skillId: "skill-1",
  source: "llm",
  matched: true,
  score: 0.85,
  rationale: "useful",
  evaluatorVersion: "llm-matcher-v1",
  agentInputHash: "a".repeat(64),
  skillInputHash: "b".repeat(64),
  status: "ok",
  errorCode: null,
  errorMessage: null,
};

const existingRow = (overrides: Partial<SkillMatchRow>): SkillMatchRow => ({
  ...baseRow,
  evaluatedAt: T1,
  jobStartedAt: T1,
  ...overrides,
});

describe("upsert", () => {
  beforeEach(() => {
    vi.mocked(store.readSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockReset();
  });

  it("writes a row using injected now() and jobStartedAt", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockResolvedValue();

    const result = await upsertMatchRow(baseRow, { now: () => NOW, jobStartedAt: T2 });

    expect(result).toEqual({ skipped: false });
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const [written] = vi.mocked(store.upsertSkillMatch).mock.calls[0];
    expect(written.evaluatedAt).toEqual(NOW);
    expect(written.jobStartedAt).toEqual(T2);
  });

  it("skips an incoming row when jobStartedAt is older than the existing row", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(existingRow({ jobStartedAt: T2 }));

    const result = await upsertMatchRow(baseRow, { now: () => NOW, jobStartedAt: T1 });

    expect(result).toEqual({ skipped: true, reason: "stale_job_started_at" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("overwrites when incoming jobStartedAt is newer than the existing row", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(existingRow({ jobStartedAt: T1 }));
    vi.mocked(store.upsertSkillMatch).mockResolvedValue();

    const result = await upsertMatchRow(baseRow, { now: () => NOW, jobStartedAt: T2 });

    expect(result).toEqual({ skipped: false });
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
  });

  it("overwrites on equal jobStartedAt using last-writer-wins", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(existingRow({ jobStartedAt: T1 }));
    vi.mocked(store.upsertSkillMatch).mockResolvedValue();

    const result = await upsertMatchRow(baseRow, { now: () => NOW, jobStartedAt: T1 });

    expect(result).toEqual({ skipped: false });
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
  });

  it("preserves a manual existing row from llm overwrite", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({ source: "manual", score: null, jobStartedAt: T1 }),
    );

    const result = await upsertMatchRow(
      { ...baseRow, source: "llm" },
      { now: () => NOW, jobStartedAt: T2 },
    );

    expect(result).toEqual({ skipped: true, reason: "manual_protected" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("preserves a manual unmatched row from rule overwrite", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({ source: "manual", matched: false, score: null }),
    );

    const result = await upsertMatchRow(
      { ...baseRow, source: "rule" },
      { now: () => NOW, jobStartedAt: T2 },
    );

    expect(result).toEqual({ skipped: true, reason: "manual_protected" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("protects an existing rule row from an older incoming llm batch result", async () => {
    // The race: install hook fires inline-for-skill at T1, writes source="rule"
    // (match_when: always). Earlier, at T0, an admin batch had already been
    // submitted with jobStartedAt=T0. Batch poll completes at T2, lands an
    // LLM result whose payload still carries jobStartedAt=T0 < T1. Without
    // the rule-precedence guard, the stale-write check passes (T0 < T1) — BUT we want
    // the deterministic rule row to win, not the probabilistic LLM result.
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({
        source: "rule",
        evaluatedAt: T2, // rule row was evaluated at T2 (the later wall-clock time)
        jobStartedAt: T2,
      }),
    );

    const result = await upsertMatchRow(
      { ...baseRow, source: "llm" },
      { now: () => NOW, jobStartedAt: T1 }, // incoming batch payload anchor T1 < T2
    );

    expect(result).toEqual({ skipped: true, reason: "rule_protected" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("blocks through evaluatedAt when jobStartedAt alone would allow the write", async () => {
    // Specifically: existing.jobStartedAt = T0, existing.evaluatedAt = T2,
    // incoming.jobStartedAt = T1 (T0 < T1 < T2). The stale-write guard
    // (strict-newer) does NOT fire (T1 > T0); only the rule_protected
    // guard (compares against existing.evaluatedAt) blocks the write.
    // This proves the guard covers a behavior jobStartedAt-only comparison misses.
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({
        source: "rule",
        jobStartedAt: T0,
        evaluatedAt: T2,
      }),
    );

    const result = await upsertMatchRow(
      { ...baseRow, source: "llm" },
      { now: () => NOW, jobStartedAt: T1 },
    );

    expect(result).toEqual({ skipped: true, reason: "rule_protected" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("allows an equal-timestamp incoming llm row through the rule-precedence boundary", async () => {
    // Equal timestamps fall through this guard (boundary is strict <). They
    // either hit the stale-write guard (which is also strict <) or
    // last-writer-wins per UPSERT-04. Last-writer-wins is acceptable for the
    // exact-tie case.
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({
        source: "rule",
        evaluatedAt: T1,
        jobStartedAt: T1,
      }),
    );
    vi.mocked(store.upsertSkillMatch).mockResolvedValue();

    const result = await upsertMatchRow(
      { ...baseRow, source: "llm" },
      { now: () => NOW, jobStartedAt: T1 },
    );

    // T1 < T1 is false → guard does not fire → falls to last-writer-wins → write happens.
    expect(result).toEqual({ skipped: false });
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
  });

  it("does not rule-protect an existing llm row from an older incoming rule row", async () => {
    // Install hook fires a fresh rule row that's older than an existing LLM
    // row from yesterday's batch. The intent is for the rule row to UPGRADE
    // the LLM row to the deterministic source. We don't want to block this.
    // The stale-write guard will reject it if rule.jobStartedAt is
    // strictly older than llm.jobStartedAt — which is the standard
    // last-writer-wins behavior, not a rule-precedence violation.
    vi.mocked(store.readSkillMatch).mockResolvedValue(
      existingRow({
        source: "llm",
        evaluatedAt: T2,
        jobStartedAt: T2,
      }),
    );

    const result = await upsertMatchRow(
      { ...baseRow, source: "rule" },
      { now: () => NOW, jobStartedAt: T1 },
    );

    // Falls through the rule_protected guard (existing is llm, not rule), hits
    // the stale_job_started_at guard (T1 < T2).
    expect(result).toEqual({ skipped: true, reason: "stale_job_started_at" });
    expect(store.upsertSkillMatch).not.toHaveBeenCalled();
  });

  it("redacts error_message to <=1024 bytes before write", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockResolvedValue();

    const giantGarbage = "g".repeat(5120);
    const errRow = {
      ...baseRow,
      status: "error" as const,
      errorCode: "llm_schema_violation",
      errorMessage: giantGarbage,
      score: 0,
      matched: false,
      rationale: null,
    };

    await upsertMatchRow(errRow, { now: () => NOW, jobStartedAt: T2 });

    const [written] = vi.mocked(store.upsertSkillMatch).mock.calls[0];
    expect(written.errorMessage).not.toBeNull();
    if (written.errorMessage !== null) {
      expect(Buffer.byteLength(written.errorMessage, "utf-8")).toBeLessThanOrEqual(1024);
      expect(written.errorMessage.endsWith("…[truncated to 1 KiB]")).toBe(true);
    }
  });

  it("redactErrorMessage byte-cap helper holds for any input", () => {
    expect(Buffer.byteLength(redactErrorMessage("a".repeat(5000)), "utf-8")).toBeLessThanOrEqual(1024);
    // No-op for short inputs.
    const small = "ok";
    expect(redactErrorMessage(small)).toBe(small);
  });
});
