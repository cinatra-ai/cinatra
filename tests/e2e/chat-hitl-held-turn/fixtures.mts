// THE WORLD THE RUNTIME NEEDS, AND NOTHING THE FLOW IS ABOUT (chat-hitl S9k,
// cinatra#2824).
//
// A fresh instance has no provider connection, no MCP public URL and no assigned
// skills. None of those is the thing under proof, and none of them is a hold: the
// hold, the card, Confirm and Skip are created by the runtime while the browser
// drives it. What this script does is put the instance in the state a real one is
// already in, so the dispatch can reach the recommendation checkpoint at all.
//
// EVERY WRITE GOES THROUGH A SHIPPED WRITER. Not one row is INSERTed by hand.
// That matters more here than in an ordinary fixture: the OpenAI row's key is
// SEALED at rest (`@/lib/connector-config-secret-fields`), so a hand-written row
// would either carry a plaintext key the reader rejects or a sealing this file
// would have to re-implement — and a fixture that re-implements production
// encryption is a second implementation that can drift into passing for the wrong
// reason. `agent_assigned_skills` is written through `insertAssignedSkill`, which
// owns the advisory lock, the cap and the position ordering.
//
// WHY IT IS A SUBPROCESS rather than part of the Playwright setup project: these
// writers are `server-only`, so they resolve only under `--conditions=react-server`.
// The setup project shells out to this file, which is the same shape the S9b
// evidence round used (`evidence/2786-s9b-chat-thread-held/drivers/00-fixtures.mts`).
//
// NO REAL CREDENTIAL IS READ, USED OR STORED. The OpenAI row is a PRESENCE
// placeholder: generation is served by `CINATRA_TEST_LLM_PROVIDER=scripted`, and
// the placeholder exists only because the assistant runtime falls into
// `conversationOnly` without a bound provider adapter — and a conversation-only
// turn NULLS the explicit-dispatch package, so the hard pre-router never fires and
// no run is created at all.
//
// Usage (from the repo root, with .env.local pointing at the lane stack):
//   node --conditions=react-server --env-file-if-exists=.env.local --import tsx \
//     tests/e2e/chat-hitl-held-turn/fixtures.mts
import { writeOpenAIConnection } from "../../../src/lib/openai-connection-store";
import { setMcpPublicBaseUrl } from "../../../packages/mcp-server/src/llm-credentials";
import { insertAssignedSkill } from "../../../src/lib/agent-assigned-skills-store";
import {
  HELD_TURN_AGENT_PACKAGE,
  HELD_TURN_SKILL_ID,
  HELD_TURN_FIXTURE_ACTOR,
} from "./constants";

const BASE = process.env.CINATRA_HELD_TURN_BASE_URL || process.env.BETTER_AUTH_URL || "";
if (!BASE) throw new Error("fixtures: CINATRA_HELD_TURN_BASE_URL / BETTER_AUTH_URL is required");

// (1) The provider PRESENCE placeholder. Without it `runAssistantTurn` answers
//     "No LLM provider configured." and returns BEFORE the pre-router line, so
//     `agent_runs` stays empty and the flow fails with no card and no diagnosis.
writeOpenAIConnection({
  apiKey: "sk-not-a-real-key-chat-hitl-s9k",
  defaultModel: "gpt-4o-mini",
  loggingEnabled: false,
  availableModels: [],
} as never);
console.log("[fixture] openai_connection presence placeholder written (no real key)");

// (2) The MCP public base URL — an origin-only value on the connector-config row.
await setMcpPublicBaseUrl(BASE);
console.log(`[fixture] mcp public base url = ${BASE}`);

// (3) THE ONE ROW THAT MAKES THE CHECKPOINT REACHABLE. The recommendation scorer
//     offers an agent's ASSIGNED skills and nothing else, so with no assignment
//     `maybeHoldRunForRecommendation` answers "no recommendation candidates",
//     returns `held:false`, and the run dispatches unheld — a green flow proving
//     the opposite of what it claims. Exactly one skill is assigned, deliberately:
//     the §V row releases only once EVERY chip is decided, so one chip makes
//     "Confirm" and "Skip" single, unambiguous presses.
const assigned = await insertAssignedSkill({
  agentPackageName: HELD_TURN_AGENT_PACKAGE,
  skillId: HELD_TURN_SKILL_ID,
  createdBy: HELD_TURN_FIXTURE_ACTOR,
});
console.log(
  `[fixture] assigned skill ${HELD_TURN_SKILL_ID} -> ${HELD_TURN_AGENT_PACKAGE}: ${assigned.outcome}`,
);
if (assigned.outcome === "cap_exceeded") {
  throw new Error("fixtures: assigned-skill cap exceeded — the lane database is not clean");
}

console.log("fixtures done");
