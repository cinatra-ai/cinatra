// @vitest-environment jsdom
//
// THE SKILLS STEP'S OWN CHROME, SENTENCE BY SENTENCE (cinatra#3047, leg 7).
//
// The sixth proof round graded the Skills step at 15 of 22 applicable items on
// every frame of both palettes. The placement mechanism held — exactly one row
// root, in the run detail column, never in the run-progress panel — and every
// failure it recorded was the STEP'S CHROME against the ratified drawing. This
// suite pins one item per drawing sentence, read off a mounted card rather than
// off source, so a later change cannot quietly take any of them back.
//
// THE SENTENCES, quoted from the drawing this proof is graded against — the
// artifact-review page's Skills-step examples and their stylesheet:
//
//   1. THE CONTINUE ROW.  `<div style="display:flex;justify-content:flex-end;
//      margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">`.
//      The round measured it left-aligned, with no rule above it.
//   2. THE CONTINUE GLYPH. `<button …>Continue<svg …><path d="M5 12h14"/><path
//      d="m12 5 7 7-7 7"/></svg></button>` — the word, then a right arrow.
//      The round measured no glyph at all.
//   3. ONE GROUND FOR EVERY PILL. `.skchip { … border: 1px solid var(--line);
//      background: var(--surface-strong); }`, with no rule anywhere giving a
//      ticked pill a ground of its own: the drawing states the value in the box
//      alone. The round measured a tinted ground on the ticked pill.
//   4. THE PILL IS A STADIUM. `.skchip { … border-radius: 9999px; … }`. The
//      round measured roughly 6 CSS px.
//   5. THE READ-ONLY READING IS `aria-disabled`. The drawing's own "run that has
//      started" example writes `<span class="skchip" aria-disabled="true">` on
//      every pill, and `.skchip[aria-disabled="true"] { color: var(--muted); }`
//      dims the label with it.
//   6. THE NAME AND ITS BYLINE ARE TWO WEIGHTS. `font-weight:600` on the name,
//      `font-weight:500;color:var(--muted)` on the "by …" that follows it.
//
// WHY CLASSES AND NOT COMPUTED PIXELS. jsdom resolves no stylesheet, so a
// computed-style read here would measure nothing; the classes ARE the seam the
// step draws through, and the pixels they resolve to are measured on a live
// boot by the round's own checklist.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-chrome-per-drawing.test.tsx
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";

const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** One candidate the scorer recommended (its box opens ticked), one it did not. */
const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: "hold-ref-3047",
  canDecide: true,
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      vendorName: "Northstar",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
    {
      skillId: "skill-crm",
      skillRevisionId: "skill-crm@3",
      name: "CRM enrichment",
      vendorName: "Northstar",
      score: 0.2,
      rank: 2,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

/** The reading a run that has already started draws: the same pills, read-only. */
const SETTLED = {
  state: "confirmed" as const,
  skillNames: ["Blog content"],
  decided: [
    { skillId: "skill-blog", name: "Blog content", mark: "confirmed" as const },
    { skillId: "skill-crm", name: "CRM enrichment", mark: "skipped" as const },
  ],
  candidates: [
    {
      skillId: "skill-blog",
      name: "Blog content",
      skillRevisionId: "skill-blog@1",
      rank: 1,
      recommended: true,
    },
    {
      skillId: "skill-crm",
      name: "CRM enrichment",
      skillRevisionId: "skill-crm@3",
      rank: 2,
      recommended: false,
    },
  ],
};

const mount = () =>
  render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );

const pills = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-pill]"));
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  holdStateMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Continue row sits on a floor rule at the right of the detail", () => {
  beforeEach(() => {
    holdStateMock.mockResolvedValue(HELD);
  });

  it("puts Continue at the RIGHT of its own row, not at the left", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    const floor = container.querySelector<HTMLElement>("[data-skills-step-floor]");
    expect(floor).not.toBeNull();
    // The button is this row's own content, so the row is what aligns it.
    expect(floor!.contains(continueButton(container)!)).toBe(true);
    // BOTH HALVES OF THE SENTENCE. `justify-content` is inert without the flex
    // context the drawing names it in, so dropping `flex` would leave the
    // control back at the left with `justify-end` still on the row and this
    // test still green — the alignment is asserted as the pair it is.
    const alignment = floor!.className.split(/\s+/);
    expect(alignment).toContain("flex");
    expect(alignment).toContain("justify-end");
  });

  it("draws the rule ABOVE the row, with the drawing's own space either side", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    const floor = container.querySelector<HTMLElement>("[data-skills-step-floor]")!;
    const classes = floor.className.split(/\s+/);
    // `border-top: 1px solid var(--line)` over `padding-top: 12px`, and the
    // 12px of air between the list and the rule.
    // ONE EDGE, AND ONLY ONE. `border-t` is both the edge and its hairline;
    // `border-line` is the ink alone, and a floor carrying the ink without the
    // edge draws nothing. A BARE `border` here would be the four-edge frame
    // the step's no-card scan exists to forbid, so it is refused rather than
    // required — the pill, which the drawing does frame on every side, names
    // it instead.
    expect(classes).toContain("border-t");
    expect(classes).not.toContain("border");
    expect(classes).toContain("border-line");
    expect(classes).toContain("pt-3");
    // The 12px of air ABOVE the rule is the step's own row gap rather than a
    // second margin — one statement of the space, not two that can disagree.
    expect(floor.parentElement!.className.split(/\s+/)).toContain("gap-3");
  });

  it("carries a right-arrow glyph AFTER the word, inside the button", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    const button = continueButton(container)!;
    // THE ANCHOR IS THE SPAN, NOT THE ICON — the same rule the rail's own glyph
    // follows: a suite that stubs `lucide-react` renders no icon element, and
    // an anchor carried by the icon would vanish with it.
    const glyph = button.querySelector<HTMLElement>("[data-skills-step-continue-glyph]");
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("aria-hidden")).toBe("true");
    // AFTER the word: the label is a bare text node, so the glyph is the LAST
    // thing in the button and the word is what precedes it — a reader meets
    // "Continue" and then the arrow, never the arrow first.
    expect(button.textContent).toContain("Continue");
    expect(button.lastElementChild).toBe(glyph);
    expect(button.childNodes[0]!.textContent).toBe("Continue");
    // AND THE ARROW IS ACTUALLY DRAWN. The anchor alone proves only a marked
    // wrapper, which an empty span satisfies; this suite renders the real
    // icon set, so the glyph is required to hold the rendered mark.
    expect(glyph!.querySelector("svg")).not.toBeNull();
  });
});

