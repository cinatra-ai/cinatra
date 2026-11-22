// The publish card on all four hosts -- the MOUNT inventory (cinatra#4150).
//
// The per-host RENDER is pinned in the card's own suite (every host draws exactly one card with an open decision and
// nothing without one) and in the conversation-mount suite (the real column on /chat and the widget). This file pins
// the INVENTORY of the two page hosts and the column, by reading source: the run panel and the review page are large
// trees (the review page an async SERVER component with a session and stores), and standing them up would prove
// more about a harness than about the mount. What must not rot silently is the SHAPE: each mount keyed by the run
// alone, under a real host declaration, passing no decide door (so its controls stay disabled), and the run panel's
// mount standing down inside a conversation host, where the column's card owns the run.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PANEL = "packages/agents/src/agentic-run-panel.tsx";
const REVIEW_PAGE = "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx";
const COLUMN = "packages/chat/src/chat-messages-view.tsx";

/** Every `<PublishDecisionCard ... />` element in a source, verbatim. */
function cardElements(source: string): string[] {
  return [...source.matchAll(/<PublishDecisionCard\b[^>]*\/>/g)].map((m) => m[0]);
}

/** The body of the FIRST host provider that encloses `index`, or null when none does. */
function enclosingHost(source: string, index: number): string | null {
  const open = /<LifecycleCardSurfaceProvider\b[^>]*host="([a-z_]+)"[^>]*>/g;
  let found: string | null = null;
  for (let m = open.exec(source); m !== null; m = open.exec(source)) {
    if (m.index > index) break;
    const close = source.indexOf("</LifecycleCardSurfaceProvider>", m.index);
    if (close > index) found = m[1]!;
  }
  return found;
}

describe("the publish card's mounts (cinatra#4150)", () => {
  it.each([
    // The panel passes the run's status as the card's change signal (a pure signal: nothing is read out of it).
    [PANEL, "run_card", "<PublishDecisionCard runId={runId} wireRef={status} />"],
    [REVIEW_PAGE, "page_gate_region", "<PublishDecisionCard runId={runId} />"],
  ])("%s mounts the card ONCE, keyed by the run, under %s", (file, host, element) => {
    const source = read(file);
    const elements = cardElements(source);
    expect(elements).toEqual([element]);
    expect(enclosingHost(source, source.indexOf(elements[0]!))).toBe(host);
  });

  it("the run panel's mount stands down inside a conversation host, on the hitl screen's own switch", () => {
    const source = read(PANEL);
    const at = source.indexOf("<PublishDecisionCard runId={runId} wireRef={status} />");
    const guard = source.lastIndexOf("{panelMountsHitlScreenCard ? (", at);
    expect(guard).toBeGreaterThan(-1);
    // The switch opens right before this mount's own provider, with nothing between them.
    const between = source.slice(guard, at);
    expect(between.match(/<LifecycleCardSurfaceProvider host="run_card">/g)).toHaveLength(1);
    expect(source).toMatch(/const panelMountsHitlScreenCard = runCardOwnsLifecycleCopy\(ambientLifecycleHost\);/);
  });

  it("the column mounts the card beside the hitl screen in every placement, with no decide door", () => {
    const source = read(COLUMN);
    expect(source).toContain('import { PublishDecisionCard } from "@cinatra-ai/agents/publish-decision-card-view";');
    // Its change signal is the run's status as the panel reports it, so a decision opened later still draws.
    expect(cardElements(source)).toEqual(["<PublishDecisionCard runId={runId} wireRef={runStatusSignal} />"]);
    expect(source).toContain("onRunStatusChange={onRunStatusChange}");
    // The turn's own placement and both moved placements draw it, exactly where they draw the hitl screen.
    expect(source).toContain("{turnCarriesSettledSchedule ? null : publishCard}");
    expect(source.match(/<div data-agent-run-screen-slot=\{runId\}>\{hitlScreen\}\{publishCard\}<\/div>/g)).toHaveLength(2);
  });

  it("no mount passes a decide door: the card's controls stay disabled until one is built", () => {
    for (const file of [PANEL, REVIEW_PAGE, COLUMN]) {
      for (const element of cardElements(read(file))) expect(element, file).not.toMatch(/\bdecide=/);
    }
  });
});
