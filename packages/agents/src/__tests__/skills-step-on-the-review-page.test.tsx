// @vitest-environment jsdom
//
// THE REVIEW PAGE'S SKILLS STEP DRAWS THE SKILLS STEP (cinatra#3047, the
// re-shoot's first defect — its second half).
//
// Moving the row off the top of the review card is half the fix; the other half
// is WHAT the step it moved onto draws. The re-shoot's DOM reading of the review
// page recorded the row's wrapper as `flex flex-wrap gap-2` printing
// "Blog Idea Authoring Skill ✓ CONFIRMED / … ✗ SKIPPED" — the pre-refinement
// chip reading, with no checkbox and nothing to press. That reading is the one
// the change request's point C retired and the drawing at the capture contract's
// pin no longer draws: §V is checkbox pills, a `<name> by <vendor>` label and
// one Continue beneath the list, in its three readings.
//
// THE SEAM IS THE HOST DECLARATION, AND IT WIDENS BY ONE — STATED, NOT SLIPPED
// IN. `chipRowDrawsSkillChecklist` was `host === "run_card"`, because point C
// named the run page and point E gives the conversation and the widget their own
// issue. The review page is neither: it is the run's OWN second page — the same
// run, the same rail, the same Skills step — and the change request's point D
// names it in the same breath as the run page ("do not show the skills on top of
// the review card"). So the predicate is "the run's own pages", and the two
// transcript hosts are untouched, which the last two arms here read rather than
// assert in prose.
//
// WHY THE HOST IS NOT SIMPLY RE-DECLARED AS `run_card` ON THAT STEP. The anchor
// contract's `hostParity` records `recommendation_hold` as reaching
// `page_gate_region` by composition, and the host-parity ratchet raises
// `host-lost` for a kind that stops rendering on a host it is recorded on. The
// review page's mount stays `page_gate_region` — the same four hosts, the same
// two methods, nothing owed — and what changes is the READING that host draws.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-on-the-review-page.test.tsx
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
import {
  RecommendationHoldCard,
  chipRowDrawsSkillChecklist,
} from "../run-recommendation-chip-row";

const RUN_ID = "run-3047-review";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** The run's question, answered: two skills kept, two dropped — the shape the
 *  re-shoot's own decision readback recorded for its completed run. */
const SETTLED = {
  state: "confirmed" as const,
  skillNames: ["Blog Idea Authoring Skill", "Blog Writing Skill"],
  decided: [
    { skillId: "s-idea", name: "Blog Idea Authoring Skill", mark: "confirmed" as const },
    { skillId: "s-write", name: "Blog Writing Skill", mark: "confirmed" as const },
    { skillId: "s-voice", name: "Brand Voice Matcher Skill", mark: "skipped" as const },
    { skillId: "s-web", name: "Web Research Skill", mark: "skipped" as const },
  ],
  candidates: [
    { skillId: "s-idea", name: "Blog Idea Authoring Skill", skillRevisionId: "s-idea@1", rank: 1, recommended: true },
    { skillId: "s-write", name: "Blog Writing Skill", skillRevisionId: "s-write@1", rank: 2, recommended: true },
    { skillId: "s-voice", name: "Brand Voice Matcher Skill", skillRevisionId: "s-voice@1", rank: 3, recommended: false },
    { skillId: "s-web", name: "Web Research Skill", skillRevisionId: "s-web@1", rank: 4, recommended: false },
  ],
  runStarted: true,
  canDecide: true,
  holdRef: "hold-ref-review",
};

function mount(host: "run_card" | "page_gate_region" | "chat_thread") {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="checkbox"]'));

beforeEach(() => {
  holdStateMock.mockReset();
  holdStateMock.mockResolvedValue(SETTLED);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the seam", () => {
  it("names the run's own two pages", () => {
    expect(chipRowDrawsSkillChecklist("run_card")).toBe(true);
    expect(chipRowDrawsSkillChecklist("page_gate_region")).toBe(true);
  });

  it("and the two conversation hosts as well — no declared host is left out", () => {
    // THE DEVIATION THIS ARM NAMED IS CLOSED. It read "and no other host — the
    // conversation and the widget keep today's reading", which was true of
    // cinatra#3047's leg alone. cinatra#3062 moves `/chat` and the site widget
    // onto the same reading, so §IX's "every card appears on every host, and it
    // is the same card wherever it appears" is owed nowhere. The arm keeps its
    // job — it is still the one place the seam's whole answer is read — and
    // states the answer the two legs together produce.
    expect(chipRowDrawsSkillChecklist("chat_thread")).toBe(true);
    expect(chipRowDrawsSkillChecklist("site_widget")).toBe(true);
  });

  it("but a surface that never declared itself still draws no card", () => {
    // The seam stays a predicate rather than collapsing to `true` precisely
    // for this: an undeclared mount is not a host, and it draws nothing.
    expect(chipRowDrawsSkillChecklist(null)).toBe(false);
  });
});

describe("the settled Skills step on the review page", () => {
  it("draws the checkbox pills, not the retired CONFIRMED / SKIPPED chips", async () => {
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(row(container)).not.toBeNull());

    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    expect(boxes(container)).toHaveLength(4);
    // The words the photograph printed. None of them belongs to this reading.
    expect(container.textContent).not.toContain("CONFIRMED");
    expect(container.textContent).not.toContain("SKIPPED");
    expect(container.querySelectorAll("[data-chip-mark]")).toHaveLength(0);
  });

  it("keeps the run's answer on the boxes — kept skills checked, dropped ones clear", async () => {
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(boxes(container)).toHaveLength(4));

    const checked = boxes(container).map((b) => b.getAttribute("aria-checked"));
    expect(checked).toEqual(["true", "true", "false", "false"]);
  });

  it("is READ-ONLY once the run has started — no Continue, nothing to press", async () => {
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(row(container)).not.toBeNull());

    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
  });

  it("draws no bordered outcome plate — the reading the drawing withdrew", async () => {
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(container.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
  });

  it("reads exactly as the run page's own step does — one anatomy, two pages", async () => {
    const a = mount("page_gate_region");
    await waitFor(() => expect(row(a.container)).not.toBeNull());
    const reviewReading = row(a.container)!.getAttribute("data-run-recommendation-reading");
    const reviewBoxes = boxes(a.container).length;
    cleanup();

    const b = mount("run_card");
    await waitFor(() => expect(row(b.container)).not.toBeNull());
    expect(row(b.container)!.getAttribute("data-run-recommendation-reading")).toBe(reviewReading);
    expect(boxes(b.container)).toHaveLength(reviewBoxes);
  });
});

describe("the conversation reads the same step (cinatra#3062)", () => {
  it("draws the checkbox pills there too, and no per-chip settled face", async () => {
    // POINT E'S SEPARATE ISSUE LANDED. This arm pinned the change request's
    // point E — "the conversation and the embedded widget keep the chip-row
    // they draw today, byte for byte, until that issue lands" — and that issue
    // is cinatra#3062, which moves them. The arm keeps measuring the same
    // thing, the conversation's reading beside the review page's, and states
    // the reading it now draws: §V's checklist, the same one this file reads in
    // full on the review page.
    const { container } = mount("chat_thread");
    await waitFor(() => expect(row(container)).not.toBeNull());

    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    expect(boxes(container).length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-chip-mark]")).toHaveLength(0);
  });
});
