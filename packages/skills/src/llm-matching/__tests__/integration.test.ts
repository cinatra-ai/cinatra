/**
 * Cross-path integration regression for the evaluator-core round-trip.
 *
 * Coverage targets (3 cases):
 *  - Happy path: mocked generate returns a valid
 *    structured-output JSON; evaluatePair upserts a SkillMatchRow with
 *    source="llm", matched=true, score=0.9, evaluatorVersion=LLM_MATCHER_VERSION,
 *    status="ok".
 *  - Error path end-to-end: mocked generate returns
 *    non-JSON text; evaluatePair upserts a row with source="llm", matched=false,
 *    score=0, status="error", errorCode="llm_schema_violation", and (when input
 *    is >1 KiB) errorMessage ends with "…[truncated to 1 KiB]".
 *  - Inline + batch parity: given identical model output, the
 *    inline path (via evaluatePair) and a synthetic batch-result-line driven
 *    through parseLlmResponse + upsertMatchRow with the same hash inputs
 *    produce IDENTICAL SkillMatchRow payloads (with deterministic timestamps
 *    via vi.setSystemTime + injected deps).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentForMatching, SkillForMatching, SkillMatchRow } from "../types";

// --- Mock the LLM gateway BEFORE importing evaluatePair. ---
const { orchestrateGenerateMock } = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));

// --- Mock the persistence boundary so we assert what was written. ---
vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import * as store from "../skill-matches-store";
import { evaluatePair } from "../evaluate-pair";
import { parseLlmResponse } from "../response-parser";
import { upsertMatchRow } from "../upsert";
import { computeInputHashes } from "../hashes";
import { LLM_MATCHER_VERSION } from "../constants";

const NOW = new Date("2026-05-11T10:00:00Z");

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email", "outreach"],
};

const baseSkill: SkillForMatching = {
  skillId: "skill-integration-1",
  name: "Email Compose",
  level: "system",
  content: "Use this skill to compose marketing emails.",
};

describe("evaluator-core integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    orchestrateGenerateMock.mockReset();
    vi.mocked(store.readSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("valid LLM response → ok llm row persisted with expected shape", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: true, score: 0.9, rationale: "good" }),
    });

    const result = await evaluatePair(
      { agent: baseAgent, skill: baseSkill },
      { now: () => NOW, jobStartedAt: NOW },
    );

    expect(result.skipped).toBe(false);
    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);

    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.agentId).toBe("@cinatra/email-agent");
    expect(written.skillId).toBe("skill-integration-1");
    expect(written.source).toBe("llm");
    expect(written.matched).toBe(true);
    expect(written.score).toBe(0.9);
    expect(written.rationale).toBe("good");
    expect(written.evaluatorVersion).toBe(LLM_MATCHER_VERSION);
    expect(written.status).toBe("ok");
    expect(written.errorCode).toBeNull();
    expect(written.errorMessage).toBeNull();
    expect(written.evaluatedAt).toEqual(NOW);
    expect(written.jobStartedAt).toEqual(NOW);
    // Hash invariants: stable, hex 64
    expect(written.agentInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(written.skillInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("non-JSON LLM response → error row, redacted error_message ≤1 KiB", async () => {
    // Build a payload >1 KiB to force the truncation marker.
    const giantGarbage = "this is not json ".repeat(200); // ~3400 bytes
    orchestrateGenerateMock.mockResolvedValue({ text: giantGarbage });

    const result = await evaluatePair(
      { agent: baseAgent, skill: baseSkill },
      { now: () => NOW, jobStartedAt: NOW },
    );

    expect(result.skipped).toBe(false);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);

    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.source).toBe("llm");
    expect(written.matched).toBe(false);
    expect(written.score).toBe(0);
    expect(written.rationale).toBeNull();
    expect(written.status).toBe("error");
    expect(written.errorCode).toBe("llm_schema_violation");
    expect(written.errorMessage).not.toBeNull();
    if (written.errorMessage !== null) {
      expect(Buffer.byteLength(written.errorMessage, "utf-8")).toBeLessThanOrEqual(1024);
      expect(written.errorMessage.endsWith("…[truncated to 1 KiB]")).toBe(true);
    }
  });

  it("identical model output produces identical row payload via either path", async () => {
    const modelOutputText = JSON.stringify({
      matched: true,
      score: 0.75,
      rationale: "inline-vs-batch parity",
    });

    // ---- INLINE path ----
    orchestrateGenerateMock.mockResolvedValue({ text: modelOutputText });
    await evaluatePair(
      { agent: baseAgent, skill: baseSkill },
      { now: () => NOW, jobStartedAt: NOW },
    );
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const inlineRow = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];

    // ---- BATCH path (synthetic): parse the same model text via the
    // parser the batch poller uses, build the same row, and upsert.
    vi.mocked(store.upsertSkillMatch).mockClear();
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(null);

    const parsed = parseLlmResponse(modelOutputText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable: parsed.ok asserted true above");

    const { agentInputHash, skillInputHash } = computeInputHashes(baseAgent, baseSkill);
    const batchRow: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt"> = {
      agentId: baseAgent.packageId,
      skillId: baseSkill.skillId,
      source: "llm",
      matched: parsed.value.matched,
      score: parsed.value.score,
      rationale: parsed.value.rationale,
      evaluatorVersion: LLM_MATCHER_VERSION,
      agentInputHash,
      skillInputHash,
      status: "ok",
      errorCode: null,
      errorMessage: null,
    };
    await upsertMatchRow(batchRow, { now: () => NOW, jobStartedAt: NOW });
    const synthBatchRow = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];

    // Parity: every persisted field is identical across the two paths.
    expect(synthBatchRow).toEqual(inlineRow);
  });
});
