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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

// The SHIPPED decision chrome uses the app router (`router.refresh()` after a
// landed decision, and the page's Refresh out of a stale gate). jsdom has no
// router mounted, so the seam is stubbed — the card under test never navigates.
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  LIFECYCLE_VIEW_DECIDE_PATH,
  REVIEW_TARGET_ISLAND_PATH,
  ReviewGateCard,
} from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-abc-123",
};

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ state }), {
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
// §IX — one renderer, three first-party hosts, host-specific frame only
// ---------------------------------------------------------------------------

describe("one renderer, three first-party hosts", () => {
  const HOSTS = ["chat_thread", "run_card", "page_gate_region"] as const;

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
        JSON.stringify({ state: { state: "pending", canDecide: true, canComment: true } }),
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
      const state =
        resolves === 1
          ? { state: "pending", canDecide: true, canComment: true }
          : { state: "settled" };
      return new Response(JSON.stringify({ state }), {
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
      const state =
        resolves === 1
          ? { state: "pending", canDecide: true, canComment: true }
          : { state: "settled" };
      return new Response(JSON.stringify({ state }), {
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
        JSON.stringify({ state: { state: "pending", canDecide: true, canComment: true } }),
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
        JSON.stringify({ state: { state: "pending", canDecide: true, canComment: true } }),
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
// §VIII — the suggestion chips (cinatra#2572, epic #2564 S6c)
// ---------------------------------------------------------------------------
//
// The properties a later slice must not be able to weaken: the chips are drawn
// by THIS component (so page and card cannot diverge), a mark is LOCAL until the
// one decision carries it, both marks are reversible, a reader who may not
// decide gets no press target at all, and a decided gate shows what was
// recorded.

const CHIPS = [
  { id: "sug-1", label: "subject", op: "replace" as const, message: "Not canonical." },
  { id: "sug-2", label: "items · 0 · bcc", op: "remove" as const, message: "Every disclosed field is empty." },
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
    return new Response(JSON.stringify({ state }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function chipFor(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll("[data-suggestion-state]")].find((n) =>
    (n.textContent ?? "").includes(label),
  );
  if (!el) throw new Error(`no chip for ${label}`);
  return el as HTMLElement;
}

describe("§VIII the chips are drawn by the ONE renderer", () => {
  it("pending: a chip per surfaced suggestion, at rest, with the spec's anchors", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('[data-conformance-id="suggestion-chip-rest"]')).toHaveLength(2);
    // The label is the pointer; the mono slot is the transform class.
    expect(chipFor(container, "subject").textContent).toContain("replace");
    // The producer's reason is available without printing it into the row.
    expect(chipFor(container, "subject").getAttribute("title")).toBe("Not canonical.");
  });

  it("draws the SAME chips on all three first-party hosts (one component, one drawing)", async () => {
    for (const host of ["chat_thread", "run_card", "page_gate_region"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true, suggestions: CHIPS });
      const { container, unmount } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
      );
      expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2);
      unmount();
    }
  });

  it("a gate with NO suggestions draws no chip row at all", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).toBeNull();
  });
});

describe("§VIII a mark is LOCAL, and both marks are reversible", () => {
  it("cycles rest → accepted → dismissed → rest on the ONE drawn control", async () => {
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
    const chip = () => chipFor(container, "subject");
    expect(chip().getAttribute("data-suggestion-state")).toBe("rest");
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("data-suggestion-state")).toBe("accepted"));
    expect(chip().getAttribute("data-conformance-id")).toBe("suggestion-chip-accepted");
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("data-suggestion-state")).toBe("dismissed"));
    expect(chip().getAttribute("data-conformance-id")).toBe("suggestion-chip-dismissed");
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("data-suggestion-state")).toBe("rest"));

    // §VIII "the chips carry no submit of their own": four presses, ZERO
    // requests. Nothing about a mark has left the browser.
    expect(decideBodies(fetchMock)).toHaveLength(0);
  });
});

