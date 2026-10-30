// @vitest-environment jsdom
//
// The legacy two-target pending gate card on the /design-fixtures index page
// (cinatra#4188; the drawing is cinatra#4129's).
//
// The fixture mounts the card's own pair component, so these cases read the
// shipped drawing: one bordered panel per pinned target, each header directly
// above its own island, the pinned order, the header while its body loads and
// when its body fails, and an island address that can only be refused.
//
// The revision ids, titles, type ids and the ref are spelled out HERE rather
// than imported from the fixture's data module: importing them would compare
// the fixture with itself.
//
// NO NETWORK. jsdom under the root config loads no sub-resource; that rests on
// the configuration, not on a case here. No load event fires either, so case 4
// reaches the failed body by the card's own 12-second bound.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REVIEW_TARGET_ISLAND_PATH } from "@cinatra-ai/agents/review-gate-card";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";

import { ReviewTargetPairsFixture } from "../review-target-pairs-fixture";

const PINNED = ["rev_3e90", "rev_b7d5"];
const TITLES = ["Launch announcement — first draft", "Board update — October"];
const OBJECT_TYPES = ["@acme/email-body:body", "@acme/slide-deck:artifact"];
const GATE_REF = "design-fixture-legacy-gate";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const pairsOf = (root: HTMLElement): Element[] => [
  ...root.querySelectorAll("[data-review-target-pair]"),
];

function frameQuery(frame: Element): URLSearchParams {
  const src = frame.getAttribute("src") ?? "";
  const at = src.indexOf("?");
  return new URLSearchParams(at < 0 ? "" : src.slice(at + 1));
}

function expectEachHeaderAboveItsOwnBody(root: HTMLElement): void {
  const pairs = pairsOf(root);
  expect(pairs).toHaveLength(2);
  pairs.forEach((pair, i) => {
    const header = pair.firstElementChild;
    expect(header?.getAttribute("data-conformance-id")).toBe("review-target-header");
    expect(header?.textContent).toContain(TITLES[i]);
    expect(
      header?.querySelector("[data-review-target-revision]")?.getAttribute("data-review-target-revision"),
    ).toBe(PINNED[i]);
    const body = header?.nextElementSibling;
    expect(body?.getAttribute("data-conformance-id")).toBe("review-target-island");
    expect(body?.nextElementSibling ?? null, "the pair holds exactly a header and its body").toBeNull();
    const frame = body?.querySelector("iframe");
    expect(frame, "the body holds its own island frame").not.toBeNull();
    expect(frameQuery(frame!).get("target")).toBe(PINNED[i]);
  });
}

describe("cinatra#4188 — the legacy two-target pending gate card", () => {
  it("draws one bordered pair per pinned target, in pinned order", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    expect(container.querySelector('[data-fixture="review-target-pairs"]')).not.toBeNull();
    const pairs = pairsOf(container);
    expect(pairs).toHaveLength(2);
    // ONE panel per target (cinatra#3441): the one-header reading of the frame.
    for (const pair of pairs) expect(pair.hasAttribute("data-review-target-frame")).toBe(true);
    expect(
      pairs.map((pair) =>
        pair.querySelector("[data-review-target-revision]")?.getAttribute("data-review-target-revision"),
      ),
    ).toEqual(PINNED);
    expect(pairs[0]!.compareDocumentPosition(pairs[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      expect(island.querySelector('[data-conformance-id="review-target-island-skeleton"]')).not.toBeNull();
      const frame = island.querySelector("iframe") as HTMLIFrameElement | null;
      expect(frame, "the body holds its own island frame").not.toBeNull();
    }
    const headers = [...container.querySelectorAll('[data-conformance-id="review-target-header"]')];
    expect(headers.map((h) => h.isConnected)).toEqual([true, true]);
  });

  it("the header stays above its own failed body", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<ReviewTargetPairsFixture />);
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_500);
    });
    await waitFor(() =>
      expect(
        [...container.querySelectorAll('[data-conformance-id="review-target-island"]')].map((island) =>
          island.getAttribute("data-island-load-state"),
        ),
      ).toEqual(["timed-out", "timed-out"]),
    );
    const islands = [...container.querySelectorAll('[data-conformance-id="review-target-island"]')];
    expect(islands).toHaveLength(2);
    for (const island of islands) {
      expect(island.querySelector('[data-conformance-id="review-target-island-timeout"]')).not.toBeNull();
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

  it("each island address is the denial road, never the sign-in road", () => {
    const { container } = render(<ReviewTargetPairsFixture />);
    const frames = [...container.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    frames.forEach((frame, i) => {
      const src = frame.getAttribute("src") ?? "";
      const at = src.indexOf("?");
      expect(at < 0 ? src : src.slice(0, at)).toBe(REVIEW_TARGET_ISLAND_PATH);
      const query = frameQuery(frame);
      expect(query.get("ref")).toBe(GATE_REF);
      // `ic` is the island's credential parameter: with it the island takes its
      // credential branch, which refuses this value and never redirects.
      expect(query.get("ic")).toBeTruthy();
      expect(query.get("target")).toBe(PINNED[i]);
      // A credential-bearing pair frames eagerly, so the denial needs no scroll.
      expect(frame.getAttribute("loading")).toBe("eager");
    });
  });
});
