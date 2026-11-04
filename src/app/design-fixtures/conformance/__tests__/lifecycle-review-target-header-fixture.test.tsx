// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation artifact-kind cards
// (cinatra#3157, epic #3155 W1).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e driver. The
// functional-acceptance driver asserts the manifest surface in a browser against
// the built app; this asserts what that driver depends on and what a browser run
// cannot tell you separately — that the harness MOUNT is the shipped §IV target
// header, that it draws one header per pinned target in gate order, and that the
// harness composes no reading the product composes. If the harness ever started
// wording a type label or writing a row fact of its own, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  reviewTargetRevisionMarker,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { ReviewTargetHeaders } from "@cinatra-ai/agents/review-gate-card";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { reviewTargetRowFacts } from "@/lib/artifacts/review-target-row-facts";

import {
  LifecycleReviewTargetHeaderFixtures,
  reviewTargetFixtureHeader,
} from "../lifecycle-review-target-header-fixtures";
import {
  LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES,
  LIFECYCLE_REVIEW_TARGET_HEADER_NOW,
} from "../lifecycle-review-target-header-fixture-data";

/**
 * The seven manifest surface ids, spelled out HERE from the manifest's own
 * vocabulary (tests/e2e/design/conformance/manifests/app-lifecycle-cards.json)
 * rather than imported from the fixture module. Importing the module's own
 * constant would compare the list with itself, and dropping a surface from both
 * places at once would stay green — which is the whole failure this test exists
 * to prevent.
 */
