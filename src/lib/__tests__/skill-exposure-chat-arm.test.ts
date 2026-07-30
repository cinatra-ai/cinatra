// cinatra#2240 — the ONE exposure/efficacy rollup consumes the chat delivery
// record (acceptance 2: "no parallel bookkeeping").
//
// `agent_run_skills_used.run_id` is `NOT NULL REFERENCES agent_runs(id)`, and a
// chat turn has no agent run — so chat delivery is a SECOND SOURCE
// (`assistant_turn_skill_delivery`) feeding the SAME aggregate. These cases pin
// the union's contract, and in particular the defect it must not introduce:
//
//   Chat mounts OpenAI skills with `invocation_attributable = true` (truthfully
//   — that is what the adapter reports), but the chat path wires no
//   `onSkillRead` invocation signal, so a chat-delivered skill's invocation
//   count can only ever be 0. If chat exposures counted toward the
//   deprecation-candidate sample, ~20 ordinary chat turns would flag a
//   perfectly healthy skill for deprecation. The chat arm is therefore
//   candidate-INELIGIBLE by construction.

import { describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.hoisted(() => vi.fn(() => [{ rows: [] }]));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://localhost/test",
  postgresSchema: "testschema",
}));

import { readSkillExposureAggregates } from "@/lib/agent-run-skills-used";
import {
  isDeprecationCandidate,
  SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE as MIN,
} from "@/lib/skill-efficacy";

function queryTextFor(): string {
  runPostgresQueriesSync.mockClear();
  runPostgresQueriesSync.mockReturnValueOnce([{ rows: [] }] as never);
  readSkillExposureAggregates();
  const call = runPostgresQueriesSync.mock.calls[0][0] as unknown as {
    queries: Array<{ text: string }>;
  };
  return call.queries[0].text;
}

describe("readSkillExposureAggregates unions the chat delivery record", () => {
  it("reads BOTH sources in ONE rollup — no second efficacy computation", () => {
    const text = queryTextFor();
    expect(text).toContain('"testschema"."agent_run_skills_used"');
    expect(text).toContain('"testschema"."assistant_turn_skill_delivery"');
    expect(text).toContain("UNION ALL");
    expect(text).toContain("GROUP BY skill_id");
  });

  it("counts ONLY delivered chat rows — a drop or a refusal is not an exposure", () => {
    const text = queryTextFor();
    expect(text).toContain("WHERE outcome = 'delivered'");
  });

  it("namespaces the distinct-source key so unrelated agent-run and chat-turn ids cannot collide", () => {
    const text = queryTextFor();
    expect(text).toContain("'agent:' || run_id");
    expect(text).toContain("'chat:' || turn_id");
    expect(text).toContain("COUNT(DISTINCT source_key)");
  });

  it("marks the chat arm candidate-INELIGIBLE and the agent arm eligible", () => {
    const text = queryTextFor();
    expect(text).toContain("TRUE AS candidate_eligible");
    expect(text).toContain("FALSE AS candidate_eligible");
    expect(text).toContain("WHERE candidate_eligible AND invocation_attributable IS TRUE");
  });

  it("contributes 0 invocations from chat (the path observes none)", () => {
    expect(queryTextFor()).toContain("0 AS invocation_count");
  });

  it("maps the aggregate row shape unchanged", () => {
    runPostgresQueriesSync.mockClear();
    runPostgresQueriesSync.mockReturnValueOnce([
      {
        rows: [
          {
            skill_id: "@cinatra-ai/a",
            exposure_run_count: "31",
            attributable_exposure_run_count: "0",
            invocation_count: "0",
            last_exposed_at: "2026-07-30T10:00:00.000Z",
            delivery_modes: ["openai_shell"],
          },
        ],
      },
    ] as never);
    expect(readSkillExposureAggregates()).toEqual([
      {
        skillId: "@cinatra-ai/a",
        exposureRunCount: 31,
        attributableExposureRunCount: 0,
        invocationCount: 0,
        lastExposedAt: "2026-07-30T10:00:00.000Z",
        deliveryModes: ["openai_shell"],
      },
    ]);
  });
});

describe("chat exposure can never manufacture a deprecation candidate", () => {
  it("a skill delivered on many chat turns and never invoked is NOT a candidate", () => {
    // The shape the union produces for a chat-only skill: plenty of raw
    // exposure, zero CANDIDATE-ELIGIBLE attributable exposure.
    expect(
      isDeprecationCandidate({
        lifecycleState: "active",
        dismissedAt: null,
        invocationCount: 0,
        attributableExposureRunCount: 0,
      }),
    ).toBe(false);
  });

  it("the agent arm's candidate rule is untouched — it still flags at the minimum sample", () => {
    expect(
      isDeprecationCandidate({
        lifecycleState: "active",
        dismissedAt: null,
        invocationCount: 0,
        attributableExposureRunCount: MIN,
      }),
    ).toBe(true);
  });
});
