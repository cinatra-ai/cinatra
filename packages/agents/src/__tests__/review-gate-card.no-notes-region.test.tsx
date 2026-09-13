// @vitest-environment jsdom
//
// THE CARD DRAWS TWO REGIONS, AND THE SETTLED READING DRAWS NO REQUEST
// (cinatra#3080, fix leg 5).
//
// `ReviewGateCard` is the one review renderer on all four hosts, so what it
// stops drawing here it stops drawing on the run page, the review page, the
// conversation and inside a third-party application at once.
//
// (1) NO THIRD REGION. The ratified cards drawing enumerates the review card:
// "the target panel naming what is under review and pinning its exact revision,
// then the decision floor that governs it" (§II). The fifth reading found a
// third region between the two, carrying the Audit lane's bracketed
// `[provenance]` diagnostic — an internal projection digest, an authorization
// verdict and the projected field paths — on a reviewer's decision surface.
// Advisory comments belong to the VERIFICATION card, where the drawing puts
// them: "the reading's provenance is the body of a service comment there, not a
// line of its own" (§VII).
//
// TWO WAYS IT CANNOT COME BACK. The renderer draws no such region for any
// state; and the wire's own strict shape now REFUSES a state that still carries
// notes, so a stale or hostile producer cannot smuggle one onto the card — it
// gets no card at all rather than a card with an undrawn region in it.
//
// (2) NO REQUEST HEADING OVER A SETTLED GATE. The drawing's settled readings —
// in a conversation and outside one — are "the same pane, the marker below the
// whole card, no floor": no request heading and no awaiting pill above the
// target, with the settled marker below the whole card saying what happened.
// The card was heading a settled gate with an invented settled wording, which
// no drawing draws. The pending reading keeps its heading and pill, unchanged.
//
// RE-READ AT THE ADOPTED PIN (cinatra#3080, fix leg 6). §XIII of the cards
// drawing did not exist at the pin this suite was written against, and it draws
// the settled reading outside a conversation with the SAME header strip its
// pending frame carries — the sans heading "Review" — taking away the floor and
// not the strip. So the request wording and the pill stay gone, the heading
// comes back, and the marker names its act and no person
// (`review-gate-card.settled-reading.test.tsx` owns that reading in full).
//
// AND THE CARD STILL CARRIES NO NOTES REGION, re-read at the same adopted pin.
// The question the sixth reading left open was whether the reviewer's OWN note
// has a drawn place on the card once the service diagnostic is filtered out of
// it. It does not. The note field is an INPUT on the floor - "The decision bar
// carries one free-text Note field" - and the floor is what a settled reading
// takes away; no sentence anywhere draws those words back onto the card, and a
// typed request is not on the card at all: "A change request is carried by the
// prompt window, not this field." The card's own frames agree: the in-thread
// card is "the target panel naming what is under review and pinning its exact
// revision, then the decision floor that governs it", and the settled frames
// draw the pane and the marker and nothing between them. So the filtered
// reading this suite pins CONFORMS, and leg 6 restores nothing here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-abc-123" };

/** The Audit lane's own advisory body, in the shape `buildCoreAnalysis` renders it. */
const AUDIT_DIAGNOSTIC =
  "Audit of 3 disclosed field(s).\n• 3 disclosed field(s) carry content.\n[provenance] lane=core-analysis-lane target=art-s4-demo@rev-repaired projection=9f2c1a7b4e60d3a8 authz=allowed fields=[form,resource,revision] excluded=[]";

function mockResolve(state: unknown) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

const HOSTS = ["chat_thread", "run_card", "page_gate_region"] as const;

function renderOn(host: (typeof HOSTS)[number]) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

const PENDING = { state: "pending", canDecide: true, canComment: true } satisfies LifecycleCardState;

describe("no notes region is drawn between the target and the floor", () => {
  for (const host of HOSTS) {
    it(`draws the target and the floor, and no region between them — ${host}`, async () => {
      mockResolve(PENDING);
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(
          container.querySelector('[data-conformance-id="review-decision-bar"]'),
        ).not.toBeNull(),
      );
      expect(
        container.querySelector('[data-conformance-id="review-recorded-notes"]'),
      ).toBeNull();
      expect(container.querySelector("[data-review-note]")).toBeNull();
      expect(container.textContent).not.toContain("Notes on this review");
    });
  }

  it("leaves the floor exactly as drawn — three affordances", async () => {
    mockResolve(PENDING);
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: /comment/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /regenerate/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeNull();
  });

  it("draws no notes region on a RESTRICTED card", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Continuing or regenerating needs decision access on this run.",
    } satisfies LifecycleCardState);
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.textContent).toContain("decision access"));
    expect(
      container.querySelector('[data-conformance-id="review-recorded-notes"]'),
    ).toBeNull();
  });

  it("draws no notes region on a SETTLED card", async () => {
    mockResolve({
      state: "settled",
      outcome: "changes_requested",
      decidedByName: "Ines Kovac",
    } satisfies LifecycleCardState);
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-conformance-id="review-recorded-notes"]'),
    ).toBeNull();
  });
});

describe("a state still carrying notes is refused by the wire, not drawn", () => {
  for (const host of HOSTS) {
    it(`draws no card at all, and no diagnostic anywhere — ${host}`, async () => {
      // The shape is strict, so the removed field is not merely ignored: the
      // whole state fails to parse and the card draws nothing. There is no
      // reading of this payload in which the Audit lane's diagnostic reaches a
      // reviewer's surface.
      mockResolve({
        ...PENDING,
        notes: [{ authorKind: "service", body: AUDIT_DIAGNOSTIC }],
      });
      const { container } = renderOn(host);
      await waitFor(() => expect(container.textContent).not.toContain("Loading"));
      expect(
        container.querySelector('[data-conformance-id="review-recorded-notes"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain("[provenance]");
      expect(container.textContent).not.toContain("core-analysis-lane");
    });
  }
});

describe("the settled reading carries no request heading", () => {
  it("heads a settled gate with neither wording, and no awaiting pill", async () => {
    mockResolve({
      state: "settled",
      outcome: "changes_requested",
      decidedByName: "Ines Kovac",
    } satisfies LifecycleCardState);
    const { container } = renderOn("page_gate_region");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).not.toContain("Review settled");
    expect(container.textContent).not.toContain("Review requested");
    expect(container.textContent).not.toContain("Awaiting your decision");
    // The settled marker the drawing DOES draw — its act, and no person.
    expect(container.textContent).toContain("Superseded");
    expect(container.textContent).not.toContain("Ines Kovac");
  });

  it("leaves the PENDING heading and pill exactly where they are drawn", async () => {
    mockResolve(PENDING);
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
