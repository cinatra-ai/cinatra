// @vitest-environment jsdom
//
// THERE IS NO SKIP OUTCOME ON THE RUN PAGE (cinatra#3047, review point 2).
//
// With checkboxes there is no skip ACTION. Clearing every box and pressing
// Continue is what "run with no recommended skill" means: every recommendation
// is recorded as skipped and the run is released. So the run page's Skills step
// draws no outcome word, no "Skipped by <person>" and none of that panel's
// visuals — the settled reading of an all-clear row is the ROW ITSELF, with
// every box clear.
//
// WHAT IS PINNED HERE:
//
//   1. clearing every box and pressing Continue takes the SKIP path — every
//      recommendation recorded as skipped, the hold released, and no confirm;
//   2. the settled all-clear reading on the run page is the pills, every box
//      clear — no outcome panel, no outcome word, no decider name;
//   3. a settled skip that recorded NO evidence at all still draws the row on
//      the run page rather than the panel;
//   4. and the ONE host still drawing §V's chip row — the review page's gate
//      region — keeps the outcome panel, decider name and all (cinatra#3062
//      moved the chat and the widget onto the reading above; the gate region is
//      in neither issue's scope).
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-all-clear-is-the-skip.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const confirmRunRecommendationAction = vi.fn(async (_input: unknown) => ({
  ok: true,
  dispatched: false,
}));
const skipRunRecommendationAction = vi.fn(async (_input: { runId: string; holdRef?: string }) => ({
  ok: true,
  dispatched: true,
}));
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: (input: unknown) => confirmRunRecommendationAction(input),
  skipRunRecommendationAction: (input: { runId: string; holdRef?: string }) =>
    skipRunRecommendationAction(input),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  RecommendationHoldCard,
  RunRecommendationChipRow,
  type RunRecommendationDecision,
} from "../run-recommendation-chip-row";

const RUN_ID = "run-3047-all-clear";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const HOLD_REF = "hold-ref-3047";

const CANDIDATES = [
  {
    skillId: "@cinatra-ai/chat:blog-content",
    name: "Blog Content Skill",
    vendorName: "Northstar",
    skillRevisionId: "blog-content@7",
    recommended: true,
  },
  {
    skillId: "@cinatra-ai/chat:company-research",
    name: "Company Research Skill",
    vendorName: "Northstar",
    skillRevisionId: "company-research@2",
    recommended: true,
  },
];

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
  canDecide: true,
  recommendations: CANDIDATES.map((c) => ({
    ...c,
    score: 0.8,
    rank: 1,
    scoredFeatures: [],
  })),
};

/** The all-clear settled reading: the offer stands, nothing was kept. */
const SETTLED_ALL_CLEAR: RunRecommendationDecision = {
  kind: "skipped",
  runStarted: true,
  decided: CANDIDATES.map((c) => ({ skillId: c.skillId, name: c.name, mark: "skipped" as const })),
  candidates: CANDIDATES,
};

/** A settled skip whose durable evidence names nothing at all. */
const SETTLED_NO_EVIDENCE: RunRecommendationDecision = {
  kind: "skipped",
  runStarted: true,
  decided: [],
  decidedByName: "Alex Fisher",
};

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");
const outcomePanel = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-recommendation-outcome-panel]");

function mountCard(host: "run_card" | "chat_thread" | "page_gate_region") {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

function mountRow(host: "run_card" | "chat_thread" | "page_gate_region", decision: RunRecommendationDecision) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RunRecommendationChipRow
        runId={RUN_ID}
        agentPackageName={PKG}
        decision={decision}
        holdRef={HOLD_REF}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

beforeEach(() => {
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockClear();
  skipRunRecommendationAction.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("clearing every box and pressing Continue", () => {
  beforeEach(() => holdStateMock.mockResolvedValue(HELD));

  it("takes the SKIP path — the one that records every recommendation as skipped", async () => {
    // WHAT THIS MEASURES: which decision act an all-clear Continue submits, and
    // with what. That act's own durable half — one `user_skipped` row per
    // candidate the hold offered, the run-level marker, and the earlier
    // selection cleared against THAT offer — is pinned in
    // `run-recommendation-skip-evidence.test.ts`, where the writes are visible.
    const { container } = mountCard("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    // Both start checked — the scorer recommended both. Clear them.
    for (const box of boxes(container)) {
      expect(box.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(box);
    }
    await waitFor(() =>
      expect(boxes(container).every((b) => b.getAttribute("aria-checked") === "false")).toBe(true),
    );

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(skipRunRecommendationAction).toHaveBeenCalledTimes(1));
    // The SKIP path, bound to this hold — every recommendation recorded as
    // skipped by the one write that path makes, and NO confirm: an empty
    // selection is not an empty confirm, which would read back as no decision.
    expect(skipRunRecommendationAction.mock.calls[0]![0]).toEqual({
      runId: RUN_ID,
      holdRef: HOLD_REF,
    });
    expect(confirmRunRecommendationAction).not.toHaveBeenCalled();
  });
});

describe("the settled all-clear reading on the run page", () => {
  it("is the row itself with every box clear — no outcome panel", () => {
    const { container } = mountRow("run_card", SETTLED_ALL_CLEAR);
    expect(outcomePanel(container)).toBeNull();
    expect(boxes(container)).toHaveLength(2);
    for (const box of boxes(container)) expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("names no outcome word and no decider", () => {
    const { container } = mountRow("run_card", {
      ...SETTLED_ALL_CLEAR,
      decidedByName: "Alex Fisher",
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Skipped");
    expect(text).not.toContain("Alex Fisher");
    expect(text).not.toContain("by Alex Fisher");
    expect(container.querySelectorAll("[data-recommendation-outcome]")).toHaveLength(0);
  });

  it("draws the row, not the panel, even when the evidence names nothing", () => {
    const { container } = mountRow("run_card", SETTLED_NO_EVIDENCE);
    expect(row(container)).not.toBeNull();
    expect(outcomePanel(container)).toBeNull();
    expect(container.textContent).not.toContain("Alex Fisher");
  });
});

describe("the conversation takes the same all-clear reading (cinatra#3062)", () => {
  it("draws no outcome panel and names no decider in the chat", () => {
    // §V: "A row with every box clear is still the whole card. There is nothing
    // to skip and nothing that means skip … Nothing is summarised above the row,
    // and no panel stands in for it."
    const { container } = mountRow("chat_thread", SETTLED_ALL_CLEAR);
    expect(outcomePanel(container)).toBeNull();
    expect(container.textContent).not.toContain("Skipped");
    expect(boxes(container)).toHaveLength(2);
    for (const box of boxes(container)) expect(box.getAttribute("aria-checked")).toBe("false");
  });
});

describe("no host is left drawing the outcome panel", () => {
  it("the review page's gate region takes the all-clear reading too", () => {
    // THE PANEL HAS NO HOST NOW. This arm read "the one host still drawing the
    // outcome panel" and drove the review page's gate region, which was the
    // last mount cinatra#3062's leg left on the retired reading. cinatra#3047's
    // re-shoot round moved that host onto §V, so the bordered outcome plate the
    // drawing withdrew is drawn on no declared host at all — and this arm says
    // so by driving the host that used to be the exception and finding the
    // all-clear row instead, including with evidence that names a decider the
    // panel would have printed.
    const { container } = mountRow("page_gate_region", SETTLED_NO_EVIDENCE);
    expect(row(container)).not.toBeNull();
    expect(outcomePanel(container)).toBeNull();
    expect(container.querySelectorAll("[data-recommendation-outcome]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Alex Fisher");
  });
});
