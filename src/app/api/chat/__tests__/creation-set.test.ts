/**
 * Wiring sentinel for the `CREATION_FLOW_PACKAGES` export.
 *
 * The set is now DERIVED: `explicit-dispatch-server.ts` re-exports
 * `getAgentCreationFlowPackages()` from the agents package (the creation
 * skill-lane definitions) instead of carrying a hand-maintained literal set.
 * The REAL derivation sentinel (pinning the canonical 4 against the actual
 * lane modules) lives in
 * `packages/agents/src/__tests__/creation-flow-packages.test.ts`; THIS file
 * asserts the chat-side wiring — that the exported set is exactly what the
 * agents-package derivation returns and that gate membership behaves.
 *
 * Mock prelude mirrors explicit-dispatch-preflight.test.ts — required only so
 * `../explicit-dispatch-server` is import-safe (its dynamic-import deps are
 * never exercised by these pure set assertions). The mocked derivation
 * returns the canonical 4 — the same values the real sentinel pins.
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
  getAgentCreationFlowPackages: () =>
    new Set([
      "@cinatra-ai/planner-agent",
      "@cinatra-ai/code-reviewer-agent",
      "@cinatra-ai/security-reviewer-agent",
      "@cinatra-ai/author-agent",
    ]),
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
