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
import { ReviewGateCard, ReviewTargetFrame } from "../review-gate-card";

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

  it("EXACTLY ONE header per pinned target, on a gate carrying several", async () => {
    const { container } = await renderPending("run_card", [HEADER_ONE, HEADER_TWO]);
    expect(headers(container)).toHaveLength(2);
    const revisions = [...headers(container)].map((h) =>
      h.querySelector("[data-review-target-revision]")?.getAttribute("data-review-target-revision"),
    );
    expect(revisions).toEqual([HEADER_ONE.revisionId, HEADER_TWO.revisionId]);
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

  it("a gate opened before one review per artifact that pins several keeps today's reading (cinatra#3356)", async () => {
    mockResolve(PENDING, { targetHeaders: [HEADER_ONE, HEADER_TWO] });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islandIn(container)).not.toBeNull());
    expect(panels(container)).toHaveLength(0);
    expect(headers(container)).toHaveLength(2);
    for (const h of headers(container)) expect(h.classList.contains("rounded-control")).toBe(true);
    expect(islandIn(container)!.classList.contains("rounded-control")).toBe(true);
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
