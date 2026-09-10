// @vitest-environment jsdom
//
// The conformance harness mount for the review gate's LOADING and BLOCKED
// readings (cinatra#3163, epic #3155 W7).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e driver. The
// functional-acceptance driver asserts the manifest surface in a browser against
// the built app; this asserts what that driver depends on and what a browser run
// cannot tell you separately — that the harness MOUNT is the shipped gate-state
// component, and that every word and every reason it draws is the product's,
// computed from the closed blocked axis, rather than copy written into the
// fixture. If the harness ever started naming a gate's reason or its refresh
// itself, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { reviewBlockedCopy } from "@/lib/artifacts/review-surface-model";

import { ReviewGateStateConformanceFixtures } from "../review-gate-state-fixtures";
import {
  REVIEW_GATE_STATE_FIXTURES,
  REVIEW_GATE_BLOCKED_FIXTURE_REASON,
} from "../review-gate-state-fixture-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the conformance harness mount for the review gate states", () => {
  it("draws one mount per declared reading, keyed by the manifest surface", () => {
    const { container } = render(<ReviewGateStateConformanceFixtures />);
    for (const fixture of REVIEW_GATE_STATE_FIXTURES) {
      const mount = container.querySelector(
        `[data-surface-id="${fixture.surface}"][data-variant="${fixture.variant}"]`,
      );
      expect(mount, `${fixture.surface}/${fixture.variant}: the fixture draws its declared mount`).not.toBeNull();
      expect(mount!.querySelector(`[data-conformance-id="${fixture.surface}"]`)).not.toBeNull();
    }
  });

  it("mounts the SHIPPED loading skeleton — a busy region, and never a status word", () => {
    const { container } = render(<ReviewGateStateConformanceFixtures />);
    const skeleton = container.querySelector('[data-conformance-id="review-gate-loading"]')!;
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    // Section VII: "the surface shows a loading skeleton in the target slot —
    // never a flash of empty chrome". The skeleton says nothing; a word here
    // would be a status the drawing does not give it.
    expect(skeleton.textContent).toBe("");
  });

  it("mounts the SHIPPED blocked panel and the PRODUCT writes its words", () => {
    const { container } = render(<ReviewGateStateConformanceFixtures />);
    const blocked = container.querySelector('[data-conformance-id="review-gate-blocked"]')!;
    // The reason comes from the closed set the surface model owns, and the copy
    // is resolved from it by the product — the fixture supplies neither.
    expect(blocked.getAttribute("data-blocked-reason")).toBe(REVIEW_GATE_BLOCKED_FIXTURE_REASON);
    const copy = reviewBlockedCopy(REVIEW_GATE_BLOCKED_FIXTURE_REASON);
    expect(blocked.textContent).toContain(copy.title);
    expect(blocked.textContent).toContain(copy.body);
    // "A blocked gate offers a refresh back to the live gate" (section VII).
    expect(blocked.querySelector('[data-action="refresh-gate -> live-gate"]')).not.toBeNull();
  });

  it("writes no copy of its own into either reading", () => {
    const fixture = REVIEW_GATE_STATE_FIXTURES;
    expect(fixture.length).toBeGreaterThan(0);
    // A fixture row names a surface, a reading and nothing else: no title, no
    // body, no label. What is drawn is the shipped component's to decide.
    for (const row of fixture) {
      expect(Object.keys(row).sort()).toEqual(["surface", "variant"]);
    }
  });
});
