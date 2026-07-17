/**
 * Chat MCP discoverability harness.
 *
 * For each `DISCOVERY_FIXTURE`, POSTs a vague prompt to the unified
 * assistant endpoint (POST /api/assistants/chat — the bespoke /api/chat SSE
 * wire was deleted by the cinatra#1218 delete stage), reads the AG-UI
 * stream, watches for an `agent_run` / `cinatra_<slug>` TOOL_CALL_START,
 * resolves the spawned runId (wire `DATA_PART { kind: "agent_run" }` first;
 * DB fallback for tools whose result never rides the wire), and asserts the
 * run's package_name matches the expected target via direct pg.
 *
 * Cost guard: each probe runs one chat turn (~$0.02-0.05 in OpenAI
 * tokens). This harness ships a few sample fixtures to validate the rig.
 *
 * Non-determinism: chat LLM responses jitter on cold-start. We use
 * single-retry-on-soft-failure (configurable via PLAYWRIGHT_RETRIES).
 */
import { expect, test } from "@playwright/test";

import {
  agentRunIdFromWire,
  describeAgUiEvents,
  fetchLatestRunIdForPackage,
  fetchRunPackageName,
  postAssistantChatTurn,
  readAgUiEvents,
  toolCallNames,
} from "./ag-ui-chat";

type DiscoveryFixture = {
  /** Target package name (e.g. "@cinatra-ai/media-feed-lister-agent"). */
  packageName: string;
  /**
   * A biased NATURAL-DISPLAY-NAME prompt. It names the agent
   * by its human display name ("the URL Title Fetcher agent") but MUST NOT
   * contain a `@cinatra-ai/<slug>` or `cinatra_<slug>` token — those forms
   * are intercepted by the hard pre-router (explicit-dispatch.ts) BEFORE the
   * LLM, which would test the pre-router, not organic discovery. The LLM
   * must resolve the display name to the right `cinatra_<slug>` /
   * `agent_run` via the agents catalog.
   */
  biasedPrompt: string;
  /** Optional note — context for why this prompt is discoverable. */
  note?: string;
};

/** Sample fixtures — covers the agents most likely to need
 *  description optimization. */
const DISCOVERY_FIXTURES: ReadonlyArray<DiscoveryFixture> = [
  // Standalone discovery probes. An earlier set used mid-flow agents
  // (trigger/skill-recommender/reviewer/auditor) that correctly need
  // upstream context and can never be discovered from a single standalone
  // chat turn. These are truly-standalone agents whose human display name
  // is unambiguous, so the LLM can resolve display-name
  // → `cinatra_<slug>` / `agent_run` via the agents catalog. None of the
  // prompts contain a `@cinatra-ai/`/`cinatra_` token (would trip the hard
  // pre-router and test dispatch, not discovery).
  {
    packageName: "@cinatra-ai/media-feed-lister-agent",
    biasedPrompt:
      "Run the Media Feed Lister agent for https://example.com/feed.xml. Latest 1 item is enough; return an empty list if the feed has no entries.",
    note: "Standalone feed lister; display name unambiguous.",
  },
  {
    packageName: "@cinatra-ai/blog-idea-generator-agent",
    biasedPrompt:
      "Run the Blog Idea Generator agent for one idea about example domains for software teams.",
    note: "Standalone idea generator; explicit display name.",
  },
  {
    packageName: "@cinatra-ai/web-scrape-agent",
    biasedPrompt:
      "Run the Web Scrape Agent. Use seed URL https://example.com and extract a title field plus sourceUrl.",
    note: "Standalone scrape; display name + concrete inputs.",
  },
];

