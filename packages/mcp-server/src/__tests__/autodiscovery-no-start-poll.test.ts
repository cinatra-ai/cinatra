// THE SERVER'S OWN INSTRUCTIONS ORDER NO POLL AFTER A START
// (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// `skills/mcp-autodiscovery/SKILL.md` is not documentation: it is read at boot
// and handed to every connected MCP client as `initialize.instructions`, and it
// is reachable a second way — the chat assistant can read the same file through
// its skill-read tool, which is exactly what the stored turn behind this slice
// shows it doing between the start and the poll.
//
// So the file is a MODEL-FACING INSTRUCTION SURFACE, and the rule the plan
// states about a start applies to it word for word: "the card re-reads its state
// from the server and settles in place. The assistant's line reports what came
// back and adds nothing." Its step 4 used to order a 3-5 second poll after every
// `queued` run. Removing that from the two tool descriptions and leaving it here
// would have moved the mandate rather than retired it, which is why this file is
// pinned beside them.
//
// WHAT IS PINNED, and what deliberately is not. The MANDATE is pinned: no order
// to poll a start, and no re-appearance of the sentence that carried it. The
// READ is pinned present: a client with no conversation surface still has
// `agent_run_get` and is still told it may use it, so this change strands
// nobody. A paraphrase nobody has written yet is not pinned — no string check
// can be, and claiming otherwise would be the more misleading test.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, "..", "..", "skills", "mcp-autodiscovery", "SKILL.md");

const text = (): string => readFileSync(SKILL, "utf8");

describe("the MCP autodiscovery instructions, on the start road", () => {
  it("order no poll after a start", () => {
    const body = text();
    expect(body).not.toMatch(/Poll for completion/i);
    expect(body).not.toMatch(/every 3-5 seconds/i);
    expect(body).not.toMatch(/\bpoll(ing)?\b[^.]*\buntil\b/i);
    expect(body).not.toMatch(/MUST be followed by/i);
  });

  it("say the card is what shows a run's progress, and the platform's sentence the reply", () => {
    const body = text();
    expect(body).toMatch(/do not poll the run after a start/i);
    expect(body).toMatch(/say it back exactly as it is written/i);
  });

  it("keep the run read for a client that has no card", () => {
    // The half a naive removal would have broken: a headless client still has a
    // way to learn the outcome, and is still told which primitive it is.
    const body = text();
    expect(body).toContain("agent_run_get");
    expect(body).toMatch(/no conversation surface of its own/i);
  });
});
