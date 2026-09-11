// @vitest-environment jsdom
//
// THE SKILL PILLS ON THE RUN PAGE CARRY A CHECKBOX, NOT THREE BUTTONS
// (cinatra#3047, review point C).
//
// The review, verbatim: "Remove all buttons from the skill pills, i.e.
// 'Confirm', 'Adjust', 'Skip' - instead, show a checkbox in the front of the
// pill, I.e. before the name of the skill. Selected checkbox means that this
// skill must be applied to the agent run."
//
// WHAT IS PINNED HERE, all of it read off a mounted card rather than off source:
//
//   1. the run page's held reading has NO `data-skill-action` control at all;
//   2. one checkbox per pill, IN FRONT of the name and LABELLED by it, in the
//      tab order and operable from the keyboard (a native button carrying
//      role=checkbox — the vendored primitive, because the design-system
//      boundary admits no raw <input>);
//   3. THE INITIAL STATE IS THE RECOMMENDATION'S OWN DEFAULT: checked for a
//      candidate the scorer recommended, unchecked for one it did not (the
//      below-threshold force-add the row has always offered). A reader who
//      changes nothing runs exactly the recommendation;
//   4. checked maps to CONFIRMED and unchecked to SKIPPED when the step is
//      submitted, and no `adjusted` mark can be produced from this screen;
//   5. the SETTLED reading is the same pills with the box read-only;
//   6. and the conversation host is untouched — it still draws the three
//      affordances and no checkbox (review point E gives the chat and the
//      widget their own issue).
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-checkbox-pills.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type ConfirmInput = {
  runId: string;
  agentPackageName: string;
  confirmedSkillIds: string[];
  promptText?: string;
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
  holdRef?: string;
};
const confirmRunRecommendationAction = vi.fn(async (_input: ConfirmInput) => ({
  ok: true,
  dispatched: true,
}));
const skipRunRecommendationAction = vi.fn(async (_input: { runId: string; holdRef?: string }) => ({
  ok: true,
  dispatched: true,
}));
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: (input: ConfirmInput) => confirmRunRecommendationAction(input),
  skipRunRecommendationAction: (input: { runId: string; holdRef?: string }) =>
    skipRunRecommendationAction(input),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";

const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** Two candidates: one the scorer RECOMMENDED, one it did not. */
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
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
    {
      skillId: "skill-crm",
      skillRevisionId: "skill-crm@3",
      name: "CRM enrichment",
      score: 0.2,
      rank: 2,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

const SETTLED = {
  state: "confirmed" as const,
  skillNames: ["Blog content"],
  decided: [
    { skillId: "skill-blog", name: "Blog content", mark: "confirmed" as const },
    { skillId: "skill-crm", name: "CRM enrichment", mark: "skipped" as const },
  ],
  candidates: [
    { skillId: "skill-blog", name: "Blog content", skillRevisionId: "skill-blog@1", rank: 1, recommended: true },
    { skillId: "skill-crm", name: "CRM enrichment", skillRevisionId: "skill-crm@3", rank: 2, recommended: false },
  ],
};

function mount(host: "run_card" | "chat_thread" | "page_gate_region") {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const row = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const pills = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-recommendation-chip]"));
const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockClear();
  skipRunRecommendationAction.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the held Skills step on the run page", () => {
  beforeEach(() => {
    holdStateMock.mockResolvedValue(HELD);
  });

  it("draws NO Confirm / Adjust / Skip control anywhere in the row", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Confirm");
    expect(container.textContent).not.toContain("Adjust");
    expect(container.textContent).not.toContain("Skip");
  });

  it("draws one checkbox per pill, IN FRONT of the skill name and labelled by it", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(boxes(container)).toHaveLength(2);
    for (const pill of pills(container)) {
      const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
      // IN FRONT OF THE NAME: the box is the pill's first element child, and
      // the name follows it in document order.
      expect(pill.firstElementChild).toBe(box);
      const labelId = box.getAttribute("aria-labelledby")!;
      const label = pill.querySelector(`#${CSS.escape(labelId)}`)!;
      expect(label.textContent).toBe(
        pill.getAttribute("data-skill-id") === "skill-blog" ? "Blog content" : "CRM enrichment",
      );
      expect(box.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("gives each checkbox a real control the platform operates — not a painted box", async () => {
    // WHAT THIS MEASURES, exactly (named in the convergence round rather than
    // left to the title): the STRUCTURE that makes the control keyboard-
    // operable — a native <button> carrying role=checkbox and aria-checked,
    // left in the tab order and not disabled. jsdom does not synthesize the
    // click a browser fires for Space or Enter on a button, so a keydown here
    // would prove nothing about the platform's own behaviour; what a suite CAN
    // hold is that the element is the kind of control the platform operates,
    // and that is what is asserted.
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    for (const box of boxes(container)) {
      // A native button carrying the checkbox role: the platform operates it
      // with Space and Enter, and it stays in the tab order.
      expect(box.tagName).toBe("BUTTON");
      expect(box.getAttribute("type")).toBe("button");
      expect(box.getAttribute("tabindex")).toBeNull();
      expect(box.hasAttribute("disabled")).toBe(false);
      expect(box.getAttribute("aria-checked")).toMatch(/^(true|false)$/);
    }
  });

  it("starts every box at the recommendation's OWN default — recommended on, the rest off", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const state = Object.fromEntries(
      pills(container).map((p) => [
        p.getAttribute("data-skill-id"),
        p.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"),
      ]),
    );
    expect(state).toEqual({ "skill-blog": "true", "skill-crm": "false" });
    // …and the pill states the same answer for a capture to read.
    expect(
      Object.fromEntries(
        pills(container).map((p) => [
          p.getAttribute("data-skill-id"),
          p.getAttribute("data-skill-applied"),
        ]),
      ),
    ).toEqual({ "skill-blog": "true", "skill-crm": "false" });
  });

  it("maps checked to CONFIRMED and unchecked to SKIPPED when the step is submitted", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    // Take the recommendation as offered: Blog content in, CRM enrichment out.
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    const call = confirmRunRecommendationAction.mock.calls[0]![0];
    expect(call.confirmedSkillIds).toEqual(["skill-blog"]);
    // NO `adjusted` mark can be produced from this screen — a checkbox has two
    // positions and neither of them means "I opened this one and shaped it".
    expect(call.adjustedSkillIds).toBeUndefined();
    expect(call.forcedRevisions).toBeUndefined();
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
  });

  it("checking a NOT-recommended candidate forces it on, revision-pinned", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const crm = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-crm")!;
    fireEvent.click(crm.querySelector('[role="checkbox"]')!);
    await waitFor(() =>
      expect(crm.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("true"),
    );

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    const call = confirmRunRecommendationAction.mock.calls[0]![0];
    expect([...call.confirmedSkillIds].sort()).toEqual(["skill-blog", "skill-crm"]);
    expect(call.forcedRevisions).toEqual({ "skill-crm": "skill-crm@3" });
  });

  it("clearing every box submits the run as SKIPPED, not as an empty confirm", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const blog = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-blog")!;
    fireEvent.click(blog.querySelector('[role="checkbox"]')!);
    await waitFor(() =>
      expect(blog.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("false"),
    );

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(skipRunRecommendationAction).toHaveBeenCalledTimes(1));
    expect(confirmRunRecommendationAction).not.toHaveBeenCalled();
  });
});

