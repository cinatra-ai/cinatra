/**
 * ONE FLOOR, FOUR SURFACES (cinatra#3080 acceptance items 1 and 7).
 *
 * Item 1 asks for "a conformance test per surface" pinning Comment · Regenerate
 * · Continue and asserting that neither Reject nor Approve is drawn on a pending
 * review. The honest way to answer that in this tree is to prove the thing that
 * makes all four surfaces agree: there is exactly ONE component that draws a
 * review floor, every surface mounts it, and no surface adds a floor of its own.
 * A per-surface list of button labels would be four copies of the same claim
 * that could each be satisfied by a different component.
 *
 * So this suite reads sources and asserts, per surface:
 *
 *   1. the chat thread          — the renderable-view registry dispatches
 *                                 `artifact_review_gate` to `ReviewGateCard`;
 *   2. the review page          — the route mounts `ReviewGateCard`;
 *   3. the run page's review step — the run surface mounts `ReviewGateCard`;
 *   4. inside a third-party app — the widget host mounts the same card, and the
 *                                 display ISLAND it frames draws no floor at all;
 *
 * and then, once, that the ONE floor draws the three actions and neither retired
 * one. The live per-surface proof on the running app (acceptance item 9's
 * browser test) is not part of this change; it is owed by the proof round.
 *
 * ITEM 7 rides the same structure: no artifact renderer carries a Regenerate
 * control. That is proven as the shared-renderer proof item 7 explicitly allows
 * — every display reaches the reviewer through `ReviewTargetPanel`, which is
 * rendered by the island, and neither carries a decision control.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { REVIEW_FLOOR_LABELS } from "@/lib/artifacts/review-surface-model";

const ROUTE = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROUTE, "..", "..", "..", "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Strip comments so a NEGATIVE assertion matches real code, never a docstring
 *  that names the very thing it forbids. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DECISION_BAR = read("packages/agents/src/review-decision-bar.tsx");
const GATE_CARD = read("packages/agents/src/review-gate-card.tsx");
const CHAT_REGISTRY = read("packages/chat/src/renderable-views/registry.tsx");
const REVIEW_PAGE = readFileSync(path.join(ROUTE, "page.tsx"), "utf8");
const RUN_SURFACE = read("packages/agents/src/instance-screens.tsx");
const ISLAND = read("src/app/lifecycle/review-island/page.tsx");
const TARGET_PANEL = readFileSync(path.join(ROUTE, "review-target-panel.tsx"), "utf8");

/** The floor's own three action anchors — the names the bar really emits. */
const FLOOR_ACTIONS = [
  'data-action="comment-review -> annotated"',
  'data-action="regenerate-review -> successor-gate-opened"',
  'data-action="continue-review -> resolved"',
];

/** Any review DECISION anchor, live or retired — the set a surface may not grow
 *  a second copy of. Deliberately not `[a-z-]+-review`, which would also catch
 *  the composer-binding anchor the card legitimately draws. */
const FLOOR_ACTION_RE = /data-action="(comment|regenerate|continue|approve|reject)-review/g;

/** Every retired name, in every spelling a surface could bring back. */
const RETIRED = [
  'data-action="approve-review',
  'data-action="reject-review',
  ">Approve<",
  ">Reject<",
];

describe("item 1 — the ONE floor draws exactly Comment · Regenerate · Continue", () => {
  it("emits the three action anchors and no fourth", () => {
    for (const action of FLOOR_ACTIONS) expect(DECISION_BAR).toContain(action);
    const emitted = stripComments(DECISION_BAR).match(FLOOR_ACTION_RE) ?? [];
    expect(emitted).toHaveLength(3);
  });

  it("draws the three labels from the one vocabulary, not from four literals", () => {
    for (const label of Object.values(REVIEW_FLOOR_LABELS)) {
      expect(DECISION_BAR).toContain(`REVIEW_FLOOR_LABELS.${labelKey(label)}`);
    }
  });

  it("draws NEITHER Reject NOR Approve on a pending review", () => {
    const code = stripComments(DECISION_BAR);
    for (const retired of RETIRED) expect(code).not.toContain(retired);
  });
});