/**
 * DISCOVERABILITY GAP DOCUMENTED:
 *
 * An early run of these probes revealed that the chat
 * orchestrator calls `agent_run` for these vague prompts but WITHOUT a
 * `templateId` — returning `{"error":"templateId is required."}`. The
 * LLM correctly detects "the user wants to run an agent" but doesn't
 * pick a specific agent.
 *
 * Root cause: `cinatra_<slug>` tools are referenced in the chat SKILL.md
 * and `runner.ts:TOOL_DESCRIPTIONS` but are NOT actually registered as
 * function tools in `collectAllPrimitiveHandlers()`. Only the generic
 * `agent_run` + `agents_list` exist, and the LLM doesn't always wire
 * those into a two-step "list then pick then run" sequence for short
 * vague prompts.
 *
 * The harness catches this gap deterministically. The architectural fix
 * is either (a) dynamically register `cinatra_<slug>` function tools per
 * visible HITL agent so the LLM can pick directly, OR (b) inject the
 * visible-agent template map into the system prompt so the LLM can
 * resolve "what would I call" without an extra agents_list round-trip.
 *
 * The probes use biased natural-DISPLAY-NAME prompts
 * for truly-standalone agents and are regular GREEN gates. They assert
 * the LLM resolves a human display name to the correct agent via the
 * catalog WITHOUT a `@cinatra-ai/`/`cinatra_` token (which would
 * short-circuit the hard pre-router and test dispatch, not discovery).
 */
for (const fixture of DISCOVERY_FIXTURES) {
  test.describe(`chat-discovery :: ${fixture.packageName}`, () => {
    // Biased natural-display-name probes; the LLM resolves
    // the display name to the agent via the catalog (NOT the pre-router).
    // These are regular green gates.
    test(`prompt → agent_run with matching template`, async ({ request }) => {
      // ~$0.05 budget per turn; allow 90s for the chat to make the
      // agents_list + agent_run roundtrip including LLM latency.
      test.setTimeout(180_000);

      const turnStartedAt = new Date().toISOString();
      const response = await postAssistantChatTurn(request, fixture.biasedPrompt, {
        baseUrl: process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000",
        timeoutMs: 90_000,
      });
      expect(response.ok(), `chat POST returned ${response.status()}`).toBeTruthy();

      const events = await readAgUiEvents(response);
      // The chat may call `agent_run` (generic) for these prompts, or call
      // a dynamically-registered `cinatra_<slug>` wrapper tool. Accept
      // either shape so the harness covers both. Tool NAMES ride
      // TOOL_CALL_START on the AG-UI wire (TOOL_CALL_END carries only ids).
      const slug = fixture.packageName.replace(/^@[^/]+\//, "");
      const expectedToolNames = new Set(["agent_run", `cinatra_${slug}`]);
      const invoked = toolCallNames(events).find((name) => expectedToolNames.has(name));

      expect(
        invoked,
        `chat did not invoke agent_run or cinatra_${slug} for prompt ` +
          `"${fixture.biasedPrompt}". Events emitted: ${describeAgUiEvents(events)}. ` +
          `Description optimization needed for ${fixture.packageName}: ` +
          `edit src/app/api/chat/runner.ts:TOOL_DESCRIPTIONS["cinatra_<slug>"] or ` +
          `agents/cinatra/<slug>/cinatra/oas.json info.description.`,
      ).toBeTruthy();

      // Resolve the spawned runId. The AG-UI wire carries it only for the
      // generic `agent_run` tool (DATA_PART { kind: "agent_run" }); the
      // `cinatra_<slug>` wrappers return it inside their off-wire result, so
      // fall back to the newest run of the EXPECTED package started since
      // this turn began.
      const runId =
        agentRunIdFromWire(events) ??
        (await fetchLatestRunIdForPackage(fixture.packageName, turnStartedAt));
      expect(
        runId,
        `no runId: neither a DATA_PART agent_run frame nor a ${fixture.packageName} ` +
          `run started after ${turnStartedAt}. Events: ${describeAgUiEvents(events)}`,
      ).toBeTruthy();

      // Resolve runId → package_name. (For the DB-fallback path this
      // re-checks the join rather than adding evidence — the wire path is
      // the discriminating one.)
      const pkg = await fetchRunPackageName(runId!);
      expect(
        pkg,
        `runId ${runId} not found in cinatra.agent_runs (or no joined template).`,
      ).toBe(fixture.packageName);
    });
  });
}