describe("every pill has ONE ground, and the box alone states the value", () => {
  it("gives the ticked and the clear pill the very same ground and border", async () => {
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount();
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const [ticked, clear] = pills(container);
    // The fixture opens one box ticked and one clear — so the two pills below
    // differ in exactly the thing the drawing says they may differ in.
    expect(ticked!.getAttribute("data-skill-applied")).toBe("true");
    expect(clear!.getAttribute("data-skill-applied")).toBe("false");
    expect(ticked!.className).toBe(clear!.className);
    // …and the ground itself is the drawing's, named rather than merely equal.
    const classes = ticked!.className.split(/\s+/);
    expect(classes).toContain("bg-surface-strong");
    expect(classes).toContain("border");
    expect(classes).toContain("border-line");
  });

  it("keys no ground, border or ink off a ticked state ANYWHERE, stylesheet included", () => {
    // BYTE-IDENTICAL CLASS NAMES ARE NOT THE WHOLE SENTENCE (convergence
    // finding, leg 7). The two pills still differ by attribute —
    // `data-skill-applied`, and the box's own checked state — so a rule
    // written in a stylesheet rather than in a class could tint the ticked
    // pill while the equality above stayed green. The drawing's `.skchip` is
    // ONE rule with no ticked-state companion, so the absence is read at the
    // source seam the classes cannot reach: the row's own module and every
    // stylesheet this surface loads.
    const sources = [
      "../run-recommendation-chip-row.tsx",
      "../../../design/src/index.css",
      "../../../design/src/theme.css",
      "../../../design/src/tokens.css",
      "../../../design/src/utilities.css",
      "../../../../src/app/globals.css",
    ].map((rel) => ({
      rel,
      text: readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), rel), "utf8"),
    }));

    // A selector that reaches the pill and narrows it by a ticked state.
    const TICKED_STATE_RULE =
      /\[data-skill-applied[^\]]*\]|(?:skills-step-pill|recommendation-chip|skchip)[^\n{]*(?::checked|\[aria-checked|\[data-state=)/;
    for (const { rel, text } of sources) {
      expect(`${rel} ${TICKED_STATE_RULE.exec(text)?.[0] ?? ""}`.trim()).toBe(rel);
    }
  });

  it("draws the pill as a stadium, not a rounded box", async () => {
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount();
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    for (const pill of pills(container)) {
      const classes = pill.className.split(/\s+/);
      expect(classes).toContain("rounded-full");
      expect(classes).not.toContain("rounded-chip");
    }
  });

  it("weights the name over its byline, and mutes the byline alone", async () => {
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount();
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    for (const pill of pills(container)) {
      const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
      const name = pill.querySelector<HTMLElement>(`#${CSS.escape(box.getAttribute("aria-labelledby")!)}`)!;
      const vendor = pill.querySelector<HTMLElement>("[data-skills-step-vendor]")!;
      expect(name.className.split(/\s+/)).toContain("font-semibold");
      const vendorClasses = vendor.className.split(/\s+/);
      expect(vendorClasses).toContain("font-medium");
      expect(vendorClasses).toContain("text-muted-foreground");
      // The name is NOT muted — only the byline is.
      expect(name.className).not.toContain("text-muted-foreground");
    }
  });
});

describe("the reading a started run draws is stated as unavailable, not merely inert", () => {
  it("marks every read-only pill aria-disabled and dims its label with it", async () => {
    holdStateMock.mockResolvedValue(SETTLED);
    const { container } = mount();
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(continueButton(container)).toBeNull();
    for (const pill of pills(container)) {
      expect(pill.getAttribute("aria-disabled")).toBe("true");
      expect(pill.className.split(/\s+/)).toContain("text-muted-foreground");
      expect(pill.querySelector('[role="checkbox"]')!.hasAttribute("disabled")).toBe(true);
    }
  });

  it("leaves the editable reading with no aria-disabled at all", async () => {
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount();
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    for (const pill of pills(container)) {
      expect(pill.hasAttribute("aria-disabled")).toBe(false);
    }
  });
});
