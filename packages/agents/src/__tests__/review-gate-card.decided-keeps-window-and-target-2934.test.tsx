// @vitest-environment jsdom
/**
 * A REVIEW DECIDED BY A TYPED REQUEST KEEPS ITS EXCHANGE, READ-ONLY
 * (cinatra#2934, fix leg 14).
 *
 * The drawing, `specs/app-artifact-review.html` §VI: "On submit, the gate
 * resolves changes-requested and a repair goes in flight … The reviewer's
 * request and the returned revision stay in the run, in order".
 *
 * THE MEASUREMENT (the thirteenth proof round, CELL10): once the typed request
 * settled the gate, the review window was no longer drawn, so the request and
 * its reply left the screen although the run's store still held them.
 *
 * R1  — after the settle the card still shows the request and then the reply,
 *       after the Continued marker, and the settled gate holds no field and no
 *       send control: nothing can be typed into a decided gate.
 * R1b — what must not change: a gate settled with another outcome draws no
 *       exchange, and the pending reading still draws the window with its field
 *       and its send control.
 * R2c — the card's island address across the settle (kept from fix leg 13 as a
 *       pin): the SAME address on the cookie road, never a remount onto a spent
 *       credential on the credentialed road, and a FRESH credential remounts.
 *
 * Harness: review-card-in-the-thread-draws-no-prompt-window-3481 (the card
 * mounted on a host with a resolver answer and a run) and
 * review-gate-card.island-credential (the credentialed island address).
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/review-gate-card.decided-keeps-window-and-target-2934.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

const REQUEST = "Please tighten the opening paragraph.";
const REPLY = "Changes requested.";

// The window's field is the shared `PromptField`. It stands in as what the
// person sees of it — a field to type into and the send control under its own
// accessible name — and the send carries the reviewer's words.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: (props: {
    onSubmit: (s: string) => Promise<void>;
    submitAriaLabel?: string;
    placeholder?: string;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement("textarea", {
        "data-testid": "review-prompt-field",
        placeholder: props.placeholder,
        readOnly: true,
      }),
      React.createElement("button", {
        type: "button",
        "data-testid": "review-prompt-send",
        "aria-label": props.submitAriaLabel,
        onClick: () => void props.onSubmit(REQUEST),
      }),
    ),
}));

/** The run's stored exchange, as the store holds it after the typed request. */
const EXCHANGE = [
  { id: 9, role: "user", content: REQUEST },
  { id: 10, role: "assistant", content: REPLY },
];

