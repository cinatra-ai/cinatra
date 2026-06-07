import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentForMatching, SkillForMatching } from "../types";

const { orchestrateGenerateMock } = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));

vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import { parseMatchWhen } from "../match-when-parser";
import { evaluatePair } from "../evaluate-pair";
import { buildPromptForPair } from "../prompt-builder";

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email"],
};

const skillWith = (matchWhenRaw: string | undefined): SkillForMatching => ({
  skillId: "skill-x",
  name: "skill-x",
  level: "system",
  content: "skill body",
  matchWhenRaw,
});

const NOW = new Date("2026-05-11T12:00:00Z");
const MALFORMED_RAW = "this: is: malformed: yaml: { unbalanced";

describe("match-when malformed warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    orchestrateGenerateMock.mockReset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("malformed match_when logs structured warning with all four fields", () => {
    parseMatchWhen(MALFORMED_RAW, "skill-x");

    // exactly one matching warning event
    const events = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((m): m is string => typeof m === "string")
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(
        (obj): obj is Record<string, unknown> =>
          obj !== null && (obj as Record<string, unknown>).event === "skill_match_when_malformed",
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "skill_match_when_malformed",
      skillId: "skill-x",
      raw: MALFORMED_RAW,
    });
    expect(typeof events[0].error).toBe("string");
  });

  it("malformed match_when raw text flows into the LLM prompt as hint", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: true, score: 0.5, rationale: "ok" }),
    });

    await evaluatePair(
      { agent: baseAgent, skill: skillWith(MALFORMED_RAW) },
      { now: () => NOW, jobStartedAt: NOW },
    );

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    const call = orchestrateGenerateMock.mock.calls[0][0] as { system: string; prompt: string };
    expect(`${call.system}\n${call.prompt}`).toContain(MALFORMED_RAW);

    // Sanity: the same prompt-builder invocation also contains it directly.
    const { system, user } = buildPromptForPair(baseAgent, skillWith(MALFORMED_RAW));
    expect(`${system}\n${user}`).toContain(MALFORMED_RAW);
  });

  it("malformed match_when does NOT short-circuit; LLM is called exactly once", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: false, score: 0, rationale: "n/a" }),
    });

    await evaluatePair(
      { agent: baseAgent, skill: skillWith(MALFORMED_RAW) },
      { now: () => NOW, jobStartedAt: NOW },
    );

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
  });

  it("well-formed match_when does NOT log a malformed warning", () => {
    parseMatchWhen("- always", "skill-x");
    const events = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((m): m is string => typeof m === "string")
      .filter((s) => s.includes("skill_match_when_malformed"));
    expect(events).toHaveLength(0);
  });
});
