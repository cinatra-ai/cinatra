// @vitest-environment jsdom
//
// NO CARD AROUND THE ROW (cinatra#3047, review point 4).
//
// On the run page the skill pills and their Continue sit DIRECTLY in the run
// detail column beside the rail: no bordered white card, no panel chrome of any
// kind wraps them, and the read-only reading after the run has started sits
// there the same way.
//
// WHAT IS PINNED HERE, read off the mounted DOM rather than off source:
//
//   1. the row's ROOT carries no card treatment — no border, no ground, no
//      radius, no shadow, no padding of its own;
//   2. nothing between the row's root and the pills adds one either;
//   3. the read-only reading is the same;
//   4. and no bordered outcome panel is drawn on this host at all (which is the
//      one element that used to bring a card with it).
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/skills-step-has-no-card.test.tsx
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(),
  skipRunRecommendationAction: vi.fn(),
}));
vi.mock("../server-actions", () => ({ getRunRecommendedSkillsAction: vi.fn(async () => []) }));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  RunRecommendationChipRow,
  type RunRecommendationDecision,
} from "../run-recommendation-chip-row";

const CANDIDATES = [
  {
    skillId: "@cinatra-ai/chat:blog-content",
    name: "Blog Content Skill",
    vendorName: "Northstar",
    skillRevisionId: "blog-content@7",
    recommended: true,
  },
];

/**
 * CARD CHROME, as a class-name test rather than as a vibe. These are the
 * treatments that make a panel look like a card on this app's surfaces: an
 * outline, a ground, a corner radius, a drop shadow, or padding that insets the
 * content from an edge the element is drawing.
 */
const CARD_CHROME =
  /(^|\s)(border|border-[a-z]|rounded(-|$)|bg-(?!transparent)|shadow(-|$)|p-|px-|py-|pt-|pb-)/;

function mount(decision: RunRecommendationDecision) {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RunRecommendationChipRow
        runId="run-3047-no-card"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        decision={decision}
        holdRef="hold-ref-3047"
        initialRecommendations={CANDIDATES.map((c) => ({
          ...c,
          score: 0.9,
          rank: 1,
          scoredFeatures: [],
        }))}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const HELD: RunRecommendationDecision = { kind: "pending" };
const READ_ONLY: RunRecommendationDecision = {
  kind: "confirmed",
  skillNames: ["Blog Content Skill"],
  runStarted: true,
  decided: [
    { skillId: CANDIDATES[0]!.skillId, name: "Blog Content Skill", mark: "confirmed" },
  ],
  candidates: CANDIDATES,
};

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]")!;

/**
 * Every element from the row's root down to (but not including) a pill.
 *
 * THE STEP'S OWN FLOOR IS NOT A CARD, and it is excluded here rather than
 * silently matched (cinatra#3047, leg 7). The drawing draws the Continue row on
 * a rule of its own — `justify-content:flex-end; padding-top:12px; border-top:
 * 1px solid var(--line)` — which is a FLOOR under the list, not a frame around
 * it: one hairline on one edge, no ground, no radius, no shadow and no padding
 * that could box the pills. This scan reads "card chrome" off class names
 * alone, so a one-edge rule reads to it exactly like a four-edge border; the
 * exclusion is by the floor's own anchor, and the rule it must carry is
 * asserted positively in `skills-step-chrome-per-drawing.test.tsx` — so nothing
 * this scan stops looking at goes unwatched.
 */
function frameElements(c: HTMLElement): HTMLElement[] {
  const root = row(c);
  const out: HTMLElement[] = [root];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest("[data-skills-step-pill]")) continue;
    if (el.hasAttribute("data-skills-step-pill")) continue;
    if (el.hasAttribute("data-skills-step-floor")) continue;
    if (el.closest("button") || el.tagName === "BUTTON") continue;
    out.push(el);
  }
  return out;
}

/**
 * THE FLOOR CARRIES A RULE AND NOTHING ELSE. The exclusion above is bounded
 * here, and bounded by an ALLOWLIST rather than by a list of forbidden shapes
 * (convergence finding, leg 7): a denial list has to guess every way a frame
 * could be written — a bare `border`, `border-y`, `border-s`, a padding on one
 * side — and the one it forgets is the one that lands. These are the only
 * classes the skipped element may carry; the drawing's floor is exactly a top
 * hairline, the space above it and the alignment of the row it holds, so
 * anything else on it is by definition chrome this scan stopped watching.
 */
const FLOOR_CHROME_ALLOWED = new Set([
  "flex",
  "justify-end",
  "items-center",
  "border-t",
  "border-line",
  "pt-3",
]);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the live Skills step", () => {
  it("has no card wrapper on its root", () => {
    const { container } = mount(HELD);
    expect(row(container).className).not.toMatch(CARD_CHROME);
  });

  it("adds no panel chrome anywhere between the root and the pills", () => {
    const { container } = mount(HELD);
    for (const el of frameElements(container)) {
      expect(`${el.tagName} ${el.className}`).not.toMatch(CARD_CHROME);
    }
  });

  it("keeps the step's own floor a RULE and never lets it become a frame", () => {
    const { container } = mount(HELD);
    const floor = row(container).querySelector<HTMLElement>("[data-skills-step-floor]");
    expect(floor).not.toBeNull();
    const carried = floor!.className.split(/\s+/).filter(Boolean);
    // Stated as the whole set, so the failure names the offending class.
    expect(carried.filter((c) => !FLOOR_CHROME_ALLOWED.has(c))).toEqual([]);
    // …and the rule it exists to draw is required, not merely permitted.
    expect(carried).toEqual(expect.arrayContaining(["border-t", "border-line"]));
  });

  it("is the row itself, not a card containing a row — the root IS the card root", () => {
    const { container } = mount(HELD);
    const root = row(container);
    expect(root.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root.parentElement).toBe(container);
  });
});

/**
 * THE ONE READING THAT USED TO BRING A CARD WITH IT. A settled hold whose
 * durable evidence names no skill drew a bordered, inset panel in place of the
 * row — the outcome panel — and on the run page that panel IS the card this
 * point rules out. Review point 2 removes it from this host; this is what its
 * absence looks like measured as chrome.
 */
const ALL_CLEAR_NO_EVIDENCE: RunRecommendationDecision = {
  kind: "skipped",
  runStarted: true,
  decided: [],
};

describe("the settled all-clear reading", () => {
  it("draws no bordered panel in place of the row", () => {
    const { container } = mount(ALL_CLEAR_NO_EVIDENCE);
    for (const el of frameElements(container)) {
      expect(`${el.tagName} ${el.className}`).not.toMatch(CARD_CHROME);
    }
    expect(container.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
  });
});

describe("the read-only Skills step, after the run has started", () => {
  it("sits directly in the detail the same way", () => {
    const { container } = mount(READ_ONLY);
    expect(row(container).className).not.toMatch(CARD_CHROME);
    for (const el of frameElements(container)) {
      expect(`${el.tagName} ${el.className}`).not.toMatch(CARD_CHROME);
    }
  });

  it("draws no bordered outcome panel on this host", () => {
    const { container } = mount(READ_ONLY);
    expect(container.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
  });
});
