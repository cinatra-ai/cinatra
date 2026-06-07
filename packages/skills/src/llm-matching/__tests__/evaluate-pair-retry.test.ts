/**
 * evaluatePair performs a single in-call retry on schema violation.
 *
 * When `parseLlmResponse` returns `{ ok: false }` on the first attempt,
 * `evaluatePair` issues ONE retry against the same prompt. If the retry
 * also fails, the persisted error row is tagged `[after-retry] …` so
 * retry frequency is observable without a new column. If the retry
 * succeeds, a normal `source="llm", status="ok"` row is written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store so upsertMatchRow doesn't try to talk to Postgres.
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
import type { AgentForMatching, SkillForMatching } from "../types";

const NOW = new Date("2026-05-11T12:00:00Z");
const JOB_STARTED = new Date("2026-05-11T12:00:00Z");

const agent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Outreach",
  description: "Sends outreach emails to leads",
  tags: ["sales", "email"],
};

const skill: SkillForMatching = {
  skillId: "skill-1",
  name: "Spanish Email Localization",
  level: "third-party",
  content: "# Spanish Email\nLocalize emails to Spanish.\n",
  matchWhenRaw: undefined,
};

const VALID_RESPONSE = JSON.stringify({
  matched: true,
  score: 0.9,
  rationale: "Applicable to email outreach.",
});

describe("evaluate-pair retry", () => {
  beforeEach(() => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
  });

  it("RETRY-01: invalid → invalid → persists [after-retry]-prefixed error row", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "not json", finishReason: "stop" })
      .mockResolvedValueOnce({ text: "still not json", finishReason: "stop" });

    const result = await evaluatePair(
      { agent, skill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: JOB_STARTED, generate: generate as any },
    );

    // Two `generate` calls: first attempt + one retry.
    expect(generate).toHaveBeenCalledTimes(2);
    // Final row is persisted as an error.
    expect(result.row?.status).toBe("error");
    expect(result.row?.errorCode).toBe("llm_schema_violation");
    expect(result.row?.errorMessage).not.toBeNull();
    expect(result.row?.errorMessage?.startsWith("[after-retry] ")).toBe(true);
    expect(vi.mocked(store.upsertSkillMatch)).toHaveBeenCalledTimes(1);
    const [written] = vi.mocked(store.upsertSkillMatch).mock.calls[0];
    expect(written.status).toBe("error");
    expect(written.errorMessage?.startsWith("[after-retry] ")).toBe(true);
  });

  it("RETRY-02: invalid → valid → persists clean ok row (no [after-retry] marker on success)", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "totally bogus", finishReason: "stop" })
      .mockResolvedValueOnce({ text: VALID_RESPONSE, finishReason: "stop" });

    const result = await evaluatePair(
      { agent, skill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: JOB_STARTED, generate: generate as any },
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.row?.status).toBe("ok");
    expect(result.row?.matched).toBe(true);
    expect(result.row?.score).toBe(0.9);
    expect(result.row?.rationale).toBe("Applicable to email outreach.");
    expect(result.row?.errorMessage).toBeNull();
    // The success row has no retry marker — the marker is only for error rows.
    expect(vi.mocked(store.upsertSkillMatch)).toHaveBeenCalledTimes(1);
    const [written] = vi.mocked(store.upsertSkillMatch).mock.calls[0];
    expect(written.status).toBe("ok");
    expect(written.errorMessage).toBeNull();
  });

  it("RETRY-03: valid on first attempt → no retry (only one generate call)", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: VALID_RESPONSE, finishReason: "stop" });

    const result = await evaluatePair(
      { agent, skill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: JOB_STARTED, generate: generate as any },
    );

    // Only ONE generate call — retry path not entered.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.row?.status).toBe("ok");
    expect(result.row?.errorMessage).toBeNull();
  });
});
