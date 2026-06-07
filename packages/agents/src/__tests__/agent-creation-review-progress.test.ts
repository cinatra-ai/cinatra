/**
 * `agent_creation_review` progress emit points.
 *
 * Verifies the additive plumbing wired into handleAgentCreationReview:
 *  - WITHOUT progressContext on input -> ZERO progress emits (existing
 *    baseline tests stay green; emit is a no-op).
 *  - WITH progressContext.runId + HumanUser actor -> emits at LEAST
 *    `validating`, `review_started`, `security_review_running`,
 *    `code_review_running`, `review_done`. The planner_running emit is
 *    conditional on planneIsApplicable (non-trivial OAS).
 *  - WITH progressContext + non-HumanUser actor -> NO emits (fanout-escalation
 *    guard).
 *
 * The agent-creation-review code path imports `@cinatra-ai/notifications/server`
 * dynamically inside `emitMilestoneIfThreaded`; we vi.mock it to capture
 * progress calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLlmTask, mockSkillAwareLlmTask, mockSafeEmit } = vi.hoisted(() => ({
  mockLlmTask: vi.fn(async () => ({ text: '{"findings":[]}' })),
  mockSkillAwareLlmTask: vi.fn(async () => ({ text: '{"findings":[]}' })),
  mockSafeEmit: vi.fn(async (_args: unknown) => undefined),
}));

// Re-export the real abstract base from its source file (vitest resolution
// failure on @cinatra-ai/openai-connector chain when going via the package
// index -- same defensive pattern as agent-creation-review.test.ts).
const { AnthropicSkillDeliveryError } = await vi.hoisted(async () => {
  return await import("../../../llm/src/errors");
});

vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: mockLlmTask,
  runSkillAwareDeterministicLlmTask: mockSkillAwareLlmTask,
  AnthropicSkillDeliveryError,
}));

vi.mock("@cinatra-ai/skills", () => ({
  createDeterministicSkillsClient: () => ({
    installed: {
      resolveForAgent: () => Promise.resolve({ skillIds: [] }),
    },
  }),
}));

vi.mock("@cinatra-ai/anthropic-connector", () => ({
  getConfiguredAnthropicConnection: () => Promise.resolve(null),
}));

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mockSafeEmit,
}));

import { handleAgentCreationReview } from "../agent-creation-review";

const TRIVIAL_OAS_JSON = JSON.stringify({
  // Non-trivial: planner lane applies.
  oas_flow_version: "26.1.0",
  spec: {
    info: { title: "test", version: "0.0.0" },
    paths: {
      "/start": {
        post: {
          operationId: "start",
          summary: "stub",
          responses: { 200: { description: "ok" } },
        },
      },
    },
  },
  flow: {
    nodes: [
      {
        id: "start",
        type: "StartNode",
        inputs: { topic: { type: "string", description: "stub" } },
      },
      {
        id: "api",
        type: "ApiNode",
        data: { operationId: "start" },
      },
    ],
    edges: [{ from: "start", to: "api" }],
  },
});

const HUMAN_ACTOR = {
  actorType: "human" as const,
  userId: "user-1",
  source: "mcp" as const,
};

beforeEach(() => mockSafeEmit.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("handleAgentCreationReview progress plumbing", () => {
  it("WITHOUT progressContext: zero progress emits (parity with baseline tests)", async () => {
    await handleAgentCreationReview({
      input: {
        oasJson: TRIVIAL_OAS_JSON,
        packageSlug: "@cinatra-ai/test-agent",
      },
      actor: HUMAN_ACTOR,
    });
    expect(mockSafeEmit).not.toHaveBeenCalled();
  });

  it("WITH progressContext + HumanUser actor: emits validating + review_started + lane *_running + review_done", async () => {
    await handleAgentCreationReview({
      input: {
        oasJson: TRIVIAL_OAS_JSON,
        packageSlug: "@cinatra-ai/test-agent",
        progressContext: { runId: "r-1" },
      },
      actor: HUMAN_ACTOR,
    });
    const milestones = mockSafeEmit.mock.calls.map(
      (c) => (c[0] as { milestone: string }).milestone,
    );
    expect(milestones).toContain("validating");
    expect(milestones).toContain("review_started");
    expect(milestones).toContain("security_review_running");
    expect(milestones).toContain("code_review_running");
    expect(milestones).toContain("review_done");
    // syncing_skills only emits under an ACTIVE Anthropic pin (mocked off here).
    expect(milestones).not.toContain("syncing_skills");
  });

  it("WITH progressContext + non-HumanUser actor: NO emits (fanout guard)", async () => {
    const SERVICE_ACTOR = {
      actorType: "system" as const,
      userId: undefined,
      source: "agent" as const,
    };
    await handleAgentCreationReview({
      input: {
        oasJson: TRIVIAL_OAS_JSON,
        packageSlug: "@cinatra-ai/test-agent",
        progressContext: { runId: "r-2" },
      },
      actor: SERVICE_ACTOR,
    });
    expect(mockSafeEmit).not.toHaveBeenCalled();
  });

  it("WITH progressContext + HumanUser actor but missing userId: NO emits", async () => {
    const HUMAN_NO_ID = {
      actorType: "human" as const,
      userId: undefined,
      source: "mcp" as const,
    };
    await handleAgentCreationReview({
      input: {
        oasJson: TRIVIAL_OAS_JSON,
        packageSlug: "@cinatra-ai/test-agent",
        progressContext: { runId: "r-3" },
      },
      actor: HUMAN_NO_ID,
    });
    expect(mockSafeEmit).not.toHaveBeenCalled();
  });
});
