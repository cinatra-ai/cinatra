// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation recommendation row
// (cinatra#3160, epic #3155 W4).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e drivers. The
// functional-acceptance drivers assert the thirteen manifest surfaces in a
// browser against the built app; this asserts what those drivers depend on and
// what a browser run cannot tell you separately — that every harness MOUNT is
// the shipped `RunRecommendationChipRow` under the real chat-thread host
// declaration, and that every drawn reading is computed by the product from the
// inputs the harness hands it. If the harness ever started naming a chip's mark,
// the loading line, the empty line or the disabled state itself, this is red.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  LifecycleRecommendationFixtures,
  STARTED_RUN_DECISION,
} from "../lifecycle-recommendation-fixtures";
import {
  LIFECYCLE_RECOMMENDATION_APPLIED_KINDS,
  LIFECYCLE_RECOMMENDATION_CANDIDATES,
  LIFECYCLE_RECOMMENDATION_CHIP_KINDS,
  LIFECYCLE_RECOMMENDATION_MOUNTS,
  LIFECYCLE_RECOMMENDATION_READINGS,
  LIFECYCLE_RECOMMENDATION_SKILL_ID,
  LIFECYCLE_RECOMMENDATION_SKILL_NAME,
} from "../lifecycle-recommendation-fixture-data";

// The row's server graph stays out of jsdom. Nothing here answers a decision:
// the harness presses nothing, and neither does this file.
vi.mock("../../../../../packages/agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));
vi.mock("../../../../../packages/agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
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

describe("the conformance harness mount for the recommendation row", () => {
  it("mounts the SHIPPED row, under the real chat-thread host, on every declared mount", async () => {
    const { container } = render(<LifecycleRecommendationFixtures />);
    await act(async () => {
      await Promise.resolve();
    });

    for (const mount of LIFECYCLE_RECOMMENDATION_MOUNTS) {
      const root = mountEl(container, mount);
      const rows =
        mount === "recommendation-readings"
          ? [...root.querySelectorAll<HTMLElement>("[data-run-recommendation-chip-row]")]
          : [shippedRow(root)];
      expect(rows.length).toBe(mount === "recommendation-readings" ? 3 : 1);
      for (const row of rows) {
        // The card-root declaration the capture contract identifies this card
        // by — all three of it, computed by the product from the host it was
        // declared under.
        expect(row.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
        expect(row.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
        expect(row.hasAttribute("data-chat-thread-recommendation-hold")).toBe(true);
      }
    }

    // The side-by-side example draws the drawing's three readings, each on its
    // own block so a driver can address one of them.
    const readings = mountEl(container, "recommendation-readings");
    for (const reading of LIFECYCLE_RECOMMENDATION_READINGS) {
      expect(readings.querySelector(`[data-reading="${reading}"]`)).not.toBeNull();
    }
  });

  it("draws the row and NOTHING ELSE under the mount — the row is the whole card", async () => {
    const { container } = render(<LifecycleRecommendationFixtures />);
    await act(async () => {
      await Promise.resolve();
    });
    const root = mountEl(container, "recommendation-paused");
    expect(root.children.length).toBe(1);
    expect(root.children[0]!.hasAttribute("data-run-recommendation-chip-row")).toBe(true);
  });

  it("lets the PRODUCT derive the started reading's third chip from the run's evidence", async () => {
    const { container } = render(<LifecycleRecommendationFixtures />);
    await act(async () => {
      await Promise.resolve();
    });
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

    // AND THE HARNESS NEVER SAID SO — asserted over the OBJECT THE ROW IS
    // ACTUALLY HANDED, not over a restatement of it. A guard that inspects a
    // synthetic copy cannot see what the real object carries, so it is the real
    // `decision` prop and the real offer that are read here.
    //
    // The offer names every proposed skill; the evidence names ONLY the skills
    // that ended with a selection row, each with the mark that row recorded. The
    // skill with no row is the one the drawing draws with its box clear, and
    // deriving that is the shipped `settledChipsForRow`'s job.
    const evidence =
      STARTED_RUN_DECISION.kind === "confirmed" ? (STARTED_RUN_DECISION.decided ?? []) : [];
    const decidedIds = new Set(evidence.map((row) => row.skillId));
    for (const kind of LIFECYCLE_RECOMMENDATION_CHIP_KINDS) {
      expect(
        decidedIds.has(LIFECYCLE_RECOMMENDATION_SKILL_ID[kind]),
        "the run's evidence records a selection row only where a selection was made: " + kind,
      ).toBe(LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.includes(kind));
    }
    const handed = JSON.stringify({
      decision: STARTED_RUN_DECISION,
      candidates: LIFECYCLE_RECOMMENDATION_CANDIDATES,
      names: LIFECYCLE_RECOMMENDATION_SKILL_NAME,
    });
    // The un-selected skill's reading, the loading line and the empty line are
    // all the product's — none of the three is anywhere in what it was handed.
    expect(handed).not.toContain("skipped");
    expect(handed).not.toContain("Loading recommendations");
    expect(handed).not.toContain("No candidate skills");
  });

  it("lets the PRODUCT draw the loading and the empty readings", async () => {
    const { container } = render(<LifecycleRecommendationFixtures />);
    // Before the offer is read: the row's own loading line, on the mount that is
    // handed no prefetched offer.
    expect(shippedRow(mountEl(container, "recommendation-loading")).textContent).toContain(
      "Loading recommendations",
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Offered no skill at all, the row still keeps its place and states it.
    const empty = shippedRow(mountEl(container, "recommendation-empty"));
    expect(empty.getAttribute("data-lifecycle-card-state")).toBe("held");
    expect(empty.querySelectorAll("[data-recommendation-chip]").length).toBe(0);
    expect(empty.textContent).toContain("No candidate skills");
  });

  it("lets the PRODUCT draw the restricted reading from the reader's rights alone", async () => {
    const { container } = render(<LifecycleRecommendationFixtures />);
    await act(async () => {
      await Promise.resolve();
    });
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
