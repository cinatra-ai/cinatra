// @vitest-environment jsdom
//
// `ReviewGateCard` — the ONE review renderer (cinatra#2566, epic #2564 S2).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §II, §III, §IV, §IX.
//
// What is pinned here is the part a later slice must not be able to weaken by
// accident: every §IV state draws its mandated shape, the two ABSENCES stay two
// (a reader who may not read the target and a surface that does not carry the
// card both draw nothing, and neither is ever drawn as the other or as a
// disabled card), and the three first-party hosts get the SAME component with
// only the frame differing.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ReactNode } from "react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

// The SHIPPED decision chrome uses the app router (`router.refresh()` after a
// landed decision, and the page's Refresh out of a stale gate). jsdom has no
// router mounted, so the seam is stubbed — the card under test never navigates.
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import {
  LifecycleCardSurfaceProvider,
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
  type ComposerFocusStore,
} from "../lifecycle-card-runtime";
import {
  LIFECYCLE_VIEW_DECIDE_PATH,
  REVIEW_TARGET_ISLAND_PATH,
  ReviewGateCard,
} from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // cinatra#2713 — a test that installs fake timers to cross the island's
  // bounded timeout must not leak them into the next test.
  vi.useRealTimers();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-abc-123",
};

/**
 * The resolve answer, in the per-kind envelope the card parses (epic S9, S9c).
 * The review kind carries no body — §III's target arrives through the island —
 * and the card REFUSES an answer that carries one.
 */
