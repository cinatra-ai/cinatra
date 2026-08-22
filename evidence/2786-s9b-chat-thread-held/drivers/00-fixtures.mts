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
import { insertAssignedSkill } from "../../../src/lib/agent-assigned-skills-store";

const BASE = process.env.BETTER_AUTH_URL || "http://localhost:3794";

// FIXTURE 1 — the agent's ASSIGNED SKILL SET, written by the shipped writer
// `insertAssignedSkill` (idempotent: a re-run answers `already_assigned`).
//
// The scorer offers an agent's assigned set intersected with the installed
// catalog, so a fresh instance offers nothing and the card never draws. THREE
// skills, not one, because the §V redraw (cinatra#2841) made the decision
// PER CHIP: the row does not release until every chip is decided, so a
// single-candidate set can never photograph one skill shaped while its
// neighbours stay live. Three also lets ONE settled row carry all three of §V's
// marks — Confirmed, Adjusted and Skipped.
//
// Every one of them declares a `cinatra.displayName` in its owning extension
// manifest, which is what makes the display-name claim checkable rather than
// asserted: the chip must print that title and never the id beside it. The
// third is the sharpest of the three — its slug is `chat-automation-authoring`
// and its declared title is "Automation Authoring Skill", so a card printing
// the slug and a card printing the name cannot be confused.
//
// THEY MUST BE INSTALLED, not merely catalogued. `resolveAssignedSkillTier`
// revalidates every assignment against the installed extension set and withholds
// an id whose owning extension is absent (`:not-installed`) — the assignment
// survives in settings and simply never reaches the scorer. Measured on this
// stack: two matcher skills that exist in `cinatra.skills` were withheld exactly
// that way and the row drew ONE chip. All three below are in the instance's
// bundled extension set.
const OWNER_USER_ID = process.env.S9B_OWNER_USER_ID;
if (!OWNER_USER_ID) throw new Error("S9B_OWNER_USER_ID is required (the capture owner's user id)");
const ASSIGNED_SKILL_IDS = [
  "@cinatra-ai/chat:blog-content",
  "@cinatra-ai/chat:company-research",
  "@cinatra-ai/chat:chat-automation-authoring",
];
for (const skillId of ASSIGNED_SKILL_IDS) {
  const res = await insertAssignedSkill({
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    skillId,
    createdBy: OWNER_USER_ID,
  });
  console.log(`[fixture] assigned ${skillId} -> ${res.outcome}`);
}

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