const windowStore = vi.hoisted(() => ({ rows: [] as unknown[] }));
const windowActions = vi.hoisted(() => ({
  loadRunWindowConversation: vi.fn(),
  sendRunWindowTurn: vi.fn(),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => windowActions.loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => windowActions.sendRunWindowTurn(...a),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { REVIEW_TARGET_ISLAND_PATH, ReviewGateCard } from "../review-gate-card";

const REF = "ref-2934-decided";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const RUN = "run-2934-decided";
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
// The settled member's own shape: an outcome and NO `canComment`.
const SETTLED: LifecycleCardState = { state: "settled", outcome: "changes_requested" };
const SETTLED_APPROVED: LifecycleCardState = { state: "settled", outcome: "approved" };
const FRAME = { assistant: "wordpress", instanceId: "inst-2934" };
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};
const SPENT = "AAAA-first_credential-BBBB";
const FRESH = "CCCC-fresh_credential-DDDD";
const SEND_LABEL = "Apply AI suggestion";

/** What the resolver answers now; the typed request moves it. */
const resolver = vi.hoisted(() => ({
  answer: null as null | { state: unknown; islandSrc: string | null },
}));

const realFetch = globalThis.fetch;

function installResolver(): void {
  globalThis.fetch = vi.fn(async () => {
    const current = resolver.answer!;
    return new Response(
      JSON.stringify({
        kind: "artifact_review_gate",
        state: current.state,
        body: null,
        ...(current.islandSrc ? { islandSrc: current.islandSrc } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** The typed request: the turn files the change request (acted), the store
 *  holds the exchange, and the resolver answers the gate settled. */
function armTypedRequest(settledIslandSrc: string | null): void {
  windowActions.sendRunWindowTurn.mockImplementation(async () => {
    windowStore.rows = EXCHANGE;
    resolver.answer = { state: SETTLED, islandSrc: settledIslandSrc };
    return { ok: true, entries: EXCHANGE, fills: [], acted: true };
  });
}

function renderRunPageCard() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <ReviewGateCard view={VIEW} runId={RUN} />
    </LifecycleCardSurfaceProvider>,
  );
}

function renderWidgetCard() {
  return render(
    <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAME}>
      <ReviewGateCard view={VIEW} runId={RUN} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function waitForPending(container: HTMLElement) {
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
  );
  await waitFor(() => expect(screen.queryByTestId("review-prompt-send")).not.toBeNull());
}

async function typeTheRequestAndSettle(container: HTMLElement) {
  await act(async () => {
    fireEvent.click(screen.getByTestId("review-prompt-send"));
  });
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull(),
  );
  await act(async () => {});
}

/** Every element a person could type into, inside `root`. */
const editables = (root: ParentNode) =>
  root.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
/** Every control named as the window's send, inside `root`. */
const sendControls = (root: ParentNode) => root.querySelectorAll(`[aria-label="${SEND_LABEL}"]`);

beforeEach(() => {
  windowStore.rows = [];
  windowActions.loadRunWindowConversation.mockImplementation(async () => windowStore.rows);
  resolver.answer = { state: PENDING, islandSrc: null };
  installResolver();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("@cinatra-ai/sdk-ui");
  vi.doUnmock("../run-window-actions");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("R1 — the request and its reply stay, read-only, after the typed request settles the gate", () => {
  it("shows the request then the reply after the Continued marker, with no field and no send control", async () => {
    armTypedRequest(null);
    const { container } = renderRunPageCard();
    await waitForPending(container);

    await typeTheRequestAndSettle(container);

    const card = container.querySelector('[data-conformance-id="review-gate-card"]')!;
    expect(card).not.toBeNull();
    const marker = card.querySelector('[data-conformance-id="review-gate-settled"]')!;
    expect(marker.textContent).toContain("Continued");
    expect(marker.textContent).toContain("Decided on the revision above.");
    expect(marker.getAttribute("data-review-outcome")).toBe("changes_requested");

    await waitFor(() => expect(card.querySelectorAll("[data-run-window-entry]").length).toBe(2));
    const entries = Array.from(card.querySelectorAll("[data-run-window-entry]"));
    expect(entries.map((e) => e.getAttribute("data-run-window-entry"))).toEqual([
      "person",
      "assistant",
    ]);
    expect(entries[0]!.textContent).toContain(REQUEST);
    expect(entries[1]!.textContent).toContain(REPLY);
    // In order, and after the marker.
    expect(marker.compareDocumentPosition(entries[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(entries[0]!.compareDocumentPosition(entries[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Nothing can be typed into a decided gate, and nothing sends.
    expect(editables(card)).toHaveLength(0);
    expect(sendControls(card)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: SEND_LABEL })).toBeNull();
    // The exchange is not the window: no window anchor, and the settle sent only the one request.
    expect(card.querySelector('[data-conformance-id="review-prompt-window"]')).toBeNull();
    expect(windowActions.sendRunWindowTurn).toHaveBeenCalledTimes(1);
    // The review draws no card that names who requested changes (§VI).
    expect(container.textContent).not.toContain("Changes requested by");
  });
});

describe("R1b — what the read-only exchange must not change", () => {
  it("a gate settled with another outcome draws no exchange", async () => {
    windowStore.rows = EXCHANGE;
    resolver.answer = { state: SETTLED_APPROVED, islandSrc: null };
    const { container } = renderRunPageCard();
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull(),
    );
    await act(async () => {});

    const card = container.querySelector('[data-conformance-id="review-gate-card"]')!;
    expect(card.querySelector('[data-conformance-id="review-gate-settled"]')!.getAttribute("data-review-outcome")).toBe(
      "approved",
    );
    expect(card.querySelectorAll("[data-run-window-entry]")).toHaveLength(0);
    expect(card.querySelector('[data-conformance-id="review-prompt-window"]')).toBeNull();
    expect(editables(card)).toHaveLength(0);
    expect(sendControls(card)).toHaveLength(0);
  });

  it("the pending reading still draws the window with its field and its send control", async () => {
    const { container } = renderRunPageCard();
    await waitForPending(container);

    const card = container.querySelector('[data-conformance-id="review-gate-card"]')!;
    const promptWindow = card.querySelector('[data-conformance-id="review-prompt-window"]');
    expect(promptWindow).not.toBeNull();
    expect(promptWindow!.querySelectorAll("textarea")).toHaveLength(1);
    expect(sendControls(promptWindow!)).toHaveLength(1);
    expect(windowActions.sendRunWindowTurn).not.toHaveBeenCalled();
  });
});

describe("R2c — the card frames the decided target at an address the island admits", () => {
  it("the cookie road: the SAME island address before and after the settle", async () => {
    armTypedRequest(null);
    const { container } = renderRunPageCard();
    await waitForPending(container);
    const framePending = container.querySelector("iframe");
    expect(framePending).not.toBeNull();
    const srcPending = framePending!.getAttribute("src");
    expect(srcPending).toBe(`${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}`);

    await typeTheRequestAndSettle(container);

    const frameSettled = container.querySelector("iframe");
    expect(frameSettled).not.toBeNull();
    expect(frameSettled!.getAttribute("src")).toBe(srcPending);
  });

  it("the credentialed road, settled answer without a credential: no remount onto the spent one", async () => {
    resolver.answer = {
      state: PENDING,
      islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SPENT}`,
    };
    armTypedRequest(null);
    const { container } = renderWidgetCard();
    await waitForPending(container);
    const framePending = container.querySelector("iframe")!;
    expect(new URL(framePending.getAttribute("src")!, "https://app.example").searchParams.get("ic")).toBe(
      SPENT,
    );

    await typeTheRequestAndSettle(container);

    const frameSettled = container.querySelector("iframe");
    expect(frameSettled).not.toBeNull();
    // The frame that already painted from the credential is the one still on
    // screen: a NEW frame on the same address would present a spent bearer.
    expect(frameSettled).toBe(framePending);
  });

  it("the credentialed road, settled answer with a FRESH credential: framed on the fresh one", async () => {
    resolver.answer = {
      state: PENDING,
      islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SPENT}`,
    };
    armTypedRequest(`${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${FRESH}`);
    const { container } = renderWidgetCard();
    await waitForPending(container);

    await typeTheRequestAndSettle(container);

    const frameSettled = container.querySelector("iframe");
    expect(frameSettled).not.toBeNull();
    expect(
      new URL(frameSettled!.getAttribute("src")!, "https://app.example").searchParams.get("ic"),
    ).toBe(FRESH);
  });
});
