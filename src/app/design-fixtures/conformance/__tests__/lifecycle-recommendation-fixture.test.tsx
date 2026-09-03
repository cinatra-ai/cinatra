// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation recommendation card
// (cinatra#3160, epic #3155 W4).
//
// WHAT THIS PINS. Two things the harness itself cannot be trusted to keep on its
// own:
//
//   1. THE MOUNT IS THE SHIPPED CARD. `RecommendationHoldCard` is the ONE
//      composer of `RunRecommendationChipRow` in the product (the one-card gate's
//      rule R2, scripts/audit/chat-hitl-one-card-gate.mjs). This file asserts the
//      harness module mounts the card and never the row — the same property the
//      gate enforces across the tree, asserted here at the seam where it was
//      broken once already.
//
//   2. EVERY READING IS THE PRODUCT'S. A reading is selected by handing the card
//      a RUN, and the card's OWN resolve is answered with the authoritative state
//      that run stands for — the shipped `RunRecommendationHoldState`, the same
//      object `getRunRecommendationHoldStateAction` returns. Nothing here names a
//      chip's mark, the empty line or a disabled control: the card derives the
//      row's props from the resolved state and the row derives the drawing from
//      those. If the harness ever started naming one of them, this is red.
//
// AND THE CARD'S FAIL-CLOSED READING IS PINNED TOO: with no authorised answer —
// which is the harness ROUTE's own situation, a dev-only public path with no
// session — the card draws no DOM at all. That is why this family is named on
// the wave's readiness list rather than driven by the functional-acceptance
// suite, and the claim is asserted here rather than only asserted in prose.

import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { LifecycleRecommendationFixtures } from "../lifecycle-recommendation-fixtures";
import {
  LIFECYCLE_RECOMMENDATION_APPLIED_KINDS,
  LIFECYCLE_RECOMMENDATION_CHIP_KINDS,
  LIFECYCLE_RECOMMENDATION_HOLD_STATE,
  LIFECYCLE_RECOMMENDATION_MOUNTS,
  LIFECYCLE_RECOMMENDATION_READINGS,
  LIFECYCLE_RECOMMENDATION_SKILL_ID,
  LIFECYCLE_RECOMMENDATION_SKILL_NAME,
} from "../lifecycle-recommendation-fixture-data";

// THE CARD'S OWN RESOLVE, answered per RUN with the authoritative state that run
// stands for. This is the card's real read path (the cookie-host branch), not a
// substitute for the card: the card still decides whether to draw, which props
// the row gets and when to re-read.
const holdStateForRun = vi.fn(async ({ runId }: { runId: string }) => {
  return LIFECYCLE_RECOMMENDATION_HOLD_STATE[runId] ?? { state: "none" as const };
});

