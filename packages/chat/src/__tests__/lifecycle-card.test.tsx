// @vitest-environment jsdom
//
// The lifecycle card shell + its authoritative-refetch seam (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit §IV/§IX.
//
// The properties under test are the ones a later slice must not be able to
// weaken by accident: no host means no card, an unauthorized ref draws no DOM
// at all, and nothing is drawn before the server has answered.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// cinatra#2566: the registry now dispatches `artifact_review_gate` to the DRAWN
// `ReviewGateCard`, whose shipped decision chrome uses the app router. jsdom has
// none mounted, so the seam is stubbed for the dispatch case below.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import {
  LifecycleCard,
  LifecycleCardSurfaceProvider,
  LIFECYCLE_VIEW_RESOLVE_PATH,
} from "../renderable-views/lifecycle-card";
import { RenderableViewCard } from "../renderable-views";
import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const REVIEW_VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-abc",
};

/**
 * The resolve answer, in the per-kind envelope the card parses (epic S9, S9c).
 * The kind is ECHOED from the request the card issued, so a test that renders a
 * different viewType still gets an answer to its own question.
 */
function lifecycleEnvelope(state: LifecycleCardState, init?: RequestInit): unknown {
  let kind = "artifact_review_gate";
  try {
    kind = JSON.parse(String(init?.body ?? "{}")).viewType ?? kind;
  } catch {
    // A test that issued no body keeps the review kind.
  }
  return {
    kind,
    state,
    body: kind === "verification_summary" && state.state !== "absent"
      ? VERIFICATION_BODY
      : null,
  };
}

/** A §VII reading — the verification kind carries one on every drawn state, and
 *  a card that receives none fails closed rather than half-drawing. */
