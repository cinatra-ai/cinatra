// @vitest-environment jsdom
//
// THE SETTLED READING, BUILT TO §XIII (cinatra#3080, fix leg 6).
//
// §XIII of the ratified cards drawing was written after this branch's design pin
// was taken, and it fixes the settled reading the fifth and sixth readings kept
// arguing about. It draws the states once — "The states are the card's, not the
// display's — so they are drawn once" — over one artifact, in a conversation and
// outside one, and the two settled frames are the whole of the answer:
//
//   "Settled — the same pane, the marker below the whole card, no floor"
//   "Settled, outside the conversation — the same display, no floor, and the
//    marker below the whole gate"
//
// TWO THINGS FOLLOW, and fix leg 5 got both of them wrong in the same direction.
//
// (1) THE HEADER STAYS. Outside a conversation the settled frame carries the
// SAME header strip its pending frame carries — the sans heading "Review" over
// the gate, byte for byte in both — and what the annotation takes away is the
// FLOOR, not the strip. Fix leg 5 headed a settled gate with nothing at all. So
// the request wording and the awaiting-your-decision pill go (neither is true of
// a gate already decided) and the heading stays.
//
// (2) THE MARKER NAMES NO PERSON. Every settled marker the drawings draw names
// an act and nobody: "Continued · Decided on the revision above. These are the
// words that will be sent." (§XIII.1, twice), "Continued · Decided on the
// revision above. The post keeps the revision it was continued at, and this
// review does not re-open." and "Superseded · The review of the earlier picture
// — kept, and no longer open. Its successor is below." (§II, both). The card
// read "Superseded by Nora Brandt" on the sixth reading. The decider still
// travels on the wire for the audit trail; it is simply not drawn.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/review-gate-card.settled-reading.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-fix6-1" };

/** The name the sixth reading photographed on the marker. */
const DECIDER = "Nora Brandt";

// The three cookie hosts. The widget host mounts the same component through a
// minted credential and is pinned on the envelope-parity fixture, which walks
// all four; standing that credential up here would test the credential rather
// than the reading.
const HOSTS = ["chat_thread", "run_card", "page_gate_region"] as const;

function mockResolve(state: unknown) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function renderOn(host: (typeof HOSTS)[number]) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function settledOn(
  host: (typeof HOSTS)[number],
  outcome: "approved" | "rejected" | "changes_requested",
  decidedByName: string | undefined = DECIDER,
) {
  mockResolve(
    (decidedByName === undefined
      ? { state: "settled", outcome }
      : { state: "settled", outcome, decidedByName }) satisfies LifecycleCardState,
  );
  const { container } = renderOn(host);
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull(),
  );
  return container;
}

describe("the settled gate keeps its header, minus the request and the ask", () => {
  for (const host of HOSTS) {
    it(`heads the settled reading "Review", with no request wording and no pill — ${host}`, async () => {
      const container = await settledOn(host, "changes_requested");
      // The heading itself, as its own element — not a substring of the page.
      const spans = Array.from(container.querySelectorAll("span")).map((s) => s.textContent);
      expect(spans).toContain("Review");
      expect(container.textContent).not.toContain("Review requested");
      expect(container.textContent).not.toContain("Awaiting your decision");
      // The floor is what the settled annotation takes away, and it is gone.
      expect(
        container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).toBeNull();
      // "the same pane" — the reviewed target is still drawn, by its own renderer.
      expect(
        container.querySelector('[data-conformance-id="review-target-island"]'),
      ).not.toBeNull();
    });
  }

  it("leaves the PENDING header exactly as the drawing draws it", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true } satisfies LifecycleCardState);
    const { container } = renderOn("page_gate_region");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).toContain("Review requested");
    expect(container.textContent).toContain("Awaiting your decision");
  });
});

describe("the settled marker names the act and never a person", () => {
  const CASES = [
    ["approved", "Continued"],
    ["rejected", "Rejected"],
    ["changes_requested", "Superseded"],
  ] as const;

  for (const [outcome, word] of CASES) {
    it(`${outcome}: reads "${word}" alone, with the decider on the wire and not on the card`, async () => {
      const container = await settledOn("page_gate_region", outcome);
      expect(container.textContent).toContain(word);
      expect(container.textContent).not.toContain(DECIDER);
      expect(container.textContent).not.toContain(`${word} by`);
      expect(container.textContent).not.toContain(" by ");
    });
  }

  it("reads the same way on every host, decider or none", async () => {
    for (const host of HOSTS) {
      const withName = await settledOn(host, "changes_requested", DECIDER);
      const named = withName.textContent ?? "";
      cleanup();
      const without = await settledOn(host, "changes_requested", undefined);
      expect(named, `the decider changes nothing on ${host}`).toBe(without.textContent ?? "");
      cleanup();
    }
  });
});
