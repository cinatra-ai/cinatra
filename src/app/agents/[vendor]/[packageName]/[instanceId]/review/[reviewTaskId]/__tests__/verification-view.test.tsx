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
//   · the PAGE-ONLY adjuncts survive the move: the pinned visual pair and the
//     navigation back to the gate;
//   · a page that cannot mint a ref draws no core rather than falling back to
//     a second composition — and still keeps its adjuncts.

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
  scopePaths: ["subject", "body"],
  fieldDiff: [
    { field: "bcc", before: null, after: "legal@evil.test" },
    { field: "subject", before: "Reengage Q3 churned cohort", after: "Win back your Q3 favourites" },
  ],
  advisoryComments: [
    { authorKind: "service", body: "Core analysis of 3 disclosed field(s)." },
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

const GATE_HREF = "/agents/acme/mailer/run-1/review/task-1";

describe("the review page reuses the ONE §VII core", () => {
  it("draws the same card, with the same anchors, on the page's own host", async () => {
    mockResolve({ state: "advisory" });
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" gateHref={GATE_HREF} />,
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
    for (const anchor of [
      "chrome",
      "outcome",
      "authorized-scope",
      "field-diff",
      "advisory",
    ]) {
      expect(card.querySelector(`[data-verification-${anchor}]`), anchor).not.toBeNull();
    }
    // …and the reading itself is the card's, not the page's: the authorized
    // scope, the pinned revisions and the out-of-scope mark all come through.
    expect(card.textContent).toContain("rev-base");
    expect(card.textContent).toContain("rev-repaired");
    expect(card.textContent).toContain("out of scope");
    const drifted = card.querySelector<HTMLElement>('[data-diff-field="bcc"]')!;
    expect(drifted.dataset.diffInScope).toBe("false");
  });

  it("keeps its PAGE-ONLY adjuncts composed around the core", async () => {
    mockResolve({ state: "advisory" });
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" gateHref={GATE_HREF} visualPair={null} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
    );
    // The navigation back to the gate — a route affordance only a route has.
    const back = container.querySelector<HTMLAnchorElement>("[data-verification-back-to-gate]")!;
    expect(back).not.toBeNull();
    expect(back.getAttribute("href")).toBe(GATE_HREF);
    // The region still identifies itself as the run surface's verification view.
    const region = container.querySelector<HTMLElement>('[data-surface="verification"]')!;
    expect(region).not.toBeNull();
    expect(region.dataset.conformanceId).toBe("run-surface");
  });

  it("draws NO core at all when the page could not mint a ref — never a second composition", () => {
    const fetchMock = mockResolve({ state: "advisory" });
    const { container } = render(<VerificationView cardRef={null} gateHref={GATE_HREF} />);
    expect(container.querySelector('[data-conformance-id="verification-card"]')).toBeNull();
    expect(container.querySelector("[data-verification-chrome]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The adjuncts are unaffected — the page is still a page.
    expect(container.querySelector("[data-verification-back-to-gate]")).not.toBeNull();
  });

  it("draws no core when the resolve answers `absent`, on this host as on any other", async () => {
    const fetchMock = mockResolve({ state: "absent" }, null);
    const { container } = render(
      <VerificationView cardRef="ref-verification-1" gateHref={GATE_HREF} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).toBeNull(),
    );
    expect(container.querySelector("[data-lifecycle-card]")).toBeNull();
    // …and the reader still has their way back out.
    expect(container.querySelector("[data-verification-back-to-gate]")).not.toBeNull();
  });
});
