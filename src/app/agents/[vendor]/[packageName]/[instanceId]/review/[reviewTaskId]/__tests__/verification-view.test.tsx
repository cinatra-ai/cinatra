// @vitest-environment jsdom
//
// The review page's VERIFICATION region (cinatra#2789, epic #2784 S9e).
//
// The slice's claim is that the page and the transcript now draw ONE core, and
// that the page kept only the adjuncts that are genuinely its own. Both halves
// are checked here against a real render:
//
//   · the page's region draws the SAME §VII core the card suite pins — same
//     component, same anchors, same authorized reading — rather than a second
//     composition that happens to look alike;
//   · it declares `page_gate_region` as its host, so the fail-closed surface
//     gate applies to this mount exactly as it does to a turn's;
//   · the PAGE-ONLY adjunct survives the move: the pinned visual pair;
//   · the "Back to the review gate" link is GONE (plan §8.3(5), §8.4 — the link
//     exists only because the reading lived on its own page, so it goes when
//     the card lands, and this slice is named as what resolves it);
//   · a page that cannot mint a ref draws no core rather than falling back to
//     a second composition.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardState,
  VerificationSummaryBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { VerificationView } from "../verification-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BODY: VerificationSummaryBody = {
  version: 1,
  outcome: "drifted",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-repaired",
  fieldDiff: [
    { field: "bcc", before: null, after: "legal@evil.test", inScope: false },
    {
      field: "subject",
      before: "Reengage Q3 churned cohort",
      after: "Win back your Q3 favourites",
      inScope: true,
    },
  ],
  advisoryComments: [
    { authorKind: "service", body: "Audit of 3 disclosed field(s)." },
  ],
};

function mockResolve(state: LifecycleCardState, body: VerificationSummaryBody | null = BODY) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "verification_summary", state, body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("the review page reuses the ONE §VII core", () => {
  it("draws the same card, with the same anchors, on the page's own host", async () => {
    mockResolve({ state: "advisory" });
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
    );
    const card = container.querySelector<HTMLElement>(
      '[data-conformance-id="verification-card"]',
    )!;
    // The card resolved on the PAGE host — the same fail-closed declaration a
    // transcript mount goes through.
    expect(card.dataset.lifecycleCard).toBe("verification_summary");
    expect(card.dataset.lifecycleCardHost).toBe("page_gate_region");
    expect(card.dataset.lifecycleCardState).toBe("advisory");
    // Every §VII anchor, drawn by the card rather than by the page.
    // Kept in step with `VERIFICATION_CORE_ANCHORS` in the one-card gate —
    // mirrored rather than imported because that module is a Node audit script.
    for (const anchor of ["chrome", "outcome", "revisions", "field-diff", "advisory"]) {
      expect(card.querySelector(`[data-verification-${anchor}]`), anchor).not.toBeNull();
    }
    // …and no region §VII does not draw (cinatra#2861).
    expect(card.querySelector("[data-verification-authorized-scope]")).toBeNull();
    // …and the reading itself is the card's, not the page's: the pinned
    // revisions and the out-of-scope mark both come through.
    expect(card.textContent).toContain("rev-base");
    expect(card.textContent).toContain("rev-repaired");
    expect(card.textContent).toContain("out of scope");
    const drifted = card.querySelector<HTMLElement>('[data-diff-field="bcc"]')!;
    expect(drifted.dataset.diffInScope).toBe("false");
  });

  it("keeps its PAGE-ONLY adjunct composed around the core, and NO back link", async () => {
    mockResolve({ state: "advisory" });
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" visualPair={null} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
    );
    // Plan §8.3(5) and §8.4: the "Back to the review gate" link exists only
    // because the reading lived on its own page, so it goes when the card
    // lands. §VII's no-floor rule points the same way — the reading "asks
    // nothing, so it draws nothing to press", and this was the last pressable
    // thing on the surface. Nothing anywhere in the region, by anchor, by role
    // or by copy.
    expect(container.querySelector("[data-verification-back-to-gate]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("Back to the review gate");
    // The region still identifies itself as the run surface's verification view.
    const region = container.querySelector<HTMLElement>('[data-surface="verification"]')!;
    expect(region).not.toBeNull();
    expect(region.dataset.conformanceId).toBe("run-surface");
  });

  it("draws NO core at all when the page could not mint a ref — never a second composition", () => {
    const fetchMock = mockResolve({ state: "advisory" });
    const { container } = render(<VerificationView cardRef={null} />);
    expect(container.querySelector('[data-conformance-id="verification-card"]')).toBeNull();
    expect(container.querySelector("[data-verification-chrome]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The region is still drawn — it just has no reading in it.
    expect(container.querySelector('[data-surface="verification"]')).not.toBeNull();
    expect(container.querySelector("[data-verification-back-to-gate]")).toBeNull();
  });

  it("draws no core when the resolve answers `absent`, on this host as on any other", async () => {
    const fetchMock = mockResolve({ state: "absent" }, null);
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).toBeNull(),
    );
    expect(container.querySelector("[data-lifecycle-card]")).toBeNull();
    // …and the retired back link did not come back on this path either.
    expect(container.querySelector("[data-verification-back-to-gate]")).toBeNull();
  });
});