describe("item 1 — every surface mounts that one floor, and adds none of its own", () => {
  const SURFACES: ReadonlyArray<[string, string]> = [
    ["the chat thread", CHAT_REGISTRY],
    ["the review page", REVIEW_PAGE],
    ["the run page's review step", RUN_SURFACE],
  ];

  for (const [surface, source] of SURFACES) {
    it(`${surface} mounts ReviewGateCard`, () => {
      expect(source).toContain("ReviewGateCard");
    });

    it(`${surface} draws no review floor of its own`, () => {
      const code = stripComments(source);
      for (const action of [...FLOOR_ACTIONS, ...RETIRED]) {
        expect(code).not.toContain(action);
      }
    });
  }

  it("inside a third-party application it is the SAME card — the widget is a host, not a second drawing", () => {
    // The card resolves its host from the surface provider; `site_widget` is one
    // of them and gets the live floor, which is what makes "one renderer, every
    // host" true rather than asserted.
    expect(GATE_CARD).toContain("site_widget");
    expect(stripComments(GATE_CARD)).toContain("<ReviewDecisionBar");
    // And the card COMPOSES the floor rather than drawing one: not a single
    // review-action anchor is emitted by the card itself. (Its own
    // `focus-review-composer` is the composer binding, not a decision.)
    const emitted = stripComments(GATE_CARD).match(FLOOR_ACTION_RE) ?? [];
    expect(emitted).toHaveLength(0);
  });
});

describe("item 7 — no artifact renderer carries a Regenerate control", () => {
  it("the display ISLAND inside a third-party application stays display-only", () => {
    const code = stripComments(ISLAND);
    expect(code).not.toContain("ReviewDecisionBar");
    for (const action of [...FLOOR_ACTIONS, ...RETIRED]) expect(code).not.toContain(action);
    expect(code).not.toContain("Regenerate");
  });

  it("the ONE target panel every display reaches the reviewer through carries no decision control", () => {
    // The shared-renderer proof item 7 allows: the markdown display, the
    // blog-image display and the download card are all mounted by this panel —
    // the ladder is resolved here and nowhere else — so a Regenerate absent from
    // it is absent from every display kind.
    const code = stripComments(TARGET_PANEL);
    expect(code).not.toContain("ReviewDecisionBar");
    expect(code).not.toContain("Regenerate");
    for (const action of [...FLOOR_ACTIONS, ...RETIRED]) expect(code).not.toContain(action);
  });

  it("the recorded prompt is resolved on the server from the pinned revision and reaches the floor through the one card", () => {
    // Item 5's pre-fill, end to end in source, on main's road (#4054): the gate
    // ports read the pinned revision's recorded prompt (its finalized ledger row
    // only; a failed read fails), the resolve route hands it to the card, and
    // the ONE card forwards it to the ONE floor. No display gets it.
    const PORTS = read("src/app/artifacts/[id]/review-gate-ports.ts");
    expect(PORTS).toContain("export async function readReviewGateRecordedPrompt");
    expect(PORTS).toContain("return readRevisionImagePrompt(");
    const RESOLVE = read("src/app/api/lifecycle-views/resolve/route.ts");
    expect(RESOLVE).toContain("readReviewGateRecordedPrompt");
    expect(stripComments(GATE_CARD)).toContain("recordedPrompt={recordedPrompt}");
  });

  it("the prompt a picture is regenerated with never reaches a display", () => {
    // Item 5's "the display shows nothing of this". The prompt is the review
    // SCREEN's field: the bar holds it, and neither the panel nor the island is
    // handed it.
    expect(DECISION_BAR).toContain("recordedPrompt");
    expect(stripComments(TARGET_PANEL)).not.toContain("recordedPrompt");
    expect(stripComments(ISLAND)).not.toContain("recordedPrompt");
  });
});

/** The vocabulary key a label belongs to — so the assertion above reads against
 *  the one record rather than repeating its strings. */
function labelKey(label: string): string {
  const entry = Object.entries(REVIEW_FLOOR_LABELS).find(([, v]) => v === label);
  if (!entry) throw new Error(`no floor action draws "${label}"`);
  return entry[0];
}
