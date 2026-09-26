// @vitest-environment jsdom
/**
 * THE PANEL HOLDS ITS NEWEST TURN IN VIEW (cinatra#2934, CELL6).
 *
 * The ratified drawing, §IX: "The panel scrolls at its own cap and holds itself
 * at the bottom, so the newest turn is the one in view." And §X: the panel is
 * one across all five readings of the window.
 *
 * jsdom lays out nothing, so the scroll area alone (the element carrying
 * `data-run-window-scroll`) is given a scroll height of 1000 and a writable
 * scroll position with a backing value; both are restored after each case.
 *
 *   P1  the stored exchange arrives after the panel mounts empty (the schedule
 *       page's read-back) → the area opens at its end, on all five readings.
 *   P2  closed by a click outside the window, opened again from the field →
 *       the area that opens stands at its end.
 *   P3  closed by the run's step transition, opened by the next entry → the
 *       area that opens stands at its end.
 *   P4  the reader's own position is kept across a re-render that adds nothing.
 *   P5  an append while the reader is scrolled up brings the area to its end.
 *   P6  there is no panel above an empty exchange.
 *   P7  an exchange replaced by another of the same length (another run's
 *       read-back, numbered by position) brings the area to its end.
 *   P8  the pending turn toggling brings the area to its end.
 *   P9  the reading changing on the same panel brings the area to its end.
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  // The same forward-ref stand-in hitl-conversation-panel.test.tsx uses, named,
  // and handing the panel the one handle method its submit calls.
  PromptField: React.forwardRef<
    { clear: () => void },
    { onSubmit: (s: string) => Promise<void> }
  >(function PromptFieldStandIn(props, ref) {
    React.useImperativeHandle(ref, () => ({ clear: () => {} }));
    return React.createElement(
      "button",
      {
        type: "button",
        onClick: () => void props.onSubmit("test prompt"),
        "data-testid": "prompt-field",
      },
      "PromptField",
    );
  }),
  LoadingSpinner: () => null,
}));

import {
  HitlConversationPanel,
  type HitlConversationEntry,
} from "../hitl-conversation-panel";
import type { RunWindowSurface } from "../run-window-conversation-store";

const SCROLL_HEIGHT = 1000;
const SCROLL_ATTR = "data-run-window-scroll";

const FOUR: HitlConversationEntry[] = [
  {
    id: 1,
    role: "user",
    content:
      "Fill the idea with: Why self-hosted upgrades take longer than planned. Do not submit it.",
  },
  { id: 2, role: "assistant", content: "I filled the idea. Nothing was submitted." },
  {
    id: 3,
    role: "user",
    content:
      "Set the idea to: Why self-hosted upgrades take longer than planned, and submit it.",
  },
  { id: 4, role: "assistant", content: "Submitted." },
];
const THREE = FOUR.slice(0, 3);
const FIVE: HitlConversationEntry[] = [
  ...FOUR,
  { id: 5, role: "user", content: "What happens next?" },
];

const SURFACES: RunWindowSurface[] = [
  "run-page",
  "step-by-step",
  "schedule",
  "armed-trigger",
  "review",
];

// --- the scroll-area stub -------------------------------------------------
const scrollTops = new WeakMap<Element, number>();
const savedTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
const savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const baseTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
const baseHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");

function installScrollStub() {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute(SCROLL_ATTR)) return scrollTops.get(this) ?? 0;
      return baseTop?.get ? baseTop.get.call(this) : 0;
    },
    set(this: HTMLElement, value: number) {
      if (this.hasAttribute(SCROLL_ATTR)) {
        scrollTops.set(this, value);
        return;
      }
      baseTop?.set?.call(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute(SCROLL_ATTR)) return SCROLL_HEIGHT;
      return baseHeight?.get ? baseHeight.get.call(this) : 0;
    },
  });
}

function restoreScrollStub() {
  if (savedTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", savedTop);
  else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  if (savedHeight) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", savedHeight);
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
}

// --- the mount ------------------------------------------------------------
let portal: HTMLDivElement;
let outside: HTMLDivElement;

beforeEach(() => {
  installScrollStub();
  portal = document.createElement("div");
  outside = document.createElement("div");
  document.body.append(portal, outside);
});

afterEach(() => {
  cleanup();
  portal.remove();
  outside.remove();
  restoreScrollStub();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("@cinatra-ai/sdk-ui");
  vi.restoreAllMocks();
  vi.resetModules();
});

const onSubmit = async () => {};

function panel(
  conversation: HitlConversationEntry[],
  extra: { surface?: RunWindowSurface; resetSignal?: unknown; promptPending?: boolean } = {},
) {
  return (
    <HitlConversationPanel
      surface={extra.surface ?? "schedule"}
      portalTarget={portal}
      visible={true}
      conversation={conversation}
      promptPending={extra.promptPending ?? false}
      storageKey="k"
      onSubmit={onSubmit}
      resetSignal={extra.resetSignal}
    />
  );
}

function area(): HTMLElement | null {
  return portal.querySelector<HTMLElement>(`[${SCROLL_ATTR}]`);
}

function convOpen(): string | null | undefined {
  return portal.querySelector("[data-conv-open]")?.getAttribute("data-conv-open");
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Mount empty, then deliver the exchange as the stored read-back does. */
async function openAtEnd(extra: { resetSignal?: unknown } = {}) {
  const view = render(panel([], extra));
  view.rerender(panel(THREE, extra));
  await settle();
  // An append while the panel is open is the road the head already takes.
  view.rerender(panel(FOUR, extra));
  await settle();
  expect(convOpen()).toBe("true");
  expect(area()!.scrollTop).toBe(SCROLL_HEIGHT);
  return view;
}

