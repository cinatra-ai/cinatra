/**
 * Standing-invariant sentinel for the DERIVED agent-creation-flow package set.
 *
 * The chat explicit-dispatch gate (`CREATION_FLOW_PACKAGES` in
 * `src/app/api/chat/explicit-dispatch-server.ts`) keys off
 * `getAgentCreationFlowPackages()`, which derives from the creation skill-lane
 * definitions this package owns (`REVIEWER_LANE_PACKAGES` +
 * `AUTHOR_AGENT_PACKAGE_NAME`). This sentinel pins the DERIVED set against the
 * REAL modules (no mocked set), so it fails loudly the moment a lane
 * definition changes — a silent add/remove would either start preflight-gating
 * an unrelated package or stop gating a creation agent.
 */

import { describe, expect, it, vi } from "vitest";

// Minimal import-safety mocks (mirrors agent-creation-review.test.ts): the
// lane modules import LLM/skills surfaces whose full package chains are
// unresolvable/slow in vitest's loader. The constants under test are
// module-level literals — these mocks never execute.
vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(),
  runSkillAwareDeterministicLlmTask: vi.fn(),
  AnthropicSkillDeliveryError: class extends Error {},
}));
vi.mock("@cinatra-ai/skills", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { resolveForAgent: () => Promise.resolve({ skillIds: [] }) },
  }),
}));

import { getAgentCreationFlowPackages } from "../creation-flow-packages";
import { REVIEWER_LANE_PACKAGES } from "../agent-creation-review";
import { AUTHOR_AGENT_PACKAGE_NAME } from "../run-author-agent";

const EXPECTED = [
  "@cinatra-ai/author-agent",
  "@cinatra-ai/code-reviewer-agent",
  "@cinatra-ai/planner-agent",
  "@cinatra-ai/security-reviewer-agent",
];

describe("getAgentCreationFlowPackages (derived creation-flow set)", () => {
  it("is EXACTLY the canonical 4-package creation-flow set", () => {
    const set = getAgentCreationFlowPackages();
    expect(set.size).toBe(4);
    expect(Array.from(set).sort()).toEqual([...EXPECTED].sort());
  });

  it("derives from the lane definitions (reviewer lanes + author lane)", () => {
    const set = getAgentCreationFlowPackages();
    for (const pkg of REVIEWER_LANE_PACKAGES) {
      expect(set.has(pkg)).toBe(true);
    }
    expect(set.has(AUTHOR_AGENT_PACKAGE_NAME)).toBe(true);
  });

  it("excludes non-lane agents by construction", () => {
    const set = getAgentCreationFlowPackages();
    // lint-policy is deterministic + skill-free — it is NOT a lane, and
    // gating it would false-fail anthropic_no_skills_resolved preflight.
    expect(set.has("@cinatra-ai/lint-policy-agent")).toBe(false);
    expect(set.has("@cinatra-ai/email-test-delivery-agent")).toBe(false);
  });

  it("returns a fresh set per call (callers cannot mutate shared state)", () => {
    const a = getAgentCreationFlowPackages() as Set<string>;
    const b = getAgentCreationFlowPackages();
    a.add("@cinatra-ai/not-a-real-agent");
    expect(b.has("@cinatra-ai/not-a-real-agent")).toBe(false);
    expect(getAgentCreationFlowPackages().size).toBe(4);
  });
});
