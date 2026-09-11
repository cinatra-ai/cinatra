// @vitest-environment jsdom
//
// The conformance harness mounts for the ONE-OFF surfaces of the
// in-conversation lifecycle drawing (cinatra#3165, epic #3155 W9).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e drivers. The
// functional-acceptance drivers assert each manifest surface in a browser
// against the built app; this asserts what those drivers depend on and what a
// browser run cannot tell you separately — that each mount is the SHIPPED
// component, and that every reading the drivers grade is computed by the
// product rather than written by the harness. The moment the harness starts
// naming a type label, a blocked title, a chip mode or a reader's reading
// itself, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  // ReviewGateBlocked's Refresh falls back to the ROUTE refresh when a card
  // supplies no card-local one. The harness supplies none, so the component
  // needs an app router to exist; nothing in this file presses it.
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { LifecycleOneOffFixtures } from "../lifecycle-one-off-fixtures";
import {
  LIFECYCLE_READER_STATES,
  LIFECYCLE_REVIEW_TARGET_FIXTURE,
  LIFECYCLE_REVIEW_TARGET_TYPE_LABEL,
} from "../lifecycle-one-off-fixture-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  return render(<LifecycleOneOffFixtures />).container;
}

const populated = (container: HTMLElement, surface: string) =>
  container.querySelector(`[data-surface-id="${surface}"][data-variant="populated"]`);

describe("the harness mounts for the drawing's one-off surfaces", () => {
  it("draws the SHIPPED review-target header, with the type label the PRODUCT derives", () => {
    const root = populated(mount(), "review-target-in-thread");
    expect(root, "the review target mount is drawn").not.toBeNull();
    const header = root!.querySelector('[data-conformance-id="review-target-header"]');
    expect(header).not.toBeNull();
    // name = type.displayName. The harness writes no label: it hands the header
    // the artifact's TYPE ID and the shipped `artifactKindLabelFor` derives the
    // short display name from it. This is the expectation that derivation is
    // reconciled against — a change to the rule reds here first.
    const typeTag = header!.querySelector("[data-review-target-type]");
    expect(typeTag!.getAttribute("data-review-target-type")).toBe(
      LIFECYCLE_REVIEW_TARGET_TYPE_LABEL,
    );
    expect(typeTag!.textContent).toBe(LIFECYCLE_REVIEW_TARGET_TYPE_LABEL);
    // Bound to the TYPE, not to the artifact's own title — and the two share no
    // token, so a header that read the title could not pass this.
    expect(typeTag!.textContent).not.toContain(LIFECYCLE_REVIEW_TARGET_FIXTURE.title);
    expect(header!.textContent).toContain(LIFECYCLE_REVIEW_TARGET_FIXTURE.title);
    // The harness publishes its raw sources, so the driver names a source of
    // truth rather than whatever the header rendered.
    expect(root!.getAttribute("data-review-target-title")).toBe(
      LIFECYCLE_REVIEW_TARGET_FIXTURE.title,
    );
    expect(root!.getAttribute("data-review-target-object-type")).toBe(
      LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType,
    );
    // §IV: the header is INERT — no edit control, no revision picker.
    expect(header!.querySelectorAll("button").length).toBe(0);
  });

  it("draws the two other review readings as the SHIPPED components, on their own variants", () => {
    const container = mount();
    for (const surface of ["review-target-in-thread", "review-states-outside-chat"]) {
      const loading = container.querySelector(
        `[data-surface-id="${surface}"][data-variant="loading"]`,
      );
      expect(
        loading!.querySelector('[data-conformance-id="review-gate-loading"]'),
        `${surface} draws the shipped loading skeleton`,
      ).not.toBeNull();
      // A loading reading does not keep the previous header on screen.
      expect(loading!.querySelector('[data-conformance-id="review-target-header"]')).toBeNull();

      const error = container.querySelector(
        `[data-surface-id="${surface}"][data-variant="error"]`,
      );
      const blocked = error!.querySelector('[data-conformance-id="review-gate-blocked"]');
      expect(blocked, `${surface} draws §IV's "no longer open" panel`).not.toBeNull();
      expect(blocked!.getAttribute("data-blocked-reason")).toBe("no-longer-pending");
      // The TITLE is the component's, from the closed reason set — never the
      // harness's own wording.
      expect(blocked!.textContent).toContain("This review is no longer open");
    }
  });

  it("draws the run-progress placeholder with the card's own name and nothing to press", () => {
    const root = populated(mount(), "run-progress-placeholder-in-thread");
    const placeholder = root!.querySelector('[data-conformance-id="review-gate-placeholder"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.getAttribute("role")).toBe("status");
    expect(placeholder!.getAttribute("aria-busy")).toBe("true");
    // The card's own fixed name is the WHOLE of the words on it: a status word,
    // a progress line or an early result would be drawn beside it and a
    // contains-check would pass with them there.
    expect(placeholder!.textContent).toBe("Agentic Run Progress");
    // Names no status, reports no result, draws nothing to press — and there is
    // exactly one arc.
    expect(placeholder!.querySelectorAll("button").length).toBe(0);
    expect(placeholder!.querySelectorAll("a").length).toBe(0);
    expect(placeholder!.querySelectorAll("svg").length).toBe(1);
    expect(placeholder!.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("draws the reader matrix's mounted readings from INPUTS, never from styles", () => {
    const root = populated(mount(), "reader-state-matrix");
    expect(root!.querySelectorAll("[data-reader-state]").length).toBe(
      LIFECYCLE_READER_STATES.length,
    );

    const acts = root!.querySelector('[data-reader-state="may-view-and-act"]')!;
    const actsRow = acts.querySelector('[data-conformance-id="suggestion-chips"]')!;
    expect(actsRow.getAttribute("data-suggestion-chips-mode")).toBe("live");
    expect(actsRow.querySelectorAll("button").length).toBe(1);

    const views = root!.querySelector('[data-reader-state="may-view-not-act"]')!;
    const viewsRow = views.querySelector('[data-conformance-id="suggestion-chips"]')!;
    // Read-only is a DIFFERENT ELEMENT, not a disabled button.
    expect(viewsRow.getAttribute("data-suggestion-chips-mode")).toBe("read-only");
    expect(viewsRow.querySelectorAll("button").length).toBe(0);
    expect(viewsRow.querySelector('[data-conformance-id="suggestion-accepted"]')).not.toBeNull();
    // The reason is the component's own sentence, and it is on screen.
    expect(viewsRow.textContent).toContain("Deciding these needs approve access on this run.");

    // The withheld reading is NOT mounted from an empty suggestion set: that
    // would pin what an empty list does, not what a denied reader gets. It is on
    // the wave's readiness list, and this is the assertion that keeps a later
    // hand from quietly re-adding the look-alike.
    expect(root!.querySelector('[data-reader-state="may-not-read"]')).toBeNull();
    // Neither reading is ever drawn as a disabled press target.
    expect(root!.querySelectorAll("button[disabled]").length).toBe(0);
  });
});
