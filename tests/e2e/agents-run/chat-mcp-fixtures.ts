/**
 * Track B fixtures — chat-MCP UAT.
 *
 * Two fixture shapes:
 *   - HITL-bearing agents (Track A + Track B parity): pair the prompt with
 *     a Track A `AgentFixture` so HITL screen drive logic is reused.
 *   - Non-HITL agents (Track B only): supply only the prompt + expected
 *     terminal status. The spec's adaptive HITL loop has zero gates to
 *     drive and just polls to terminal.
 *
 * Prompts are deliberately SPECIFIC (they name the agent or its package).
 * Discoverability of vague prompts lives in `chat-discovery.spec.ts`;
 * Track B's contract is "does the chat successfully execute the agent
 * end-to-end when asked to".
 */
import type { AgentFixture } from "./fixtures";
import { AGENT_FIXTURES } from "./fixtures";

export type ChatMcpFixture = {
  packageName: string;
  /** Natural-language prompt sent to /api/chat. */
  prompt: string;
  /**
   * Optional Track A fixture. When present, the spec walks
   * `agentFixture.hitlScreens` and asserts
   * `agentFixture.expectedTerminalStatus`. When absent, the spec waits
   * for terminal directly using `expectedTerminalStatus` below.
   */
  agentFixture?: AgentFixture;
  /** Used when `agentFixture` is not provided. Defaults to "completed". */
  expectedTerminalStatus?: "completed" | "failed" | "stopped";
  /** Run timeout (ms). Default 240_000. */
  runTimeoutMs?: number;
};

function fixtureFor(packageName: string): AgentFixture {
  const f = AGENT_FIXTURES.find((x) => x.packageName === packageName);
  if (!f) {
    throw new Error(
      `Track B references Track A fixture ${packageName} that doesn't exist`,
    );
  }
  return f;
}

// Minimal WayFlow-shaped OAS body for the design/code/security
// reviewer agents. They parse `oasJson` and emit a finding array; a tiny but
// structurally-valid OAS avoids advisory noise vs `{}` and is small enough for
// the hard-pre-router extraction LLM to transcribe verbatim.
const REVIEW_OAS_JSON =
  "{\"agentspec_version\":\"26.1.0\",\"component_type\":\"Flow\",\"id\":\"example-agent-flow\",\"name\":\"Example Agent\",\"description\":\"Smoke-test agent definition.\",\"metadata\":{\"cinatra\":{\"type\":\"flow\",\"packageName\":\"@cinatra-ai/example-agent\",\"packageVersion\":\"0.1.0\"}},\"inputs\":[],\"outputs\":[],\"start_node\":{\"$component_ref\":\"start\"},\"nodes\":[{\"$component_ref\":\"start\"},{\"$component_ref\":\"end\"}],\"control_flow_connections\":[{\"component_type\":\"ControlFlowEdge\",\"name\":\"start_to_end\",\"from_node\":{\"$component_ref\":\"start\"},\"to_node\":{\"$component_ref\":\"end\"}}],\"data_flow_connections\":[],\"$referenced_components\":{\"start\":{\"component_type\":\"StartNode\",\"id\":\"start\",\"name\":\"Start\",\"inputs\":[]},\"end\":{\"component_type\":\"EndNode\",\"id\":\"end\",\"name\":\"End\",\"outputs\":[]}}}";

