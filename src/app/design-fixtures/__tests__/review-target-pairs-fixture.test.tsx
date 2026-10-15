// @vitest-environment jsdom
//
// The legacy two-target pending gate fixture on the /design-fixtures index page
// (cinatra#4129).
//
// A review gate opened before reviews became one per artifact, and still
// pending, can pin two targets. The card draws such a gate one target after
// another: each target's header directly above its own island frame. The
// fixture mounts the card's own pair component, so these cases read the
// shipped drawing: the paired layout, the header/body association, the pinned
// order, and the header while its body loads and when its body fails.
//
// The revision ids and type ids are spelled out HERE rather than imported from
// the fixture's data module: importing them would compare the fixture with
// itself, and a change to both places at once would stay green.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REVIEW_TARGET_ISLAND_PATH } from "@cinatra-ai/agents/review-gate-card";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";

import { ReviewTargetPairsFixture } from "../review-target-pairs-fixture";

/** The two pinned revisions, in the gate's order. */
const PINNED = ["rev_3e90", "rev_b7d5"];
/** The two titles, in the same order. */
const TITLES = ["Launch announcement — first draft", "Board update — October"];
/** The two type ids the rows carry, in the same order. */
const OBJECT_TYPES = ["@acme/email-body:body", "@acme/slide-deck:artifact"];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pairsOf(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("[data-review-target-pair]")];
}

function frameQuery(frame: Element): URLSearchParams {
  const src = frame.getAttribute("src") ?? "";
  const query = src.indexOf("?");
  return new URLSearchParams(query < 0 ? "" : src.slice(query + 1));
}

/** Each header sits directly above its own body, and the body frames that header's target. */
function expectEachHeaderAboveItsOwnBody(container: HTMLElement): void {
  const pairs = pairsOf(container);
  expect(pairs).toHaveLength(2);
  pairs.forEach((pair, i) => {
    const header = pair.firstElementChild;
    expect(header?.getAttribute("data-conformance-id")).toBe("review-target-header");
    expect(header?.textContent).toContain(TITLES[i]);
    expect(
      header
        ?.querySelector("[data-review-target-revision]")
        ?.getAttribute("data-review-target-revision"),
    ).toBe(PINNED[i]);
    const body = header?.nextElementSibling;
    expect(body?.getAttribute("data-conformance-id")).toBe("review-target-island");
    const frame = body?.querySelector("iframe");
    expect(frame, "the body holds its island frame").not.toBeNull();
    expect(frameQuery(frame!).get("target")).toBe(PINNED[i]);
  });
}

describe("cinatra#4129 — the legacy two-target pending gate fixture", () => {
  it("draws one pair per pinned target, in pinned order", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    const root = container.querySelector('[data-fixture="review-target-pairs"]');
    expect(root).not.toBeNull();
    const pairs = pairsOf(container);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((pair) => pair.getAttribute("data-review-target-pair"))).toEqual(PINNED);
    expect(
      pairs[0]!.compareDocumentPosition(pairs[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("each header sits directly above its own body", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    expectEachHeaderAboveItsOwnBody(container);
  });

  it("the header is drawn while its body loads", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    const islands = [...container.querySelectorAll('[data-conformance-id="review-target-island"]')];
    expect(islands).toHaveLength(2);
    for (const island of islands) {
      expect(island.getAttribute("data-island-load-state")).toBe("loading");
      expect(
        island.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
      ).not.toBeNull();
    }
    const headers = [...container.querySelectorAll('[data-conformance-id="review-target-header"]')];
    expect(headers).toHaveLength(2);
    headers.forEach((header, i) => {
      expect(header.isConnected).toBe(true);
      expect(header.textContent).toContain(TITLES[i]);
    });
  });

  it("the header stays above its own failed body", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<ReviewTargetPairsFixture />);
    act(() => {
      vi.advanceTimersByTime(12_500);
    });
    const islands = [...container.querySelectorAll('[data-conformance-id="review-target-island"]')];
    expect(islands).toHaveLength(2);
    for (const island of islands) {
      expect(island.getAttribute("data-island-load-state")).toBe("timed-out");
      expect(
        island.querySelector('[data-conformance-id="review-target-island-timeout"]'),
      ).not.toBeNull();
    }
    expectEachHeaderAboveItsOwnBody(container);
  });

  it("the fixture composes no reading of its own", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    const tags = [...container.querySelectorAll("[data-review-target-type]")];
    expect(tags).toHaveLength(2);
    tags.forEach((tag, i) => {
      const label = artifactKindLabelFor(OBJECT_TYPES[i]!);
      expect(tag.getAttribute("data-review-target-type")).toBe(label);
      expect(tag.textContent).toBe(label);
    });
  });

  it("the island address is the denial road, never the sign-in road", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    const frames = [...container.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const src = frame.getAttribute("src") ?? "";
      const query = src.indexOf("?");
      expect(query < 0 ? src : src.slice(0, query)).toBe(REVIEW_TARGET_ISLAND_PATH);
      // `ic` is the island's credential parameter: with it the island answers
      // its one denial document and never redirects to sign-in.
      expect(frameQuery(frame).get("ic")).toBeTruthy();
    }
  });
});
