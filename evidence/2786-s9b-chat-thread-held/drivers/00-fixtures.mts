// S9b re-shoot, step 0 — the capture fixtures, each written by a SHIPPED writer.
//
// NONE of these is the thing under proof. They exist because a fresh instance
// has no assigned skills, no provider connection and no MCP public URL, and the
// pre-router refuses to dispatch without a bound provider adapter. The decision
// under test — the hold, the card, Confirm and Skip — is untouched by all of it.
//
// Usage:
//   node --conditions=react-server --env-file=.env.local --import tsx \
//     evidence/2786-s9b-chat-thread-held/drivers/00-fixtures.mts
import { writeOpenAIConnection } from "../../../src/lib/openai-connection-store";
import { setMcpPublicBaseUrl } from "../../../packages/mcp-server/src/llm-credentials";

const BASE = process.env.BETTER_AUTH_URL || "http://localhost:3794";

// FIXTURE 3 — an OpenAI PRESENCE placeholder, so a provider adapter binds
// before the pre-router runs. Without one the runtime falls into
// `conversationOnly`, `explicitDispatchPackage` is nulled and the hard
// pre-router never fires — measured on this stack: 0 runs created.
// Generation is served by CINATRA_TEST_LLM_PROVIDER=scripted; no real key is
// read, used or stored.
writeOpenAIConnection({
  apiKey: "sk-test-placeholder",
  defaultModel: "gpt-4o-mini",
  loggingEnabled: false,
  availableModels: [],
} as never);
console.log("[fixture] openai_connection placeholder written (presence only)");

// FIXTURE 4a — the MCP public base URL, an origin-only value on the
// connector-config row.
await setMcpPublicBaseUrl(BASE);
console.log(`[fixture] mcp public base url = ${BASE}`);

console.log("fixtures done");
