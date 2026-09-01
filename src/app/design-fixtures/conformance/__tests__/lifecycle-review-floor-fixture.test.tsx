// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation review decision floor
// (cinatra#3156, epic #3155 W0).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e driver. The
// functional-acceptance driver asserts the manifest surface in a browser against
// the built app; this asserts the thing that driver depends on and that a
// browser run cannot tell you separately — that the harness MOUNT is the shipped
// floor, and that the outcome the driver will read is produced by the product
// rather than written by the harness. If the harness ever drifted back into
// naming its own outcome, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// The shipped decision chrome calls `router.refresh()` on a settled decision.
// jsdom mounts no router, so the seam is stubbed — the floor under test never
// navigates, and the comment path does not refresh at all.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleReviewFloorFixtures } from "../lifecycle-card-fixtures";
import { LIFECYCLE_REVIEW_FLOOR_FIXTURES } from "../lifecycle-card-fixture-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SURFACE = "review-decision-floor-in-thread";

describe("the conformance harness mount for the review decision floor", () => {
  it("mounts the SHIPPED floor under the surface id the manifest names", () => {
    const { container } = render(<LifecycleReviewFloorFixtures />);
    const root = container.querySelector(`[data-surface-id="${SURFACE}"]`);
    expect(root, "the fixture row is the manifest surface id").not.toBeNull();
    expect(root!.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull();
    // The subordinate rationale field is drawn inside the floor, not beside it.
    expect(
      root!.querySelector('[data-conformance-id="review-note-field-subordinate"]'),
    ).not.toBeNull();
    // Addressed by the MANIFEST'S OWN action names, which is how the driver
    // presses them: the shipped attribute is written "<action> -> <outcome>".
    expect(root!.querySelector('[data-action="comment-review -> annotated"]')).not.toBeNull();
    expect(root!.querySelector('[data-action="approve-review -> resolved"]')).not.toBeNull();
    expect(root!.querySelector('[data-action="reject-review -> resolved"]')).not.toBeNull();
  });

  it("presses the shipped Comment control and the PRODUCT decides the outcome", async () => {
    const { container } = render(<LifecycleReviewFloorFixtures />);
    const root = container.querySelector(`[data-surface-id="${SURFACE}"]`)!;
    const comment = root.querySelector<HTMLButtonElement>(
      '[data-action="comment-review -> annotated"]',
    )!;
    expect(comment.disabled).toBe(false);
    fireEvent.click(comment);

    const annotated = await waitFor(() => {
      const el = root.querySelector('[data-review-outcome="annotated"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // ANNOTATED is non-terminal, and that is the whole of what the name means.
    expect(annotated.getAttribute("role")).toBe("status");
    expect(root.querySelector('[data-review-outcome="decided"]')).toBeNull();
    expect(root.querySelector('[data-review-outcome="changes-requested"]')).toBeNull();
    // The gate stays open, so the terminal affordances stay live.
    expect(
      root.querySelector<HTMLButtonElement>('[data-action="approve-review -> resolved"]')!.disabled,
    ).toBe(false);
    expect(
      root.querySelector<HTMLButtonElement>('[data-action="reject-review -> resolved"]')!.disabled,
    ).toBe(false);
  });

  it("carries exactly the one fixture row this wave lands", () => {
    expect(LIFECYCLE_REVIEW_FLOOR_FIXTURES.map((f) => f.surfaceId)).toEqual([SURFACE]);
  });
});
