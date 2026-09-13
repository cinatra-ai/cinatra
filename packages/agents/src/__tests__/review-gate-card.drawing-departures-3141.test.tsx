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
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

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

  it("wherever the gate is mounted WITH its run, it draws that one window and no other", async () => {
    // The window is the RUN's conversation, so what it needs is the run — not a
    // host identity. Given the run, every host draws the same single window; the
    // host makes no difference to it, which is the point of one card for every
    // surface. What decides whether a window is drawn at all is the next case.
    for (const host of ["chat_thread", "run_card", "page_gate_region", "site_widget"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container } = renderOn(host);
      await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
      cleanup();
    }
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

  it("a landed change request KEEPS the exchange on screen — the card does not re-resolve it away", async () => {
    // THE WINDOW'S OWN RULING, in its own words: "A landed changes-request
    // RESOLVES the base gate, but the EXCHANGE (the typed request + the
    // repair/lineage reply) must stay visible — so we do NOT blank the surface
    // to the resolved/blocked state." The decision bar re-resolves the card
    // after a landed decision; the window must not, or the settled reading
    // unmounts the pending branch and takes the reader's own words with it.
    const resolveFetch = mockResolve({ state: "pending", canDecide: true, canComment: true });
    const submitAction = vi.fn(
      async () =>
        ({ kind: "changes-requested", status: "requested", idempotent: false }) as const,
    );
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3141" submitAction={submitAction} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(promptWindows(container)).toHaveLength(1));
    const resolvesBefore = resolveFetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="review-prompt-send"]')!);
    });

    expect(submitAction).toHaveBeenCalledWith({ disposition: "comment", comment: TYPED_REQUEST });
    // The window — and with it the exchange — is still on screen.
    expect(promptWindows(container)).toHaveLength(1);
    expect(
      container.querySelector('[data-conformance-id="review-decision-bar"]'),
      "the gate the exchange belongs to is still the reading on screen",
    ).not.toBeNull();
    // And the card did not go back to the server for a settled answer.
    expect(resolveFetch.mock.calls.length).toBe(resolvesBefore);
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
// cinatra#3356 — EVERY ARTIFACT RENDERS ITSELF (the ruling of 2026-09-13).
//
// "Every artifact must render itself, i.e. do not show the head of all artifacts
// stacked, then their bodies stacked. Instead, always show one artifact with head
// plus body, then the next artifact with head plus body and so on."
//
// And cinatra#3456, which falls with it: the target region was capped at 380 CSS
// px and scrolled inside itself, so a gate over several targets showed only the
// first body. §IV draws each target with its header and its representation in the
// page's own flow; the card grows with its targets, and the page — not a box
// inside it — scrolls.
// ---------------------------------------------------------------------------

const blocks = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-target-block"]');
const islands = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-target-island"]');

describe("#3356 — one block per artifact: its head directly over its own body", () => {
  const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

  async function renderBlocks(headerList = [HEADER_ONE, HEADER_TWO]) {
    mockResolve(PENDING, { targetHeaders: headerList });
    const rendered = renderOn("run_card");
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[data-conformance-id="review-decision-bar"]'),
      ).not.toBeNull(),
    );
    return rendered;
  }

  it("draws ONE block per artifact, in the gate's order", async () => {
    const { container } = await renderBlocks();
    expect(blocks(container)).toHaveLength(2);
    const revisions = [...blocks(container)].map((b) =>
      b
        .querySelector("[data-review-target-revision]")
        ?.getAttribute("data-review-target-revision"),
    );
    expect(revisions).toEqual([HEADER_ONE.revisionId, HEADER_TWO.revisionId]);
  });

  it("each block carries its own head and its own body, the head first", async () => {
    const { container } = await renderBlocks();
    expect(islands(container)).toHaveLength(2);
    for (const block of [...blocks(container)]) {
      const head = block.querySelector('[data-conformance-id="review-target-header"]');
      const body = block.querySelector('[data-conformance-id="review-target-island"]');
      expect(head, "the block draws its own head").not.toBeNull();
      expect(body, "the block draws its own body").not.toBeNull();
      expect(
        head!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the head sits directly over its own body",
      ).toBeTruthy();
    }
  });

  it("ONE bordered block per artifact — the head and its own body inside the SAME border", async () => {
    // THE MEASURED DEPARTURE (round 2). The head sat in its own bordered card and
    // the body in a second one, with 8 CSS px of page ground between them: two
    // cards where the drawing draws one thing. §IV puts the two
    // halves in ONE block — "Every target opens with a header …" and "Beneath the
    // header sits the representation slot" — and the card's own loading skeleton
    // has always drawn exactly that: one bordered box, a hairline, the body.
    const { container } = await renderBlocks();
    expect(blocks(container)).toHaveLength(2);
    for (const block of [...blocks(container)]) {
      const head = block.querySelector('[data-conformance-id="review-target-header"]')!;
      const body = block.querySelector('[data-conformance-id="review-target-island"]')!;
      // The BLOCK is the one bordered container.
      expect(block.className, "the block draws the border").toMatch(/\bborder border-line\b/);
      expect(block.className).toContain("rounded-control");
      // Neither half draws a card of its own inside it.
      expect(head.className, "the head draws no card of its own").not.toMatch(
        /\bborder border-line\b/,
      );
      expect(head.className).not.toContain("rounded-control");
      expect(body.className, "the body draws no card of its own").not.toMatch(
        /\bborder border-line\b/,
      );
      expect(body.className).not.toContain("rounded-control");
      // What divides them is a hairline, not a gap.
      expect(head.className, "a hairline under the head").toContain("border-b");
      expect(
        block.className,
        "no page ground between the head and its own body",
      ).not.toMatch(/\bgap-/);
      expect(head.nextElementSibling, "the body follows its head with nothing between").toBe(body);
    }
  });

  it("never a column of heads followed by a region of bodies", async () => {
    const { container } = await renderBlocks();
    const [firstHead, secondHead] = [...headers(container)];
    const firstBody = blocks(container)[0].querySelector(
      '[data-conformance-id="review-target-island"]',
    )!;
    expect(
      firstHead.compareDocumentPosition(firstBody) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      firstBody.compareDocumentPosition(secondHead) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the FIRST artifact's body comes before the SECOND artifact's head",
    ).toBeTruthy();
  });

  it("each block's frame asks for THAT artifact's body and no other", async () => {
    const { container } = await renderBlocks();
    const srcs = [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src") ?? "");
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toContain(`tr=${HEADER_ONE.revisionId}`);
    expect(srcs[1]).toContain(`tr=${HEADER_TWO.revisionId}`);
  });

  it("no inner capped region — the frame is never held at a fixed height (cinatra#3456)", async () => {
    const { container } = await renderBlocks();
    for (const island of [...islands(container)]) {
      expect(
        island.className,
        "the target region clips nothing — the page scrolls, not a box inside it",
      ).not.toContain("overflow-hidden");
      expect((island as HTMLElement).style.height, "the region takes no fixed height").toBe("");
    }
    for (const frame of [...container.querySelectorAll("iframe")]) {
      expect(
        (frame as HTMLIFrameElement).style.height,
        "the frame is not capped while its own height is unknown",
      ).toBe("");
      expect(
        (frame as HTMLIFrameElement).style.minHeight,
        "it stands at a floor until its document says how tall it is",
      ).not.toBe("");
    }
  });

  it("a SETTLED gate keeps the same composition", async () => {
    mockResolve({ state: "settled", outcome: "approved" }, {
      targetHeaders: [HEADER_ONE, HEADER_TWO],
    });
    const { container } = renderOn("run_card");
    await waitFor(() => expect(blocks(container)).toHaveLength(2));
    expect(islands(container)).toHaveLength(2);
    const firstBody = blocks(container)[0].querySelector(
      '[data-conformance-id="review-target-island"]',
    )!;
    const secondHead = [...headers(container)][1];
    expect(
      firstBody.compareDocumentPosition(secondHead) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("an answer that carries no headers still frames the gate's own pinned set", async () => {
    mockResolve(PENDING);
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(blocks(container)).toHaveLength(0);
    expect(islands(container)).toHaveLength(1);
  });
});
