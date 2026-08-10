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

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ state }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("the host declaration is fail-closed (§IX)", () => {
  it("renders NO DOM and issues NO request without a declared host", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(<LifecycleCard view={REVIEW_VIEW} />);
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders NO DOM on a host the matrix excludes this kind from", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="site_widget">
        <LifecycleCard
          view={{ ...REVIEW_VIEW, viewType: "trigger_schedule_proposal" }}
        />
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
        JSON.stringify({ state: { state: "pending", canDecide: true, canComment: true } }),
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
        JSON.stringify({ state: { state: "pending", canDecide: true, canComment: true } }),
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
