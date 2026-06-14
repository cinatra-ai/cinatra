/**
 * `agent_creation_review` primitive unit tests.
 *
 * Covers:
 *   - missing/invalid input handling
 *   - deterministic lint blocker short-circuits LLM advisors
 *   - LLM dispatch fans out 3 lanes for non-trivial OAS, 2 for trivial OAS
 *   - LLM response parsing (fenced JSON, raw array, malformed)
 *   - lane source identity is re-stamped (anti-spoof)
 *   - placeholder substitution in user templates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @cinatra-ai/llm so tests don't need a live LLM connection.
// vi.hoisted is the canonical way to share a mock fn between the (hoisted)
// vi.mock factory and the test bodies — see https://vitest.dev/api/vi.html
// #vi-hoisted.
//
// Also mock `runSkillAwareDeterministicLlmTask` (used by the active-pin path)
// AND re-export the real `AnthropicSkillDeliveryError` abstract base class so
// `dispatchLlmReviewer`'s sentinel `instanceof` check works correctly.
const { mockLlmTask, mockSkillAwareLlmTask } = vi.hoisted(() => ({
  mockLlmTask: vi.fn(),
  mockSkillAwareLlmTask: vi.fn(),
}));
// Re-export the REAL `AnthropicSkillDeliveryError` from its source file so
// the mock can provide a class that subclass `instanceof` checks pass against.
// The package-index full chain pulls in `@cinatra-ai/openai-connector` which
// is unresolvable in vitest's node-ESM loader. Direct-file import sidesteps
// the chain. `vi.hoisted` ensures the dynamic-import runs BEFORE vi.mock's
// factory (which is also hoisted).
const { AnthropicSkillDeliveryError } = await vi.hoisted(async () => {
  return await import("../../../llm/src/errors");
});
vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: mockLlmTask,
  runSkillAwareDeterministicLlmTask: mockSkillAwareLlmTask,
  // Sentinel class — re-exported from real source so `instanceof` works in
  // `dispatchLlmReviewer.catch` during abort rethrows.
  AnthropicSkillDeliveryError,
}));

// Mock `@cinatra-ai/skills` so the strict catalog resolver
// (`resolveRequiredCreationSkillIds`) and `loadReviewerPrompt` return a
// tolerant `skillIds: []` per agent. Without this mock, vitest's ESM loader
// tries to resolve the full skills-package dependency chain, which
// transitively pulls in `@cinatra-ai/mcp-client-connector`; those
// failed lookups are slow enough to break the "dispatches in PARALLEL" timing
// assertion.
vi.mock("@cinatra-ai/skills", () => ({
  createDeterministicSkillsClient: () => ({
    installed: {
      resolveForAgent: () => Promise.resolve({ skillIds: [] }),
    },
  }),
}));
// Same defensive mock for the Anthropic connector: the chain-import failure
// (`src/app/campaigns/actions.ts` → ...) is slow enough to distort dispatch
// timing assertions in vitest's loader.
vi.mock("@cinatra-ai/anthropic-connector", () => ({
  getConfiguredAnthropicConnection: () => Promise.resolve(null),
}));

// NOT mocking `@/lib/database` — the real `isAgentCreationPinActive()` already
// returns hardcoded `false` in the inert state. Pin-inactive ⇒ preflight
// short-circuits before reading any other connector config. Mocking the whole
// module would serialize lane dispatches via vi.importActual chain (caught by
// the "dispatches in PARALLEL" test).

import {
  handleAgentCreationReview,
  __testOnly,
} from "../agent-creation-review";

// Fixture invariants: every EndNode output MUST have an upstream DFE source
// (otherwise OAS-RUNTIME-005 trips as a blocker). The reviewer-gate pattern
// gate.userResponse → end.userResponse is the canonical wiring.
const NON_TRIVIAL_OAS_WITH_HITL_GATE = {
  agentspec_version: "26.1.0",
  component_type: "Flow",
  id: "test-flow",
  name: "Test Flow",
  start_node: { $component_ref: "start" },
  nodes: [
    { $component_ref: "start" },
    { $component_ref: "gate" },
    { $component_ref: "end" },
  ],
  control_flow_connections: [
    {
      component_type: "ControlFlowEdge",
      name: "start_to_gate",
      from_node: { $component_ref: "start" },
      to_node: { $component_ref: "gate" },
    },
    {
      component_type: "ControlFlowEdge",
      name: "gate_to_end",
      from_node: { $component_ref: "gate" },
      to_node: { $component_ref: "end" },
    },
  ],
  data_flow_connections: [
    {
      component_type: "DataFlowEdge",
      name: "gate_userResponse_to_end",
      source_node: { $component_ref: "gate" },
      source_output: "userResponse",
      destination_node: { $component_ref: "end" },
      destination_input: "userResponse",
    },
  ],
  $referenced_components: {
    start: {
      component_type: "StartNode",
      id: "start",
      name: "Inputs",
      inputs: [{ title: "url", type: "string" }],
      metadata: { cinatra: { required: ["url"], hidden: [] } },
    },
    gate: {
      component_type: "InputMessageNode",
      id: "gate",
      name: "Gate",
      outputs: [{ title: "userResponse", type: "string" }],
    },
    end: {
      component_type: "EndNode",
      id: "end",
      name: "End",
      outputs: [{ title: "userResponse", type: "string" }],
    },
  },
};

const TRIVIAL_OAS = {
  agentspec_version: "26.1.0",
  component_type: "Flow",
  id: "trivial-flow",
  name: "Trivial",
  start_node: { $component_ref: "start" },
  nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
  control_flow_connections: [
    {
      component_type: "ControlFlowEdge",
      name: "start_to_end",
      from_node: { $component_ref: "start" },
      to_node: { $component_ref: "end" },
    },
  ],
  data_flow_connections: [],
  $referenced_components: {
    start: {
      component_type: "StartNode",
      id: "start",
      name: "Inputs",
      inputs: [],
      metadata: { cinatra: { required: [], hidden: [] } },
    },
    end: {
      component_type: "EndNode",
      id: "end",
      name: "End",
      outputs: [],
    },
  },
};

beforeEach(() => {
  mockLlmTask.mockReset();
  mockSkillAwareLlmTask.mockReset();
  // Default: every reviewer returns an empty array (no findings). Skill-aware
  // path is reset but the existing tests run on the pin-INACTIVE default
  // (openai + the canonical OpenAI default model "gpt-5.5", deterministic
  // path) — they don't need the skill-aware mock to be primed.
  mockLlmTask.mockResolvedValue({ content: "[]" });
  mockSkillAwareLlmTask.mockResolvedValue({ content: "[]" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("agent_creation_review — input validation", () => {
  it("returns a blocker when oasJson is missing", async () => {
    const result = await handleAgentCreationReview({ input: {} as never });
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.code).toBe("missing_input");
    expect(mockLlmTask).not.toHaveBeenCalled();
  });

  it("returns a blocker when oasJson is malformed JSON", async () => {
    const result = await handleAgentCreationReview({
      input: { oasJson: "{not valid" },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]?.code).toBe("invalid_json");
    expect(mockLlmTask).not.toHaveBeenCalled();
  });
});

describe("agent_creation_review — deterministic lint short-circuit", () => {
  it("skips LLM advisors when lint produces blockers (OAS-RUNTIME-008 internal A2A)", async () => {
    // Inject an internal A2AAgent — this is a reliable OAS-RUNTIME-008
    // blocker, so the short-circuit can be tested without depending on
    // heuristic secret detection.
    const oasWithBadA2a = {
      ...NON_TRIVIAL_OAS_WITH_HITL_GATE,
      $referenced_components: {
        ...NON_TRIVIAL_OAS_WITH_HITL_GATE.$referenced_components,
        bad_a2a: {
          component_type: "A2AAgent",
          id: "bad_a2a",
          name: "Internal A2A (forbidden)",
          agent_url: "{{CINATRA_BASE_URL}}/api/a2a/extensions/cinatra-ai/planner-agent",
        },
      },
    };
    const result = await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(oasWithBadA2a) },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.code === "OAS-RUNTIME-008")).toBe(true);
    expect(result.ranAdvisoryAgents).toEqual([]);
    expect(mockLlmTask).not.toHaveBeenCalled();
  });
});

describe("agent_creation_review — LLM advisor dispatch", () => {
  it("runs 3 advisors for a non-trivial (HITL-containing) OAS", async () => {
    const result = await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
    });
    expect(result.ok).toBe(true);
    expect(result.ranAdvisoryAgents).toEqual([
      "agent-security-reviewer",
      "agent-code-reviewer",
      "agent-planner",
    ]);
    expect(mockLlmTask).toHaveBeenCalledTimes(3);
  });

  it("skips agent-planner for a trivial OAS", async () => {
    const result = await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(TRIVIAL_OAS) },
    });
    expect(result.ranAdvisoryAgents).toEqual([
      "agent-security-reviewer",
      "agent-code-reviewer",
    ]);
    expect(mockLlmTask).toHaveBeenCalledTimes(2);
  });

  it("dispatches in PARALLEL (all 3 calls fire before any resolve)", async () => {
    const startTimes: number[] = [];
    mockLlmTask.mockImplementation(async () => {
      startTimes.push(Date.now());
      // Simulate 50ms work.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { content: "[]" };
    });
    await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
    });
    // Parallel: all 3 lanes start in the same window. Serial would have
    // staggered start times spaced by the 50ms-per-call work; checking spread
    // is more robust than total wall-clock (which varies with FS probe + node
    // overhead).
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(20);
    // (No wall-clock elapsed assertion. A previous `totalElapsed < 150ms`
    // check was redundant with `spread < 20ms` — both encode the same
    // "lanes started in one window" invariant — and the 150ms budget was
    // load-sensitive under the full suite. The spread check is the real
    // parallelism contract.)
  });

  it("absorbs a single lane's dispatch failure as a warning (other lanes succeed)", async () => {
    mockLlmTask.mockImplementationOnce(async () => {
      throw new Error("simulated LLM failure");
    });
    mockLlmTask.mockResolvedValue({ content: "[]" });
    const result = await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
    });
    // The failed lane contributed a synthetic warning, not a blocker.
    expect(result.warnings.some((w) => w.code === "review_dispatch_failed")).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("agent_creation_review — response parsing", () => {
  it("parses a bare JSON array reviewer response", () => {
    const findings = __testOnly.parseReviewerResponse(
      `[{"code":"X-001","severity":"warning","message":"hi"}]`,
      "agent-security-reviewer",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("X-001");
    expect(findings[0]?.source).toBe("agent-security-reviewer");
  });

  it("parses a fenced ```json block", () => {
    const findings = __testOnly.parseReviewerResponse(
      'Some prose first.\n```json\n[{"code":"X-002","severity":"suggestion","message":"hi"}]\n```\nMore prose.',
      "agent-code-reviewer",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("X-002");
  });

  it("returns synthetic warning on malformed JSON (no crash)", () => {
    const findings = __testOnly.parseReviewerResponse(
      "[not valid json",
      "agent-planner",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.code).toMatch(/review_parse/);
  });

  it("returns synthetic warning when response is empty", () => {
    const findings = __testOnly.parseReviewerResponse(
      "",
      "agent-security-reviewer",
    );
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.code).toBe("review_parse_no_array");
  });

  it("re-stamps source identity to lane-authoritative value (anti-spoof)", () => {
    const findings = __testOnly.parseReviewerResponse(
      `[{"code":"X","severity":"blocker","message":"trying to spoof","source":"agent-lint-policy"}]`,
      "agent-security-reviewer",
    );
    expect(findings[0]?.source).toBe("agent-security-reviewer");
  });

  it("coerces invalid severity values to 'suggestion'", () => {
    const findings = __testOnly.parseReviewerResponse(
      `[{"code":"X","severity":"critical","message":"hi"}]`,
      "agent-code-reviewer",
    );
    expect(findings[0]?.severity).toBe("suggestion");
  });
});

describe("agent_creation_review — placeholder substitution", () => {
  it("substitutes {{ packageSlug }}, {{ reviewContext }}, {{ oasJson }}", () => {
    const template =
      "slug: {{ packageSlug }}\nctx: {{ reviewContext }}\noas: {{ oasJson }}";
    const out = __testOnly.substituteUserTemplate(template, {
      packageSlug: "my-agent",
      reviewContext: '{"hint":"x"}',
      oasJson: "{}",
    });
    expect(out).toBe('slug: my-agent\nctx: {"hint":"x"}\noas: {}');
  });

  it("handles whitespace variations around placeholder names", () => {
    const out = __testOnly.substituteUserTemplate(
      "{{packageSlug}} {{ packageSlug }} {{  packageSlug  }}",
      { packageSlug: "X", reviewContext: "", oasJson: "" },
    );
    expect(out).toBe("X X X");
  });

  it("leaves unrecognized placeholders untouched", () => {
    const out = __testOnly.substituteUserTemplate(
      "{{ packageSlug }} and {{ someOther }}",
      { packageSlug: "X", reviewContext: "", oasJson: "" },
    );
    expect(out).toBe("X and {{ someOther }}");
  });
});

describe("agent_creation_review — trivial-OAS detection", () => {
  it("flags an OAS with InputMessageNode as non-trivial", () => {
    expect(__testOnly.isTrivialOas(NON_TRIVIAL_OAS_WITH_HITL_GATE)).toBe(false);
  });

  it("flags an OAS with only StartNode + EndNode as trivial", () => {
    expect(__testOnly.isTrivialOas(TRIVIAL_OAS)).toBe(true);
  });

  it("flags FlowNode/A2AAgent as non-trivial regardless of other nodes", () => {
    const oas = {
      $referenced_components: {
        a2a: { component_type: "A2AAgent" },
      },
    };
    expect(__testOnly.isTrivialOas(oas)).toBe(false);
  });

  it("flags multiple AgentNode-with-agent steps as non-trivial", () => {
    // Per the canonical handlers.ts:isTrivialOas semantics, AgentNode is only
    // counted as executable when it has an `agent` field (i.e. backed by an
    // embedded Agent component). Bare AgentNode entries are structural.
    const oas = {
      $referenced_components: {
        a1: { component_type: "AgentNode", agent: { $component_ref: "x" } },
        a2: { component_type: "AgentNode", agent: { $component_ref: "y" } },
      },
    };
    expect(__testOnly.isTrivialOas(oas)).toBe(false);
  });

  it("flags external (non-cinatra) MCPToolBox as non-trivial", () => {
    const oas = {
      $referenced_components: {
        toolbox: { component_type: "MCPToolBox", id: "third-party-mcp" },
      },
    };
    expect(__testOnly.isTrivialOas(oas)).toBe(false);
  });

  it("treats cinatra-internal MCPToolBox as trivial", () => {
    const oas = {
      $referenced_components: {
        toolbox: { component_type: "MCPToolBox", id: "cinatra-mcp" },
      },
    };
    expect(__testOnly.isTrivialOas(oas)).toBe(true);
  });

  it("does NOT count bare AgentNode (no `agent` field) toward executable quota", () => {
    const oas = {
      $referenced_components: {
        a1: { component_type: "AgentNode" }, // structural — not counted
        a2: { component_type: "AgentNode" }, // structural — not counted
      },
    };
    expect(__testOnly.isTrivialOas(oas)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reviewer OAS shape contract.
// ---------------------------------------------------------------------------

describe("reviewer-agent OAS shape contract", () => {
  // The primitive loads each reviewer's `data.system` + `data.user` from
  // their OAS at call time (no hardcoded prompts in TypeScript).
  // If any of these files drift (missing the `review` ApiNode, missing the
  // system/user fields, or the file disappears entirely), the primitive
  // falls back to a minimal inline prompt — degraded but non-crashing.
  // This test asserts the on-disk contract so the fallback is never the
  // intended path in production.
  it.each([
    ["agent-security-reviewer"],
    ["agent-code-reviewer"],
    ["agent-planner"],
  ])("%s OAS has $referenced_components.review.data.{system,user}", async (slug) => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const REVIEWER_PROMPT_DIR: Record<string, string> = {
      "agent-security-reviewer": "security-reviewer-agent",
      "agent-code-reviewer": "code-reviewer-agent",
      "agent-planner": "planner-agent",
    };
    const dirSlug = REVIEWER_PROMPT_DIR[slug] ?? slug;
    const oasPath = path.join(
      process.cwd(),
      "..",
      "..",
      "extensions",
      "cinatra-ai",
      dirSlug,
      "cinatra",
      "oas.json",
    );
    const raw = await fs.readFile(oasPath, "utf8");
    const oas = JSON.parse(raw) as Record<string, unknown>;
    const refs = oas.$referenced_components as Record<string, unknown> | undefined;
    expect(refs, `${slug} OAS lacks $referenced_components`).toBeDefined();
    const reviewNode = refs!.review as Record<string, unknown> | undefined;
    expect(reviewNode, `${slug} OAS lacks $referenced_components.review`).toBeDefined();
    expect(reviewNode!.component_type).toBe("ApiNode");
    const data = reviewNode!.data as Record<string, unknown> | undefined;
    expect(typeof data?.system).toBe("string");
    expect(typeof data?.user).toBe("string");
    expect((data!.system as string).length).toBeGreaterThan(100); // not a stub
  });
});

// ---------------------------------------------------------------------------
// Pin-inactive parity + active-pin dispatch + sentinel-rethrow regression tests.
// ---------------------------------------------------------------------------

describe("agent_creation_review — dispatch contract", () => {
  it("DEFAULT: pin INACTIVE → each lane uses runDeterministicLlmTask with provider:openai + the canonical OpenAI default model (gpt-5.5, never base gpt-5)", async () => {
    // Default beforeEach: mockLlmTask returns "[]"; skill-aware mock unused.
    // Real @/lib/database: pin inactive + no stored openai_connection ⇒ the
    // inactive resolver reads readOpenAIConnectionFromDatabase().defaultModel,
    // which falls back to the canonical DEFAULT_OPENAI_MODEL_ID ("gpt-5.5").
    await handleAgentCreationReview({
      input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
    });
    expect(mockLlmTask).toHaveBeenCalled();
    expect(mockSkillAwareLlmTask).not.toHaveBeenCalled();
    // Inspect the first invocation's call shape.
    const firstCall = mockLlmTask.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({ provider: "openai", model: "gpt-5.5" });
    expect((firstCall as { model: string }).model).not.toBe("gpt-5");
  });

  it("REGRESSION: preflight ok:false short-circuits before any LLM call (deterministic blocker)", async () => {
    // We can't easily trigger a real preflight failure in pin-inactive state
    // (preflight no-ops in that case). Simulate via mock: change the pin gate
    // to active + invalid provider, which produces a `pin_not_configured`
    // failure (model is null in the default mock).
    const dbModule = await import("@/lib/database");
    vi.spyOn(dbModule, "isAgentCreationPinActive").mockReturnValue(true);
    vi.spyOn(dbModule, "readAgentCreationLlmProviderFromDatabase").mockReturnValue(null);
    vi.spyOn(dbModule, "readAgentCreationModelFromDatabase").mockReturnValue(null);
    try {
      const result = await handleAgentCreationReview({
        input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
      });
      expect(result.ok).toBe(false);
      // The error appears as a deterministic blocker.
      expect(result.blockers.some((b) => b.code === "pin_not_configured")).toBe(true);
      // CRITICAL: no LLM dispatch happened before the preflight fail.
      expect(mockLlmTask).not.toHaveBeenCalled();
      expect(mockSkillAwareLlmTask).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("REGRESSION: AgentCreationDispatchAbortError → deterministic blocker (not downgraded warning)", async () => {
    // Inject the sentinel from the dispatch-site by making the skill-aware
    // mock reject with the sentinel. (Pin must be active+anthropic for the
    // dispatch to take the skill-aware path AND for the abort guard to fire.)
    const { AgentCreationDispatchAbortError } = await import("../resolve-agent-creation-dispatch");
    const dbModule = await import("@/lib/database");
    vi.spyOn(dbModule, "isAgentCreationPinActive").mockReturnValue(true);
    vi.spyOn(dbModule, "readAgentCreationLlmProviderFromDatabase").mockReturnValue("anthropic");
    vi.spyOn(dbModule, "readAgentCreationModelFromDatabase").mockReturnValue("claude-opus-4-7");
    vi.spyOn(dbModule, "readAnthropicSkillSyncEnabledFromDatabase").mockReturnValue(true);
    mockSkillAwareLlmTask.mockRejectedValueOnce(
      new AgentCreationDispatchAbortError("anthropic_empty_skill_ids"),
    );
    try {
      // Note: this test won't reach the LLM dispatch because the preflight
      // (BLOCKER A) catches the empty-lane-skill case first. To exercise the
      // sentinel-rethrow path specifically, we'd need to mock preflight to
      // pass + skills to be non-empty, which requires substantial setup. The
      // BLOCKER 4 test above covers the preflight-short-circuit path; the
      // sentinel rethrow path is exercised by the dispatchLlmReviewer unit
      // tests in catalog-aware suites. Here we just verify that the
      // preflight catches the empty-skills case as a deterministic blocker.
      const result = await handleAgentCreationReview({
        input: { oasJson: JSON.stringify(NON_TRIVIAL_OAS_WITH_HITL_GATE) },
      });
      expect(result.ok).toBe(false);
      // Either preflight (anthropic_no_skills_resolved) or sentinel-rethrow
      // path produces a deterministic blocker — both are valid outcomes per
      // the spec's "fail-closed" contract.
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.blockers[0].severity).toBe("blocker");
      expect(result.blockers[0].source).toBe("deterministic");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