describe("the settled Skills step on the run page", () => {
  it("draws the same pills with the box read-only, and nothing to press", async () => {
    holdStateMock.mockResolvedValue(SETTLED);
    const { container } = mount("run_card");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    // The pills are the SAME pills: a box in front of the name.
    for (const pill of pills(container)) {
      const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
      expect(pill.firstElementChild).toBe(box);
      expect(box.hasAttribute("disabled")).toBe(true);
    }
    expect(
      Object.fromEntries(
        pills(container).map((p) => [
          p.getAttribute("data-skill-id"),
          p.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"),
        ]),
      ),
    ).toEqual({ "skill-blog": "true", "skill-crm": "false" });
    // Nothing left to press: no Continue, and no per-chip affordance either.
    expect(continueButton(container)).toBeNull();
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
  });
});

describe("the conversation is untouched (review point E)", () => {
  // WHICH HOSTS ARE STILL "EVERY OTHER" NARROWED BY ONE (cinatra#3047, the
  // re-shoot's first defect). This arm drove `chat_thread` AND
  // `page_gate_region`, because point C named the run page alone. The re-shoot
  // then photographed the review page still drawing the retired chip reading
  // above its review card, and the review page is not "another host" in the
  // sense point E means: it is the run's OWN second page — the same run, the
  // same rail, the same Skills step — and the change request names it beside
  // the run page. So `page_gate_region` draws the Skills step now, which
  // `skills-step-on-the-review-page.test.tsx` reads in full, and what is left
  // here is the CONVERSATION, which point E still leaves alone.
  //
  // THE WIDGET IS NOT DRIVEN HERE, and the reason is a property of the product
  // rather than a gap: `site_widget` is not a cookie host, so the surface
  // provider refuses to mount it without a credential declaration and the card
  // reads and decides through the broker instead. Driving it needs that
  // declaration and a stub for both broker routes, which
  // `recommendation-hold-card.test.tsx` already carries — and its per-host arm
  // asserts the same reading, for all four hosts, through each host's own
  // transport.
  it.each(["chat_thread"] as const)(
    "keeps the three affordances on %s, and draws no checkbox and no Continue",
    async (host) => {
      holdStateMock.mockResolvedValue(HELD);
      const { container } = mount(host);
      await waitFor(() => expect(pills(container)).toHaveLength(2));

      expect(row(container)!.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBeNull();
      expect(container.querySelectorAll('[data-skill-action="confirm"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-skill-action="adjust"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-skill-action="skip"]')).toHaveLength(2);
      expect(boxes(container)).toHaveLength(0);
      expect(continueButton(container)).toBeNull();
    },
  );
});
