// @vitest-environment jsdom
//
// THE GATE AGAINST THE DRAWING (cinatra#3141 items 1 and 7).
//
// ITEM 1 — the drawing puts the changes-request channel INSIDE the gate's own
// frame, on every surface the gate opens on: "Inside the run detail, the gate
// opens with a gate header …, then the review target, then the decision bar and
// the conversational prompt window (§VI)", and §VI fixes what it is for —
// "Beneath the decision bar the run detail carries a conversational prompt
// window — a chat-style input onto the run, offered as 'Ask Cinatra about this
// review, or ask for changes to the work…'. Typing a change request into it is
// how a reviewer requests changes; there is no dedicated 'request changes'
// button." The window was mounted by the review ROUTE alone, at page level and
// outside the card, so the run page's own gate offered no channel at all: the
// decision bar worked, and the one road the drawing designates for asking for
// changes was not on that surface.
//
// ITEM 7 — "Every target opens with a header that names what is under review
// and fixes it in place: the artifact's display title over a mono meta line
// carrying its type, the pinned representation revision (shown as a mono
// revision id with a pinned marker)…" (§IV). The header was server-rendered
// INSIDE the island document, so until that frame painted the card drew a
// skeleton with no title, no type and no revision, and past the bound it drew a
// recovery panel with none either — a pending gate on the run page with no
// header at all.
//
// Both are proven on the CARD, which is the one renderer every surface mounts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// The window's field is the shared `PromptField`, which pulls browser-only deps
// jsdom cannot load. Stubbed to a plain element that surfaces the placeholder as
// text, exactly as the sibling panel suites stub it — so the assertion below is
// on the drawing's SENTENCE, which is the thing under test.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({
    placeholder,
    onSubmit,
  }: {
    placeholder?: string;
    onSubmit?: (prompt: string) => void | Promise<void>;
  }) => (
    <div data-testid="review-prompt-field">
      {placeholder}
      {/* The field's own submit, exposed so the exchange can be driven: typing a
          change request IS the affordance under test, and the real field pulls
          browser-only deps jsdom cannot load. */}
      {/* A <span> marker, not a raw <button> - the ui-design-system gate bans
          raw buttons; this jsdom stub only needs a clickable node carrying the
          testid, not a button role. */}
      <span
        data-testid="review-prompt-send"
        onClick={() => void onSubmit?.(TYPED_REQUEST)}
      />
    </div>
  ),
}));

// The run's stored exchange is a server action; the window reads it on mount.
//
// THE TURN'S REAL SHAPE (cinatra#2934, lifecycle-b W5c): a turn reports the
// fills it placed and whether it PRESSED a control of the bound card, and the
// one controller reads both. A mock that omits them lies about the contract.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

import { sendRunWindowTurn } from "../run-window-actions";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { REVIEW_TARGET_ISLAND_PATH, ReviewGateCard, ReviewTargetFrame } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-3141",
};

/** The drawing's own sentence for this window's reading (§VI). */
const OFFER = "Ask Cinatra about this review, or ask for changes to the work…";
/** What a reviewer types when they ask for changes — the drawing's one road. */
const TYPED_REQUEST = "Please shorten the intro and drop the second CTA.";

const HEADER_ONE = {
  title: "Q3 re-engagement email",
  typeLabel: "Email",
  objectType: "@cinatra-ai/email:draft",
  revisionId: "rev_8f3a1c2d4e5f6a7b",
  facts: ["team", "private", "text/html", "updated 8 minutes ago"],
};
const HEADER_TWO = {
  title: "Q3 cohort brief",
  typeLabel: "Document",
  objectType: "@cinatra-ai/doc:brief",
  revisionId: "rev_11223344556677",
  facts: ["team", "private", "text/markdown", "updated 3 minutes ago"],
};

function mockResolve(
  state: LifecycleCardState,
  extra: Record<string, unknown> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null, ...extra }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The widget's credential declaration — required by the provider's fail-closed
 *  invariant, and the real shape the embed passes. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

function renderOn(
  host: "chat_thread" | "run_card" | "page_gate_region" | "site_widget",
  props: { runId?: string } = {},
) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
    >
      <ReviewGateCard view={VIEW} runId={props.runId ?? "run-3141"} />
    </LifecycleCardSurfaceProvider>,
  );
}

const promptWindows = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-prompt-window"]');
const headers = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-target-header"]');
const pairs = (root: ParentNode) => root.querySelectorAll("[data-review-target-pair]");
const islands = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-target-island"]');
/** The query of an island frame's address, read the way the island page reads it. */
const frameQuery = (frame: Element | null | undefined): URLSearchParams => {
  const src = frame?.getAttribute("src") ?? "";
  return new URLSearchParams(src.slice(src.indexOf("?") + 1));
};

// ---------------------------------------------------------------------------
// ITEM 1 — the conversational prompt window is inside the gate's frame
// ---------------------------------------------------------------------------

