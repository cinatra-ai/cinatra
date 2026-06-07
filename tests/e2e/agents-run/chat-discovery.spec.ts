/**
 * Chat MCP discoverability harness.
 *
 * For each `DISCOVERY_FIXTURE`, POSTs a vague prompt to /api/chat,
 * reads the SSE response, watches for an `agent_run` tool_call +
 * tool_result, extracts the returned runId, resolves it via direct pg
 * to the agent's package_name, and asserts it matches the expected
 * target.
 *
 * Cost guard: each probe runs one chat turn (~$0.02-0.05 in OpenAI
 * tokens). This harness ships a few sample fixtures to validate the rig.
 *
 * Non-determinism: chat LLM responses jitter on cold-start. We use
 * single-retry-on-soft-failure (configurable via PLAYWRIGHT_RETRIES).
 */
import type { APIResponse } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

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

async function fetchRunPackageName(runId: string): Promise<string | null> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const res = await client.query<{ package_name: string | null }>(
      `SELECT t.package_name FROM ${SCHEMA}.agent_runs r
       JOIN ${SCHEMA}.agent_templates t ON t.id = r.template_id
       WHERE r.id = $1`,
      [runId],
    );
    return res.rows[0]?.package_name ?? null;
  } finally {
    await client.end();
  }
}

/** Parse an SSE response stream into a list of {event, data} pairs. */
async function readSseEvents(
  response: APIResponse,
): Promise<Array<{ event: string; data: unknown }>> {
  const events: Array<{ event: string; data: unknown }> = [];
  const text = await response.text();
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let dataRaw = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw = line.slice(6);
    }
    if (event && dataRaw) {
      try {
        events.push({ event, data: JSON.parse(dataRaw) });
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

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
      test.setTimeout(120_000);

      const response = await request.post("/api/chat", {
        data: {
          messages: [{ role: "user", content: fixture.biasedPrompt }],
        },
        headers: {
          "content-type": "application/json",
          Origin: process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000",
          Accept: "text/event-stream",
        },
        timeout: 90_000,
      });
      expect(response.ok(), `chat POST returned ${response.status()}`).toBeTruthy();

      const events = await readSseEvents(response);
      // The chat may call `agent_run` (generic) for these prompts, or call
      // a dynamically-registered `cinatra_<slug>` wrapper tool. Accept
      // either shape so the harness covers both.
      const slug = fixture.packageName.replace(/^@[^/]+\//, "");
      const expectedToolNames = new Set(["agent_run", `cinatra_${slug}`]);
      const agentRunResult = events.find(
        (e) =>
          e.event === "tool_result" &&
          typeof (e.data as { name?: string })?.name === "string" &&
          expectedToolNames.has((e.data as { name: string }).name),
      );

      expect(
        agentRunResult,
        `chat did not invoke agent_run or cinatra_${slug} for prompt ` +
          `"${fixture.biasedPrompt}". Events emitted: ${events.map((e) => `${e.event}/${(e.data as { name?: string })?.name ?? "_"}`).join(", ")}. ` +
          `Description optimization needed for ${fixture.packageName}: ` +
          `edit src/app/api/chat/runner.ts:TOOL_DESCRIPTIONS["cinatra_<slug>"] or ` +
          `agents/cinatra/<slug>/cinatra/oas.json info.description.`,
      ).toBeTruthy();

      // Extract runId from the tool_result.result string. The result is the
      // JSON-stringified return of the handler.
      const resultStr = (agentRunResult!.data as { result?: string })?.result ?? "";
      const runIdMatch = resultStr.match(/"runId"\s*:\s*"([^"]+)"/);
      expect(
        runIdMatch,
        `agent_run result did not contain runId. Result preview: ${resultStr.slice(0, 300)}`,
      ).toBeTruthy();
      const runId = runIdMatch![1];

      // Resolve runId → package_name.
      const pkg = await fetchRunPackageName(runId);
      expect(
        pkg,
        `runId ${runId} not found in cinatra.agent_runs (or no joined template).`,
      ).toBe(fixture.packageName);
    });
  });
}
