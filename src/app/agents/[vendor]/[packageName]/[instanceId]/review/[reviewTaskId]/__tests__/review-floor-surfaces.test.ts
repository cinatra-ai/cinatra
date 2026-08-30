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
 * one. The live per-surface proof on the running app is the browser walk
 * (`tests/e2e/review-floor`), authored by this slice.
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
const RAIL_ENTRY = read("packages/agents/src/run-step-rail-extra-entry.tsx");
const CONVERSATION_COLUMN = read("packages/chat/src/conversation-column.tsx");
const SURFACE_MODEL_SRC = read("src/lib/artifacts/review-surface-model.ts");
const REVIEW_ACTIONS = readFileSync(path.join(ROUTE, "actions.ts"), "utf8");
const DECIDE_ROUTE = read("src/app/api/lifecycle-views/decide/route.ts");
const CARD_REFETCH = read("src/lib/lifecycle/lifecycle-card-refetch.ts");

/** The floor's own three action anchors — the names the bar really emits. */
const FLOOR_ACTIONS = [
  'data-action="comment-review -> annotated"',
  'data-action="regenerate-review -> changes-requested"',
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

describe("the floor's own words, everywhere a review is read (cinatra#3080)", () => {
  it("the review page's standing prose uses neither retired word", () => {
    // THE DEFECT: the dedicated review page carried a standing subheading —
    // "Approve, reject, or comment on what an agent produced" — drawn above a
    // PENDING review. Item 1 forbids either retired word on a review surface,
    // and a heading is exactly as much a surface as a button is.
    const prose = [...stripComments(REVIEW_PAGE).matchAll(/description="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(prose.length).toBeGreaterThan(0);
    for (const line of prose) {
      expect(line).not.toMatch(/approve/i);
      expect(line).not.toMatch(/reject/i);
    }
    // …and it says what the floor actually offers instead.
    expect(prose.some((l) => /Comment/.test(l) && /Regenerate/.test(l) && /Continue/.test(l))).toBe(
      true,
    );
  });

  it("the run page's rail prints the SETTLED WORD, never the stored token", () => {
    // THE DEFECT: the rail rendered `entry.gate.disposition` straight out of the
    // column, so a settled Review entry read APPROVE after a Continue and
    // CHANGES_REQUESTED after a Regenerate — the machine's vocabulary, uppercased
    // by the badge's own CSS, on a person's surface.
    const code = stripComments(RAIL_ENTRY);
    expect(code).not.toMatch(/\{entry\.gate\?\.disposition/);
    expect(code).toMatch(/reviewSettledWord\(entry\.gate\?\.disposition\)/);
    expect(RAIL_ENTRY).toContain(
      'import { reviewSettledWord } from "@/lib/artifacts/review-surface-model";',
    );
  });

  it("a SETTLED gate's card heading reads as settled, not as still requested", () => {
    // THE DEFECT: `ReviewGateHeader` printed the literal "Review requested" on
    // every reading, so a gate that had already been continued or superseded
    // still headed its card with a request nobody was being asked for.
    expect(stripComments(GATE_CARD)).toMatch(
      /pending \? "Review requested" : "Review settled"/,
    );
  });

  it("no PENDING review surface renders a retired word in its PROSE, not only in its buttons", () => {
    // THE DEFECT the first fix leg left standing. The page's subheading was
    // rewritten, but the same class of defect survived in five other strings a
    // reader actually sees while a review is OPEN: the decision bar's
    // suggestion summary ("A reject records them as not taken."), the gate
    // card's two suggestion lines ("…until you approve or reject below.",
    // "Deciding these needs approve access on this run.") and three of the
    // floor's own access reasons ("A terminal Approve / Reject needs approve
    // access…"). Item 1 forbids either retired word on a pending review, and a
    // sentence is exactly as much a surface as a button is — the more so for
    // the suggestion summary, which after this slice is not merely retired
    // vocabulary but UNTRUE: there is no reject for a suggestion to ride.
    //
    // Buttons are already pinned by RETIRED below; this pins the PROSE, by
    // reading every rendered string literal out of the three files that own it
    // rather than by listing the five sentences (a list would pass the moment a
    // sixth was written).
    const prose = (src: string) => {
      const code = stripComments(src);
      const lits = [
        ...[...code.matchAll(/"([^"\\\n]{4,})"/g)].map((m) => m[1]),
        ...[...code.matchAll(/`([^`\\]{4,})`/g)].map((m) => m[1]),
        ...[...code.matchAll(/'([^'\\\n]{4,})'/g)].map((m) => m[1]),
      ];
      // Prose, not an identifier or a class string: a sentence has a space AND
      // ends a word with a full stop or names the floor's own actions.
      return lits.filter((l) => / /.test(l));
    };
    // THE ONE SENTENCE THAT MAY NAME REJECT: the typed road's answer to a person
    // who typed the retired word. Item 6 requires that answer to exist and to
    // say there is no reject — refusing to name the word would be answering a
    // different question. It is a REFUSAL, never a pending floor's own copy.
    const TYPED_REFUSAL = /There is no Reject on a review/;
    for (const [name, src] of [
      ["the decision bar", DECISION_BAR],
      ["the gate card", GATE_CARD],
      ["the floor's vocabulary", SURFACE_MODEL_SRC],
      // The two roads a floor press travels, whose refusals are drawn ON the
      // pending card: the review page's own server action, and the shared decide
      // route the review card inside a third-party application posts to.
      ["the review action", REVIEW_ACTIONS],
      ["the decide route", DECIDE_ROUTE],
      // The RESTRICTED reading's reason, resolved server-side and drawn on the
      // pending card itself — the sixth site, and the one a reader who may not
      // decide is the ONLY one to see.
      ["the restricted reason", CARD_REFETCH],
    ] as const) {
      for (const line of prose(src)) {
        if (TYPED_REFUSAL.test(line)) continue;
        expect(`${name}: ${line}`).not.toMatch(/\breject/i);
        expect(`${name}: ${line}`).not.toMatch(/\bapprove/i);
      }
    }
  });

  it("the chat column MEASURES the composer instead of guessing its height", () => {
    // THE DEFECT: at 1440x900 the docked composer painted over the lower part of
    // the chat review card's decision floor, so Comment/Regenerate/Continue could
    // not be reached. The list cleared the composer with a fixed `pb-24` guess.
    const code = stripComments(CONVERSATION_COLUMN);
    expect(code).toMatch(/composerDockRef/);
    expect(code).toMatch(/COMPOSER_CLEARANCE_GAP_PX/);
    expect(code).toMatch(/paddingBottom: composerClearance/);
  });
});

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

  it("the review SCREEN resolves the prompt and hands it down — and only that surface does", () => {
    // Item 5's pre-fill, end to end in source: the loader resolves the recorded
    // prompt onto the surface model, the page passes it to the card, and the
    // card forwards it to the floor. No other host supplies one, which is the
    // drawing's own asymmetry — the prompt is edited on the review screen.
    const PORTS = read("src/app/artifacts/[id]/review-gate-ports.ts");
    expect(PORTS).toContain("picturePrompt");
    expect(PORTS).toContain("recordedPrompt");
    expect(REVIEW_PAGE).toContain("picturePrompt={surface.kind === \"ready\" ? surface.picturePrompt : null}");
    expect(stripComments(GATE_CARD)).toContain("picturePrompt={picturePrompt}");
    // The chat registry mounts the card WITHOUT one — a card in a transcript
    // draws the note alone.
    expect(stripComments(CHAT_REGISTRY)).not.toContain("picturePrompt");
  });

  it("the prompt a picture is regenerated with never reaches a display", () => {
    // Item 5's "the display shows nothing of this". The prompt is the review
    // SCREEN's field: the bar holds it, and neither the panel nor the island is
    // handed it.
    expect(DECISION_BAR).toContain("picturePrompt");
    expect(stripComments(TARGET_PANEL)).not.toContain("picturePrompt");
    expect(stripComments(ISLAND)).not.toContain("picturePrompt");
    // The renderer props contract carries no prompt at all — nothing to leak.
    const props = read("packages/sdk-extensions/src/artifact-renderer-props.ts");
    expect(stripComments(props)).not.toMatch(/\bprompt\b/i);
  });
});

/** The vocabulary key a label belongs to — so the assertion above reads against
 *  the one record rather than repeating its strings. */
function labelKey(label: string): string {
  const entry = Object.entries(REVIEW_FLOOR_LABELS).find(([, v]) => v === label);
  if (!entry) throw new Error(`no floor action draws "${label}"`);
  return entry[0];
}