vi.mock("../../../../../packages/agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));
vi.mock("../../../../../packages/agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateForRun(input),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderResolved() {
  const rendered = render(<LifecycleRecommendationFixtures />);
  // Two flushes: the card's resolve effect, then the render of its answer.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

function mountEl(container: HTMLElement, mount: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-surface-id="${mount}"]`);
  expect(el, `the harness draws its declared mount "${mount}"`).not.toBeNull();
  return el!;
}

function shippedRow(root: HTMLElement): HTMLElement {
  const row = root.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
  expect(row, "the mount holds the SHIPPED recommendation row").not.toBeNull();
  return row!;
}

describe("the conformance harness mount for the recommendation card", () => {
  it("mounts the SHIPPED CARD and never the row itself", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "lifecycle-recommendation-fixtures.tsx"),
      "utf8",
    );
    // The one composer of the row, imported from the module that owns it.
    expect(source).toContain("RecommendationHoldCard");
    // …and NO direct mount of the row, which is the retired parallel renderer
    // rule R2 forbids everywhere but the owner module itself.
    expect(
      /<\s*RunRecommendationChipRow\b/.test(source),
      "the harness mounts RecommendationHoldCard; a direct <RunRecommendationChipRow> mount is the retired parallel renderer (one-card gate R2)",
    ).toBe(false);
  });

  it("draws NO DOM at all until an authorised resolve answers", async () => {
    holdStateForRun.mockImplementationOnce(async () => ({ state: "none" as const }));
    const { container } = render(<LifecycleRecommendationFixtures />);
    // Before any answer has landed: the mounts exist, and every one of them is
    // empty. The card is fail-closed by construction.
    for (const mount of LIFECYCLE_RECOMMENDATION_MOUNTS) {
      expect(
        mountEl(container, mount).querySelector("[data-run-recommendation-chip-row]"),
        `mount "${mount}" draws nothing before the card's resolve answers`,
      ).toBeNull();
    }
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("draws NOTHING for a reader the resolve refuses — the harness route's own case", async () => {
    holdStateForRun.mockImplementation(async () => ({ state: "none" as const }));
    const { container } = await renderResolved();
    for (const mount of LIFECYCLE_RECOMMENDATION_MOUNTS) {
      expect(
        mountEl(container, mount).querySelector("[data-run-recommendation-chip-row]"),
        `mount "${mount}" draws nothing when the resolve answers "no row for this reader"`,
      ).toBeNull();
    }
    holdStateForRun.mockImplementation(async ({ runId }: { runId: string }) => {
      return LIFECYCLE_RECOMMENDATION_HOLD_STATE[runId] ?? { state: "none" as const };
    });
  });

  it("resolves every mount through the card, under the real chat-thread host", async () => {
    const { container } = await renderResolved();

    for (const mount of LIFECYCLE_RECOMMENDATION_MOUNTS) {
      const root = mountEl(container, mount);
      const rows = [...root.querySelectorAll<HTMLElement>("[data-run-recommendation-chip-row]")];
      expect(rows.length, `mount "${mount}" draws one row per reading`).toBe(
        mount === "recommendation-readings" ? 3 : 1,
      );
      for (const row of rows) {
        // The card-root declaration this card is identified by — all three of
        // it, computed by the product from the host it was declared under.
        expect(row.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
        expect(row.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
        expect(row.hasAttribute("data-chat-thread-recommendation-hold")).toBe(true);
      }
    }

    // The card is the whole card: the mount holds the row and nothing else.
    const paused = mountEl(container, "recommendation-paused");
    expect(paused.querySelectorAll(":scope > * > *").length).toBe(1);

    const readings = mountEl(container, "recommendation-readings");
    for (const reading of LIFECYCLE_RECOMMENDATION_READINGS) {
      expect(readings.querySelector(`[data-reading="${reading}"]`)).not.toBeNull();
    }
  });

  it("lets the PRODUCT derive the started reading's third chip from the run's evidence", async () => {
    const { container } = await renderResolved();
    const running = mountEl(container, "recommendation-readings").querySelector<HTMLElement>(
      '[data-reading="running"]',
    )!;
    const row = shippedRow(running);
    expect(row.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(row.getAttribute("data-run-recommendation-settled")).toBe("true");
    // Nothing is left to press once the run has started.
    expect(row.querySelectorAll("button").length).toBe(0);

    for (const kind of LIFECYCLE_RECOMMENDATION_CHIP_KINDS) {
      const chip = row.querySelector<HTMLElement>(
        `[data-recommendation-chip][data-skill-id="${LIFECYCLE_RECOMMENDATION_SKILL_ID[kind]}"]`,
      );
      expect(chip, `the started reading draws a pill for "${kind}"`).not.toBeNull();
      const applied = LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.includes(kind);
      expect(chip!.getAttribute("data-chip-mark")).toBe(applied ? "confirmed" : "skipped");
      expect(chip!.textContent).toContain(LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind]);
    }

    // AND THE HARNESS NEVER SAID SO — asserted over the STATE THE RESOLVE
    // ACTUALLY ANSWERED, not over a restatement of it. The offer names every
    // proposed skill; the evidence names ONLY the skills that ended with a
    // selection row. The skill with no row is the one the drawing draws with its
    // box clear, and deriving that is the shipped `settledChipsForRow`'s job.
    const answered = await holdStateForRun.mock.results[0]!.value;
    const decidedState =
      LIFECYCLE_RECOMMENDATION_HOLD_STATE["run-conformance-3160-decided"]!;
    expect(decidedState.state).toBe("confirmed");
    const evidence = decidedState.state === "confirmed" ? decidedState.decided : [];
    const decidedIds = new Set(evidence.map((entry) => entry.skillId));
    for (const kind of LIFECYCLE_RECOMMENDATION_CHIP_KINDS) {
      expect(
        decidedIds.has(LIFECYCLE_RECOMMENDATION_SKILL_ID[kind]),
        "the run's evidence records a selection row only where a selection was made: " + kind,
      ).toBe(LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.includes(kind));
    }
    // Neither the un-selected skill's reading nor the empty line is anywhere in
    // what the resolve answered — both are the product's own.
    const handed = JSON.stringify({ answered, states: LIFECYCLE_RECOMMENDATION_HOLD_STATE });
    expect(handed).not.toContain("skipped");
    expect(handed).not.toContain("No candidate skills");
  });

  it("lets the PRODUCT draw the empty reading from a held run with no candidate", async () => {
    const { container } = await renderResolved();
    const empty = shippedRow(mountEl(container, "recommendation-empty"));
    expect(empty.getAttribute("data-lifecycle-card-state")).toBe("held");
    expect(empty.querySelectorAll("[data-recommendation-chip]").length).toBe(0);
    expect(empty.textContent).toContain("No candidate skills");
  });

  it("lets the PRODUCT draw the restricted reading from the reader's rights alone", async () => {
    const { container } = await renderResolved();
    const restricted = shippedRow(
      mountEl(container, "recommendation-readings").querySelector<HTMLElement>(
        '[data-reading="restricted"]',
      )!,
    );
    expect(restricted.getAttribute("data-can-decide")).toBe("false");
    const chip = restricted.querySelector<HTMLElement>("[data-recommendation-chip]")!;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    const controls = [...chip.querySelectorAll("button")];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control.disabled).toBe(true);
    expect(restricted.querySelector("[data-run-recommendation-restricted]")).not.toBeNull();
  });
});
