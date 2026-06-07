/**
 * AbortSignal propagation through `evaluatePair`.
 *
 * When BullMQ cancels a job mid-flight (admin stops a stuck batch, queue
 * is drained for shutdown), the in-flight OpenAI call would otherwise keep
 * going and a row eventually lands in the DB. This file asserts that:
 *
 *   1. A pre-aborted signal short-circuits BEFORE calling `generate()`.
 *   2. The signal is forwarded to the `generate()` call so the underlying
 *      OpenAI HTTP client can abort the in-flight request.
 *   3. An abort triggered while awaiting `generate()` propagates as an
 *      AbortError and prevents any DB write.
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

describe("evaluate-pair AbortSignal", () => {
  beforeEach(() => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
  });

  it("ABORT-01: pre-aborted signal short-circuits BEFORE any generate() call AND throws AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn();

    await expect(
      evaluatePair(
        { agent, skill },
        {
          now: () => NOW,
          jobStartedAt: JOB_STARTED,
          signal: controller.signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          generate: generate as any,
        },
      ),
    ).rejects.toThrow(/abort/i);

    expect(generate).not.toHaveBeenCalled();
    expect(vi.mocked(store.upsertSkillMatch)).not.toHaveBeenCalled();
  });

  it("ABORT-02: signal is forwarded to generate() so the OpenAI HTTP client can cancel", async () => {
    const controller = new AbortController();
    const generate = vi.fn().mockResolvedValueOnce({
      text: VALID_RESPONSE,
      finishReason: "stop",
    });

    await evaluatePair(
      { agent, skill },
      {
        now: () => NOW,
        jobStartedAt: JOB_STARTED,
        signal: controller.signal,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generate: generate as any,
      },
    );

    // generate() was called once and the call carries the signal forward.
    expect(generate).toHaveBeenCalledTimes(1);
    const [callArgs] = generate.mock.calls[0];
    expect(callArgs.signal).toBe(controller.signal);
  });

  it("ABORT-03: signal aborted between generate() and upsert prevents DB write", async () => {
    const controller = new AbortController();
    const generate = vi
      .fn()
      // First call resolves, but we abort immediately afterwards (before parse).
      .mockImplementationOnce(async () => {
        controller.abort();
        return { text: VALID_RESPONSE, finishReason: "stop" };
      });

    await expect(
      evaluatePair(
        { agent, skill },
        {
          now: () => NOW,
          jobStartedAt: JOB_STARTED,
          signal: controller.signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          generate: generate as any,
        },
      ),
    ).rejects.toThrow(/abort/i);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.upsertSkillMatch)).not.toHaveBeenCalled();
  });

  it("ABORT-04 (negative): no signal → normal behavior, row is written", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: VALID_RESPONSE, finishReason: "stop" });

    const result = await evaluatePair(
      { agent, skill },
      {
        now: () => NOW,
        jobStartedAt: JOB_STARTED,
        // No signal passed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generate: generate as any,
      },
    );

    expect(result.row?.status).toBe("ok");
    expect(generate).toHaveBeenCalledTimes(1);
    // signal was not present in the input.
    const [callArgs] = generate.mock.calls[0];
    expect(callArgs.signal).toBeUndefined();
    expect(vi.mocked(store.upsertSkillMatch)).toHaveBeenCalledTimes(1);
  });
});
