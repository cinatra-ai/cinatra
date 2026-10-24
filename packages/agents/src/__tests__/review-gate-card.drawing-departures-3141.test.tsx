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

import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import {
  REVIEW_TARGET_ISLAND_PATH,
  ReviewGateCard,
  ReviewTargetFrame,
  ReviewTargetHeaders,
} from "../review-gate-card";

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
const HEADER_THREE = {
  title: "Q3 send plan",
  typeLabel: "Document",
  objectType: "@cinatra-ai/doc:brief",
  revisionId: "rev_99aabbccddeeff",
  facts: ["team", "private", "text/markdown", "updated 1 minute ago"],
};

/**
 * THE ANSWER AS THE ROUTE SENDS IT: beside every header list the route says
 * whether those headers are complete. An answer in this suite is complete
 * unless the case says otherwise by carrying `targetHeadersComplete` itself.
 */
function served<T>(body: T): T {
  if (typeof body !== "object" || body === null) return body;
  const record = body as Record<string, unknown>;
  return Array.isArray(record.targetHeaders) && !("targetHeadersComplete" in record)
    ? ({ ...record, targetHeadersComplete: true } as T)
    : body;
}

function mockResolve(
  state: LifecycleCardState,
  extra: Record<string, unknown> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(served({ kind: "artifact_review_gate", state, body: null, ...extra })), {
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
/** The revision a pair names, read off its own header: the pair element only
 *  marks a pair (an empty attribute) and carries no identity of its own. */
const pairRevision = (pair: Element) =>
  pair
    .querySelector('[data-conformance-id="review-target-header"] [data-review-target-revision]')
    ?.getAttribute("data-review-target-revision") ?? null;
/** Every pair's marker: present and EMPTY, never a revision id. */
const pairMarkers = (pairList: readonly Element[]) =>
  pairList.map((pair) => pair.getAttribute("data-review-target-pair"));
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
      expect(panel.getAttribute("data-review-target-pair")).toBe("");
      expect(pairRevision(panel)).toBe([HEADER_ONE.revisionId, HEADER_TWO.revisionId][i]);
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
// classes round them change. These readings pin `ReviewTargetFrame` itself, the
// one element of every reading that draws one island (the settled reading, and
// an answer with no header or one). A pending or restricted gate whose answer
// names several targets is drawn as pairs instead (cinatra#4129, below): one
// island per target, each keeping its own frame for as long as its revision
// stays among the headers in the order it had.

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
      expect(pairList.map(pairRevision)).toEqual(PINNED);
      expect(pairMarkers(pairList)).toEqual(["", ""]);
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
    expect(pairList.map(pairRevision)).toEqual(PINNED);
    expect(pairMarkers(pairList)).toEqual(["", ""]);
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
  // PAIRS ONLY OVER COMPLETE HEADERS. The route stops the headers at their
  // bound of twelve and may carry an id inexactly, so a list of headers is not
  // complete by itself; the answer says whether it is. A target this reader
  // cannot read has no header and makes the headers not complete. An answer whose
  // headers are NOT complete keeps the gate's ONE aggregate island, which
  // renders every pinned target, at the gate's own address — on a cookie host
  // the reader's cookie, on the widget the one gate-wide grant the route
  // minted — and never pairs that would drop every target they do not name
  // from under the gate's one decision.
  // -------------------------------------------------------------------------

  const RESTRICTED_READER: LifecycleCardState = {
    state: "restricted",
    canDecide: false,
    canComment: false,
    reason: "You can view this review but not respond to it.",
  };
  /** Twelve headers — the bound — of a gate that pins sixteen. */
  const BOUND_HEADERS = Array.from({ length: 12 }, (_, i) => ({
    ...HEADER_TWO,
    title: `Pinned target ${i + 1}`,
    revisionId: `rev_bound_${String(i + 1).padStart(2, "0")}`,
  }));
  /** The gate-wide address the route mints for a widget reader of the one island. */
  const gateServed = (credential: string) =>
    `${REVIEW_TARGET_ISLAND_PATH}?${new URLSearchParams({ ref: VIEW.ref, ic: credential }).toString()}`;

  /** The aggregate reading: every header over ONE island at the gate's own
   *  address, no pair, no one-target panel. Returns that island's frame. */
  const aggregateDrawn = (container: HTMLElement, headerList: readonly { revisionId: string }[]) => {
    expect(pairs(container)).toHaveLength(0);
    expect(container.querySelectorAll("[data-review-target-frame]")).toHaveLength(0);
    expect([...headers(container)].map(revisionOf)).toEqual(headerList.map((h) => h.revisionId));
    const islandList = [...islands(container)];
    expect(islandList).toHaveLength(1);
    for (const header of headers(container)) expect(islandList[0].contains(header)).toBe(false);
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frameQuery(frames[0]).get("ref")).toBe(VIEW.ref);
    expect(frameQuery(frames[0]).has("target"), "the one island addresses the whole gate").toBe(false);
    return frames[0];
  };

  for (const [name, headerList] of [
    ["a gate whose two headers the answer says are not complete", [HEADER_ONE, HEADER_TWO]],
    ["a gate that pins SIXTEEN targets, its headers cut at the bound of twelve", BOUND_HEADERS],
  ] as const) {
    it(`${name}: a cookie host draws the ONE aggregate island at the gate's own address`, async () => {
      for (const state of [PENDING, RESTRICTED_READER]) {
        mockResolve(state, { targetHeaders: headerList, targetHeadersComplete: false });
        const { container, unmount } = renderOn("run_card");
        await waitFor(() =>
          expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
        );
        const frame = aggregateDrawn(container, headerList);
        expect(frameQuery(frame).has("ic")).toBe(false);
        unmount();
      }
    });

    it(`${name}: the site widget frames the gate-wide grant in the ONE aggregate island`, async () => {
      mockResolve(PENDING, {
        targetHeaders: headerList,
        targetHeadersComplete: false,
        islandSrc: gateServed("ic-gate"),
      });
      const { container } = renderOn("site_widget");
      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
      const frame = aggregateDrawn(container, headerList);
      expect(frameQuery(frame).get("ic"), "the grant the route minted for the gate is framed").toBe("ic-gate");
      expect(
        container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
        "no island is refused",
      ).toBeNull();
    });
  }

  // ONE HEADER IS ONE PANEL, AS IT ALWAYS WAS. Whether the headers are complete
  // decides the pairs alone; an answer with one header is never drawn as pairs,
  // so it keeps the one-target panel on every reading of the flag, pending or
  // settled.
  /** Answer with one header, saying `complete` beside it, or saying nothing. */
  const answerOneHeader = (state: LifecycleCardState, complete: boolean | "absent") => {
    const body: Record<string, unknown> = { kind: "artifact_review_gate", state, body: null, targetHeaders: [HEADER_ONE] };
    if (complete !== "absent") body.targetHeadersComplete = complete;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
  };
  /** The one-target panel: its frame holds the header, then the island. */
  const onePanelDrawn = (container: HTMLElement) => {
    expect(pairs(container)).toHaveLength(0);
    const panelList = container.querySelectorAll("[data-review-target-frame]");
    expect(panelList).toHaveLength(1);
    const panel = panelList[0] as HTMLElement;
    expect(panel.className).toBe("overflow-hidden rounded-control border border-line bg-surface-strong");
    expect([...panel.children].map((child) => child.getAttribute("data-conformance-id"))).toEqual([
      "review-target-header",
      "review-target-island",
    ]);
    expect(panel.children[0]!.textContent).toContain(HEADER_ONE.title);
    expect(islands(container)).toHaveLength(1);
    expect(islands(container)[0].className).toBe("relative overflow-hidden bg-surface-strong");
  };

  for (const complete of [false, "absent"] as const) {
    const said = complete === "absent" ? "says nothing of whether its headers are complete" : "says its headers are not complete";
    it(`a pending gate whose answer carries ONE header and ${said} draws the one panel`, async () => {
      answerOneHeader(PENDING, complete);
      const { container } = renderOn("run_card");
      await waitFor(() => expect(islands(container)).toHaveLength(1));
      onePanelDrawn(container);
    });

    it(`a settled gate whose answer carries ONE header and ${said} draws the one panel`, async () => {
      answerOneHeader({ state: "settled", outcome: "approved" }, complete);
      const { container } = renderOn("run_card");
      await waitFor(() => expect(islands(container)).toHaveLength(1));
      onePanelDrawn(container);
    });
  }

  it("an answer that does not say its headers are complete is never drawn as pairs", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ kind: "artifact_review_gate", state: PENDING, body: null, targetHeaders: [HEADER_ONE, HEADER_TWO] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const { container } = renderOn("run_card");
    await waitFor(() => expect(islands(container)).toHaveLength(1));
    aggregateDrawn(container, [HEADER_ONE, HEADER_TWO]);
  });

  // EACH PAIR'S SELECTOR NAMES ITS OWN TARGET ALONE: a pair's island is selected
  // by its revision id, so a WHOLE pinned set whose revision ids are not
  // distinct, or not within the per-target key bound, keeps the ONE aggregate
  // island on every host — on the widget at the one gate-wide grant.
  /** Two headers whose revision ids are `length` characters long and differ. */
  const keyedHeaders = (length: number) => [
    { ...HEADER_ONE, revisionId: `a${"7".repeat(length - 1)}` },
    { ...HEADER_TWO, revisionId: `b${"7".repeat(length - 1)}` },
  ];
  for (const [name, selectorHeaders] of [
    [
      "two pinned targets of different artifacts that share ONE revision id",
      [HEADER_ONE, { ...HEADER_TWO, revisionId: HEADER_ONE.revisionId }],
    ],
    ["revision ids one character past the per-target key bound (129)", keyedHeaders(129)],
    ["revision ids AT the header's 200-character bound, past the per-target key bound (128)", keyedHeaders(200)],
  ] as const) {
    it(`${name}: a WHOLE pinned set keeps the ONE aggregate island on a cookie host and on the widget`, async () => {
      mockResolve(PENDING, { targetHeaders: selectorHeaders, targetHeadersComplete: true });
      const cookie = renderOn("run_card");
      await waitFor(() => expect(islands(cookie.container)).toHaveLength(1));
      aggregateDrawn(cookie.container, selectorHeaders);
      cookie.unmount();

      mockResolve(PENDING, {
        targetHeaders: selectorHeaders,
        targetHeadersComplete: true,
        islandSrc: gateServed("ic-gate"),
      });
      const widget = renderOn("site_widget");
      await waitFor(() => expect(widget.container.querySelectorAll("iframe")).toHaveLength(1));
      const frame = aggregateDrawn(widget.container, selectorHeaders);
      expect(frameQuery(frame).get("ic"), "the one gate-wide grant, framed once").toBe("ic-gate");
    });
  }

  it("revision ids AT the per-target key bound (128) are still drawn as pairs", async () => {
    const atBound = keyedHeaders(128);
    mockResolve(PENDING, { targetHeaders: atBound, targetHeadersComplete: true });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(pairs(container)).toHaveLength(2));
    expect([...pairs(container)].map(pairRevision)).toEqual(atBound.map((h) => h.revisionId));
    expect(pairMarkers([...pairs(container)])).toEqual(["", ""]);
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
        JSON.stringify(served({ kind: "artifact_review_gate", state: PENDING, body: null, ...extra })),
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
        pair: "",
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
      const headerList = [...headers(container)];
      expect(headerList).toHaveLength(2);
      for (const header of headerList) {
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
      expect(pairList.map(pairRevision)).toEqual(PINNED);
      expect(pairMarkers(pairList)).toEqual(["", ""]);
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

  // THE ROUTE'S OVER-BUDGET FALLBACK, AT THE READER (cinatra#4129). When a
  // per-target address would not fit, or could not carry its target, the route
  // answers the gate-wide grant alone and no per-target map. A single-use grant
  // paints ONE document, so the card draws the gate's ONE aggregate island on
  // that grant, which renders every pinned target: never pairs that all fail,
  // and never one grant shared between frames.
  it("a gate-wide grant with no per-target addresses draws the ONE aggregate island on that grant", async () => {
    const { container } = await renderWidgetGate({
      islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=ref-3141&ic=ic-placeholder`,
    });
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    const frame = aggregateDrawn(container, [HEADER_ONE, HEADER_TWO]);
    expect(frameQuery(frame).get("ic"), "the gate-wide grant, framed once").toBe("ic-placeholder");
    expect(
      container.querySelector('[data-conformance-id="review-target-island-timeout"]'),
      "no pair is drawn failed",
    ).toBeNull();
  });

  // THE FINAL ADDRESS IS BOUNDED WHERE THE CARD COMPOSES IT (cinatra#4129). The
  // route proves only the address it mints; a widget card adds its own frame
  // selectors, so an answer that fit the route's bound can compose a longer
  // frame address. At 2048 characters the frame is mounted; one past it, the
  // island the address was for draws its failed state and frames nothing, and
  // every other island is untouched.
  describe("the composed frame address is bounded at 2048 characters", () => {
    const FRAMED_WIDGET = { assistant: "wordpress", instanceId: "inst-1" };
    async function renderFramedWidget(extra: Record<string, unknown>) {
      mockResolve(PENDING, { targetHeaders: [HEADER_ONE, HEADER_TWO], ...extra });
      const rendered = render(
        <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAMED_WIDGET}>
          <ReviewGateCard view={VIEW} runId="run-3141" />
        </LifecycleCardSurfaceProvider>,
      );
      await waitFor(() =>
        expect(
          rendered.container.querySelector('[data-conformance-id="review-decision-bar"]'),
        ).not.toBeNull(),
      );
      return rendered;
    }
    /** The credential that makes the frame address `probeLength` + n − 1 long
     *  reach exactly 2048 characters. */
    const fitting = (probeSrc: string | null | undefined) =>
      "c".repeat(2048 - ((probeSrc ?? "").length - 1));

    it("a pair: 2048 is framed, 2049 is refused for that pair alone (the answer itself fits)", async () => {
      const mapOf = (first: string) => ({
        [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, first),
        [HEADER_TWO.revisionId]: servedFor(HEADER_TWO.revisionId, "ic-two"),
      });
      const probe = await renderFramedWidget({ islandSrcByRevision: mapOf("c") });
      const probeSrc = pairs(probe.container)[0]?.querySelector("iframe")?.getAttribute("src");
      expect(frameQuery(pairs(probe.container)[0]?.querySelector("iframe")).get("assistant")).toBe("wordpress");
      const fits = fitting(probeSrc);
      probe.unmount();

      const at = await renderFramedWidget({ islandSrcByRevision: mapOf(fits) });
      expect(pairs(at.container)[0]?.querySelector("iframe")?.getAttribute("src")).toHaveLength(2048);
      at.unmount();

      expect(servedFor(HEADER_ONE.revisionId, `${fits}c`).length).toBeLessThanOrEqual(2048);
      const past = await renderFramedWidget({ islandSrcByRevision: mapOf(`${fits}c`) });
      const pairList = [...pairs(past.container)];
      expect(pairList).toHaveLength(2);
      timedOutWithPlateAndNoFrame(pairList[0].lastElementChild ?? undefined);
      expect(frameQuery(pairList[1].querySelector("iframe")).get("ic")).toBe("ic-two");
      for (const frame of past.container.querySelectorAll("iframe")) {
        expect(frame.getAttribute("src")!.length).toBeLessThanOrEqual(2048);
      }
    });

    it("the ONE aggregate island: 2048 is framed, 2049 draws its failed state and frames nothing", async () => {
      const probe = await renderFramedWidget({ islandSrc: gateServed("c") });
      await waitFor(() => expect(probe.container.querySelectorAll("iframe")).toHaveLength(1));
      const fits = fitting(probe.container.querySelector("iframe")?.getAttribute("src"));
      probe.unmount();

      const at = await renderFramedWidget({ islandSrc: gateServed(fits) });
      await waitFor(() => expect(at.container.querySelectorAll("iframe")).toHaveLength(1));
      expect(aggregateDrawn(at.container, [HEADER_ONE, HEADER_TWO]).getAttribute("src")).toHaveLength(2048);
      at.unmount();

      expect(gateServed(`${fits}c`).length).toBeLessThanOrEqual(2048);
      const past = await renderFramedWidget({ islandSrc: gateServed(`${fits}c`) });
      expect(pairs(past.container)).toHaveLength(0);
      expect([...headers(past.container)].map(revisionOf)).toEqual(PINNED);
      const islandList = [...islands(past.container)];
      expect(islandList).toHaveLength(1);
      timedOutWithPlateAndNoFrame(islandList[0]);
      expect(past.container.querySelectorAll("iframe")).toHaveLength(0);
    });
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
          JSON.stringify(served({ kind: "artifact_review_gate", state: PENDING, body: null, ...extra })),
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

  // -------------------------------------------------------------------------
  // A GATE SETTLED ON THIS CARD. A decision taken here settles the card before
  // the settled answer arrives, and the settled reading draws the gate as ONE
  // island. The widget's held set addresses each pinned target on its own and
  // carries no address for the gate, so that island frames nothing - and never
  // the cookie address - until the settled answer's own grant is adopted. A gate
  // with one target, and every cookie host, settle exactly as before.
  // -------------------------------------------------------------------------

  const SETTLED: LifecycleCardState = { state: "settled", outcome: "approved" };
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(served(body)), { status, headers: { "Content-Type": "application/json" } });
  /** The gate-wide address the route mints for a widget reader of one island. */
  const servedForGate = (credential: string) =>
    `${REVIEW_TARGET_ISLAND_PATH}?${new URLSearchParams({ ref: VIEW.ref, ic: credential }).toString()}`;
  const pairedMap = () => ({
    [HEADER_ONE.revisionId]: servedFor(HEADER_ONE.revisionId, "ic-one"),
    [HEADER_TWO.revisionId]: servedFor(HEADER_TWO.revisionId, "ic-two"),
  });
  const settledAnswer = (extra: Record<string, unknown>) =>
    respond({ kind: "artifact_review_gate", state: SETTLED, body: null, ...extra });

  /** The first resolve answers `first`; every later one is `later()`; the
   *  decision itself lands as a committed approve. */
  function mockDecision(first: Record<string, unknown>, later: () => Promise<Response>) {
    let resolves = 0;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/decide") && init?.method === "POST") {
        return respond({ outcome: { kind: "decided", disposition: "approve", idempotent: false } });
      }
      resolves += 1;
      return resolves === 1
        ? respond({ kind: "artifact_review_gate", state: PENDING, body: null, ...first })
        : later();
    }) as unknown as typeof fetch;
    return { resolves: () => resolves };
  }

  /** Every address a frame inside `root` is handed from now on, read from the
   *  mutation records themselves, so a frame mounted and dropped again between
   *  two reads is counted too. */
  function watchFrameAddresses(root: HTMLElement) {
    const seen: string[] = [];
    const note = (node: Node) => {
      if (!(node instanceof Element)) return;
      const frames = node.tagName === "IFRAME" ? [node] : [...node.querySelectorAll("iframe")];
      for (const frame of frames) seen.push(frame.getAttribute("src") ?? "");
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") note(record.target);
        for (const added of record.addedNodes) note(added);
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["src"], subtree: true, childList: true });
    return {
      seen,
      stop: () => {
        for (const record of observer.takeRecords()) {
          if (record.type === "attributes") note(record.target);
          for (const added of record.addedNodes) note(added);
        }
        observer.disconnect();
      },
    };
  }

  const settledMarker = (root: ParentNode) =>
    root.querySelector('[data-conformance-id="review-gate-settled"]');

  it("a widget gate that pins several, settled here, frames nothing until the settled answer's own grant", async () => {
    let answer!: (response: Response) => void;
    const pendingAnswer = new Promise<Response>((done) => {
      answer = done;
    });
    const { resolves } = mockDecision(
      { targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrcByRevision: pairedMap() },
      () => pendingAnswer,
    );
    const { container } = renderOn("site_widget");
    await waitFor(() => expect(pairs(container)).toHaveLength(2));
    const addresses = watchFrameAddresses(container);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves()).toBe(2));
    await waitFor(() => expect(settledMarker(container)).not.toBeNull());

    // Settled here, the settled answer still outstanding: the ONE island draws
    // its loading state under the headers, and no frame stands anywhere.
    expect(pairs(container)).toHaveLength(0);
    expect(headers(container)).toHaveLength(2);
    const waiting = [...islands(container)];
    expect(waiting).toHaveLength(1);
    expect(waiting[0].getAttribute("data-island-load-state")).toBe("loading");
    expect(waiting[0].querySelector('[data-conformance-id="review-target-island-skeleton"]')).not.toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(0);

    await act(async () => {
      answer(settledAnswer({ targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrc: servedForGate("ic-settled") }));
    });
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    addresses.stop();

    // Adopted: exactly one frame, at the settled answer's own grant, for the gate.
    const framed = frameQuery(container.querySelector("iframe"));
    expect(framed.get("ic")).toBe("ic-settled");
    expect(framed.get("ref")).toBe(VIEW.ref);
    expect(framed.has("target")).toBe(false);
    expect(container.querySelector("iframe")?.getAttribute("loading")).toBe("eager");
    // From the press on, no frame was ever handed another address: never the
    // cookie address, never a spent per-target grant.
    expect(addresses.seen.length).toBeGreaterThan(0);
    for (const src of addresses.seen) {
      expect(new URLSearchParams(src.slice(src.indexOf("?") + 1)).get("ic"), src).toBe("ic-settled");
    }
  });

  it("a widget gate that pins several, settled here, draws its failed body with no frame when the settled answer fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let later: () => Promise<Response> = async () => respond({ error: "unavailable" }, 503);
    const { resolves } = mockDecision(
      { targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrcByRevision: pairedMap() },
      () => later(),
    );
    const { container } = renderOn("site_widget");
    await waitFor(() => expect(pairs(container)).toHaveLength(2));
    const addresses = watchFrameAddresses(container);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves()).toBe(2));
    await waitFor(() => expect(settledMarker(container)).not.toBeNull());
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });

    // The settled answer never came: the one island draws its failed body under
    // the headers and frames nothing.
    const failed = [...islands(container)];
    expect(failed).toHaveLength(1);
    timedOutWithPlateAndNoFrame(failed[0]);
    expect(headers(container)).toHaveLength(2);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);

    // Its retry re-resolves, and the answer's own grant is framed once.
    later = async () =>
      settledAnswer({ targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrc: servedForGate("ic-retried") });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(resolves()).toBe(3));
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    addresses.stop();
    expect(frameQuery(container.querySelector("iframe")).get("ic")).toBe("ic-retried");
    expect(addresses.seen.length).toBeGreaterThan(0);
    for (const src of addresses.seen) {
      expect(new URLSearchParams(src.slice(src.indexOf("?") + 1)).get("ic"), src).toBe("ic-retried");
    }
  });

  it("a widget gate that pins ONE target keeps its painted island across a settle here", async () => {
    let answer!: (response: Response) => void;
    const pendingAnswer = new Promise<Response>((done) => {
      answer = done;
    });
    const { resolves } = mockDecision(
      { targetHeaders: [HEADER_ONE], islandSrc: servedForGate("ic-gate") },
      () => pendingAnswer,
    );
    const { container } = renderOn("site_widget");
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    const painted = container.querySelector("iframe")!;
    expect(frameQuery(painted).get("ic")).toBe("ic-gate");

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves()).toBe(2));
    await waitFor(() => expect(settledMarker(container)).not.toBeNull());
    // The same frame, at the same grant, through the settle.
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")).toBe(painted);
    expect(frameQuery(painted).get("ic")).toBe("ic-gate");

    await act(async () => {
      answer(settledAnswer({ targetHeaders: [HEADER_ONE], islandSrc: servedForGate("ic-settled") }));
    });
    await waitFor(() =>
      expect(frameQuery(container.querySelector("iframe")).get("ic")).toBe("ic-settled"),
    );
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("a cookie host's gate that pins several, settled here, frames the gate's own cookie address at once", async () => {
    let answer!: (response: Response) => void;
    const pendingAnswer = new Promise<Response>((done) => {
      answer = done;
    });
    const { resolves } = mockDecision({ targetHeaders: [HEADER_ONE, HEADER_TWO] }, () => pendingAnswer);
    const { container } = renderOn("run_card");
    await waitFor(() => expect(pairs(container)).toHaveLength(2));

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves()).toBe(2));
    await waitFor(() => expect(settledMarker(container)).not.toBeNull());
    // The settled reading's one island, at the reader's cookie, before any answer.
    expect(pairs(container)).toHaveLength(0);
    expect(headers(container)).toHaveLength(2);
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const query = frameQuery(frames[0]);
    expect(query.get("ref")).toBe(VIEW.ref);
    expect(query.has("ic")).toBe(false);
    expect(query.has("target")).toBe(false);
    expect(frames[0].getAttribute("loading")).toBe("lazy");

    await act(async () => {
      answer(settledAnswer({ targetHeaders: [HEADER_ONE, HEADER_TWO] }));
    });
    await waitFor(() => expect(resolves()).toBe(2));
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")).toBe(frames[0]);
  });

  // -------------------------------------------------------------------------
  // EVERY MINT FAILED. A widget answer whose per-target mints all failed holds
  // a set with no grant in it. A decision taken here settles the card, and a
  // settled answer whose own mint failed as well brings neither a grant nor a
  // set: the one island goes on awaiting the gate's own grant and frames
  // nothing, never the cookie address, until an answer brings that grant. A
  // cookie host's answers carry no set, so there the same sequence frames the
  // gate's own cookie address at once, and a repaint lands at once.
  // -------------------------------------------------------------------------

  /** The second header as a later answer composes it: its relative fact has moved on. */
  const LATER_FACT = "updated 4 minutes ago";
  const HEADER_TWO_LATER = { ...HEADER_TWO, facts: ["team", "private", "text/markdown", LATER_FACT] };
  const failedMap = () => ({ [HEADER_ONE.revisionId]: null, [HEADER_TWO.revisionId]: null });
  /** The settled answer of a gate whose own mint failed: no address, and the
   *  headers as that later answer composes them, which the card draws once it
   *  has read the answer. */
  const grantlessSettled = () =>
    respond({
      kind: "artifact_review_gate",
      state: SETTLED,
      body: null,
      targetHeaders: [HEADER_ONE, HEADER_TWO_LATER],
    });
  const settledAnswerDrawn = (root: HTMLElement) =>
    waitFor(() => expect(root.textContent).toContain(LATER_FACT));
  const credentialOf = (src: string) =>
    new URLSearchParams(src.slice(src.indexOf("?") + 1)).get("ic");
  /** The palette class the app writes on a document root for each scheme. */
  const paintDocument = (scheme: "light" | "dark" | "none") => {
    document.documentElement.className =
      scheme === "none" ? "" : scheme === "dark" ? "dark" : "cinatra";
  };

  /** A widget gate whose every per-target mint failed, decided here, until the
   *  card has drawn the settled answer `later` brings. */
  async function settleWidgetGateWithEveryMintFailed(later: () => Promise<Response>) {
    const { resolves } = mockDecision(
      { targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrcByRevision: failedMap() },
      later,
    );
    const { container } = renderOn("site_widget");
    await waitFor(() => expect(pairs(container)).toHaveLength(2));
    // Each pair draws its own failed body, and nothing is framed.
    const pairList = [...pairs(container)];
    expect(pairList).toHaveLength(2);
    for (const pair of pairList) timedOutWithPlateAndNoFrame(pair.lastElementChild ?? undefined);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    const addresses = watchFrameAddresses(container);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolves()).toBe(2));
    await settledAnswerDrawn(container);
    return { container, addresses, resolves };
  }

  it("a widget gate whose every mint failed, settled here, frames nothing when the settled answer brings no grant", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container, addresses } = await settleWidgetGateWithEveryMintFailed(async () => grantlessSettled());

    // The settled answer is drawn and brought no grant: the ONE island awaits
    // the gate's own grant under the headers, and no frame stands anywhere.
    expect(pairs(container)).toHaveLength(0);
    expect(headers(container)).toHaveLength(2);
    const waiting = [...islands(container)];
    expect(waiting).toHaveLength(1);
    expect(waiting[0].getAttribute("data-island-load-state")).toBe("loading");
    expect(waiting[0].querySelector('[data-conformance-id="review-target-island-skeleton"]')).not.toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(0);

    // Past its bound it draws its failed body, still with no frame.
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const failed = [...islands(container)];
    expect(failed).toHaveLength(1);
    timedOutWithPlateAndNoFrame(failed[0]);
    expect(headers(container)).toHaveLength(2);
    addresses.stop();
    // No frame was ever handed an address, so none without a credential.
    expect(addresses.seen.filter((src) => !credentialOf(src)), "a frame without a credential").toEqual([]);
    expect(addresses.seen).toEqual([]);
  });

  it("a cookie host's gate that pins several, settled here on an answer without a grant, frames its cookie address and repaints at once", async () => {
    try {
      paintDocument("light");
      const { resolves } = mockDecision({ targetHeaders: [HEADER_ONE, HEADER_TWO] }, async () =>
        grantlessSettled(),
      );
      const { container } = renderOn("run_card");
      await waitFor(() => expect(pairs(container)).toHaveLength(2));
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      await waitFor(() => expect(resolves()).toBe(2));
      await settledAnswerDrawn(container);

      // Nothing to spend: the one island stands at the reader's cookie address.
      expect(pairs(container)).toHaveLength(0);
      expect(headers(container)).toHaveLength(2);
      const frames = container.querySelectorAll("iframe");
      expect(frames).toHaveLength(1);
      const query = frameQuery(frames[0]);
      expect(query.get("ref")).toBe(VIEW.ref);
      expect(query.has("ic")).toBe(false);
      expect(query.has("target")).toBe(false);
      expect(query.get("scheme")).toBe("light");

      // A repaint lands at once, with no new resolve.
      await act(async () => {
        paintDocument("dark");
      });
      await waitFor(() =>
        expect(frameQuery(container.querySelector("iframe")).get("scheme")).toBe("dark"),
      );
      expect(container.querySelectorAll("iframe")).toHaveLength(1);
      expect(frameQuery(container.querySelector("iframe")).has("ic")).toBe(false);
      expect(resolves()).toBe(2);
    } finally {
      paintDocument("none");
    }
  });

  it("a widget gate whose every mint failed, settled here, frames the gate's own grant once when an answer brings it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let later: () => Promise<Response> = async () => grantlessSettled();
    const { container, addresses, resolves } = await settleWidgetGateWithEveryMintFailed(() => later());
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const failed = [...islands(container)];
    expect(failed).toHaveLength(1);
    timedOutWithPlateAndNoFrame(failed[0]);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);

    // Its retry re-resolves, and the answer that brings the gate's own grant
    // is framed once, at that grant, for the gate.
    later = async () =>
      settledAnswer({ targetHeaders: [HEADER_ONE, HEADER_TWO], islandSrc: servedForGate("ic-granted") });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(resolves()).toBe(3));
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    addresses.stop();
    const framed = frameQuery(container.querySelector("iframe"));
    expect(framed.get("ic")).toBe("ic-granted");
    expect(framed.get("ref")).toBe(VIEW.ref);
    expect(framed.has("target")).toBe(false);
    expect(addresses.seen.length).toBeGreaterThan(0);
    for (const src of addresses.seen) expect(credentialOf(src), src).toBe("ic-granted");
  });
});

// ---------------------------------------------------------------------------
// THE HELD ISLAND ADDRESS AND ITS TRANSITIONS. Each row drives ONE mounted card
// through a sequence of answers, drawing it for another gate where the row says
// so, and reads what every island frames after each step: a frame holding a
// credential as its gate and grant (`A:ic=A.g1`), a frame at the reader's
// cookie as its gate (`A:cookie`), each with the target it names (`@r1`) and
// the palette it is painted in (`~dark`); an island with no frame as `empty`;
// and no card at all as `none`. The rows cover the card's transition table:
// the same gate and another gate, every kind of answer, the widget and the
// cookie hosts.
// On the widget a target without its credential draws the empty region
// (`empty`), never the reader's cookie address: the island frames no address
// without its credential off a cookie session.
// ---------------------------------------------------------------------------

describe("the held island address follows one transition table on one mounted card", () => {
  const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
  const SETTLED: LifecycleCardState = { state: "settled", outcome: "approved" };
  const RESTRICTED: LifecycleCardState = { state: "restricted", canDecide: false, canComment: true, reason: "Not yours to decide." };
  const GATES = { A: "ref-gate-a", B: "ref-gate-b", C: "ref-gate-c" } as const;
  type Gate = keyof typeof GATES;
  type Host = "site_widget" | "run_card" | "chat_thread";
  type Scheme = "light" | "dark";
  /** The short name a reading gives each gate ref and each pinned revision. */
  const NAME_OF: Record<string, string> = {
    [GATES.A]: "A",
    [GATES.B]: "B",
    [GATES.C]: "C",
    [HEADER_ONE.revisionId]: "r1",
    [HEADER_TWO.revisionId]: "r2",
    [HEADER_THREE.revisionId]: "r3",
  };

  /** One resolve answer as the route composes it: a gate-wide grant, a
   *  per-target set (a null entry is a mint that failed), or neither. Each
   *  credential names its gate, so a reading shows whose grant a frame holds. */
  type Answer = {
    state: "pending" | "restricted" | "settled" | "absent" | "advisory" | "loading";
    targets: 0 | 1 | 2 | 3;
    grant?: string;
    set?: readonly (string | null)[];
    /** The pinned targets the headers name, in this order; `set` follows it. */
    order?: readonly Pin[];
  };
  type Pin = "r1" | "r2" | "r3";
  const PIN: Record<Pin, typeof HEADER_ONE> = { r1: HEADER_ONE, r2: HEADER_TWO, r3: HEADER_THREE };
  /** A gate whose headers name `order`, each with its entry of `set`. */
  const pins = (order: readonly Pin[], set?: readonly (string | null)[], state: "pending" | "restricted" = "pending"): Answer =>
    ({ state, targets: order.length > 1 ? 2 : 1, order, set });
  const one = (grant?: string): Answer => ({ state: "pending", targets: 1, grant });
  const several = (set?: readonly [string | null, string | null], grant?: string): Answer => ({
    state: "pending",
    targets: 2,
    set,
    grant,
  });
  const settledWith = (targets: 1 | 2, grant?: string): Answer => ({ state: "settled", targets, grant });
  /** An answer the card draws no frame for: no header, no address. */
  const frameless = (state: "absent" | "advisory" | "loading"): Answer => ({ state, targets: 0 });

  /** One step of a row: what moves the card, the answer every resolve gets
   *  from then on (`fail` answers 503, `hold` keeps it outstanding until the
   *  next `arrive`), and what every island frames once the card has read it. */
  type Step =
    | { on: "mount"; gate: Gate; answer: Answer; frames: string[]; scheme?: Scheme }
    | { on: "gate"; gate: Gate; answer: Answer | "fail" | "hold"; frames: string[] }
    | { on: "focus"; answer: Answer | "fail"; frames: string[] }
    | { on: "decide"; answer: Answer | "fail" | "hold"; frames: string[] }
    | { on: "refused"; answer?: undefined; frames: string[] }
    | { on: "arrive"; answer: Answer; frames: string[] }
    | { on: "paint"; scheme: Scheme; answer?: Answer; frames: string[] };
  type Row = { name: string; host: Host; steps: Step[]; strict?: true };

  const PAIRS_A = ["A:ic=A.s1@r1", "A:ic=A.s2@r2"];
  const REFUSED = ["empty@r1", "empty@r2"];
  const FRESH_A = ["A:ic=A.t1@r1", "A:ic=A.t2@r2"];
  /** A, then B whose resolve fails or stays outstanding, then back to A while
   *  the resolve holds A's earlier answer: nothing framed is framed again. */
  const backTo = (first: Answer, framedFirst: string[], b: "fail" | "hold", spent: string[], none: Answer, fresh: Answer, framedFresh: string[]): Step[] => [
    { on: "mount", gate: "A", answer: first, frames: framedFirst },
    { on: "gate", gate: "B", answer: b, frames: ["none"] },
    { on: "gate", gate: "A", answer: b, frames: spent },
    b === "hold" ? { on: "arrive", answer: none, frames: spent } : { on: "focus", answer: none, frames: spent },
    { on: "focus", answer: fresh, frames: framedFresh },
    { on: "focus", answer: "fail", frames: framedFresh },
  ];
  /** Grants framed on one gate, then an answer that draws no frame, then an
   *  answer without a fresh grant: the framed grants are never framed again. */
  const unframed = (first: Answer, framedFirst: string[], between: Answer, drawn: string[], none: Answer, spent: string[], fresh: Answer, framedFresh: string[]): Step[] => [
    { on: "mount", gate: "A", answer: first, frames: framedFirst },
    { on: "focus", answer: between, frames: drawn },
    { on: "focus", answer: none, frames: spent },
    { on: "focus", answer: fresh, frames: framedFresh },
    { on: "focus", answer: "fail", frames: framedFresh },
  ];
  const restrictedSet = (set: readonly [string | null, string | null]): Answer => ({ state: "restricted", targets: 2, set });
  const ROWS: Row[] = [
    {
      name: "widget, same gate, one target: a grant is framed, an answer without one keeps it, a fresh grant replaces it, a failed fetch changes nothing",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: one(), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: one("g2"), frames: ["A:ic=A.g2"] },
        { on: "focus", answer: "fail", frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "widget, same gate, one target whose mint failed: the empty region at once, then the grant an answer brings",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one(), frames: ["empty"] },
        { on: "focus", answer: one("g1"), frames: ["A:ic=A.g1"] },
      ],
    },
    {
      name: "widget, same gate, several targets: each pair at its own grant, kept by a set of nulls, replaced whole by a set with a fresh grant",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "focus", answer: several([null, null]), frames: PAIRS_A },
        { on: "focus", answer: several(["t1", null]), frames: ["A:ic=A.t1@r1", "empty@r2"] },
        { on: "focus", answer: several(["u1", "u2"]), frames: ["A:ic=A.u1@r1", "A:ic=A.u2@r2"] },
        { on: "focus", answer: "fail", frames: ["A:ic=A.u1@r1", "A:ic=A.u2@r2"] },
      ],
    },
    {
      name: "widget, same gate, several targets whose every mint failed: every pair refused until an answer brings their grants",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several([null, null]), frames: ["empty@r1", "empty@r2"] },
        { on: "focus", answer: several([null, null]), frames: ["empty@r1", "empty@r2"] },
        { on: "focus", answer: several(["s1", "s2"]), frames: PAIRS_A },
      ],
    },
    {
      // ONE gate-wide grant and no per-target addresses (the route's
      // over-budget fallback) is drawn as the ONE aggregate island on that
      // grant, never as pairs that all fail (`reviewGateTargetDrawing`).
      name: "widget, same gate, several targets with one gate-wide grant: the ONE aggregate island on that grant; then per-target grants: pairs",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(undefined, "g1"), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: several(["s1", "s2"]), frames: PAIRS_A },
      ],
    },
    {
      name: "widget, same gate, several targets settled here: the one island frames nothing until the settled answer's grant",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "decide", answer: "hold", frames: ["empty"] },
        { on: "arrive", answer: settledWith(2, "g1"), frames: ["A:ic=A.g1"] },
      ],
    },
    {
      name: "widget, same gate, several targets settled here: a settled answer that fails leaves the one island empty",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "decide", answer: "fail", frames: ["empty"] },
        { on: "focus", answer: settledWith(2, "g1"), frames: ["A:ic=A.g1"] },
      ],
    },
    {
      name: "widget, same gate, every mint failed and settled here: answers without a grant keep the one island empty, never the cookie address",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several([null, null]), frames: ["empty@r1", "empty@r2"] },
        { on: "decide", answer: settledWith(2), frames: ["empty"] },
        { on: "focus", answer: settledWith(2), frames: ["empty"] },
        { on: "focus", answer: settledWith(2, "g1"), frames: ["A:ic=A.g1"] },
      ],
    },
    {
      name: "widget, same gate, one target settled here: the painted frame stands until the settled answer's grant",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "decide", answer: "hold", frames: ["A:ic=A.g1"] },
        { on: "arrive", answer: settledWith(1, "g2"), frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "widget, same gate, a repaint over held grants asks once and frames the fresh set in the new palette",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", scheme: "light", answer: several(["s1", "s2"]), frames: ["A:ic=A.s1@r1~light", "A:ic=A.s2@r2~light"] },
        { on: "paint", scheme: "dark", answer: several(["t1", "t2"]), frames: ["A:ic=A.t1@r1~dark", "A:ic=A.t2@r2~dark"] },
      ],
    },
    {
      name: "widget, another gate: from several targets with grants to one target whose answer brings neither, the new gate's empty region",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "gate", gate: "B", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate: from several targets settled here to one target whose answer brings neither, the new gate's empty region",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "decide", answer: "hold", frames: ["empty"] },
        { on: "gate", gate: "B", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate: from every mint failed and settled here to a settled gate whose answer brings neither, the new gate's empty region",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several([null, null]), frames: ["empty@r1", "empty@r2"] },
        { on: "decide", answer: settledWith(2), frames: ["empty"] },
        { on: "gate", gate: "B", answer: settledWith(1), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate each way: several targets, one target with a grant, several again, each at its own gate's grants",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "gate", gate: "B", answer: one("g1"), frames: ["B:ic=B.g1"] },
        { on: "gate", gate: "C", answer: several(["s1", "s2"]), frames: ["C:ic=C.s1@r1", "C:ic=C.s2@r2"] },
      ],
    },
    {
      name: "widget, another gate each way: several targets, one target without a grant drawn empty, several again at their grants",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "gate", gate: "B", answer: one(), frames: ["empty"] },
        { on: "gate", gate: "A", answer: several(["t1", "t2"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2"] },
      ],
    },
    {
      name: "widget, another gate each way: one target with a grant, several targets at their grants, one target without a grant drawn empty",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "gate", gate: "B", answer: several(["s1", "s2"]), frames: ["B:ic=B.s1@r1", "B:ic=B.s2@r2"] },
        { on: "gate", gate: "A", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate: from one target to several targets whose every mint failed, every pair refused, settled here nothing framed",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "gate", gate: "B", answer: several([null, null]), frames: ["empty@r1", "empty@r2"] },
        { on: "decide", answer: "hold", frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate whose fetch failed draws nothing, and its later answer is read as its first",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "gate", gate: "B", answer: "fail", frames: ["none"] },
        { on: "focus", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate: a palette asked for on the gate before is not carried over",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", scheme: "light", answer: several(["s1", "s2"]), frames: ["A:ic=A.s1@r1~light", "A:ic=A.s2@r2~light"] },
        { on: "paint", scheme: "dark", answer: several([null, null]), frames: ["A:ic=A.s1@r1~light", "A:ic=A.s2@r2~light"] },
        { on: "gate", gate: "B", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate, one target each: the new gate's grant, then the next gate's empty region",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "gate", gate: "B", answer: one("h1"), frames: ["B:ic=B.h1"] },
        { on: "gate", gate: "C", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, another gate and back: a grant held for a gate is never framed again when the card returns to it",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "gate", gate: "B", answer: one(), frames: ["empty"] },
        { on: "gate", gate: "A", answer: one(), frames: ["empty"] },
      ],
    },
    {
      name: "widget, several targets, another gate whose fetch failed and back: the spent pairs refused until a fresh set, framed once",
      host: "site_widget",
      steps: backTo(several(["s1", "s2"]), PAIRS_A, "fail", REFUSED, several([null, null]), several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, several targets, another gate still outstanding and back: the spent pairs refused until a fresh set, framed once",
      host: "site_widget",
      steps: backTo(several(["s1", "s2"]), PAIRS_A, "hold", REFUSED, several([null, null]), several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, one target, another gate whose fetch failed and back: the spent grant awaits a fresh grant, framed once",
      host: "site_widget",
      steps: backTo(one("g1"), ["A:ic=A.g1"], "fail", ["empty"], one(), one("g2"), ["A:ic=A.g2"]),
    },
    {
      name: "widget, one target, another gate still outstanding and back: the spent grant awaits a fresh grant, framed once",
      host: "site_widget",
      steps: backTo(one("g1"), ["A:ic=A.g1"], "hold", ["empty"], one(), one("g2"), ["A:ic=A.g2"]),
    },
    {
      name: "cookie host, another gate whose fetch failed and back: the earlier answer's cookie address at once, no credential to spend",
      host: "run_card",
      steps: backTo(several(), ["A:cookie@r1", "A:cookie@r2"], "fail", ["A:cookie@r1", "A:cookie@r2"], several(), one(), ["A:cookie"]),
    },
    {
      name: "widget, same gate, several targets, absent, then every mint null: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: unframed(several(["s1", "s2"]), PAIRS_A, frameless("absent"), ["none"], several([null, null]), REFUSED, several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, same gate, several targets, advisory, then every mint null: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: unframed(several(["s1", "s2"]), PAIRS_A, frameless("advisory"), ["none"], several([null, null]), REFUSED, several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, same gate, several targets, loading, then every mint null: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: unframed(several(["s1", "s2"]), PAIRS_A, frameless("loading"), [], several([null, null]), REFUSED, several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, same gate, several targets restricted, absent, then every mint null: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: unframed(restrictedSet(["s1", "s2"]), PAIRS_A, frameless("absent"), ["none"], restrictedSet([null, null]), REFUSED, restrictedSet(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, same gate, one target, absent, then no grant: the framed grant awaits a fresh grant",
      host: "site_widget",
      steps: unframed(one("g1"), ["A:ic=A.g1"], frameless("absent"), ["none"], one(), ["empty"], one("g2"), ["A:ic=A.g2"]),
    },
    {
      name: "widget, same gate, one target, advisory, then no grant: the framed grant awaits a fresh grant",
      host: "site_widget",
      steps: unframed(one("g1"), ["A:ic=A.g1"], frameless("advisory"), ["none"], one(), ["empty"], one("g2"), ["A:ic=A.g2"]),
    },
    {
      name: "widget, same gate, the header count falls to one, then every mint null: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: unframed(several(["s1", "s2"]), PAIRS_A, one(), ["empty"], several([null, null]), REFUSED, several(["t1", "t2"]), FRESH_A),
    },
    {
      name: "widget, same gate, several targets, a decision blocked: the frames stand, and after absent they are refused",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "refused", frames: PAIRS_A },
        { on: "focus", answer: several([null, null]), frames: PAIRS_A },
        { on: "focus", answer: frameless("absent"), frames: ["none"] },
        { on: "focus", answer: several([null, null]), frames: REFUSED },
        { on: "focus", answer: several(["t1", "t2"]), frames: FRESH_A },
      ],
    },
    {
      name: "widget, same gate, one target, a decision blocked: the frame stands, and after advisory it awaits a fresh grant",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "refused", frames: ["A:ic=A.g1"] },
        { on: "focus", answer: one(), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: frameless("advisory"), frames: ["none"] },
        { on: "focus", answer: one(), frames: ["empty"] },
        { on: "focus", answer: one("g2"), frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "widget, another gate absent and back: the framed pairs refused until a fresh set",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "gate", gate: "B", answer: frameless("absent"), frames: ["none"] },
        { on: "gate", gate: "A", answer: several([null, null]), frames: REFUSED },
        { on: "focus", answer: several(["t1", "t2"]), frames: FRESH_A },
      ],
    },
    {
      name: "widget, another gate advisory and back while the resolve fails: nothing drawn until a fresh grant, framed once",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "gate", gate: "B", answer: frameless("advisory"), frames: ["none"] },
        { on: "gate", gate: "A", answer: "fail", frames: ["none"] },
        { on: "focus", answer: one("g2"), frames: ["A:ic=A.g2"] },
        { on: "focus", answer: one(), frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "widget under StrictMode, several targets: the pairs stand, and after absent they are refused until a fresh set",
      host: "site_widget",
      strict: true,
      steps: [
        { on: "mount", gate: "A", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "focus", answer: several([null, null]), frames: PAIRS_A },
        { on: "focus", answer: frameless("absent"), frames: ["none"] },
        { on: "focus", answer: several([null, null]), frames: REFUSED },
        { on: "focus", answer: several(["t1", "t2"]), frames: FRESH_A },
      ],
    },
    {
      name: "widget under StrictMode, one target: the frame stands, and after absent it awaits a fresh grant",
      host: "site_widget",
      strict: true,
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: one(), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: frameless("absent"), frames: ["none"] },
        { on: "focus", answer: one(), frames: ["empty"] },
        { on: "focus", answer: one("g2"), frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "cookie host, same gate: absent, advisory, loading and a header count change, the cookie address at once",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "focus", answer: frameless("absent"), frames: ["none"] },
        { on: "focus", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "focus", answer: frameless("advisory"), frames: ["none"] },
        { on: "focus", answer: one(), frames: ["A:cookie"] },
        { on: "focus", answer: frameless("loading"), frames: [] },
        { on: "focus", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
      ],
    },
    {
      name: "cookie host under StrictMode, another gate absent and back: each gate's cookie address at once",
      host: "chat_thread",
      strict: true,
      steps: [
        { on: "mount", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "gate", gate: "B", answer: frameless("absent"), frames: ["none"] },
        { on: "gate", gate: "A", answer: one(), frames: ["A:cookie"] },
      ],
    },
    {
      name: "cookie host, same gate, one target: the cookie address at once, a repaint at once, a failed fetch changes nothing, settled here the same",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", scheme: "light", answer: one(), frames: ["A:cookie~light"] },
        { on: "paint", scheme: "dark", frames: ["A:cookie~dark"] },
        { on: "focus", answer: "fail", frames: ["A:cookie~dark"] },
        { on: "decide", answer: "hold", frames: ["A:cookie~dark"] },
        { on: "arrive", answer: settledWith(1), frames: ["A:cookie~dark"] },
      ],
    },
    {
      name: "cookie host, same gate, several targets: each pair at the cookie address naming its target, settled here the gate's own",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "focus", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "decide", answer: "hold", frames: ["A:cookie"] },
        { on: "arrive", answer: settledWith(2), frames: ["A:cookie"] },
      ],
    },
    {
      name: "cookie host, another gate each way: each gate's own cookie address, and nothing while a gate's fetch fails",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "gate", gate: "B", answer: one(), frames: ["B:cookie"] },
        { on: "gate", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "gate", gate: "C", answer: "fail", frames: ["none"] },
      ],
    },
    {
      name: "cookie host in a conversation, another gate after a settle here: the new gate's cookie address",
      host: "chat_thread",
      steps: [
        { on: "mount", gate: "A", answer: several(), frames: ["A:cookie@r1", "A:cookie@r2"] },
        { on: "decide", answer: "hold", frames: ["A:cookie"] },
        { on: "gate", gate: "B", answer: one(), frames: ["B:cookie"] },
      ],
    },
    {
      name: "cookie host, another gate, one target each and back: each gate's own cookie address in the palette in force",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", scheme: "light", answer: one(), frames: ["A:cookie~light"] },
        { on: "paint", scheme: "dark", frames: ["A:cookie~dark"] },
        { on: "gate", gate: "B", answer: one(), frames: ["B:cookie~dark"] },
        { on: "gate", gate: "A", answer: one(), frames: ["A:cookie~dark"] },
      ],
    },
    // Header-count transitions: every pair that stays keeps its frame, and no credential is framed twice.
    {
      name: "widget, same gate, three targets, the leading header lost: the pairs that stay keep their frames, the lost target refused when it returns",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r2", "r3"], [null, null]), frames: ["A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: "fail", frames: ["A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["empty@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      name: "widget, restricted reader, three targets, a middle header lost: the first and last pairs keep their frames",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"], "restricted"), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r3"], [null, null], "restricted"), frames: ["A:ic=A.s1@r1", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null], "restricted"), frames: ["A:ic=A.s1@r1", "empty@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"], "restricted"), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      name: "widget, same gate, two targets, then three: a header added before them moves no frame",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r2", "r3"], ["s2", "s3"]), frames: ["A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["empty@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      name: "widget, same gate, the same targets in another order: the pair that keeps its place keeps its frame, the one that would move is refused until a fresh set",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2"], ["s1", "s2"]), frames: PAIRS_A },
        { on: "focus", answer: pins(["r2", "r1"], [null, null]), frames: ["A:ic=A.s2@r2", "empty@r1"] },
        { on: "focus", answer: pins(["r2", "r1"], ["t2", "t1"]), frames: ["A:ic=A.t2@r2", "A:ic=A.t1@r1"] },
        { on: "focus", answer: pins(["r1", "r2"], [null, null]), frames: ["A:ic=A.t1@r1", "empty@r2"] },
      ],
    },
    {
      name: "widget, same gate, one target, then two, then one: each grant framed once, the one island awaiting over the set",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: one("g1"), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: several(["s1", "s2"]), frames: PAIRS_A },
        { on: "focus", answer: one(), frames: ["empty"] },
        { on: "focus", answer: several([null, null]), frames: REFUSED },
        { on: "focus", answer: one("g2"), frames: ["A:ic=A.g2"] },
      ],
    },
    {
      name: "widget under StrictMode, three targets, the leading header lost and back: the pairs that stay keep their frames",
      host: "site_widget",
      strict: true,
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r2", "r3"], [null, null]), frames: ["A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["empty@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
      ],
    },
    {
      name: "widget, same gate, three targets, the last header lost and added again: the pairs that stay keep their frames",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2"], [null, null]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "empty@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      name: "widget, same gate, two targets, then a header added between them: neither pair moves its frame",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r3"], ["s1", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["A:ic=A.s1@r1", "empty@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      name: "widget, same gate, three targets in another order and back: only the pairs that keep their order keep their frames",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r2", "r1", "r3"], [null, null, null]), frames: ["A:ic=A.s2@r2", "empty@r1", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["empty@r1", "empty@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], ["t1", "t2", "t3"]), frames: ["A:ic=A.t1@r1", "A:ic=A.t2@r2", "A:ic=A.t3@r3"] },
      ],
    },
    {
      // A revision id two headers share selects no ONE target, so the gate is
      // never drawn as pairs: per-target addresses are never framed outside a
      // pair, and the ONE aggregate island frames the gate-wide grant alone.
      // A later set of nulls brings no grant, so the held grant stands and the
      // aggregate island keeps it painted; fresh per-target grants draw pairs.
      name: "widget, same gate, a target pinned twice: never pairs — the ONE aggregate island frames only a gate-wide grant, a set of nulls keeps it painted; then once: one frame per pair",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r1", "r2"], ["s1", "s1", "s2"]), frames: ["empty"] },
        { on: "focus", answer: { ...pins(["r1", "r1", "r2"]), grant: "g1" }, frames: ["A:ic=A.g1"] },
        { on: "focus", answer: pins(["r1", "r2"], [null, null]), frames: ["A:ic=A.g1"] },
        { on: "focus", answer: pins(["r1", "r2"], ["t1", "t2"]), frames: FRESH_A },
      ],
    },
    {
      name: "widget, same gate, three targets, pending then restricted: the pairs keep their frames",
      host: "site_widget",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"], ["s1", "s2", "s3"]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null], "restricted"), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"], [null, null, null]), frames: ["A:ic=A.s1@r1", "A:ic=A.s2@r2", "A:ic=A.s3@r3"] },
      ],
    },
    {
      name: "widget, same gate, one target, loading, then no grant: the framed grant awaits a fresh grant",
      host: "site_widget",
      steps: unframed(one("g1"), ["A:ic=A.g1"], frameless("loading"), [], one(), ["empty"], one("g2"), ["A:ic=A.g2"]),
    },
    {
      name: "cookie host, same gate: three targets, the leading header lost, another order and three again, the cookie address at once",
      host: "run_card",
      steps: [
        { on: "mount", gate: "A", answer: pins(["r1", "r2", "r3"]), frames: ["A:cookie@r1", "A:cookie@r2", "A:cookie@r3"] },
        { on: "focus", answer: pins(["r2", "r3"]), frames: ["A:cookie@r2", "A:cookie@r3"] },
        { on: "focus", answer: pins(["r3", "r2"]), frames: ["A:cookie@r3", "A:cookie@r2"] },
        { on: "focus", answer: pins(["r1", "r2", "r3"]), frames: ["A:cookie@r1", "A:cookie@r2", "A:cookie@r3"] },
      ],
    },
  ];

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(served(body)), { status, headers: { "Content-Type": "application/json" } });
  const islandAt = (ref: string, credential: string, target?: string) =>
    `${REVIEW_TARGET_ISLAND_PATH}?${new URLSearchParams({ ref, ic: credential, ...(target ? { target } : {}) }).toString()}`;
  /** The answer's envelope for one gate, each credential named after that gate. */
  const envelope = (ref: string, answer: Answer) => {
    const gate = NAME_OF[ref];
    const entry = (credential: string | null, target: string) =>
      credential === null ? null : islandAt(ref, `${gate}.${credential}`, target);
    if (answer.targets === 0) return { kind: "artifact_review_gate", state: { state: answer.state }, body: null };
    if (answer.order) {
      const order = answer.order.map((pin) => PIN[pin]);
      return {
        kind: "artifact_review_gate",
        state: answer.state === "restricted" ? RESTRICTED : PENDING,
        body: null,
        targetHeaders: order,
        ...(answer.grant ? { islandSrc: islandAt(ref, `${gate}.${answer.grant}`) } : {}),
        ...(answer.set
          ? { islandSrcByRevision: Object.fromEntries(order.map((h, i) => [h.revisionId, entry(answer.set?.[i] ?? null, h.revisionId)])) }
          : {}),
      };
    }
    return {
      kind: "artifact_review_gate",
      state: answer.state === "settled" ? SETTLED : answer.state === "restricted" ? RESTRICTED : PENDING,
      body: null,
      targetHeaders: answer.targets === 2 ? [HEADER_ONE, HEADER_TWO] : [HEADER_ONE],
      ...(answer.grant ? { islandSrc: islandAt(ref, `${gate}.${answer.grant}`) } : {}),
      ...(answer.set
        ? {
            islandSrcByRevision: {
              [HEADER_ONE.revisionId]: entry(answer.set[0], HEADER_ONE.revisionId),
              [HEADER_TWO.revisionId]: entry(answer.set[1], HEADER_TWO.revisionId),
            },
          }
        : {}),
    };
  };

  /** The resolve and decide endpoints: a decision lands as a committed approve,
   *  and every resolve gets the answer in force when it is asked. */
  function serve() {
    const server = {
      answer: "fail" as Answer | "fail" | "hold",
      blocked: false,
      answered: 0,
      held: [] as Array<{ ref: string; done: (response: Response) => void }>,
    };
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/decide") && init?.method === "POST") {
        return respond({
          outcome: server.blocked
            ? { kind: "blocked", reason: "no-longer-pending" }
            : { kind: "decided", disposition: "approve", idempotent: false },
        });
      }
      const { ref } = JSON.parse(String(init?.body)) as { ref: string };
      const answer = server.answer;
      if (answer === "hold") return new Promise<Response>((done) => server.held.push({ ref, done }));
      server.answered += 1;
      return answer === "fail" ? respond({ error: "unavailable" }, 503) : respond(envelope(ref, answer));
    }) as unknown as typeof fetch;
    return server;
  }

  /** What every island inside `root` frames, in document order. */
  function framed(root: HTMLElement): string[] {
    if (root.querySelector('[data-conformance-id="review-gate-card"]') === null) return ["none"];
    return [...islands(root)].map((island) => {
      const frame = island.querySelector("iframe");
      if (frame === null) {
        const pairElement = island.closest("[data-review-target-pair]");
        const pair = pairElement === null ? null : pairRevision(pairElement);
        return pair ? `empty@${NAME_OF[pair] ?? pair}` : "empty";
      }
      const query = frameQuery(frame);
      const named = (key: string) => NAME_OF[query.get(key) ?? ""] ?? query.get(key);
      return (
        `${named("ref")}:${query.has("ic") ? `ic=${query.get("ic")}` : "cookie"}` +
        (query.has("target") ? `@${named("target")}` : "") +
        (query.has("scheme") ? `~${query.get("scheme")}` : "")
      );
    });
  }

  const paint = (scheme: Scheme | null) => {
    document.documentElement.className = scheme === null ? "" : scheme === "dark" ? "dark" : "cinatra";
  };
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  /** Calls `mounted` for an iframe at the moment it is connected to the
   *  document (inserted or moved, alone or inside an inserted element) and
   *  each time a connected iframe's address is set: a browser loads the
   *  address each time. Returns the undo. */
  function watchFrameMounts(mounted: (frame: Element) => void): () => void {
    const node = Node.prototype;
    const { appendChild, insertBefore, replaceChild } = node;
    const setAttribute = Element.prototype.setAttribute;
    const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    let setting = false;
    const framesIn = (child: Node): Element[] =>
      child instanceof HTMLIFrameElement
        ? [child]
        : child instanceof Element || child instanceof DocumentFragment
          ? [...child.querySelectorAll("iframe")]
          : [];
    const connect = <T,>(parent: Node, child: Node, act: () => T): T => {
      const frames = framesIn(child);
      const done = act();
      if (parent.isConnected) frames.forEach(mounted);
      return done;
    };
    node.appendChild = function (this: Node, child: Node) {
      return connect(this, child, () => appendChild.call(this, child));
    } as typeof appendChild;
    node.insertBefore = function (this: Node, child: Node, before: Node | null) {
      return connect(this, child, () => insertBefore.call(this, child, before));
    } as typeof insertBefore;
    node.replaceChild = function (this: Node, child: Node, old: Node) {
      return connect(this, child, () => replaceChild.call(this, child, old));
    } as typeof replaceChild;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      setAttribute.call(this, name, value);
      if (!setting && this instanceof HTMLIFrameElement && name.toLowerCase() === "src" && this.isConnected) mounted(this);
    };
    if (src?.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, "src", {
        ...src,
        set(this: HTMLIFrameElement, value: string) {
          setting = true;
          try {
            src.set?.call(this, value);
          } finally {
            setting = false;
          }
          if (this.isConnected) mounted(this);
        },
      });
    }
    return () => {
      Object.assign(node, { appendChild, insertBefore, replaceChild });
      Element.prototype.setAttribute = setAttribute;
      if (src) Object.defineProperty(HTMLIFrameElement.prototype, "src", src);
    };
  }

  it("the frame-mount reading counts each connection of a frame and each address set on a connected one, when it happens", () => {
    const seen: string[] = [];
    const unwatch = watchFrameMounts((frame) => seen.push(frameQuery(frame).get("ic") ?? "cookie"));
    const root = document.createElement("div");
    try {
      document.body.appendChild(root);
      const frame = document.createElement("iframe");
      frame.setAttribute("src", "/island?ic=x1");
      root.appendChild(frame);
      frame.setAttribute("src", "/island?ref=a");
      const box = document.createElement("div");
      const inner = document.createElement("iframe");
      inner.src = "/island?ic=y1";
      box.appendChild(inner);
      root.insertBefore(box, frame);
      inner.remove();
      const moved = document.createElement("iframe");
      moved.setAttribute("src", "/island?ic=z1");
      root.appendChild(moved);
      root.insertBefore(moved, root.firstChild);
      moved.src = "/island?ic=z2";
      moved.setAttribute("src", "/island?ic=z3");
    } finally {
      unwatch();
      root.remove();
    }
    expect(seen).toEqual(["x1", "cookie", "y1", "z1", "z1", "z2", "z3"]);
  });

  // Each row is its own case, named in full.
  for (const { name, host, steps, strict } of ROWS) {
    it(name, async () => {
      const server = serve();
      const surface = (gate: Gate) => (
        <LifecycleCardSurfaceProvider host={host} auth={host === "site_widget" ? WIDGET_AUTH : undefined}>
          <ReviewGateCard view={{ ...VIEW, ref: GATES[gate] }} runId="run-3141" />
        </LifecycleCardSurfaceProvider>
      );
      const draw = (gate: Gate) => (strict ? <StrictMode>{surface(gate)}</StrictMode> : surface(gate));
      // Every frame mounted on each credential, read when it happens, and the
      // frame that holds each credential after a step.
      const mounts = new Map<string, number>();
      const unwatch = watchFrameMounts((frame) => {
        const credential = frameQuery(frame).get("ic");
        if (credential) mounts.set(credential, (mounts.get(credential) ?? 0) + 1);
      });
      let holding = new Map<string, Element>();
      let card: ReturnType<typeof render> | null = null;
      try {
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          const answered = server.answered;
          const held = server.held.length;
          switch (step.on) {
            case "mount":
              server.answer = step.answer;
              paint(step.scheme ?? null);
              card = render(draw(step.gate));
              break;
            case "gate":
              server.answer = step.answer;
              card?.rerender(draw(step.gate));
              break;
            case "focus":
              server.answer = step.answer;
              await act(async () => {
                window.dispatchEvent(new Event("focus"));
              });
              break;
            case "decide":
              server.answer = step.answer;
              fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
              break;
            case "refused":
              server.blocked = true;
              fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
              await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/decide$/), expect.anything()));
              break;
            case "arrive": {
              const answer = step.answer;
              server.answer = answer;
              await act(async () => {
                for (const { ref, done } of server.held.splice(0)) {
                  server.answered += 1;
                  done(respond(envelope(ref, answer)));
                }
              });
              break;
            }
            case "paint":
              if (step.answer) server.answer = step.answer;
              await act(async () => {
                paint(step.scheme);
              });
              break;
          }
          if (step.answer === "hold") {
            await waitFor(() => expect(server.held.length).toBeGreaterThan(held));
          } else if (step.answer !== undefined) {
            await waitFor(() => expect(server.answered).toBeGreaterThan(answered));
          }
          await settle();
          const root = card?.container;
          if (!root) throw new Error("the row mounts no card");
          await waitFor(() => expect(framed(root), `step ${index + 1} (${step.on})`).toEqual(step.frames));
          await settle();
          expect(framed(root), `step ${index + 1} (${step.on}) once settled`).toEqual(step.frames);
          const now = new Map<string, Element>();
          root.querySelectorAll("iframe").forEach((frame) => {
            const credential = frameQuery(frame).get("ic");
            if (credential) now.set(credential, frame);
          });
          for (const [credential, frame] of now) {
            if (holding.has(credential)) expect(frame === holding.get(credential), `step ${index + 1}: ${credential} keeps its frame`).toBe(true);
          }
          holding = now;
          for (const [credential, count] of mounts) {
            expect(count, `step ${index + 1}: frames mounted on ${credential}`).toBeLessThanOrEqual(1);
          }
        }
      } finally {
        unwatch();
        paint(null);
      }
    });
  }
});

// cinatra#4129 — THE AGGREGATE ISLAND'S HEADERS EACH KEEP THEIR OWN IDENTITY.
// Two pins of different artifacts may share one revision id and one object
// type; that answer is never drawn as pairs, so it is drawn HERE, as the one
// aggregate island's header list. Each header must stay one React child of its
// own across re-renders: no duplicate-key diagnostic, no header lost or doubled.
describe("the aggregate header list keys each header apart, even where revision and type repeat", () => {
  const sharing = (title: string) => ({
    title,
    typeLabel: "Email",
    objectType: "post",
    revisionId: "rev-shared",
    facts: [],
  });
  const titlesIn = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-conformance-id="review-target-header"] .font-bold')).map(
      (node) => node.textContent,
    );

  it("draws every header once per render, in order, with no duplicate-key diagnostic", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = sharing("Q3 email");
      const second = sharing("Q3 brief");
      const third = sharing("Q3 landing page");
      const view = render(<ReviewTargetHeaders headers={[first, second]} />);
      expect(titlesIn(view.container)).toEqual(["Q3 email", "Q3 brief"]);
      view.rerender(<ReviewTargetHeaders headers={[second, first, third]} />);
      expect(titlesIn(view.container)).toEqual(["Q3 brief", "Q3 email", "Q3 landing page"]);
      view.rerender(<ReviewTargetHeaders headers={[third, first]} />);
      expect(titlesIn(view.container)).toEqual(["Q3 landing page", "Q3 email"]);
      const keyDiagnostics = errors.mock.calls.filter((call) =>
        call.some((part) => typeof part === "string" && part.includes("same key")),
      );
      expect(keyDiagnostics).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