const VERIFICATION_BODY = {
  version: 1,
  outcome: "verified",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-fixed",
  fieldDiff: [{ field: "content.title", before: "old", after: "new", inScope: true }],
  // §VII's advisory comments (epic S9, slice S9e). The field is REQUIRED, not
  // optional: a body that omits it cannot be told apart from one whose producer
  // dropped the reading's provenance, so the parse refuses it and the card
  // draws nothing at all.
  advisoryComments: [{ authorKind: "service", body: "Core analysis of 1 disclosed field(s)." }],
};

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) =>
    new Response(JSON.stringify(lifecycleEnvelope(state, init)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("the host declaration is the one fail-closed surface gate", () => {
  it("renders NO DOM and issues NO request without a declared host", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(<LifecycleCard view={REVIEW_VIEW} />);
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a DECLARED host resolves every kind — no per-surface exclusion remains", async () => {
    // The corrected contract (owner ruling 2026-08-11): the host declaration is
    // the ONLY gate. A kind that used to be withheld from the widget is now
    // asked about there like any other. The widget must declare its credential
    // (see the fail-closed test below), so this mounts the real shape.
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    render(
      <LifecycleCardSurfaceProvider
        host="site_widget"
        auth={{ headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_x" }), credentials: "omit" }}
      >
        <LifecycleCard
          view={{ ...REVIEW_VIEW, viewType: "trigger_schedule_proposal" }}
        />
      </LifecycleCardSurfaceProvider>,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("FAIL-CLOSED: a non-cookie host that declares NO credential is not a host at all", async () => {
    // codex round 0, finding 2. A dropped `auth` prop on the widget would
    // otherwise send the resolve — and the DECISION — same-origin with an
    // ambient Cinatra cookie, and the server would answer as whoever else uses
    // this browser. The provider refuses to declare the host: no DOM, no request.
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="site_widget">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: a widget credential that would send cookies is refused the same way", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider
        host="site_widget"
        auth={{ headers: () => ({}), credentials: "same-origin" }}
      >
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: a COOKIE host that declares a credential is refused too", async () => {
    // The invariant runs both ways: a first-party host is defined by having no
    // credential of its own, so one appearing there means the two identity paths
    // could disagree. Silence, not a guess.
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider
        host="chat_thread"
        auth={{ headers: () => ({}), credentials: "omit" }}
      >
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("nothing is drawn without a successful authorized refetch", () => {
  it("draws nothing before the resolve answers", () => {
    let release!: (value: Response) => void;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    ) as unknown as typeof fetch;
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    expect(container.innerHTML).toBe("");
    release(new Response("{}", { status: 200 }));
  });

  it("draws nothing when the resolve answers `absent` (§IV — no card DOM at all)", async () => {
    mockResolve({ state: "absent" });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("draws nothing when the resolve FAILS (never optimistic)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

describe("a changed ref is a DIFFERENT card", () => {
  it("never paints the previous card's authorized state under a new ref", async () => {
    // First ref resolves to a drawn state; the second never answers.
    let answered = false;
    globalThis.fetch = vi.fn(async () => {
      if (answered) return new Promise<Response>(() => {}); // never settles
      answered = true;
      return new Response(
        JSON.stringify(lifecycleEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );

    rerender(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={{ ...REVIEW_VIEW, ref: "ref-other" }} />
      </LifecycleCardSurfaceProvider>,
    );
    // SYNCHRONOUSLY after the swap — not after an effect flush.
    expect(container.innerHTML).toBe("");
  });

  it("a LATE answer for the old ref never renders under the new one", async () => {
    // The first request is held open and released only AFTER the ref changed.
    let releaseFirst!: (value: Response) => void;
    let call = 0;
    globalThis.fetch = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => (releaseFirst = resolve));
      }
      return new Promise<Response>(() => {}); // the new ref never answers
    }) as unknown as typeof fetch;

    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(call).toBe(1));

    rerender(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={{ ...REVIEW_VIEW, ref: "ref-other" }} />
      </LifecycleCardSurfaceProvider>,
    );
    releaseFirst(
      new Response(
        JSON.stringify(lifecycleEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
  });
});

describe("the resolved states (§IV)", () => {
  it("posts the ref to the resolve route on mount", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LIFECYCLE_VIEW_RESOLVE_PATH);
    expect(JSON.parse(String(init.body))).toEqual({
      viewType: "artifact_review_gate",
      ref: "ref-abc",
    });
  });

  it("draws the pending card", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );
    expect(screen.getByText("Review")).toBeTruthy();
  });

  it("draws a RESTRICTED card with the reason, never a withheld one", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Approving or rejecting needs approve access on this run.",
    });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="restricted"]')).not.toBeNull(),
    );
    expect(
      screen.getByText("Approving or rejecting needs approve access on this run."),
    ).toBeTruthy();
  });

  it("draws a decided gate as settled — the reload case", async () => {
    mockResolve({ state: "settled" });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
  });

  it("draws the verification summary as advisory (§VII — no floor)", async () => {
    // The SHELL's own `advisory` rung, exercised by mounting the shell
    // DIRECTLY. Since S9e (#2789) the registry routes `verification_summary` to
    // the drawn `VerificationSummaryCard` instead — that dispatch is pinned in
    // its own case below, and the §VII drawing has its own suite in the agents
    // package. What stays true here is the shell's state ladder, which every
    // kind still on the shell depends on.
    mockResolve({ state: "advisory" });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={{ ...REVIEW_VIEW, viewType: "verification_summary" }} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="advisory"]')).not.toBeNull(),
    );
    expect(screen.getByText("Verification")).toBeTruthy();
  });
});

describe("registry dispatch", () => {
  it("RenderableViewCard routes a lifecycle payload to the lifecycle card", async () => {
    // S2 (#2566) swapped the review entry for the drawn `ReviewGateCard`; the
    // marker asserted below is the one every lifecycle card carries, so the
    // dispatch contract this test pins is unchanged by that swap.
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RenderableViewCard data={REVIEW_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-lifecycle-card="artifact_review_gate"]'),
      ).not.toBeNull(),
    );
  });

  it("routes `verification_summary` to the DRAWN §VII card, not the S1 shell", async () => {
    // S9e (#2789) swapped this registry line the way S2 swapped the review one.
    // The payload is identical to the shell case above; only the registry entry
    // decides which component draws, so this is the whole content of "the S1
    // shell is retired for this kind".
    mockResolve({ state: "advisory" });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RenderableViewCard data={{ ...REVIEW_VIEW, viewType: "verification_summary" }} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="verification-card"]'),
      ).not.toBeNull(),
    );
    // The §VII core, not the shell's one-line summary.
    expect(container.querySelector('[data-verification-chrome="Core analysis"]')).not.toBeNull();
    expect(container.querySelector('[data-verification-field-diff]')).not.toBeNull();
    expect(screen.queryByText("Advisory reading.")).toBeNull();
  });

  it("a lifecycle payload carrying CONTENT falls back rather than rendering it", () => {
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RenderableViewCard data={{ ...REVIEW_VIEW, title: "Q3 re-engagement email" }} />
      </LifecycleCardSurfaceProvider>,
    );
    expect(container.querySelector('[data-view-type="__fallback__"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Q3 re-engagement email");
  });
});