const MANIFEST_SURFACES = [
  "review-card-email-body",
  "review-card-mixed-kind",
  "review-card-screenshot",
  "review-card-slide-deck",
  "review-card-dashboard",
  "review-card-portlet",
  "review-card-cms-page",
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the conformance harness mount for the artifact-kind cards", () => {
  it("mounts the SHIPPED target header under every manifest surface the family covers", () => {
    const { container } = render(<LifecycleReviewTargetHeaderFixtures />);
    for (const fixture of LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES) {
      const root = container.querySelector(`[data-surface-id="${fixture.surfaceId}"]`);
      expect(root, `${fixture.surfaceId} draws its declared mount`).not.toBeNull();
      // ONE HEADER PER PINNED TARGET, in gate order.
      const headers = root!.querySelectorAll('[data-conformance-id="review-target-header"]');
      expect(headers.length, `${fixture.surfaceId} header count`).toBe(fixture.headers.length);
      fixture.headers.forEach((seed, index) => {
        const header = headers[index]!;
        expect(header.textContent).toContain(seed.title);
        expect(header.textContent).toContain(seed.objectType);
        // The EXACT pinned revision, beside the elided reading the product draws.
        const revision = header.querySelector(
          `[data-review-target-revision="${seed.revisionId}"]`,
        );
        expect(revision, `${fixture.surfaceId} draws its pinned revision`).not.toBeNull();
        expect(header.textContent).toContain("pinned");
      });
    }
  });

  it("lets the PRODUCT word the type tag, from the type id the row carries", () => {
    const { container } = render(<LifecycleReviewTargetHeaderFixtures />);
    for (const fixture of LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES) {
      const root = container.querySelector(`[data-surface-id="${fixture.surfaceId}"]`)!;
      const tags = root.querySelectorAll("[data-review-target-type]");
      expect(tags.length).toBe(fixture.headers.length);
      fixture.headers.forEach((seed, index) => {
        const label = artifactKindLabelFor(seed.objectType);
        // Worded by the surface model the server-side composer words it with —
        // never a label the fixture row named for itself. Asserted on BOTH
        // readings, so a tag that kept the attribute and lost the text a reader
        // sees is red too.
        expect(tags[index]!.getAttribute("data-review-target-type")).toBe(label);
        expect(tags[index]!.textContent).toBe(label);
      });
    }
  });

  it("lets the PRODUCT compose the row facts, from the stored row the fixture carries", () => {
    const { container } = render(<LifecycleReviewTargetHeaderFixtures />);
    const now = new Date(LIFECYCLE_REVIEW_TARGET_HEADER_NOW);
    for (const fixture of LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES) {
      const root = container.querySelector(`[data-surface-id="${fixture.surfaceId}"]`)!;
      const headers = root.querySelectorAll('[data-conformance-id="review-target-header"]');
      fixture.headers.forEach((seed, index) => {
        // The meta line reads exactly what the shipped composer composes from
        // the row — owner level, visibility, MIME and the relative updated time,
        // in the drawing's order. A fixture that ever carried a finished fact
        // instead (a platform, an address, a preworded scope) is red here,
        // because the product has no reading that produces one.
        const facts = reviewTargetRowFacts(seed.row, now);
        expect(facts.length, `${fixture.surfaceId} fact count`).toBe(4);
        const text = headers[index]!.textContent ?? "";
        expect(text).toContain(facts.join(" · "));
      });
    }
  });

  it("shows the revision through the section's header projection: at the bound, past it, and across an astral character", () => {
    const now = new Date(LIFECYCLE_REVIEW_TARGET_HEADER_NOW);
    const seed = LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES[0]!.headers[0]!;
    const shownFor = (revisionId: string) => reviewTargetFixtureHeader({ ...seed, revisionId }, now).revisionId;
    // The boundary: an id of exactly the header's bound is shown whole, and
    // one unit past it is cut at the bound.
    const atBound = "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT);
    expect(shownFor(atBound)).toBe(atBound);
    expect(shownFor(`${atBound}r`)).toBe(atBound);
    // An astral character across the bound is dropped whole, never split.
    const astral = `${"r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1)}\uD83D\uDE00`;
    const shown = "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1);
    expect(shownFor(astral)).toBe(shown);
    // And the shipped header draws the projected text, not the stored id, in
    // all three readings: its attribute and its visible marker.
    for (const [stored, expected] of [
      [atBound, atBound],
      [`${atBound}r`, atBound],
      [astral, shown],
    ] as const) {
      const { container, unmount } = render(
        <ReviewTargetHeaders headers={[reviewTargetFixtureHeader({ ...seed, revisionId: stored }, now)]} />,
      );
      const revision = container.querySelector("[data-review-target-revision]");
      expect(revision?.getAttribute("data-review-target-revision")).toBe(expected);
      expect(revision?.textContent).toBe(`revision ${reviewTargetRevisionMarker(expected).short}`);
      unmount();
    }
  });

  it("draws an INERT header: no control, no link, no revision picker", () => {
    const { container } = render(<LifecycleReviewTargetHeaderFixtures />);
    const headers = container.querySelectorAll('[data-conformance-id="review-target-header"]');
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.querySelectorAll("button, a, input, select, textarea").length).toBe(0);
    }
  });

  it("carries exactly the manifest surfaces this wave lands, one row each", () => {
    expect(LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES.map((f) => f.surfaceId)).toEqual(
      MANIFEST_SURFACES,
    );
    for (const fixture of LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES) {
      expect(fixture.headers.length, `${fixture.surfaceId} pins one target`).toBe(1);
    }
  });
});


describe("the shipped header names the owner's scope by its type and its name (cinatra#3443)", () => {
  it("renders the team's row as the drawing's Team: Growth · Private", () => {
    const { container } = render(<LifecycleReviewTargetHeaderFixtures />);
    let matched = 0;
    for (const fixture of LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES) {
      const headers = container.querySelector(`[data-surface-id="${fixture.surfaceId}"]`)!
        .querySelectorAll('[data-conformance-id="review-target-header"]');
      fixture.headers.forEach((seed, index) => {
        if (seed.row.ownerLevel === "team" && seed.row.visibility === "private") {
          matched++;
          expect(headers[index]!.textContent).toContain("Team: Growth · Private · " + seed.row.mime);
          expect(headers[index]!.textContent).not.toContain("Team · Private");
        }
      });
    }
    expect(matched).toBeGreaterThan(0);
  });
});