function reviewEnvelope(state: LifecycleCardState): unknown {
  return { kind: "artifact_review_gate", state, body: null };
}

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(reviewEnvelope(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** jest-dom is not installed here — read the DOM property directly. */
function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true;
}

/** The widget's credential declaration — required by the provider's fail-closed
 *  invariant (codex round 0, finding 2), and the real shape the embed passes. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

function renderOn(host: "chat_thread" | "run_card" | "page_gate_region" | "site_widget") {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

// ---------------------------------------------------------------------------
// §IV — every state draws its mandated shape
// ---------------------------------------------------------------------------

describe("§IV the review states", () => {
  it("loading: the SHIPPED skeleton, and no decision floor", async () => {
    mockResolve({ state: "loading" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-loading"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).toBeNull();
    expect(container.querySelector('[data-lifecycle-card-state="loading"]')).not.toBeNull();
  });

  it("pending: the target island AND the one gate-level floor, live", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    // §III — the mounted tier arrives through the island, addressed by the ref.
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe(
      `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(VIEW.ref)}`,
    );
    // §II — exactly one floor, however many targets the island draws.
    expect(container.querySelectorAll('[data-conformance-id="review-decision-bar"]')).toHaveLength(1);
    // The three affordances, live.
    expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false);
    expect(isDisabled(screen.getByRole("button", { name: /reject/i }))).toBe(false);
    expect(isDisabled(screen.getByRole("button", { name: /comment/i }))).toBe(false);
  });

  it("restricted: the card RENDERS, terminal affordances disabled, reason on screen", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Approving or rejecting needs approve access on this run.",
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    // §IV: a restricted card is a card. It shows the target and the disabled
    // floor — it is NEVER silently dropped (that is `absent`).
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(true);
    expect(isDisabled(screen.getByRole("button", { name: /reject/i }))).toBe(true);
    // A reader who may respond keeps a live Comment.
    expect(isDisabled(screen.getByRole("button", { name: /comment/i }))).toBe(false);
    expect(
      container.querySelector('[data-conformance-id="review-decision-disabled"]'),
    ).not.toBeNull();
  });

  it("settled: 'no longer open' with a Refresh, and NO decision floor", async () => {
    mockResolve({ state: "settled" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: /refresh/i })).not.toBeNull();
  });

  it("settled: Refresh re-resolves the SAME card instead of navigating", async () => {
    const fetchMock = mockResolve({ state: "settled" });
    renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("advisory: draws nothing — a review gate has no floorless reading (§VII)", async () => {
    const fetchMock = mockResolve({ state: "advisory" });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §IV — the two absences, held apart
// ---------------------------------------------------------------------------

describe("the two absences are distinct", () => {
  it("READER absence (`absent`): the server was asked, and NO card DOM is drawn", async () => {
    const fetchMock = mockResolve({ state: "absent" });
    const { container } = renderOn("chat_thread");
    // The distinguishing fact: the resolve HAPPENED. This absence is the
    // server's answer about this reader, not a decision the surface made.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe("");
  });

  it("SURFACE absence (no declared host): nothing drawn AND the server is never asked", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(<ReviewGateCard view={VIEW} />);
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    // The distinguishing fact: no request at all. A surface that does not carry
    // the card must not probe the gate's existence on the reader's behalf.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the SITE WIDGET is a full host: the card resolves and draws the same floor as chat", async () => {
    // The correction (owner ruling 2026-08-11): the widget is not a reduced
    // surface. It resolves like every other declared host, and a `pending` gate
    // draws the live floor there — not a metadata stub, not a disabled bar.
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    renderOn("site_widget");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const widgetFloor = await screen.findByRole("button", { name: /approve/i });
    expect(isDisabled(widgetFloor)).toBe(false);
    cleanup();

    // …and it is the SAME drawing the chat thread produces for the same state.
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    renderOn("chat_thread");
    const chatFloor = await screen.findByRole("button", { name: /approve/i });
    expect(widgetFloor.textContent).toBe(chatFloor.textContent);
  });

  it("neither absence is ever drawn as a DISABLED card", async () => {
    // The inverse of the `restricted` case above, stated as its own guarantee:
    // a withheld card has no floor to disable, because it has no DOM.
    mockResolve({ state: "absent" });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).toBeNull();
    expect(container.querySelector('[data-conformance-id="review-decision-disabled"]')).toBeNull();
  });

  it("draws nothing at all before the first authorized resolve answers", () => {
    let release!: (value: Response) => void;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    ) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    expect(container.innerHTML).toBe("");
    release(new Response("{}", { status: 200 }));
  });
});

// ---------------------------------------------------------------------------
// §IX — one renderer, four first-party hosts, host-specific frame only
// ---------------------------------------------------------------------------

describe("one renderer, four first-party hosts", () => {
  // The site widget is DECLARED with the same production surface as the other
  // three (owner ruling 2026-08-11: it is not a reduced surface), and it is
  // served by the registry rather than by a JSX mount — which is exactly why it
  // has to be driven here by name. A host nothing drives has no counted proof.
  const HOSTS = ["chat_thread", "run_card", "page_gate_region", "site_widget"] as const;

  it("draws the SAME card on every first-party host, differing only in the frame", async () => {
    const drawn: Record<string, string> = {};
    for (const host of HOSTS) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container, unmount } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
      );
      const root = container.querySelector('[data-conformance-id="review-gate-card"]');
      expect(root?.getAttribute("data-lifecycle-card-host")).toBe(host);
      // Normalize away the frame (the ONE thing a host may change) and the host
      // marker; what remains must be byte-identical across the three.
      const clone = root!.cloneNode(true) as HTMLElement;
      clone.removeAttribute("class");
      clone.removeAttribute("data-lifecycle-card-host");
      drawn[host] = clone.innerHTML;
      unmount();
      cleanup();
    }
    expect(drawn.run_card).toBe(drawn.chat_thread);
    expect(drawn.page_gate_region).toBe(drawn.chat_thread);
    expect(drawn.site_widget).toBe(drawn.chat_thread);
  });

  // The ratified root contract, asserted on real DOM: the card's own identity,
  // the host it drew on, and the state it drew in. A capture that cannot say
  // which host and which state it photographed is not evidence of a cell, and a
  // card that does not name its kind cannot be addressed on a host at all. Each
  // value comes from a VALIDATED body field or the host declaration, never from
  // a literal in the markup.
  it("the root carries its lifecycle-card identity, its host and its state", async () => {
    // The hosts are named as literals, one per line, because this test IS the
    // record of which hosts were actually driven.
    for (const host of ["chat_thread", "run_card", "page_gate_region", "site_widget"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container, unmount } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-lifecycle-card="artifact_review_gate"]')).not.toBeNull(),
      );
      // EXACTLY ONE instance on this host. A second adapter drawing beside this
      // one is the failure the whole one-card rule exists to prevent, and it is
      // only visible as a COUNT on rendered DOM.
      expect(container.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]')).toHaveLength(1);
      const root = container.querySelector('[data-conformance-id="review-gate-card"]')!;
      expect(root.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
      expect(root.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("pending");
      expect(root.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull();
      unmount();
      cleanup();
    }

    // The RESTRICTED marker, off the same root: a reader who may see the gate
    // and not decide it gets the disabled floor, never a withheld card.
    mockResolve({ state: "restricted", canDecide: false, canComment: false, reason: "not yours" });
    const restricted = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        restricted.container.querySelector('[data-conformance-id="review-decision-disabled"]'),
      ).not.toBeNull(),
    );
    expect(
      restricted.container
        .querySelector('[data-conformance-id="review-gate-card"]')!
        .getAttribute("data-lifecycle-card-state"),
    ).toBe("restricted");
    restricted.unmount();
    cleanup();

    // …and the state really tracks the resolve rather than a constant.
    mockResolve({ state: "settled" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-conformance-id="review-gate-card"]')
          ?.getAttribute("data-lifecycle-card-state"),
      ).toBe("settled"),
    );
  });

  it("every host addresses the same island with the same ref", async () => {
    for (const host of HOSTS) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container, unmount } = renderOn(host);
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
        `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(VIEW.ref)}`,
      );
      unmount();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// §III — the mounted tier arrives contained, clamped, and display-only
// ---------------------------------------------------------------------------

describe("§III the target island", () => {
  it("is a same-origin frame with the documented sandbox tokens, clamped with an expand", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    // The src is a RELATIVE first-party path — the island is never fetched from
    // another origin, and the ref is the only thing in the query.
    expect(frame.getAttribute("src")?.startsWith("/")).toBe(true);
    const clamped = frame.style.height;
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    await waitFor(() =>
      expect(container.querySelector("iframe")!.style.height).not.toBe(clamped),
    );
  });

  it("carries NO decision chrome inside the frame — the floor is the card's", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const frame = container.querySelector("iframe")!;
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    expect(frame.contains(bar)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // cinatra#2713 — the island's OWN load state: loading / loaded / timed-out.
  // The outer §IV "pending" resolve above is already settled by this point;
  // these tests are about the SEPARATE window before the iframe's own `load`
  // event, which used to paint a blank white box (the S8e proof round, V5).
  // ---------------------------------------------------------------------

  /**
   * Report the frame's load THE WAY THE ISLAND DOES — carrying the island's own
   * body anchor.
   *
   * Since cinatra#3051 a bare `load` event is no longer a painted target: every
   * island refusal answers 200 with an empty document and fires `load` exactly
   * like a full one, so the card reads the framed document and only the island's
   * own body anchor says it painted.
   */
  function islandPaints(container: HTMLElement): void {
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      '<html><body><div data-conformance-id="review-target-island-body"></div></body></html>',
    );
    doc.close();
    fireEvent.load(frame);
  }

  function island(container: HTMLElement): HTMLElement {
    return container.querySelector('[data-conformance-id="review-target-island"]')!;
  }

  it("loading: a skeleton, not a blank frame, until the iframe's own load event", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(island(container).getAttribute("data-island-load-state")).toBe("loading");
    expect(
      container.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
    ).not.toBeNull();
    // No error/refusal panel yet either — the loading and timed-out
    // presentations are mutually exclusive.
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
    ).toBeNull();
  });

  it("loaded: the iframe's own `load` event swaps the skeleton for the painted frame", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    islandPaints(container);
    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("loaded"));
    expect(
      container.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
    ).toBeNull();
  });

  it("timed-out: a bounded wait with no load event swaps to the retry panel — the decision floor stays live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("timed-out"));
    expect(
      container.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
    ).not.toBeNull();
    // §II — a preview that failed to load is never drawn as a reason the
    // reviewer cannot decide; the floor below is untouched.
    expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false);
  });

  it("timed-out: Try again remounts the iframe and returns to loading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("timed-out"));

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(island(container).getAttribute("data-island-load-state")).toBe("loading");
    expect(
      container.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
    ).not.toBeNull();
  });

  it("a late load event self-heals a timed-out island instead of sticking on the retry panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("timed-out"));

    // The ORIGINAL iframe (never remounted — no retry was pressed) finally
    // fires its load event.
    islandPaints(container);

    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("loaded"));
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
    ).toBeNull();
  });

  it("no layout shift: loading, loaded and timed-out all hold the SAME clamped height", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const clamped = (container.querySelector("iframe") as HTMLIFrameElement).style.height;
    expect(clamped).not.toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("timed-out"));
    // The iframe itself — still mounted underneath the retry panel — keeps its
    // clamped height; only the overlay on top of it changed.
    expect((container.querySelector("iframe") as HTMLIFrameElement).style.height).toBe(clamped);
  });

  it("a card re-pointed at a different gate's island starts loading again, never on the old verdict", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    islandPaints(container);
    await waitFor(() => expect(island(container).getAttribute("data-island-load-state")).toBe("loaded"));

    mockResolve({ state: "pending", canDecide: true, canComment: true });
    rerender(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={{ ...VIEW, ref: "ref-a-different-gate" }} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("src")).toContain("ref-a-different-gate"),
    );
    expect(island(container).getAttribute("data-island-load-state")).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// The decision leaves through an EXISTING seam
