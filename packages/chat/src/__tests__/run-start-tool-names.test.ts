// THE RUN CARD DRAWS FOR BOTH START DOORS (cinatra#2935, lifecycle-b W5d) —
// acceptance item 1, "with the run card appearing", for the widget host.
//
// FOUND BY CONVERGENCE, ROUND 1, FINDING 1, and it was the sharpest kind of
// defect: the start SUCCEEDED and the conversation drew nothing. Three
// production gates decided whether a started run appears as a card, and all
// three compared a tool name against the single literal `agent_run`:
//
//   1. the turn's sink, which emits the durable `agent_run` DATA_PART — the
//      reducer contract's only sanctioned source for the card's runId;
//   2. the transcript view, which mounts `<InlineAgentRunCard>`;
//   3. the interactive renderer, which does the same for the ordered parts.
//
// The widget's own start carries a different tool name by construction (its
// closed allowlist does not hold `agent_run`), so a widget start would have
// produced a real run and a silent thread — the exact failure this plan's
// "never silence" rule exists to remove.
//
// These cases are RED on the base branch: the shared set does not exist there,
// and each gate holds its literal.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_RUN_TOOL_NAME,
  NAMED_AGENT_START_TOOL_NAME,
  RUN_START_TOOL_NAMES,
  isRunStartToolName,
} from "../run-start-tool-names";

// The repository root, from this file's own location — so the source
// assertions below resolve under EVERY vitest root that collects this suite
// (the repo config and the per-package ones alike).
const CHAT_SRC = join(__dirname, "..");
const REPO = join(CHAT_SRC, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("the closed set of names that start a run from a conversation", () => {
  it("is exactly the two doors onto the one road", () => {
    // Exhaustive on purpose: membership is what makes a tool result eligible to
    // pin a runId onto a card, so an addition is a decision about what may put a
    // lifecycle card on screen and must fail here.
    expect([...RUN_START_TOOL_NAMES].sort()).toEqual(
      ["agent_named_start", "agent_run"],
    );
    expect(AGENT_RUN_TOOL_NAME).toBe("agent_run");
    expect(NAMED_AGENT_START_TOOL_NAME).toBe("agent_named_start");
  });

  it("recognizes both and nothing else", () => {
    expect(isRunStartToolName("agent_run")).toBe(true);
    expect(isRunStartToolName("agent_named_start")).toBe(true);
    expect(isRunStartToolName("agent_run_get")).toBe(false);
    expect(isRunStartToolName("agent_run_stop")).toBe(false);
    expect(isRunStartToolName("Agent_Named_Start")).toBe(false);
    expect(isRunStartToolName(undefined)).toBe(false);
    expect(isRunStartToolName(null)).toBe(false);
    expect(isRunStartToolName("")).toBe(false);
  });
});

describe("every gate that mounts the run card reads that set, not a literal", () => {
  // Source assertions, the same convention the run-scope wiring audit uses: the
  // behaviour they stand for needs a live stream or a DOM, and what regresses is
  // always the same edit — someone narrows a comparison back to one name.
  it("the turn's sink emits the durable data part for both — and holds the SAME list", () => {
    const sink = read("src/lib/assistant-runtime/ag-ui-sink-adapter.ts");
    expect(sink).toContain("isRunStartToolName(d.name)");
    expect(sink).not.toContain('d.name === "agent_run"');
    // THE PIN, in both directions. The sink keeps its own copy of the list
    // because neither vitest root resolves the other tree's specifier; this
    // compares the two so the copy cannot drift — an addition here without one
    // there fails, and so does the reverse.
    const declared = sink.match(
      /const RUN_START_TOOL_NAMES: readonly string\[\] = \[([^\]]*)\]/,
    );
    expect(declared, "the sink's own list was not found").toBeTruthy();
    const sinkNames = [...declared![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(sinkNames).toEqual([...RUN_START_TOOL_NAMES].sort());
  });

  it("the transcript view mounts the card for both", () => {
    const view = readFileSync(join(CHAT_SRC, "chat-messages-view.tsx"), "utf8");
    expect(view).toContain("isRunStartToolName(part.name)");
    expect(view).toContain("<InlineAgentRunCard");
    expect(view).not.toContain('part.name === "agent_run"');
  });

  it("the run-card suppression gate reads the set — and holds the SAME list", () => {
    // cinatra#2991 gave the platform a writer that injects a review gate into a
    // run's own turn UNLESS that turn already draws the run's card. Its
    // predicate is the renderer's condition replayed on stored content, so a
    // narrower set here than in the renderer means a run started under the other
    // name is reported as drawing no card while the transcript draws one — and
    // the reader gets the gate twice, beside the card that already carries it.
    const outbox = read("src/lib/lifecycle/lifecycle-run-outbox.ts");
    expect(outbox).toContain("isRunStartToolName(raw.name)");
    expect(outbox).toContain("isRunStartToolName(call.name)");
    expect(outbox).not.toContain('raw.name === "agent_run"');
    expect(outbox).not.toContain('call.name === "agent_run"');
    const declared = outbox.match(
      /const RUN_START_TOOL_NAMES: readonly string\[\] = \[([^\]]*)\]/,
    );
    expect(declared, "the outbox's own list was not found").toBeTruthy();
    const names = [...declared![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...RUN_START_TOOL_NAMES].sort());
  });

  it("the interactive renderer mounts the card for both", () => {
    const interactive = readFileSync(
      join(CHAT_SRC, "renderer", "ag-ui-interactive.tsx"),
      "utf8",
    );
    expect(interactive).toContain("isRunStartToolName(part.name)");
    expect(interactive).not.toContain('part.name === "agent_run"');
  });
});
