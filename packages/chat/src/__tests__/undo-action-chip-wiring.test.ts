// UndoActionChip wiring. Source-pin
// (repo convention for client components): the chip mounts under the agent_run
// card (the parts that carry a runId), uses bounded polling
// (not a tight loop), and deep-links to the ?openRestore
// modal via undoDeepLink.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(PKG_ROOT, rel), "utf8");

describe("chat undo chip wiring", () => {
  it("the messages view mounts <UndoActionChip runId> in the agent_run branch", () => {
    // cinatra#918: the agent_run render branch (OrderedPartsSection) moved from
    // chat-page.tsx into the lazily-loaded conversation view.
    const src = read("src/chat-messages-view.tsx");
    expect(src).toMatch(/import \{ UndoActionChip \} from "\.\/chat-undo-action-chip"/);
    // Mounted inside the agent_run tool_call branch (which has part.runId).
    expect(src).toMatch(/part\.name === "agent_run" && part\.runId/);
    expect(src).toMatch(/<UndoActionChip runId=\{part\.runId\}/);
  });

  it("the chip uses bounded polling + the ?openRestore deep-link", () => {
    const src = read("src/chat-undo-action-chip.tsx");
    expect(src).toMatch(/POLL_DELAYS_MS/);
    // Bounded — a small fixed set of delays, not setInterval.
    expect(src).not.toMatch(/setInterval/);
    expect(src).toMatch(/undoDeepLink\(changeSetId\)/);
    expect(src).toMatch(/recentUndoableChangeSetForRunAction/);
    // shadcn: data-icon on the button icon, Button asChild + Link.
    expect(src).toMatch(/data-icon="inline-start"/);
    // §VI: the rendered (eligible-only) chip carries the artifacts-undo-entry
    // conformance anchor; the ineligible state is its absence (null render).
    expect(src).toMatch(/data-conformance-id="artifacts-undo-entry"/);
  });
});
