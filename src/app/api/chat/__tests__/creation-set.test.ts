/**
 * Standing-invariant sentinel for the `CREATION_FLOW_PACKAGES` set.
 *
 * This is a deliberately tiny, self-contained regression file (separate from
 * explicit-dispatch-preflight.test.ts) whose ONLY job is to fail loudly the
 * moment the creation-flow package set changes. The chat dispatch preflight
 * gate keys off membership in this set; a silent add/remove would either
 * (a) start gating an unrelated package, or (b) stop gating a creation agent.
 *
 * Mock prelude mirrors explicit-dispatch-preflight.test.ts — required only so
 * `../explicit-dispatch-server` is import-safe (its dynamic-import deps are
 * never exercised by these pure set assertions).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/service", () => ({
  safeEmitAgentCreationProgress: vi.fn(async () => undefined),
}));
vi.mock("@/lib/database", () => ({
  isAgentCreationPinActive: () => false,
}));
vi.mock("@cinatra-ai/agents", () => ({
  preflightAgentCreation: vi.fn(),
  resolveRequiredCreationSkillIds: vi.fn(),
  createAgentBuilderPrimitiveHandlers: () => ({}),
  readPublishedAgentTemplates: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(() => ({})),
  invokePrimitive: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(async () => ({ text: "{}" })),
}));

import { CREATION_FLOW_PACKAGES } from "../explicit-dispatch-server";

const EXPECTED = [
  "@cinatra-ai/author-agent",
  "@cinatra-ai/code-reviewer-agent",
  "@cinatra-ai/planner-agent",
  "@cinatra-ai/security-reviewer-agent",
];

describe("CREATION_FLOW_PACKAGES standing invariant", () => {
  it("has exactly 4 members (no silent growth/shrink)", () => {
    expect(CREATION_FLOW_PACKAGES.size).toBe(4);
  });

  it("is EXACTLY the canonical 4-package creation-flow set", () => {
    expect(Array.from(CREATION_FLOW_PACKAGES).sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });

  it("contains each canonical creation package and nothing else", () => {
    for (const pkg of EXPECTED) {
      expect(CREATION_FLOW_PACKAGES.has(pkg)).toBe(true);
    }
    // lint-policy is deterministic + skill-free — intentionally NOT gated.
    expect(CREATION_FLOW_PACKAGES.has("@cinatra-ai/lint-policy-agent")).toBe(
      false,
    );
    // A non-creation package must never be in the gate set.
    expect(CREATION_FLOW_PACKAGES.has("@cinatra-ai/email-test-delivery-agent")).toBe(
      false,
    );
  });
});
