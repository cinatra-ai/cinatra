// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation suggestion chips
// (cinatra#3156, epic #3155 W0).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e driver. The
// functional-acceptance driver asserts the manifest surface in a browser against
// the built app; this asserts what that driver depends on and what a browser run
// cannot tell you separately — that the harness MOUNT is the shipped chip row,
// and that every drawn consequence of a press is computed by the product rather
// than written by the harness. If the harness ever started naming a chip's state
// or its control itself, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { LifecycleSuggestionChipFixtures } from "../lifecycle-card-fixtures";
import { LIFECYCLE_SUGGESTION_CHIP_FIXTURES } from "../lifecycle-card-fixture-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SURFACE = "suggestion-accepted";

describe("the conformance harness mount for the suggestion chips", () => {
  it("mounts the SHIPPED chip row under the surface id the manifest names", () => {
    const { container } = render(<LifecycleSuggestionChipFixtures />);
    const root = container.querySelector(`[data-surface-id="${SURFACE}"]`);
    expect(root, "the fixture row is the manifest surface id").not.toBeNull();
    const row = root!.querySelector('[data-conformance-id="suggestion-chips"]');
    expect(row).not.toBeNull();
    // LIVE, not the recorded or the read-only partition: this reader may mark.
    expect(row!.getAttribute("data-suggestion-chips-mode")).toBe("live");
    // A suggestion ARRIVES accepted — there is no unmarked state to return to.
    const accepted = row!.querySelector('[data-conformance-id="suggestion-accepted"]');
    expect(accepted).not.toBeNull();
    expect(accepted!.getAttribute("data-suggestion-state")).toBe("accepted");
    // Addressed by the MANIFEST'S OWN action name, which is how the driver
    // presses it: the shipped attribute is written "action -> outcome".
    expect(accepted!.getAttribute("data-action")).toBe("dismiss-suggestion -> dismissed");
  });

  it("presses the shipped chip and the PRODUCT decides what is then drawn", async () => {
    const { container } = render(<LifecycleSuggestionChipFixtures />);
    const root = container.querySelector(`[data-surface-id="${SURFACE}"]`)!;
    const row = root.querySelector('[data-conformance-id="suggestion-chips"]')!;
    const accepted = row.querySelector('[data-action="dismiss-suggestion -> dismissed"]')!;
    fireEvent.click(accepted.querySelector("button")!);

    const dismissed = await waitFor(() => {
      const el = row.querySelector('[data-conformance-id="suggestion-dismissed"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(dismissed.getAttribute("data-suggestion-state")).toBe("dismissed");
    // ONE control per suggestion, and the toggle is its own inverse: the
    // accepted reading is gone and the same chip now offers the way back.
    expect(row.querySelector('[data-conformance-id="suggestion-accepted"]')).toBeNull();
    expect(dismissed.getAttribute("data-action")).toBe("accept-suggestion -> accepted");
    // A dismissal is a MARK, not a submit — the row stays live.
    expect(row.getAttribute("data-suggestion-chips-mode")).toBe("live");
  });

  it("carries exactly the one fixture row this wave lands", () => {
    expect(LIFECYCLE_SUGGESTION_CHIP_FIXTURES.map((f) => f.surfaceId)).toEqual([SURFACE]);
  });
});