describe("§VIII the marks ride the ONE decision submit", () => {
  it("approve carries the partition on the single decide request", async () => {
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
    fireEvent.click(chipFor(container, "subject")); // accepted
    fireEvent.click(chipFor(container, "items · 0 · bcc")); // accepted
    fireEvent.click(chipFor(container, "items · 0 · bcc")); // dismissed
    await waitFor(() =>
      expect(chipFor(container, "items · 0 · bcc").getAttribute("data-suggestion-state")).toBe(
        "dismissed",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    const body = decideBodies(fetchMock)[0];
    expect(body.disposition).toBe("approve");
    expect(body.suggestionDecisions).toEqual({ accepted: ["sug-1"], dismissed: ["sug-2"] });
  });

  it("a gate with no marks posts NO partition key — the pre-#2571 fingerprint", async () => {
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
    fireEvent.click(chipFor(container, "subject"));
    await waitFor(() =>
      expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted"),
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(hostAction).toHaveBeenCalledTimes(1));
    expect(hostAction).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "approve",
        suggestionDecisions: { accepted: ["sug-1"], dismissed: [] },
      }),
    );
  });

  it("a COMMENT carries no partition, and the marks survive it", async () => {
    // S6b refuses a partition on a non-terminal decision — a stream of comments
    // each "accepting" items on a gate that never resolves is the parallel
    // approval pathway #2047 row 8 bans. So Comment must not send one, or it
    // would fail for every reviewer who had marked a chip. The marks are not
    // lost: a comment leaves the gate open, and they ride the terminal decision.
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
    fireEvent.click(chipFor(container, "subject"));
    await waitFor(() =>
      expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted"),
    );
    fireEvent.click(screen.getByRole("button", { name: /comment/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    const body = decideBodies(fetchMock)[0];
    expect(body.disposition).toBe("comment");
    expect("suggestionDecisions" in body).toBe(false);
    // Still marked, still reversible.
    expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted");
  });

  it("a surface that CHANGES clears the marks and says so, rather than quietly weakening the decision", async () => {
    // The snapshot is immutable, so the surfaced set can only change by a row
    // that stopped verifying or a read that failed. Submitting whatever survived
    // would land an approve recording NOTHING while the reviewer believes it
    // recorded their accepts.
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
      return new Response(JSON.stringify({ state: surfaced }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    fireEvent.click(chipFor(container, "items · 0 · bcc"));
    await waitFor(() =>
      expect(chipFor(container, "items · 0 · bcc").getAttribute("data-suggestion-state")).toBe(
        "accepted",
      ),
    );
    // The surface narrows underneath the reader (a re-resolve on window focus).
    surfaced = { state: "pending", canDecide: true, canComment: true, suggestions: [CHIPS[0]] };
    fireEvent.focus(window);
    await waitFor(() => expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(1));
    // The mark is GONE, visibly, with the reason on screen…
    expect(
      container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
    ).not.toBeNull();
    expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("rest");
    // …and the decision carries nothing, which is now the truth on screen.
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(decideBodies(fetchMock)).toHaveLength(1));
    expect("suggestionDecisions" in decideBodies(fetchMock)[0]).toBe(false);
  });

  it("a surface that VANISHES still tells the reviewer their marks went with it", async () => {
    // A snapshot that stopped verifying, or a read that failed, draws no chips
    // at all. The reviewer who had marked something must not simply find an
    // empty space where the row was.
    let surfaced: LifecycleCardState = {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: surfaced }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    fireEvent.click(chipFor(container, "subject"));
    await waitFor(() =>
      expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted"),
    );
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
    // A transient store failure that drops the chips and then restores them is
    // two surface changes in a row. Recomputing the notice from "were there
    // marks a moment ago" would answer no on the second one, and the reviewer
    // would be left looking at chips at rest with nothing to say theirs are
    // gone.
    let surfaced: LifecycleCardState = {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: CHIPS,
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: surfaced }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="suggestion-chips"]')).not.toBeNull(),
    );
    fireEvent.click(chipFor(container, "subject"));
    await waitFor(() =>
      expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted"),
    );
    // 1st change — the chips vanish.
    surfaced = { state: "pending", canDecide: true, canComment: true };
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
      ).not.toBeNull(),
    );
    // 2nd change — they come back, at rest.
    surfaced = { state: "pending", canDecide: true, canComment: true, suggestions: CHIPS };
    fireEvent.focus(window);
    await waitFor(() => expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2));
    expect(
      container.querySelector('[data-conformance-id="suggestion-marks-cleared"]'),
    ).not.toBeNull();
    // The reviewer acting is what retires the notice.
    fireEvent.click(chipFor(container, "subject"));
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
    fireEvent.click(chipFor(container, "subject"));
    await waitFor(() =>
      expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("accepted"),
    );
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
    expect(chipFor(container, "subject").getAttribute("data-suggestion-state")).toBe("rest");
  });
});

describe("§VIII read-only presentations", () => {
  it("restricted (respond access, no approve): the chips RENDER with no press target", async () => {
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
    // Two chips, drawn — a withheld affordance is never a withheld chip.
    expect(container.querySelectorAll("[data-suggestion-state]")).toHaveLength(2);
    // …and none of them is a control at all: not a live one, and not a disabled
    // one either (a disabled button reads as "later"; this is "not yours").
    expect(
      [...container.querySelectorAll("[data-suggestion-state]")].every(
        (n) => n.tagName.toLowerCase() === "span",
      ),
    ).toBe(true);
    expect(container.querySelector('[data-suggestion-chips-mode="read-only"]')).not.toBeNull();
  });

  it("settled: the RECORDED partition, drawn in the same chips, with no affordance", async () => {
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
      "suggestion-chip-accepted",
    );
    expect(chipFor(container, "items · 0 · bcc").getAttribute("data-conformance-id")).toBe(
      "suggestion-chip-dismissed",
    );
    expect(container.querySelector('[data-suggestion-chips-mode="recorded"]')).not.toBeNull();
    // §IV still holds: the gate is no longer open.
    expect(container.querySelector('[data-conformance-id="review-gate-blocked"]')).not.toBeNull();
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