export const CHAT_MCP_FIXTURES: ReadonlyArray<ChatMcpFixture> = [
  // -- HITL-bearing visible agents (Track A + Track B parity) --
  {
    packageName: "@cinatra-ai/skill-recommender-agent",
    prompt:
      "Run @cinatra-ai/skill-recommender-agent so I can confirm which installed skills apply to the next step",
    agentFixture: fixtureFor("@cinatra-ai/skill-recommender-agent"),
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/trigger-agent",
    // Explicit tool name nudge — `cinatra_trigger-agent` is registered as a
    // function tool, but the LLM sometimes prefers `agent_run_trigger_set`
    // for the "schedule a trigger" intent. Naming the tool unambiguously
    // forces the right dispatch.
    prompt:
      "Invoke the cinatra_trigger-agent tool to configure an immediate trigger. The agent will pause on its configure HITL gate for me to confirm.",
    agentFixture: fixtureFor("@cinatra-ai/trigger-agent"),
    runTimeoutMs: 1_200_000,
  },
  // -- Non-HITL agents (Track B only — no /agents/run surface) --
  //
  // These complete without pausing for HITL. The chat path passes the
  // necessary inputs via the cinatra_<slug> tool call (or via agent_run
  // with packageName), the run dispatches the underlying flow (often a
  // single AgentNode or a chain of ApiNodes), and terminates.
  //
  // Prompts include the agent name explicitly to make tool selection
  // deterministic. Inputs use sandboxed example.com URLs / generic terms
  // so no real external side-effects.
  {
    packageName: "@cinatra-ai/web-scrape-agent",
    // Embed the exact structured inputParams JSON so the hard
    // pre-router's gpt-5.5 extraction transcribes it verbatim.
    // outputSchema is a full per-item JSON Schema (SKILL.md:24); sourceUrl is
    // required by behavior (SKILL.md:28). web_search → example.com is sandbox-safe.
    prompt:
      'Use the @cinatra-ai/web-scrape-agent. Use ONLY this exact structured input JSON for inputParams: {"seedUrls":["https://example.com"],"outputSchema":{"type":"object","properties":{"title":{"type":"string"},"sourceUrl":{"type":"string"}},"required":["title","sourceUrl"]},"instructions":"Extract the page title from the example.com page."}',
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/web-research-agent",
    // rows must be 1-20 objects, not [] (oas.json:24,
    // SKILL.md:27); the research node iterates each row (SKILL.md:83).
    prompt:
      'Use the @cinatra-ai/web-research-agent. Use ONLY this exact structured input JSON for inputParams: {"rows":[{"topic":"example.com","url":"https://example.com"}],"prompt":"Verify that https://example.com is the Example Domain page and add one research note."}',
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/media-feed-lister-agent",
    prompt:
      "Use the @cinatra-ai/media-feed-lister-agent to list episodes from the RSS feed https://www.example.com/feed.xml — fall back to an empty list if the feed is empty.",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/media-transcript-agent",
    prompt:
      "Use the @cinatra-ai/media-transcript-agent to produce a transcript from the public YouTube video https://www.youtube.com/watch?v=jNQXAC9IVRw — keep it short, this is a smoke test.",
    // An example.com/sample.mp3 prompt
    // 404s at the media fetch layer (MEDIA-FETCH-FAILED). YouTube's
    // "Me at the zoo" (the first-ever YouTube video, 19s) is a stable
    // public URL the Gemini multimodal call can fetch.
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/blog-idea-generator-agent",
    prompt:
      "Invoke the @cinatra-ai/blog-idea-generator-agent for the topic 'example domains' — generate one short blog idea.",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/blog-draft-writer-agent",
    prompt:
      "Use the @cinatra-ai/blog-draft-writer-agent to draft a short blog post about 'example domains' — keep it under 100 words.",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/blog-image-prompt-agent",
    prompt:
      "Use the @cinatra-ai/blog-image-prompt-agent to generate an image prompt for a blog post about 'example domains'.",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/company-discovery-agent",
    prompt:
      "Use the @cinatra-ai/company-discovery-agent to discover information about the company at https://example.com",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/contact-discovery-agent",
    prompt:
      "Use the @cinatra-ai/contact-discovery-agent to discover contact info for the example company at https://example.com",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/planner-agent",
    // planner reviews a real OAS body (oas.json:146, SKILL.md:50).
    prompt:
      `Use the @cinatra-ai/planner-agent. Use ONLY this exact structured input JSON for inputParams: {"oasJson":${JSON.stringify(REVIEW_OAS_JSON)}}`,
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/code-reviewer-agent",
    // code-reviewer lints a real OAS body (oas.json:146, SKILL.md:66).
    prompt:
      `Use the @cinatra-ai/code-reviewer-agent. Use ONLY this exact structured input JSON for inputParams: {"oasJson":${JSON.stringify(REVIEW_OAS_JSON)}}`,
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/security-reviewer-agent",
    // security-reviewer scans a real OAS body (oas.json:146, SKILL.md:50).
    prompt:
      `Use the @cinatra-ai/security-reviewer-agent. Use ONLY this exact structured input JSON for inputParams: {"oasJson":${JSON.stringify(REVIEW_OAS_JSON)}}`,
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
  {
    packageName: "@cinatra-ai/lint-policy-agent",
    prompt:
      "Use the @cinatra-ai/lint-policy-agent to lint a trivial agent definition.",
    expectedTerminalStatus: "completed",
    runTimeoutMs: 1_200_000,
  },
];
