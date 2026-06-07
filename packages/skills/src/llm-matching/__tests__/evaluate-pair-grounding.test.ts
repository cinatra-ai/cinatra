/**
 * Integration tests for the rationale-grounding guard inside evaluate-pair.ts.
 * The guard ONLY runs on matched=true rows; matched=false passes through
 * unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { UNGROUNDED_RATIONALE_FALLBACK } from "../rationale-grounding";
import type { AgentForMatching, SkillForMatching } from "../types";

const NOW = new Date("2026-05-11T12:00:00Z");

const agent: AgentForMatching = {
  packageId: "@cinatra-ai/email-outreach-agent",
  name: "Email Outreach Agent",
  description: "Drafts cold emails to leads in a contact list.",
  tags: ["email", "outreach", "cold-email", "sales"],
};

const groundableSkill: SkillForMatching = {
  skillId: "skill-cold-email-template",
  name: "Cold Email Template",
  level: "third-party",
  content:
    "# Cold Email Template\n\nProvides reusable cold-email opener variants for outbound sales. Includes subject-line patterns optimized for response rates and personalization placeholders for company name and prospect role.",
  matchWhenRaw: "",
};

describe("evaluate-pair grounding guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(store.readSkillMatch).mockResolvedValue(null);
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("GROUND-INT-01: matched=true + grounded rationale → row preserves LLM rationale verbatim, no warn", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        matched: true,
        score: 0.92,
        rationale:
          "Skill provides cold-email opener templates with personalization for company name — directly aligned with this outreach agent's job.",
      }),
      finishReason: "stop",
    });

    const result = await evaluatePair(
      { agent, skill: groundableSkill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: NOW, generate: generate as any },
    );

    expect(result.row?.matched).toBe(true);
    expect(result.row?.rationale).toContain("cold-email");
    expect(result.row?.rationale).not.toEqual(UNGROUNDED_RATIONALE_FALLBACK);

    const ungroundedEvents = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string")
      .filter((s) => s.includes("skill-match-ungrounded-rationale"));
    expect(ungroundedEvents).toHaveLength(0);
  });

  it("GROUND-INT-02: matched=true + fabricated rationale → row gets fallback + structured warn", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        matched: true,
        score: 0.87,
        rationale:
          "The recommendation aligns with quarterly performance benchmarks and stakeholder expectations from prior reviews.",
      }),
      finishReason: "stop",
    });

    const result = await evaluatePair(
      { agent, skill: groundableSkill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: NOW, generate: generate as any },
    );

    // Decision preserved — only the rationale is downgraded.
    expect(result.row?.matched).toBe(true);
    expect(result.row?.score).toBe(0.87);
    expect(result.row?.status).toBe("ok");
    expect(result.row?.rationale).toBe(UNGROUNDED_RATIONALE_FALLBACK);

    // Structured warning emitted with hashed rationale. Verbatim rationale is
    // NOT logged, keeping the warning PII-safe while hash + length remain
    // sufficient for log-correlation across occurrences.
    const events = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string")
      .map((s) => {
        try {
          return JSON.parse(s) as {
            event?: string;
            originalRationale?: string;
            originalRationaleHash?: string;
            originalRationaleLength?: number;
            overlapRatio?: number;
            agentId?: string;
            skillId?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(
        (m): m is NonNullable<typeof m> =>
          !!m && m.event === "skill-match-ungrounded-rationale",
      );
    expect(events.length).toBe(1);
    expect(events[0].agentId).toBe("@cinatra-ai/email-outreach-agent");
    expect(events[0].skillId).toBe("skill-cold-email-template");
    // PII-safe: verbatim rationale must NOT appear; hash + length must.
    expect(events[0].originalRationale).toBeUndefined();
    expect(events[0].originalRationaleHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].originalRationaleLength).toBeGreaterThan(0);
    expect(events[0].overlapRatio).toBeLessThan(0.2);
  });

  it("GROUND-INT-03: matched=false + fabricated rationale → row preserves rationale verbatim (no grounding check on negatives)", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        matched: false,
        score: 0.05,
        rationale:
          "Stakeholder benchmark performance review — irrelevant content but valid for a negative match.",
      }),
      finishReason: "stop",
    });

    const result = await evaluatePair(
      { agent, skill: groundableSkill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: NOW, generate: generate as any },
    );

    expect(result.row?.matched).toBe(false);
    expect(result.row?.rationale).toContain("Stakeholder benchmark");
    expect(result.row?.rationale).not.toEqual(UNGROUNDED_RATIONALE_FALLBACK);

    const ungroundedEvents = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string")
      .filter((s) => s.includes("skill-match-ungrounded-rationale"));
    expect(ungroundedEvents).toHaveLength(0);
  });

  it("GROUND-INT-04: ungrounded warning carries evaluatorVersion + sharedTokens for audit", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        matched: true,
        score: 0.85,
        rationale:
          "Aligned with quarterly review benchmarks across stakeholder cohort surveys.",
      }),
      finishReason: "stop",
    });

    await evaluatePair(
      { agent, skill: groundableSkill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { now: () => NOW, jobStartedAt: NOW, generate: generate as any },
    );

    const event = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string")
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .find(
        (m: { event?: string } | null) =>
          !!m && m.event === "skill-match-ungrounded-rationale",
      );
    expect(event).toBeDefined();
    expect(event.evaluatorVersion).toMatch(/^llm-matcher-v/);
    expect(Array.isArray(event.sharedTokens)).toBe(true);
    expect(event.rationaleTokenCount).toBeGreaterThan(0);
  });
});