describe("#3141 item 1 — the conversational prompt window is part of the gate", () => {
  it("the run page's own gate draws the window inside the gate's frame, offered in the drawing's words", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const card = container.querySelector('[data-conformance-id="review-gate-card"]');
    expect(card).not.toBeNull();
    const window = card!.querySelector('[data-conformance-id="review-prompt-window"]');
    expect(window, "the window is inside the gate's own frame").not.toBeNull();
    expect(window!.textContent).toContain(OFFER);
  });

  it("draws it beneath the decision bar, which is where the drawing puts it", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    const window = container.querySelector('[data-conformance-id="review-prompt-window"]')!;
    expect(bar.compareDocumentPosition(window) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("EXACTLY ONE window per surface — the review page never draws a second", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("page_gate_region");
    await waitFor(() => expect(promptWindows(container).length).toBeGreaterThan(0));
    expect(promptWindows(container)).toHaveLength(1);
    expect(document.querySelectorAll('[data-conformance-id="review-prompt-window"]')).toHaveLength(1);
  });

  it("wherever the gate is mounted OUTSIDE a conversation WITH its run, it draws that one window and no other", async () => {
    // The window is the RUN's conversation, so what it needs is the run. Given
    // the run, every host OUTSIDE a conversation draws the same single window,
    // which is the point of one card for every surface. THE CONVERSATION IS THE
    // ONE DIVISION (cinatra#3481, `app-lifecycle-cards.html` §II): "No prompt
    // window is drawn inside a conversation — the prompt window is the box
    // outside the chat", so the chat-hosted card draws none even with its run,
    // and `review-card-in-the-thread-draws-no-prompt-window-3481.test.tsx`
    // holds it to that. What decides whether a window is drawn at all on these
    // hosts is the next case.
    for (const host of ["run_card", "page_gate_region", "site_widget"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container } = renderOn(host);
      await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
      cleanup();
    }
  });

  it("the CONVERSATION's card draws no window even when it names its run", async () => {
    // The same loop's fourth host, split out because its reading is the
    // opposite one: inside a conversation the composer at the foot of the
    // thread is where a change request is typed (§II), so the card adds no box
    // of its own above it.
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(promptWindows(container)).toHaveLength(0);
  });

  it("a card dispatched in a TRANSCRIPT names no run and draws no window — a thread ends in its composer", async () => {
    // THE DRAWING'S OWN DIVISION (§I.3): "The run page hosts the same card the
    // conversation hosts … Only the frame around it changes: a thread ends in
    // its composer, and the run detail ends in the prompt window (§VI)." The
    // transcript dispatch passes the view and nothing else, so a card in a
    // thread or a widget names no run — and draws no window, because the
    // reader's channel there is the composer the thread already ends in. A
    // window whose exchange had no run to be kept with would be a control that
    // fails on press.
    for (const host of ["chat_thread", "site_widget"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container } = render(
        <LifecycleCardSurfaceProvider
          host={host}
          auth={host === "site_widget" ? WIDGET_AUTH : undefined}
        >
          <ReviewGateCard view={VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
      );
      expect(promptWindows(container)).toHaveLength(0);
      cleanup();
    }
  });

  // AMENDED BY THE FORWARD MERGE OF cinatra#2934 (lifecycle-b W5c). This case
  // used to press the window and assert that the REVIEW'S DECISION ACTION had
  // been called with `{ disposition: "comment" }` — the direct filing the window
  // did before any model read the sentence. That road is the one W5c retires,
  // and the code this case guarded says so in its own words ("kept until #2934
  // retires it"). What the case is really about survives unchanged and is what
  // it asserts now: the reader's own exchange is still on screen afterwards.
  it("the typed request goes to the RUN's assistant — the window files nothing itself", async () => {
    const resolveFetch = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const submitAction = vi.fn(
      async () =>
        ({ kind: "changes-requested", status: "requested", idempotent: false }) as const,
    );
    // A QUESTION: the turn answered and pressed nothing.
    vi.mocked(sendRunWindowTurn).mockImplementation(
      async () => ({ ok: true, entries: [], fills: [], acted: false }) as never,
    );
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3141" submitAction={submitAction} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
    const resolvesBefore = resolveFetch.mock.calls.length;
    vi.mocked(sendRunWindowTurn).mockClear();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="review-prompt-send"]')!);
    });

    // What was typed reached the run's own conversation, word for word …
    expect(vi.mocked(sendRunWindowTurn)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-3141", surface: "review", prompt: TYPED_REQUEST }),
    );
    // … and the window filed nothing itself. The decision bar keeps the action.
    expect(submitAction).not.toHaveBeenCalled();
    // The window — and with it the exchange — is still on screen.
    expect(promptWindows(container)).toHaveLength(1);
    expect(
      container.querySelector('[data-conformance-id="review-decision-bar"]'),
      "the gate the exchange belongs to is still the reading on screen",
    ).not.toBeNull();
    // A turn that only answered moves nothing: no re-read.
    expect(resolveFetch.mock.calls.length).toBe(resolvesBefore);
  });

  it("a turn that PRESSED Comment re-reads the card, and the exchange survives it", async () => {
    // THE OTHER HALF OF THE SAME RULING. The exchange had to stay visible, and
    // before W5c the only way to keep it was to refuse the re-read, because the
    // outcome line lived in the window's own state. The exchange is the RUN's
    // now — stored server side per turn and read back on mount (cinatra#2933) —
    // so the card CAN show the state the server holds after a landed request
    // without taking the reader's words off screen. It must: a gate that was
    // settled by the press would otherwise keep drawing its decision bar.
    const resolveFetch = mockResolve({ state: "pending", canDecide: true, canComment: true });
    vi.mocked(sendRunWindowTurn).mockImplementation(
      async () => ({ ok: true, entries: [], fills: [], acted: true }) as never,
    );
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3141" />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
    const resolvesBefore = resolveFetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="review-prompt-send"]')!);
    });

    await waitFor(() => expect(resolveFetch.mock.calls.length).toBeGreaterThan(resolvesBefore));
    expect(promptWindows(container)).toHaveLength(1);
  });

  it("offered only to a reviewer who may comment — a restricted reader with none gets no window", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: "You can view this review but not respond to it.",
    });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(promptWindows(container)).toHaveLength(0);
  });

  it("a restricted reader who MAY comment keeps the channel the drawing gives them", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "You can comment on this review but not approve it.",
    });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
  });

  it("a SETTLED gate carries no window — there is nothing left to request changes on", async () => {
    mockResolve({ state: "settled", outcome: "approved" });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
    );
    expect(promptWindows(container)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ITEM 7 — the target header survives every island state
// ---------------------------------------------------------------------------

describe("#3141 item 7 — the target header does not vanish with the preview", () => {
  const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

  async function renderPending(host: "run_card" | "chat_thread" | "page_gate_region", headerList = [HEADER_ONE]) {
    mockResolve(PENDING, { targetHeaders: headerList });
    const rendered = renderOn(host);
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    return rendered;
  }

  it("draws title, type chip and the pinned revision while the island is still LOADING", async () => {
    const { container } = await renderPending("run_card");
    expect(
      container.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("loading");
    const header = container.querySelector('[data-conformance-id="review-target-header"]');
    expect(header, "a header over the still-loading island").not.toBeNull();
    expect(header!.textContent).toContain(HEADER_ONE.title);
    expect(
      header!.querySelector("[data-review-target-type]")?.textContent,
    ).toBe(HEADER_ONE.typeLabel);
    expect(header!.textContent).toContain("pinned");
    expect(header!.querySelector("[data-review-target-revision]")).not.toBeNull();
  });

  it("keeps the header past the 12-second bound, where only the BODY shows the recovery affordance", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderPending("run_card");
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const island = container.querySelector('[data-conformance-id="review-target-island"]')!;
    expect(island.getAttribute("data-island-load-state")).toBe("timed-out");
    expect(
      island.querySelector('[data-conformance-id="review-target-island-timeout"]'),
      "the recovery affordance is in the body",
    ).not.toBeNull();
    const header = container.querySelector('[data-conformance-id="review-target-header"]');
    expect(header, "the header stays drawn when the preview failed").not.toBeNull();
    expect(header!.textContent).toContain(HEADER_ONE.title);
    // The header is the CARD's, not the island's — it is outside the frame that
    // failed, which is the whole reason it survived.
    expect(island.contains(header!)).toBe(false);
  });

  it("keeps the header once the island has PAINTED, and draws exactly one", async () => {
    const { container } = await renderPending("run_card");
    const frame = container.querySelector("iframe")!;
    await act(async () => {
      fireEvent.load(frame);
    });
    expect(
      container.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("loaded");
    expect(headers(container)).toHaveLength(1);
    expect(container.querySelector('[data-conformance-id="review-target-header"]')!.textContent)
      .toContain(HEADER_ONE.title);
  });

  it("EXACTLY ONE header per pinned target, each directly above its own island, on a gate carrying several", async () => {
    const { container } = await renderPending("run_card", [HEADER_ONE, HEADER_TWO]);
    expect(headers(container)).toHaveLength(2);
    const revisions = [...headers(container)].map((h) =>
      h.querySelector("[data-review-target-revision]")?.getAttribute("data-review-target-revision"),
    );
    expect(revisions).toEqual([HEADER_ONE.revisionId, HEADER_TWO.revisionId]);
    // cinatra#4129 — each header is followed by ITS OWN body: the island frame
    // that names that header's pinned revision, not one shared frame drawn
    // after every header.
    [...headers(container)].forEach((header, i) => {
      const island = header.nextElementSibling;
      expect(island?.getAttribute("data-conformance-id")).toBe("review-target-island");
      const query = frameQuery(island!.querySelector("iframe"));
      expect(query.get("target")).toBe([HEADER_ONE.revisionId, HEADER_TWO.revisionId][i]);
      expect(query.get("ref")).toBe("ref-3141");
    });
  });

  it("the conversation's card draws the header in every island state too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderPending("chat_thread");
    expect(headers(container)).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    expect(headers(container)).toHaveLength(1);
  });

  it("a SETTLED gate keeps the reviewed target's header over its read-only island", async () => {
    mockResolve({ state: "settled", outcome: "approved" }, { targetHeaders: [HEADER_ONE] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(headers(container)).toHaveLength(1));
  });

  it("the target's own frame carries NO control of its own — no Expand, no Collapse", async () => {
    // §IV of the ratified artifact-review drawing: "The renderer fills the slot
    // exactly as it would on the detail surface; the review surface adds no
    // per-type controls of its own around it." §V.1 repeats it for the display
    // that sits in the slot: "the surface around it adds no controls of its own".
    // An Expand / Collapse toggle on the island's own footer is exactly such a
    // control, and it was measured on the graded frames.
    const { container } = await renderPending("run_card");
    const island = container.querySelector('[data-conformance-id="review-target-island"]')!;
    expect(island.querySelector('[data-action="toggle-review-target-height"]')).toBeNull();
    expect(island.textContent).not.toContain("Expand");
    expect(island.textContent).not.toContain("Collapse");
    expect(island.querySelector("[aria-expanded]")).toBeNull();
  });

  it("keeps that frame control-free once the island has painted, and on a settled gate", async () => {
    const { container } = await renderPending("chat_thread");
    const frame = container.querySelector("iframe")!;
    await act(async () => {
      fireEvent.load(frame);
    });
    expect(
      container.querySelector('[data-action="toggle-review-target-height"]'),
      "no height control over a painted target",
    ).toBeNull();
    cleanup();
    mockResolve({ state: "settled", outcome: "approved" }, { targetHeaders: [HEADER_ONE] });
    const settled = renderOn("run_card");
    await waitFor(() => expect(headers(settled.container)).toHaveLength(1));
    expect(
      settled.container.querySelector('[data-action="toggle-review-target-height"]'),
    ).toBeNull();
  });

  it("an answer that carries no headers draws none — never an invented one", async () => {
    mockResolve(PENDING);
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(headers(container)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3441 — ONE bordered target card: the header over the island
// ---------------------------------------------------------------------------
//
// specs/app-artifact-review.html §IV draws a target as ONE container: "Every
// target opens with a header that names what is under review and fixes it in
// place … Beneath the header sits the representation slot". Its markup is one
// bordered, rounded box whose header carries the rule that separates it from the
// work, with nothing wrapped around the work. Measured on a real run
// (cinatra#3441): the representation sat inside two extra bordered boxes — the
// header as its own card, the island as a second card, the island document's
// panel as a third. A gate that pins ONE target now draws the header and the
// island inside ONE panel on every host, and neither half draws a frame of its
// own. The header stays the card's and outside the frame that can fail (#3141
// item 7), so it survives the skeleton and the recovery panel as before.

describe("cinatra#3441 — a one-target gate draws ONE bordered panel: its header over its island", () => {
  const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
  const panels = (root: ParentNode) => root.querySelectorAll("[data-review-target-frame]");
  const islandIn = (root: ParentNode) =>
    root.querySelector('[data-conformance-id="review-target-island"]') as HTMLElement | null;

  for (const host of ["run_card", "chat_thread", "page_gate_region"] as const) {
    it(`${host}: one panel holds the header, then the island, and neither draws a frame of its own`, async () => {
      mockResolve(PENDING, { targetHeaders: [HEADER_ONE] });
      const { container } = renderOn(host);
      await waitFor(() => expect(islandIn(container)).not.toBeNull());

      expect(panels(container)).toHaveLength(1);
      const panel = panels(container)[0] as HTMLElement;
      // §IV's one frame — "border:1px solid var(--line); border-radius:8px" —
      // drawn by the panel.
      expect(panel.classList.contains("border")).toBe(true);
      expect(panel.classList.contains("border-line")).toBe(true);
      expect(panel.classList.contains("rounded-control")).toBe(true);
      // … and the rest of §IV's container: it clips the work to its rounded
      // corners ("overflow:hidden") and paints the target's surface
      // ("background:var(--surface-strong)"). Every class of the frame is pinned.
      expect(panel.classList.contains("overflow-hidden")).toBe(true);
      expect(panel.classList.contains("bg-surface-strong")).toBe(true);
      expect(panel.className).toBe("overflow-hidden rounded-control border border-line bg-surface-strong");

      const header = panel.querySelector('[data-conformance-id="review-target-header"]') as HTMLElement;
      const island = islandIn(panel)!;
      expect(header).not.toBeNull();
      // Two children of the one panel, in the drawing's order, nothing between.
      expect(header.parentElement).toBe(panel);
      expect(island.parentElement).toBe(panel);
      expect(header.nextElementSibling).toBe(island);
      expect(panel.children).toHaveLength(2);

      // The header draws only the rule that separates it from the work
      // ("border-bottom:1px solid var(--line)") …
      expect(header.classList.contains("border-b")).toBe(true);
      expect(header.classList.contains("border-line")).toBe(true);
      expect(header.classList.contains("border")).toBe(false);
      expect(header.classList.contains("rounded-control")).toBe(false);
      // … inside the padding the header has always drawn ("padding:11px 14px" in
      // the drawing, the shipped `px-4 py-3`). Every class of the header is pinned.
      expect(header.classList.contains("px-4")).toBe(true);
      expect(header.classList.contains("py-3")).toBe(true);
      expect(header.className).toBe("border-b border-line px-4 py-3");
      // … and the island draws no border and no rounding of its own.
      expect(island.classList.contains("border")).toBe(false);
      expect(island.classList.contains("rounded-control")).toBe(false);
      // It keeps what it needs inside the panel: the box its skeleton and its
      // recovery panel are laid over, the clip, and the target's surface.
      expect(island.className).toBe("relative overflow-hidden bg-surface-strong");
    });
  }

  it("the SETTLED reading keeps the one panel: the header the decision was taken on, over the work", async () => {
    mockResolve({ state: "settled", outcome: "approved" }, { targetHeaders: [HEADER_ONE] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islandIn(container)).not.toBeNull());
    expect(panels(container)).toHaveLength(1);
    const panel = panels(container)[0] as HTMLElement;
    expect(panel.children).toHaveLength(2);
    expect(panel.children[0]!.getAttribute("data-conformance-id")).toBe("review-target-header");
    expect(panel.children[1]!.getAttribute("data-conformance-id")).toBe("review-target-island");
  });

  it("past the 12-second bound the header is still drawn in the panel, outside the island that failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResolve(PENDING, { targetHeaders: [HEADER_ONE] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islandIn(container)).not.toBeNull());
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const island = islandIn(container)!;
    expect(island.getAttribute("data-island-load-state")).toBe("timed-out");
    expect(panels(container)).toHaveLength(1);
    const header = panels(container)[0]!.querySelector('[data-conformance-id="review-target-header"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain(HEADER_ONE.title);
    expect(island.contains(header!)).toBe(false);
  });

  it("an answer that carried no header draws no panel: the island keeps its own frame, as before", async () => {
    mockResolve(PENDING);
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islandIn(container)).not.toBeNull());
    expect(panels(container)).toHaveLength(0);
    expect(islandIn(container)!.classList.contains("border")).toBe(true);
    expect(islandIn(container)!.classList.contains("rounded-control")).toBe(true);
  });

  it("a pending gate opened before one review per artifact that pins several draws this ONE panel per pinned target (cinatra#4129)", async () => {
    mockResolve(PENDING, { targetHeaders: [HEADER_ONE, HEADER_TWO] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islandIn(container)).not.toBeNull());
    const panelList = [...panels(container)] as HTMLElement[];
    expect(panelList).toHaveLength(2);
    expect(headers(container)).toHaveLength(2);
    expect(container.querySelectorAll('[data-conformance-id="review-target-island"]')).toHaveLength(2);
    panelList.forEach((panel, i) => {
      // The very panel a one-target gate draws, once per pinned target, in
      // pinned order: the frame, then the header, then that target's island.
      expect(panel.getAttribute("data-review-target-pair")).toBe(
        [HEADER_ONE.revisionId, HEADER_TWO.revisionId][i],
      );
      expect(panel.className).toBe("overflow-hidden rounded-control border border-line bg-surface-strong");
      expect(panel.children).toHaveLength(2);
      const [header, island] = [...panel.children] as HTMLElement[];
      expect(header!.getAttribute("data-conformance-id")).toBe("review-target-header");
      expect(header!.textContent).toContain([HEADER_ONE.title, HEADER_TWO.title][i]);
      expect(header!.className).toBe("border-b border-line px-4 py-3");
      expect(island!.getAttribute("data-conformance-id")).toBe("review-target-island");
      expect(island!.className).toBe("relative overflow-hidden bg-surface-strong");
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#3441 — the island is never mounted again when the header count moves
// ---------------------------------------------------------------------------
//
// The one panel stands round an answer that carries exactly ONE header, and a
// later answer for the SAME gate may carry another number: a header read that
// failed answers none, and a gate that still pins several may lose one it can
// no longer read. The island is a live frame — its load state, its bound, the
// height its document reported, the focus inside it and, on the widget, an
// address that is spent the moment it paints — so a re-render that moves the
// header count across one keeps the SAME island and the SAME iframe: only the
// classes round them change.

describe("cinatra#3441 — the island keeps its element when the header count crosses one", () => {
  const SRC = "/lifecycle/review-island?ref=ref-3441";
  const frameWith = (targetHeaders: readonly (typeof HEADER_ONE)[] | null) => (
    <LifecycleCardSurfaceProvider host="run_card">
      <ReviewTargetFrame
        headers={targetHeaders}
        islandSrc={SRC}
        islandCredentialed={false}
        onRetryResolve={() => undefined}
      />
    </LifecycleCardSurfaceProvider>
  );
  const islandIn = (root: ParentNode) =>
    root.querySelector('[data-conformance-id="review-target-island"]') as HTMLElement;

  it("one header, then none, then several, then one again: the same island and the same iframe throughout", () => {
    const { container, rerender } = render(frameWith([HEADER_ONE]));
    const island = islandIn(container);
    const iframe = island.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(island.parentElement!.hasAttribute("data-review-target-frame")).toBe(true);

    for (const next of [null, [HEADER_ONE, HEADER_TWO], [HEADER_ONE]]) {
      rerender(frameWith(next));
      expect(islandIn(container)).toBe(island);
      expect(island.querySelector("iframe")).toBe(iframe);
    }
    expect(island.parentElement!.hasAttribute("data-review-target-frame")).toBe(true);
  });

  it("an answer without exactly one header draws no box round the island: the element stands and draws nothing", () => {
    for (const targetHeaders of [null, [HEADER_ONE, HEADER_TWO]]) {
      const { container, unmount } = render(frameWith(targetHeaders));
      const island = islandIn(container);
      const holder = island.parentElement!;
      expect(holder.hasAttribute("data-review-target-frame")).toBe(false);
      // `display: contents`: the header(s) and the island sit in the card's own
      // column exactly as they did, each in its own frame.
      expect(holder.className).toBe("contents");
      expect(island.className).toBe(
        "relative overflow-hidden rounded-control border border-line bg-surface-strong",
      );
      expect(holder.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(
        targetHeaders ? targetHeaders.length : 0,
      );
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#4129 — a gate opened before reviews became one per artifact, and
// still pending, can pin several targets. The drawing pairs every target's
// header with its own representation slot (§IV: "Every target opens with a
// header that names what is under review … Beneath the header sits the
// representation slot"), so such a gate draws one target after another, each
// header directly above its own island, and keeps ONE decision floor below them.
// ---------------------------------------------------------------------------

describe("cinatra#4129 — a pending gate that pins several targets draws each header above its own body", () => {
  const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
  const PINNED = [HEADER_ONE.revisionId, HEADER_TWO.revisionId];
  const TITLES = [HEADER_ONE.title, HEADER_TWO.title];

  async function renderGate(
    host: "run_card" | "chat_thread" | "page_gate_region",
    state: LifecycleCardState = PENDING,
    headerList = [HEADER_ONE, HEADER_TWO],
  ) {
    mockResolve(state, { targetHeaders: headerList });
    const rendered = renderOn(host);
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    return rendered;
  }

  const revisionOf = (header: Element | null | undefined) =>
    header
      ?.querySelector("[data-review-target-revision]")
      ?.getAttribute("data-review-target-revision");

  it.each(["run_card", "chat_thread", "page_gate_region"] as const)(
    "pairs each header with its own island, in pinned order — %s",
    async (host) => {
      const { container } = await renderGate(host);
      const pairList = [...pairs(container)];
      expect(pairList).toHaveLength(2);
      expect(pairList.map((pair) => pair.getAttribute("data-review-target-pair"))).toEqual(PINNED);
      expect(
        pairList[0].compareDocumentPosition(pairList[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      pairList.forEach((pair, i) => {
        const children = [...pair.children];
        expect(children).toHaveLength(2);
        expect(children[0].getAttribute("data-conformance-id")).toBe("review-target-header");
        expect(revisionOf(children[0])).toBe(PINNED[i]);
        expect(children[1].getAttribute("data-conformance-id")).toBe("review-target-island");
      });
      for (const header of headers(container)) {
        expect(header.closest("[data-review-target-pair]"), "no header outside a pair").not.toBeNull();
      }
    },
  );

  it("each island frames only its own target", async () => {
    const { container } = await renderGate("run_card");
    const frames = [...container.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frameQuery(frame).get("target"))).toEqual(PINNED);
    expect(frames.map((frame) => frameQuery(frame).get("ref"))).toEqual(["ref-3141", "ref-3141"]);
  });

  it("every header is drawn while its own island is still loading", async () => {
    const { container } = await renderGate("run_card");
    const islandList = [...islands(container)];
    expect(islandList).toHaveLength(2);
    for (const island of islandList) {
      expect(island.getAttribute("data-island-load-state")).toBe("loading");
    }
    expect(headers(container)).toHaveLength(2);
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    pairList.forEach((pair, i) => {
      const header = pair.querySelector('[data-conformance-id="review-target-header"]');
      expect(header?.parentElement).toBe(pair);
      expect(header?.textContent).toContain(TITLES[i]);
      expect(pair.querySelector('[data-conformance-id="review-target-island"]')).toBe(islandList[i]);
    });
  });

  it("past the 12-second bound each header stays above its own failed body", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderGate("run_card");
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const islandList = [...islands(container)];
    expect(islandList).toHaveLength(2);
    for (const island of islandList) {
      expect(island.getAttribute("data-island-load-state")).toBe("timed-out");
      expect(
        island.querySelector('[data-conformance-id="review-target-island-timeout"]'),
        "the recovery affordance is in each body",
      ).not.toBeNull();
    }
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    pairList.forEach((pair, i) => {
      const header = pair.firstElementChild!;
      expect(header.getAttribute("data-conformance-id")).toBe("review-target-header");
      expect(header.textContent).toContain(TITLES[i]);
      for (const island of islandList) expect(island.contains(header)).toBe(false);
    });
  });

  it("a restricted reader of the same gate sees the same pairs", async () => {
    const { container } = await renderGate("run_card", {
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: "You can view this review but not respond to it.",
    });
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    expect(pairList.map((pair) => pair.getAttribute("data-review-target-pair"))).toEqual(PINNED);
    pairList.forEach((pair, i) => {
      expect(revisionOf(pair.firstElementChild)).toBe(PINNED[i]);
      expect(pair.lastElementChild?.getAttribute("data-conformance-id")).toBe("review-target-island");
    });
  });

  it("a gate that pins ONE target keeps its reading", async () => {
    const { container } = await renderGate("run_card", PENDING, [HEADER_ONE]);
    expect(pairs(container)).toHaveLength(0);
    expect(headers(container)).toHaveLength(1);
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frameQuery(frames[0]).has("target")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ONE IMPLEMENTATION ON EVERY HOST. The site widget is the same stream and the
  // same card as the chat thread, so it draws the same pairs. Only the TRANSPORT
  // of each frame differs, and it is read from the answer: a cookie host's answer
  // carries no credential, and the widget's answer carries one single-use
  // address per pinned target — one grant paints one document.
  // -------------------------------------------------------------------------

  /** The address the widget's answer carries for one target, as the route mints it. */
  const servedFor = (target: string, credential: string) =>
    `${REVIEW_TARGET_ISLAND_PATH}?${new URLSearchParams({ ref: VIEW.ref, ic: credential, target }).toString()}`;

  /** Answer the cookie host and the widget with their own answers to one gate. */
  function mockResolveByHost(cookie: Record<string, unknown>, widget: Record<string, unknown>) {
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const sent = (init?.headers ?? {}) as Record<string, string>;
      const extra = "X-Cinatra-Widget-User-Token" in sent ? widget : cookie;
      return new Response(
        JSON.stringify({ kind: "artifact_review_gate", state: PENDING, body: null, ...extra }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  }

  async function renderWidgetGate(extra: Record<string, unknown>) {
    mockResolve(PENDING, { targetHeaders: [HEADER_ONE, HEADER_TWO], ...extra });
    const rendered = renderOn("site_widget");
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    return rendered;
  }

  /** The pairs region, read the same way on every host — never the host frame's spacing. */
  const pairsRegion = (root: ParentNode) =>
    [...pairs(root)].map((pair) => {
      const [header, island] = [...pair.children];
      const frame = island?.querySelector("iframe");
      return {
        pair: pair.getAttribute("data-review-target-pair"),
        children: [...pair.children].map((child) => child.getAttribute("data-conformance-id")),
        revision: revisionOf(header),
        title: header?.querySelector("span")?.textContent,
        loadState: island?.getAttribute("data-island-load-state"),
        target: frameQuery(frame).get("target"),
        ref: frameQuery(frame).get("ref"),
      };
    });

  const timedOutWithPlateAndNoFrame = (island: Element | undefined) => {
    expect(island?.getAttribute("data-conformance-id")).toBe("review-target-island");
    expect(island?.getAttribute("data-island-load-state")).toBe("timed-out");
    expect(
      island?.querySelector('[data-conformance-id="review-target-island-timeout"]')?.textContent,
    ).toContain("The preview did not load");
    expect(island?.querySelector("iframe"), "a refused pair mounts no frame").toBeNull();
  };

  it("the site widget draws the SAME pairs as a cookie host", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const map = {
      [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, "ic-one"),
      [HEADER_TWO.revisionId]: servedFor(HEADER_TWO.revisionId, "ic-two"),
    };
    mockResolveByHost(
      { targetHeaders: [HEADER_ONE, HEADER_TWO] },
      { targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrcByRevision: map },
    );
    const cookie = renderOn("chat_thread");
    const widget = renderOn("site_widget");
    for (const { container } of [cookie, widget]) {
      await waitFor(() => expect(pairs(container)).toHaveLength(2));
    }

    const drawn = pairsRegion(cookie.container);
    expect(drawn).toEqual(
      [HEADER_ONE, HEADER_TWO].map((header) => ({
        pair: header.revisionId,
        children: ["review-target-header", "review-target-island"],
        revision: header.revisionId,
        title: header.title,
        loadState: "loading",
        target: header.revisionId,
        ref: VIEW.ref,
      })),
    );
    expect(pairsRegion(widget.container), "the widget draws the cookie host's pairs").toEqual(drawn);

    // Only the transport differs, and it is the answer's: each widget frame
    // carries the credential of its OWN revision's entry; a cookie frame none.
    const widgetFrames = [...widget.container.querySelectorAll("[data-review-target-pair] iframe")];
    expect(widgetFrames.map((frame) => frameQuery(frame).get("ic"))).toEqual(["ic-one", "ic-two"]);
    const cookieFrames = [...cookie.container.querySelectorAll("[data-review-target-pair] iframe")];
    expect(cookieFrames).toHaveLength(2);
    for (const frame of cookieFrames) expect(frameQuery(frame).has("ic")).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    for (const { container } of [cookie, widget]) {
      const islandList = [...islands(container)];
      expect(islandList).toHaveLength(2);
      for (const island of islandList) {
        expect(island.getAttribute("data-island-load-state")).toBe("timed-out");
        expect(
          island.querySelector('[data-conformance-id="review-target-island-timeout"]'),
        ).not.toBeNull();
      }
      for (const header of headers(container)) {
        for (const island of islandList) expect(island.contains(header)).toBe(false);
      }
    }
    expect(pairsRegion(widget.container).map((pair) => pair.loadState)).toEqual([
      "timed-out",
      "timed-out",
    ]);
    expect(pairsRegion(widget.container)).toEqual(pairsRegion(cookie.container));
  });

  it("each widget pair frames its OWN single-use address", async () => {
    const { container } = await renderWidgetGate({
      islandSrcByRevision: {
        [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, "ic-one"),
        [HEADER_TWO.revisionId]: servedFor(HEADER_TWO.revisionId, "ic-two"),
      },
    });
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    const frames = pairList.map((pair) => pair.querySelector("iframe"));
    expect(frames.map((frame) => frameQuery(frame).get("ic"))).toEqual(["ic-one", "ic-two"]);
    expect(frames.map((frame) => frameQuery(frame).get("target"))).toEqual([
      HEADER_ONE.revisionId,
      HEADER_TWO.revisionId,
    ]);
    // A perishable bearer cannot wait for a scroll, on every pair.
    expect(frames.map((frame) => frame?.getAttribute("loading"))).toEqual(["eager", "eager"]);
  });

  it("a target whose address failed draws its failed body, never another target's", async () => {
    for (const second of [
      // The mint failed for this target.
      null,
      // An address bound to the OTHER target.
      servedFor(HEADER_ONE.revisionId, "ic-two"),
    ]) {
      const { container, unmount } = await renderWidgetGate({
        islandSrcByRevision: {
          [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, "ic-one"),
          [HEADER_TWO.revisionId]: second,
        },
      });
      const pairList = [...pairs(container)];
      expect(pairList).toHaveLength(2);
      expect(pairList.map((pair) => pair.getAttribute("data-review-target-pair"))).toEqual(PINNED);
      // The first target is framed at its own address.
      const firstFrame = pairList[0].querySelector("iframe");
      expect(frameQuery(firstFrame).get("ic")).toBe("ic-one");
      expect(frameQuery(firstFrame).get("target")).toBe(HEADER_ONE.revisionId);
      // The second keeps its header and draws its own failed body, with no frame.
      expect(revisionOf(pairList[1].firstElementChild)).toBe(HEADER_TWO.revisionId);
      timedOutWithPlateAndNoFrame(pairList[1].lastElementChild ?? undefined);
      expect(container.querySelectorAll("iframe")).toHaveLength(1);
      unmount();
    }
  });

  it("a single credential is never shared between pairs", async () => {
    const { container } = await renderWidgetGate({
      islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=ref-3141&ic=ic-placeholder`,
    });
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    expect(pairList.map((pair) => pair.getAttribute("data-review-target-pair"))).toEqual(PINNED);
    for (const pair of pairList) timedOutWithPlateAndNoFrame(pair.lastElementChild ?? undefined);
    for (const frame of container.querySelectorAll("iframe")) {
      expect(frameQuery(frame).get("ic")).not.toBe("ic-placeholder");
    }
  });

  it("a fresh answer gives every target a fresh grant", async () => {
    /** The palette class the app writes on a document root for each scheme. */
    const paintHost = (scheme: "light" | "dark" | "none") => {
      document.documentElement.className =
        scheme === "none" ? "" : scheme === "dark" ? "dark" : "cinatra";
    };
    const mapOf = (one: string, two: string) => ({
      targetHeaders: [HEADER_ONE, HEADER_TWO],
      islandSrcByRevision: {
        [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, one),
        [HEADER_TWO.revisionId]: servedFor(HEADER_TWO.revisionId, two),
      },
    });
    /** Answer each successive resolve with the next answer in the list. */
    const mockResolveSequence = (answers: Array<Record<string, unknown>>) => {
      let call = 0;
      const fetchMock = vi.fn(async () => {
        const extra = answers[Math.min(call, answers.length - 1)];
        call += 1;
        return new Response(
          JSON.stringify({ kind: "artifact_review_gate", state: PENDING, body: null, ...extra }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    };
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    };
    const queryOfSrc = (src: string) => new URLSearchParams(src.slice(src.indexOf("?") + 1));
    const framedAt = (root: ParentNode) =>
      [...pairs(root)].map((pair) => {
        const query = frameQuery(pair.querySelector("iframe"));
        return { ic: query.get("ic"), scheme: query.get("scheme"), target: query.get("target") };
      });
    const firstGrants = [
      { ic: "grant-one-a", scheme: "light", target: HEADER_ONE.revisionId },
      { ic: "grant-one-b", scheme: "light", target: HEADER_TWO.revisionId },
    ];

    try {
      // A repaint with a held set asks ONCE for a fresh answer, and the fresh
      // answer's grants — one per target — replace both frames' addresses.
      const fetchMock = mockResolveSequence([
        mapOf("grant-one-a", "grant-one-b"),
        mapOf("grant-two-a", "grant-two-b"),
      ]);
      paintHost("light");
      const fresh = renderOn("site_widget");
      await settle();
      expect(framedAt(fresh.container)).toEqual(firstGrants);

      // EVERY address a frame is ever handed, not just the one it settles on:
      // one committed render pairing a spent grant with the new palette is the
      // defect this guards.
      const seen = new Set<string>();
      const record = () => {
        for (const frame of fresh.container.querySelectorAll("iframe")) {
          seen.add(frame.getAttribute("src") ?? "");
        }
      };
      record();
      const observer = new MutationObserver(record);
      observer.observe(fresh.container, {
        attributes: true,
        attributeFilter: ["src"],
        subtree: true,
        childList: true,
      });
      await act(async () => {
        paintHost("dark");
      });
      await settle();
      await settle();
      record();
      observer.disconnect();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const replayed = [...seen].filter(
        (src) =>
          (queryOfSrc(src).get("ic") ?? "").startsWith("grant-one") &&
          queryOfSrc(src).get("scheme") === "dark",
      );
      expect(replayed, `a spent grant replayed in a new palette: ${[...seen].join(" | ")}`).toEqual([]);
      expect(framedAt(fresh.container)).toEqual([
        { ic: "grant-two-a", scheme: "dark", target: HEADER_ONE.revisionId },
        { ic: "grant-two-b", scheme: "dark", target: HEADER_TWO.revisionId },
      ]);
      fresh.unmount();

      // An answer that carries no credential leaves both held addresses whole.
      paintHost("light");
      mockResolveSequence([mapOf("grant-one-a", "grant-one-b"), { targetHeaders: [HEADER_ONE, HEADER_TWO] }]);
      const held = renderOn("site_widget");
      await settle();
      expect(framedAt(held.container)).toEqual(firstGrants);
      await act(async () => {
        paintHost("dark");
      });
      await settle();
      await settle();
      expect(framedAt(held.container)).toEqual(firstGrants);
    } finally {
      paintHost("none");
    }
  });

  it("a SETTLED gate that pins several keeps its reading", async () => {
    mockResolve({ state: "settled", outcome: "approved" }, { targetHeaders: [HEADER_ONE, HEADER_TWO] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(headers(container)).toHaveLength(2));
    expect(pairs(container)).toHaveLength(0);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });
});