// ---------------------------------------------------------------------------

describe("the decision seam", () => {
  it("with no host action, posts the OPAQUE REF to the gate-scoped entry", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(
          JSON.stringify({ outcome: { kind: "decided", disposition: "approve", idempotent: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    renderOn("chat_thread");
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === LIFECYCLE_VIEW_DECIDE_PATH)).toBe(true),
    );
    const decide = calls.find((c) => c.url === LIFECYCLE_VIEW_DECIDE_PATH)!;
    expect(decide.body).toMatchObject({ ref: VIEW.ref, disposition: "approve" });
    // The card names its gate ONLY with the server-minted ref — never with a run
    // id or a gate id it assembled itself.
    expect(JSON.stringify(decide.body)).not.toMatch(/runId|reviewTaskId/);
  });

  it("uses the HOST's bound action when one is supplied (the review page's unchanged transport)", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const hostAction = vi.fn(async () => ({ kind: "annotated" }) as const);
    render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} submitAction={hostAction} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /comment/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /comment/i }));
    await waitFor(() => expect(hostAction).toHaveBeenCalledTimes(1));
    expect(hostAction).toHaveBeenCalledWith({ disposition: "comment", comment: null });
  });

  it("a landed decision RE-RESOLVES the card, so it settles to the server's answer", async () => {
    // Codex round 1, finding 3: the review page used to settle via
    // `router.refresh()` re-running its server component. A card in a transcript
    // has no such re-render, so the refresh has to be explicit — otherwise the
    // card sits on the state it resolved BEFORE the decision.
    let resolves = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(
          JSON.stringify({
            outcome: { kind: "decided", disposition: "approve", idempotent: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      resolves += 1;
      const state: LifecycleCardState =
        resolves === 1
          ? { state: "pending", canDecide: true, canComment: true }
          : { state: "settled" };
      return new Response(JSON.stringify(reviewEnvelope(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull(),
    );
    expect(resolves).toBeGreaterThanOrEqual(2);
  });

  it("a HOST action that lands also re-resolves (all three hosts settle alike)", async () => {
    let resolves = 0;
    globalThis.fetch = vi.fn(async () => {
      resolves += 1;
      const state: LifecycleCardState =
        resolves === 1
          ? { state: "pending", canDecide: true, canComment: true }
          : { state: "settled" };
      return new Response(JSON.stringify(reviewEnvelope(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const hostAction = vi.fn(
      async () => ({ kind: "decided", disposition: "approve", idempotent: false }) as const,
    );
    const { container } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} submitAction={hostAction} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull(),
    );
  });

  it("a malformed 'decided' answer is a retryable error, NEVER a landed decision", async () => {
    // Codex round 1, finding 2: `{kind:"decided"}` with no disposition used to
    // pass the narrowing and render as a successful REJECT.
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(JSON.stringify({ outcome: { kind: "decided" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    renderOn("chat_thread");
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(document.querySelector('[data-review-outcome="error"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-review-outcome="decided"]')).toBeNull();
  });

  it("a non-2xx from the decision entry is a uniform refusal, never a silent success", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) return new Response("nope", { status: 500 });
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    renderOn("chat_thread");
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(document.querySelector('[data-review-outcome="not-permitted"]')).not.toBeNull(),
    );
    // Nothing claims the decision landed.
    expect(document.querySelector('[data-review-outcome="decided"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ref never reaches an LLM-visible payload (Codex round 1 on the host half)
// ---------------------------------------------------------------------------
//
// Source assertions: the run panel cannot be mounted in this environment (its
// graph reaches the generated extension registry, whose companion repos are a
// CI-only clone), and the property being pinned is structural — which branches
// exist — rather than behavioural. The established repo pattern for exactly this
// is the review-surface conformance suite.

describe("a marked review gate never feeds the field-assist LLM path", () => {
  const PANEL = readFileSync(
    path.join(__dirname, "..", "agentic-run-panel.tsx"),
    "utf8",
  );

  it("hides the field-assist panel for a marked review gate", () => {
    // The panel exists to help fill a gate's FIELDS. A review gate has none, and
    // leaving it visible fed the gate's interrupt values — including the opaque
    // card ref — into a prompt the assist route serializes for the model.
    expect(PANEL).toMatch(
      /visible=\{[\s\S]*?xRenderer !== ARTIFACT_REVIEW_REDIRECT_RENDERER_ID[\s\S]*?\}/,
    );
  });

  it("refuses to SEND an assist request for a marked review gate, independently of the prop", () => {
    expect(PANEL).toMatch(
      /if \(xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID\) return;/,
    );
  });

  it("strips the card ref out of the assist payload as defence in depth", () => {
    expect(PANEL).toMatch(/currentValue: withoutLifecycleCardRef\(/);
    expect(PANEL).toMatch(/function withoutLifecycleCardRef\(/);
  });

  it("reads the ref ONLY to address the card — never into a submitted payload", () => {
    // Every other use of the ref name in the panel is the read that builds the
    // card's view, or the strip above. If a third kind of use appears, this
    // fails and the reviewer looks at where it goes.
    const uses = [...PANEL.matchAll(/lifecycleCardRef/g)].length;
    expect(uses).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// §VIII — the suggestions (cinatra#2572, epic #2564 S6c; redrawn by cinatra#2852)
// ---------------------------------------------------------------------------
//
// Redrawn by cinatra#2852 (design@60b27dfbb8a2a1594e6e88333cc5c048c244e640).
//
// The properties a later slice must not be able to weaken: the suggestions are
// drawn by THIS component (so page and card cannot diverge), each one shows its
// own before/after, the marking is a TWO-state toggle that starts accepted, a
// dismissal is never a strike-through, a mark is LOCAL until the one decision
// carries it, an immediate Reject records them as not taken rather than being
// refused, a reader who may not decide gets no press target at all, and a
// decided gate shows what was recorded.

const CHIPS = [
  {
    id: "sug-1",
    label: "subject",
    op: "replace" as const,
    message: "Not canonical.",
    before: "Re-connecting on Q3 priorities  ",
    after: "Re-connecting on Q3 priorities",
  },
  {
    id: "sug-2",
    label: "items · 0 · bcc",
    op: "remove" as const,
    message: "Every disclosed field is empty.",
  },
];

/** The decide POST bodies this render produced, in order. */
function decideBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]) === LIFECYCLE_VIEW_DECIDE_PATH)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

function mockResolveAndDecide(state: LifecycleCardState) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
      return new Response(
        JSON.stringify({ outcome: { kind: "decided", disposition: "approve", idempotent: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(reviewEnvelope(state)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The whole drawn suggestion — the pill, the class and the before/after panel. */
function chipFor(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll("[data-suggestion-state]")].find((n) =>
    (n.textContent ?? "").includes(label),
  );
  if (!el) throw new Error(`no suggestion for ${label}`);
  return el as HTMLElement;
}

/** Press a suggestion's ONE control — the pill inside its block. */
function pressChip(container: HTMLElement, label: string): void {
  const pill = chipFor(container, label).querySelector("button");
  if (!pill) throw new Error(`suggestion ${label} has no press target`);
  fireEvent.click(pill);
}

function stateOf(container: HTMLElement, label: string): string | null {
  return chipFor(container, label).getAttribute("data-suggestion-state");
}

describe("§VIII the suggestions are drawn by the ONE renderer", () => {
  it("pending: one drawn suggestion per surfaced item, ACCEPTED, with the spec's anchors", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    // §VIII: "a suggestion arrives accepted". Both of them, with no press.
    expect(container.querySelectorAll('[data-conformance-id="suggestion-accepted"]')).toHaveLength(2);
    expect(container.querySelector('[data-conformance-id="suggestion-dismissed"]')).toBeNull();
    // The label is the pointer; the mono slot is the transform class.
    expect(chipFor(container, "subject").textContent).toContain("replace");
    // The producer's reason is available without printing it into the row.
    expect(
      chipFor(container, "subject").querySelector("button")?.getAttribute("title"),
    ).toBe("Not canonical.");
  });

  it("draws each suggestion's BEFORE/AFTER — the current content beside the suggested one", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    const panel = chipFor(container, "subject").querySelector(
      '[data-conformance-id="suggestion-before-after"]',
    );
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('[data-suggestion-panel="before"]')!.textContent).toContain(
      "Re-connecting on Q3 priorities",
    );
    expect(panel!.querySelector('[data-suggestion-panel="after"]')!.textContent).toContain(
      "Re-connecting on Q3 priorities",
    );
    // The panel keys are the drawing's words.
    expect(panel!.textContent).toContain("Now");
    expect(panel!.textContent).toContain("Suggested");
  });

  it("NEGATIVE CONTROL: a suggestion with no values draws the label + class and NO panel", async () => {
    // A snapshot from before the pair existed, a `remove`, an `add` of the empty
    // string. An empty panel would read as "this change is blank".
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    const bare = chipFor(container, "items · 0 · bcc");
    expect(bare.querySelector('[data-conformance-id="suggestion-before-after"]')).toBeNull();
    expect(bare.textContent).toContain("items · 0 · bcc");
    expect(bare.textContent).toContain("remove");
  });

  it("NEVER strikes a dismissed suggestion through — the muted ground and dashed edge alone", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    const row = container.querySelector('[data-conformance-id="suggestion-chips"]')!;
    expect(row.innerHTML).not.toContain("line-through");
    expect(chipFor(container, "subject").className).toContain("border-dashed");
  });

  it("draws the SAME suggestions on all three first-party hosts (one component, one drawing)", async () => {
    for (const host of ["chat_thread", "run_card", "page_gate_region"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
      const { container, unmount } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
      );
      expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2);
      expect(
        container.querySelectorAll('[data-conformance-id="suggestion-before-after"]'),
      ).toHaveLength(1);
      unmount();
    }
  });

  it("a gate with NO suggestions draws no row at all", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).toBeNull();
  });
});

describe("§VIII the marking is a TWO-STATE toggle, accepted by default", () => {
  it("accepted → press → dismissed → press → accepted, on the ONE drawn control", async () => {
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    expect(stateOf(container, "subject")).toBe("accepted");
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    expect(chipFor(container, "subject").getAttribute("data-conformance-id")).toBe(
      "suggestion-dismissed",
    );
    // RE-ACCEPT: the toggle is its own inverse, and there is no third state to
    // pass through on the way back.
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("accepted"));
    expect(chipFor(container, "subject").getAttribute("data-conformance-id")).toBe(
      "suggestion-accepted",
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));

    // §VIII "the suggestions carry no submit of their own": three presses, ZERO
    // requests. Nothing about a mark has left the browser.
    expect(decideBodies(fetchMock)).toHaveLength(0);
  });

  it("says how many of them the decision is about to carry", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    const line = () =>
      container.querySelector('[data-conformance-id="suggestion-accepted-count"]')!.textContent;
    expect(line()).toContain("2 of 2 suggestions accepted");
    pressChip(container, "subject");
    await waitFor(() => expect(line()).toContain("1 of 2 suggestions accepted"));
  });
});

describe("§VIII the marks ride the ONE decision submit", () => {
  it("approve carries what is on screen: untouched means ACCEPTED", async () => {
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    expect(decideBodies(fetchMock)[0].suggestionDecisions).toEqual({
      accepted: ["sug-1", "sug-2"],
      dismissed: [],
    });
  });

  it("approve carries the partition the reviewer pressed into being", async () => {
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "items · 0 · bcc"); // dismissed
    await waitFor(() => expect(stateOf(container, "items · 0 · bcc")).toBe("dismissed"));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    const body = decideBodies(fetchMock)[0];
    expect(body.disposition).toBe("approve");
    expect(body.suggestionDecisions).toEqual({ accepted: ["sug-1"], dismissed: ["sug-2"] });
  });

  it("an IMMEDIATE Reject is not refused — it records every suggestion as NOT TAKEN", async () => {
    // The reworked guard (cinatra#2852). With accepted-by-default, the shipped
    // rule ("clear them first to reject") would refuse the very first press of
    // Reject on a row the reviewer never touched. A reject tombstones the
    // revisions, so nothing can be applied into them; the truthful record is a
    // dismissal for every surfaced id.
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    // Nothing pressed: every suggestion is accepted on screen.
    expect(stateOf(container, "subject")).toBe("accepted");
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    const body = decideBodies(fetchMock)[0];
    expect(body.disposition).toBe("reject");
    expect(body.suggestionDecisions).toEqual({ accepted: [], dismissed: ["sug-1", "sug-2"] });
    // …and the surface no longer warns about a combination that cannot happen.
    expect(container.querySelector('[data-conformance-id="suggestion-chips-reject-note"]')).toBeNull();
  });

  it("a reject records them as not taken however the reviewer marked them", async () => {
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject"); // dismissed
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    expect(decideBodies(fetchMock)[0].suggestionDecisions).toEqual({
      accepted: [],
      dismissed: ["sug-1", "sug-2"],
    });
  });

  it("a gate with NO suggestions posts no partition key — the pre-#2571 fingerprint", async () => {
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
    });
    renderOn("chat_thread");
    await waitFor(() => expect(screen.getByRole("button", { name: /approve/i })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    expect("suggestionDecisions" in decideBodies(fetchMock)[0]).toBe(false);
  });

  it("the PAGE's route-bound action receives the very same partition", async () => {
    // The page supplies its own action; the card must hand it the identical
    // input, or the two surfaces would be two decision shapes again.
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const hostAction = vi.fn(
      async () => ({ kind: "decided", disposition: "approve", idempotent: false }) as const,
    );
    const { container } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} submitAction={hostAction} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(hostAction).toHaveBeenCalledTimes(1));
    expect(hostAction).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "approve",
        suggestionDecisions: { accepted: ["sug-2"], dismissed: ["sug-1"] },
      }),
    );
  });

  it("a COMMENT carries no partition, and the marks survive it", async () => {
    // S6b refuses a partition on a non-terminal decision — a stream of comments
    // each "accepting" items on a gate that never resolves is the parallel
    // approval pathway #2047 row 8 bans. So Comment must not send one, or it
    // would fail for every reviewer looking at a row of suggestions. Nothing is
    // lost: a comment leaves the gate open, and the marks ride the terminal
    // decision when the reviewer takes one.
    const fetchMock = mockResolveAndDecide({
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    fireEvent.click(screen.getByRole("button", { name: /comment/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    const body = decideBodies(fetchMock)[0];
    expect(body.disposition).toBe("comment");
    expect("suggestionDecisions" in body).toBe(false);
    // Still marked, still reversible.
    expect(stateOf(container, "subject")).toBe("dismissed");
  });

  it("a surface that CHANGES clears the marks and says so, rather than quietly weakening the decision", async () => {
    // The snapshot is immutable, so the surfaced set can only change by a row
    // that stopped verifying or a read that failed. Carrying a dismissal into a
    // set the reviewer never saw would decide for them.
    let surfaced: LifecycleCardState = {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(
          JSON.stringify({ outcome: { kind: "decided", disposition: "approve", idempotent: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(reviewEnvelope(surfaced)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "items · 0 · bcc");
    await waitFor(() => expect(stateOf(container, "items · 0 · bcc")).toBe("dismissed"));
    // The surface narrows underneath the reader (a re-resolve on window focus).
    surfaced = { state: "pending", canDecide: true, canComment: true, suggestions: [CHIPS[0]] };
    fireEvent.focus(window);
    await waitFor(() => expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(1));
    // The mark is GONE, visibly, with the reason on screen…
    expect(
      container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
    ).not.toBeNull();
    expect(stateOf(container, "subject")).toBe("accepted");
    // …and the decision carries exactly what is now on screen.
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    expect(decideBodies(fetchMock)[0].suggestionDecisions).toEqual({
      accepted: ["sug-1"],
      dismissed: [],
    });
  });

  it("a surface that VANISHES still tells the reviewer their marks went with it", async () => {
    // A snapshot that stopped verifying, or a read that failed, draws no
    // suggestions at all. The reviewer who had pressed something must not simply
    // find an empty space where the row was.
    let surfaced: LifecycleCardState = {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(reviewEnvelope(surfaced)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    surfaced = { state: "pending", canDecide: true, canComment: true };
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
      ).not.toBeNull(),
    );
    expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(0);
    // The floor is still live — a failed decoration never costs the decision.
    expect(isDisabled(screen.getByRole("button", { name: /approve/i }))).toBe(false);
  });

  it("the notice SURVIVES a second surface change — a flap must not wipe the warning", async () => {
    // A transient store failure that drops the row and then restores it is two
    // surface changes in a row. Recomputing the notice from "were there marks a
    // moment ago" would answer no on the second one, and the reviewer would be
    // left looking at an all-accepted row with nothing to say theirs are gone.
    let surfaced: LifecycleCardState = {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(reviewEnvelope(surfaced)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    // 1st change — the suggestions vanish.
    surfaced = { state: "pending", canDecide: true, canComment: true };
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
      ).not.toBeNull(),
    );
    // 2nd change — they come back, accepted.
    surfaced = { state: "pending", canDecide: true, canComment: true, suggestions: CHIPS };
    fireEvent.focus(window);
    await waitFor(() => expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2));
    expect(
      container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
    ).not.toBeNull();
    // The reviewer acting is what retires the notice.
    pressChip(container, "subject");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-marks-cleared"]')).toBeNull(),
    );
  });

  it("marks NEVER cross gates, even when two gates mint the same ids", async () => {
    // A suggestion id derives from (lane, projection digest, op, pointer) and
    // NOT from the gate, so two gates shown the same text legitimately mint the
    // same ids. The binding is the REF as well as the id set.
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    pressChip(container, "subject");
    await waitFor(() => expect(stateOf(container, "subject")).toBe("dismissed"));
    // The SAME component instance is pointed at another gate whose snapshot
    // happens to carry identical suggestion ids.
    rerender(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={{ ...VIEW, ref: "ref-a-different-gate" }} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    expect(stateOf(container, "subject")).toBe("accepted");
  });
});

describe("§VIII read-only presentations", () => {
  it("restricted (respond access, no approve): the suggestions RENDER with no press target", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Approving or rejecting needs approve access on this run.",
      suggestions: CHIPS,
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    // Two suggestions, drawn — a withheld affordance is never a withheld chip,
    // and the before/after they annotate is drawn with them.
    expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-conformance-id="suggestion-before-after"]'),
    ).toHaveLength(1);
    // …and none of them is a control at all: not a live one, and not a disabled
    // one either (a disabled button reads as "later"; this is "not yours").
    expect(
      [...container.querySelectorAll("[data-suggestion-state]")].every(
        (n) => n.querySelector("button") === null,
      ),
    ).toBe(true);
    expect(container.querySelector('[data-suggestion-chips-mode="read-only"]')).not.toBeNull();
  });

  it("settled: the RECORDED partition, drawn in the same readings, with no affordance", async () => {
    mockResolve({
      state: "settled",
      suggestions: [
        { ...CHIPS[0], mark: "accepted" as const },
        { ...CHIPS[1], mark: "dismissed" as const },
      ],
    });
    const { container } = renderOn("page_gate_region");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    expect(chipFor(container, "subject").getAttribute("data-conformance-id")).toBe(
      "suggestion-accepted",
    );
    expect(chipFor(container, "items · 0 · bcc").getAttribute("data-conformance-id")).toBe(
      "suggestion-dismissed",
    );
    expect(container.querySelector('[data-suggestion-chips-mode="recorded"]')).not.toBeNull();
    // §IV still holds: the gate is no longer open.
    expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull();
  });

  it("settled BEFORE this slice: an id with no recorded mark reports no choice, not a guess", async () => {
    // A gate decided under the old three-state marking recorded a row only for
    // the items the reviewer touched. Drawing the rest as accepted or dismissed
    // would report a choice nobody made. This reading exists for history only —
    // a pending gate can never produce it.
    mockResolve({ state: "settled", suggestions: [CHIPS[0]] });
    const { container } = renderOn("page_gate_region");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("unrecorded");
  });

  it("a settled gate that surfaced nothing draws only §IV's blocked notice", async () => {
    mockResolve({ state: "settled" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMPOSER FOCUS (cinatra#2566's composer-focus deliverable; the program
// Done-definition is cinatra#2573 — "multiple concurrent gates require explicit
// composer focus").
//
// The card is the only thing that knows whether the SERVER says this reader may
// comment, and it owns the comment transport. So it is the card that registers
// the gate with the composer, and the card that draws which review a typed
// message will reach. What is pinned here: the affordance exists only where a
// composer does and only for a gate that would accept the comment; the binding
// the card SAYS is the binding the resolver computes; and the comment the
// composer sends travels the card's own decision path.
// ---------------------------------------------------------------------------

describe("#2566 composer focus", () => {
  const OTHER_VIEW = {
    viewType: "artifact_review_gate" as const,
    schemaVersion: 1,
    ref: "ref-def-456",
  };

  function renderWithComposer(
    ui: ReactNode,
    store = createComposerFocusStore(),
  ): { store: ComposerFocusStore; container: HTMLElement } {
    const { container } = render(
      <LifecycleComposerFocusProvider store={store}>{ui}</LifecycleComposerFocusProvider>,
    );
    return { store, container };
  }

  const card = (view: typeof VIEW) => (
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ReviewGateCard view={view} />
    </LifecycleCardSurfaceProvider>
  );

  /**
   * Wait for the gate to be REGISTERED with the composer — the store's own
   * truth, which is what a test that then reaches into the store depends on.
   *
   * Waiting on the painted row instead is a RACE, and it is the test's race and
   * not the card's. The card computes `available` (the row) during render and
   * registers in a passive effect, so the row lands in the commit and the
   * registration lands in the effect flush that follows it. `waitFor` observes
   * the DOM through a MutationObserver — a microtask off the commit — and can
   * therefore return in the window between the two, where `getCommentAction`
   * is still `undefined` and calling it throws. It is entered rarely and
   * nondeterministically — measured on this card at 1-2 of 120 renders on an
   * idle machine, on this branch AND on the code before it — which is why it
   * surfaced as a single unreproducible CI failure (cinatra#2713, "a blank
   * comment is refused without a request") rather than as a broken suite.
   *
   * The window is not a product defect: it is bounded by React's effect flush,
   * so no reader can act inside it. The registration itself is on the RIGHT
   * axis — the server's `canComment`, never the island's load event; the pin
   * below ("the composer binding is live while the island is still loading")
   * holds that axis.
   */
  async function waitForComposerRegistration(
    store: ComposerFocusStore,
    ref: string,
  ): Promise<void> {
    await waitFor(() => expect(typeof store.getCommentAction(ref)).toBe("function"));
  }

  it("NO composer on the surface ⇒ no affordance and no registration at all", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    // The review page and the run-detail page mount no focus provider.
    const { container } = render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-composer-focus"]')).toBeNull();
  });

  it("a gate this reader may not COMMENT on registers nothing", async () => {
    // §IV `restricted` with respond access withheld: the floor's Comment is
    // dead, so a composer binding would be a control that fails on press.
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: "You can view this review but not act on it.",
    });
    const { store, container } = renderWithComposer(card(VIEW));
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-composer-focus"]')).toBeNull();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("ONE open review binds the composer on its own, and the card says so", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { store, container } = renderWithComposer(card(VIEW));
    await waitForComposerRegistration(store, VIEW.ref);
    expect(store.getSnapshot().eligible).toEqual([VIEW.ref]);
    const row = container.querySelector('[data-conformance-id="review-composer-focus"]')!;
    expect(row.getAttribute("data-composer-bound")).toBe("true");
    expect(container.querySelector('[data-conformance-id="review-composer-bound"]')).not.toBeNull();
    // The control is drawn PRESSED because the composer really is bound — and
    // the press is what gives the binding back, which is the only escape from a
    // lone review turning every chat message into a comment.
    const control = screen.getByRole("button", { name: /replying to this review/i });
    expect(control.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(control);
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-conformance-id="review-composer-focus"]')!
          .getAttribute("data-composer-bound"),
      ).toBe("false"),
    );
    expect(store.getSnapshot().released).toBe(true);
    // Released, not ambiguous: the reader answered, so no prompt is shown.
    expect(
      container.querySelector('[data-conformance-id="review-composer-ambiguous"]'),
    ).toBeNull();
    expect(container.querySelector('[data-conformance-id="review-composer-unbound"]')).not.toBeNull();
  });

  it("TWO open reviews: neither is bound, and both say to choose one", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { store, container } = renderWithComposer(
      <>
        {card(VIEW)}
        {card(OTHER_VIEW)}
      </>,
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toHaveLength(2));
    const rows = container.querySelectorAll('[data-conformance-id="review-composer-focus"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("data-composer-bound")).toBe("false");
      expect(row.getAttribute("data-composer-ambiguous")).toBe("true");
    }
    // The refusal the composer will give, said on the cards BEFORE the reader
    // types it.
    expect(
      container.querySelectorAll('[data-conformance-id="review-composer-ambiguous"]'),
    ).toHaveLength(2);
    expect(container.querySelector('[data-conformance-id="review-composer-bound"]')).toBeNull();
  });

  it("pressing one card binds it — explicitly — and unbinds the other", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { store, container } = renderWithComposer(
      <>
        {card(VIEW)}
        {card(OTHER_VIEW)}
      </>,
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toHaveLength(2));
    fireEvent.click(
      screen.getAllByRole("button", { name: /reply from the chat box/i })[1]!,
    );
    await waitFor(() => expect(store.getSnapshot().focused).toBe(OTHER_VIEW.ref));

    const rows = Array.from(
      container.querySelectorAll('[data-conformance-id="review-composer-focus"]'),
    );
    expect(rows[0]!.getAttribute("data-composer-bound")).toBe("false");
    expect(rows[1]!.getAttribute("data-composer-bound")).toBe("true");
    // The unbound card no longer says "choose one" — the ambiguity is resolved,
    // it just is not the chosen one.
    expect(
      rows[0]!.querySelector('[data-conformance-id="review-composer-ambiguous"]'),
    ).toBeNull();
    expect(rows[0]!.querySelector('[data-conformance-id="review-composer-unbound"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /replying to this review/i }).getAttribute("aria-pressed"),
    ).toBe("true");

    // Pressing the bound card again gives the binding back.
    fireEvent.click(screen.getByRole("button", { name: /replying to this review/i }));
    await waitFor(() => expect(store.getSnapshot().focused).toBeNull());
  });

  it("the composer's comment travels the CARD's own decision path", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(
          JSON.stringify({
            outcome: { kind: "changes-requested", status: "requested", idempotent: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { store } = renderWithComposer(card(VIEW));
    await waitForComposerRegistration(store, VIEW.ref);

    const result = await store.getCommentAction(VIEW.ref)!("shorten the intro");
    // The SAME gate-scoped entry, the SAME opaque ref, the `comment` disposition
    // the floor's Comment button posts — not a second transport.
    const decide = calls.find((c) => c.url === LIFECYCLE_VIEW_DECIDE_PATH);
    expect(decide).toBeDefined();
    expect(decide!.body).toMatchObject({
      ref: VIEW.ref,
      disposition: "comment",
      comment: "shorten the intro",
    });
    // A comment carries NO per-item partition — it does not resolve the gate, so
    // it cannot carry terminal choices (the decision core refuses that).
    expect(JSON.stringify(decide!.body)).not.toContain("suggestionDecisions");
    // A comment that resolved into a repair says so, in a line with no ids.
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/changes requested/i);
    expect(result.message).not.toContain(VIEW.ref);
  });

  // cinatra#2713 — the island's load state and the composer binding are
  // SEPARATE axes, and this pins that they stay separate.
  //
  // A preview that has not painted yet is not a reason a reader cannot reply.
  // The registration hangs off the SERVER's answer (`canComment`) and nothing
  // else; a later slice that gated it on the island — rendering the row only
  // once the frame loaded, or moving the binding inside the island's loaded
  // branch — would leave a reader looking at a skeleton with a composer that
  // silently refuses their message. The card's own §II rule for the decision
  // floor ("a preview that did not load is never drawn as a reason the reviewer
  // cannot decide") applies to replying, identically.
  it("the composer binding is live while the island is STILL LOADING", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response(
          JSON.stringify({
            outcome: { kind: "changes-requested", status: "requested", idempotent: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { store, container } = renderWithComposer(card(VIEW));
    await waitForComposerRegistration(store, VIEW.ref);

    // No `load` event has been fired on the iframe, so the island is still on
    // its skeleton — the state this test is about.
    expect(
      container
        .querySelector('[data-conformance-id="review-target-island"]')!
        .getAttribute("data-island-load-state"),
    ).toBe("loading");
    expect(
      container.querySelector('[data-conformance-id="review-target-island-skeleton"]'),
    ).not.toBeNull();

    // The affordance is drawn, and drawn BOUND — the reader is told their next
    // chat message reaches this review while the preview is still arriving.
    expect(
      container
        .querySelector('[data-conformance-id="review-composer-focus"]')!
        .getAttribute("data-composer-bound"),
    ).toBe("true");

    // And it is not merely drawn: the registered action posts the comment on
    // the card's own decision path, from the loading state.
    const result = await store.getCommentAction(VIEW.ref)!("the intro is too long");
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.url === LIFECYCLE_VIEW_DECIDE_PATH)!.body).toMatchObject({
      ref: VIEW.ref,
      disposition: "comment",
      comment: "the intro is too long",
    });
  });

  it("a blank comment is refused without a request", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { store } = renderWithComposer(card(VIEW));
    await waitForComposerRegistration(store, VIEW.ref);
    const before = fetchMock.mock.calls.length;
    const result = await store.getCommentAction(VIEW.ref)!("   ");
    expect(result.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("a refused comment reports the refusal, and never reads as success", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input) === LIFECYCLE_VIEW_DECIDE_PATH) {
        return new Response("{}", { status: 403 });
      }
      return new Response(
        JSON.stringify(reviewEnvelope({ state: "pending", canDecide: true, canComment: true })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { store } = renderWithComposer(card(VIEW));
    await waitForComposerRegistration(store, VIEW.ref);
    const result = await store.getCommentAction(VIEW.ref)!("please fix the heading");
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("a card that unmounts takes its composer binding with it", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const store = createComposerFocusStore();
    const { unmount } = render(
      <LifecycleComposerFocusProvider store={store}>{card(VIEW)}</LifecycleComposerFocusProvider>,
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toEqual([VIEW.ref]));
    unmount();
    expect(store.getSnapshot().eligible).toEqual([]);
    expect(store.getCommentAction(VIEW.ref)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §IV — the SETTLED card names its outcome, and Refresh goes with the ambiguity
// (cinatra#2855; plan §4.2)
// ---------------------------------------------------------------------------

describe("a settled card that knows its outcome", () => {
  const HOSTS = ["chat_thread", "run_card", "page_gate_region", "site_widget"] as const;

  async function settledWith(
    outcome: "approved" | "rejected" | "changes_requested",
    decidedByName?: string,
    host: (typeof HOSTS)[number] = "chat_thread",
  ) {
    mockResolve(
      decidedByName
        ? { state: "settled", outcome, decidedByName }
        : { state: "settled", outcome },
    );
    const { container } = renderOn(host);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    return container;
  }

  it("names the outcome AND the decider", async () => {
    const container = await settledWith("approved", "Dana Okonkwo");
    expect(container.textContent).toContain("Approved by Dana Okonkwo");
    expect(container.textContent).toContain(
      "The gate is resolved and the run has been released to continue.",
    );
    expect(
      container
        .querySelector('[data-conformance-id="review-gate-settled"]')
        ?.getAttribute("data-review-outcome"),
    ).toBe("approved");
  });

  it("names each of the three recorded outcomes", async () => {
    const cases: Array<[Parameters<typeof settledWith>[0], string]> = [
      ["approved", "Approved by Dana Okonkwo"],
      ["rejected", "Rejected by Dana Okonkwo"],
      ["changes_requested", "Changes requested by Dana Okonkwo"],
    ];
    for (const [outcome, title] of cases) {
      const container = await settledWith(outcome, "Dana Okonkwo");
      expect(container.textContent).toContain(title);
      cleanup();
    }
  });

  it("DROPS the Refresh affordance and the floor — but NOT the target: \"A resolved gate opens read-only: what was decided, and the reviewed target(s), kept for the run's audit trail\"", async () => {
    // The Refresh existed to resolve "decided, or did the run move on?". A named
    // outcome has already answered that, so a Refresh beside it would offer to
    // resolve an ambiguity that is not there.
    const container = await settledWith("rejected", "Dana Okonkwo");
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
    expect(
      container.querySelector('[data-conformance-id="review-gate-blocked"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("This review is no longer open");
    // No floor to press...
    expect(
      container.querySelector('[data-conformance-id="review-decision-bar"]'),
    ).toBeNull();
    // ...and the reviewed target still on screen, drawn by its own renderer.
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(
      container.querySelector('[data-conformance-id="review-target-island"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-lifecycle-card-state="settled"]'),
    ).not.toBeNull();
  });

  it("states the outcome ALONE when no decider can be named", async () => {
    // The resolver drops a decider it cannot name safely rather than reaching
    // for an identifier, so the card must read as a finished sentence without
    // one — never "Approved by" and a dangling nothing.
    const container = await settledWith("approved");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).not.toContain("Approved by");
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });

  it("draws the SAME reading on all four hosts", async () => {
    // §IX parity: the renderer decides, never the surface it is read on.
    const drawn: string[] = [];
    for (const host of HOSTS) {
      const container = await settledWith("approved", "Dana Okonkwo", host);
      drawn.push(
        container.querySelector('[data-conformance-id="review-gate-settled"]')!.outerHTML,
      );
      cleanup();
    }
    for (const html of drawn) {
      expect(html).toBe(drawn[0]);
      expect(html).toContain("Approved by Dana Okonkwo");
    }
  });

  it("keeps the recorded suggestion partition above the named outcome", async () => {
    mockResolve({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
      suggestions: [
        {
          id: "sug-1",
          label: "content.body",
          op: "replace",
          message: "Tighten the opening sentence.",
          mark: "accepted",
        },
      ],
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).toContain("content.body");
    expect(container.textContent).toContain("Approved by Dana Okonkwo");
  });
});

// ---------------------------------------------------------------------------
// §I — THE DECIDED READING KEEPS THE REVIEWED TARGET (cinatra#2931 W4)
//
// "A resolved gate opens read-only: what was decided, and the reviewed
// target(s), kept for the run's audit trail." The card that settles after an
// Approve used to drop the target entirely and leave the decision line standing
// alone, on every host it settles in. What is pinned below is the whole clause:
// the target is there and drawn by its own renderer, nothing on the card can
// decide anything any more, and the decision line names the disposition.
// ---------------------------------------------------------------------------

describe("the decided reading — \"what was decided, AND the reviewed target(s)\"", () => {
  const HOSTS = ["chat_thread", "run_card", "page_gate_region", "site_widget"] as const;

  async function decidedOn(
    outcome: "approved" | "rejected" | "changes_requested",
    host: (typeof HOSTS)[number] = "chat_thread",
  ) {
    mockResolve({ state: "settled", outcome, decidedByName: "Dana Okonkwo" });
    const { container } = renderOn(host);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    return container;
  }

  // The two TERMINAL dispositions the issue was measured on, plus the third the
  // spec holds distinct from both.
  const DISPOSITIONS = [
    ["approved", "Approved by Dana Okonkwo"],
    ["rejected", "Rejected by Dana Okonkwo"],
    ["changes_requested", "Changes requested by Dana Okonkwo"],
  ] as const;

  for (const [outcome, line] of DISPOSITIONS) {
    it(`${outcome}: the target panel is drawn by its own renderer, the controls are gone, the decision line stands`, async () => {
      const container = await decidedOn(outcome);

      // THE TARGET — the same island the pending reading mounts, addressed by
      // the SAME ref, which is what pins it to the revision the gate froze and
      // the decision was taken on ("You approve exactly what you saw").
      const island = container.querySelector(
        '[data-conformance-id="review-target-island"]',
      );
      expect(island, "the reviewed target is kept").not.toBeNull();
      const frame = container.querySelector("iframe");
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute("src")).toBe(
        `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(VIEW.ref)}`,
      );

      // NO DECISION CONTROLS — not the floor, not one of its three buttons, not
      // the rationale field, not the composer binding.
      expect(
        container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
      expect(container.querySelector("textarea")).toBeNull();
      expect(
        container.querySelector('[data-conformance-id="review-composer-focus"]'),
      ).toBeNull();

      // THE DECISION LINE — the recorded disposition, read distinctly.
      const settled = container.querySelector(
        '[data-conformance-id="review-gate-settled"]',
      );
      expect(settled?.getAttribute("data-review-outcome")).toBe(outcome);
      expect(container.textContent).toContain(line);
    });
  }

  it("draws the SAME decided reading on all four hosts — the conversation, the run page, the review page and the third-party application", async () => {
    for (const host of HOSTS) {
      const container = await decidedOn("approved", host);
      expect(
        container.querySelector('[data-conformance-id="review-target-island"]'),
        `the target is kept on ${host}`,
      ).not.toBeNull();
      expect(
        container.querySelector('[data-conformance-id="review-decision-bar"]'),
        `no floor on ${host}`,
      ).toBeNull();
      expect(container.textContent).toContain("Approved by Dana Okonkwo");
      cleanup();
    }
  });

  it("keeps the recorded chips BETWEEN the target and the decision line", async () => {
    mockResolve({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
      suggestions: [
        {
          id: "sug-1",
          label: "content.body",
          op: "replace",
          message: "Tighten the opening sentence.",
          mark: "accepted",
        },
      ],
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-settled"]'),
      ).not.toBeNull(),
    );
    const order = Array.from(
      container.querySelectorAll(
        '[data-conformance-id="review-target-island"],[data-conformance-id="suggestion-chips"],[data-conformance-id="review-gate-settled"]',
      ),
    ).map((el) => el.getAttribute("data-conformance-id"));
    expect(order).toEqual([
      "review-target-island",
      "suggestion-chips",
      "review-gate-settled",
    ]);
  });
});

describe("a settled card that does NOT know its outcome", () => {
  it("reads exactly as it always has, Refresh and all", async () => {
    // The record that predates the outcome, and the disposition this build
    // cannot read, both land here. Neither is a card that may guess.
    mockResolve({ state: "settled" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="review-gate-blocked"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-conformance-id="review-gate-settled"]'),
    ).toBeNull();
    expect(container.textContent).toContain("This review is no longer open");
    expect(container.textContent).toContain(
      "The gate was already decided or the run moved on.",
    );
    expect(screen.getByRole("button", { name: /refresh/i })).not.toBeNull();
  });
});