describe("P1 — the stored exchange arriving after the mount opens the panel at its end", () => {
  it.each(SURFACES)("on the %s reading", async (surface) => {
    const view = render(panel([], { surface }));
    await settle();
    expect(area()).toBeNull();

    view.rerender(panel(FOUR, { surface }));
    await settle();

    const el = area();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Submitted.");
    expect(el!.scrollTop).toBe(el!.scrollHeight);
  });
});

describe("P2 — opened again from the field after a click outside the window", () => {
  it("the area that opens stands at its end", async () => {
    await openAtEnd();

    fireEvent.mouseDown(outside);
    await settle();
    expect(convOpen()).toBe("false");
    expect(area()).toBeNull();

    fireEvent.click(portal.querySelector("[data-run-window-field]")!);
    await settle();

    const el = area();
    expect(convOpen()).toBe("true");
    expect(el).not.toBeNull();
    expect(el!.scrollTop).toBe(el!.scrollHeight);
  });
});

describe("P3 — opened by the next entry after the run's step transition closed it", () => {
  it("the area that opens stands at its end", async () => {
    const view = await openAtEnd({ resetSignal: "setup" });

    view.rerender(panel(FOUR, { resetSignal: "schedule" }));
    await settle();
    expect(convOpen()).toBe("false");

    view.rerender(panel(FIVE, { resetSignal: "schedule" }));
    await settle();

    const el = area();
    expect(convOpen()).toBe("true");
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("What happens next?");
    expect(el!.scrollTop).toBe(el!.scrollHeight);
  });
});

describe("P4 — the reader's own position is kept", () => {
  it("a re-render that adds no entry leaves the area where the reader put it", async () => {
    const view = await openAtEnd();
    const el = area()!;

    el.scrollTop = 0;
    fireEvent.scroll(el);
    await settle();

    view.rerender(panel(FOUR));
    await settle();

    expect(area()).toBe(el);
    expect(el.scrollTop).toBe(0);
  });
});

describe("P5 — an append while the reader is scrolled up", () => {
  it("brings the area to its end", async () => {
    const view = await openAtEnd();
    const el = area()!;

    el.scrollTop = 0;
    fireEvent.scroll(el);
    await settle();

    view.rerender(panel(FIVE));
    await settle();

    expect(area()).toBe(el);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});

describe("P6 — there is no panel above an empty exchange", () => {
  it("draws no scroll area with nothing said and nothing pending", async () => {
    render(panel([]));
    await settle();

    expect(area()).toBeNull();
    expect(portal.querySelector("[data-run-window-field]")).not.toBeNull();
  });
});

/** Open at the end, then scroll up as the reader would. */
async function scrolledUp() {
  const view = await openAtEnd();
  const el = area()!;
  el.scrollTop = 0;
  fireEvent.scroll(el);
  await settle();
  return { view, el };
}

describe("P7 — an exchange replaced by another of the same length", () => {
  it("brings the area to its end", async () => {
    const { view, el } = await scrolledUp();
    const OTHER: HitlConversationEntry[] = [
      ...FOUR.slice(0, 3),
      { id: 4, role: "assistant", content: "Scheduled for later." },
    ];

    view.rerender(panel(OTHER));
    await settle();

    expect(area()).toBe(el);
    expect(el.textContent).toContain("Scheduled for later.");
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});

describe("P8 — the pending turn toggling", () => {
  it("brings the area to its end", async () => {
    const { view, el } = await scrolledUp();

    view.rerender(panel(FOUR, { promptPending: true }));
    await settle();

    expect(area()).toBe(el);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});

describe("P9 — the reading changing on the same panel", () => {
  it("brings the area to its end", async () => {
    const { view, el } = await scrolledUp();

    view.rerender(panel(FOUR, { surface: "review" }));
    await settle();

    expect(area()).toBe(el);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});
