// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// A COLD THREAD RELOAD PINS TO THE LAST MESSAGE (cinatra#2740).
// ---------------------------------------------------------------------------
// Reloading a long thread used to render near the TOP of the conversation. The
// column's pin ran exactly once — the moment the asynchronously fetched messages
// populated the list — and at that instant the message elements were mounted but
// not laid out. Markdown, highlighted code, run panels and the auto-sized
// textareas all grow after that first paint, so the `scrollHeight` the pin read
// was roughly one screen, the pin landed there, and the rest of the thread then
// unrolled below the reader.
//
// A streaming turn never showed it: the pin re-fires on every chunk, and each
// re-fire re-measures a taller container. That is the shape of the fix — keep
// re-measuring — applied to the one case that had no second chance.
//
// This file measures the fix at BOTH levels, because they can fail for different
// reasons:
//
//   · the PASS itself (`../scroll-settle`), driven through an injected clock so
//     every frame, every late resize and the deadline are exact rather than
//     raced. This is where "re-pins until stable", "the reader's lock wins",
//     "a late image still corrects" and "the observer is disconnected at the
//     end" are pinned;
//
//   · the COLUMN's wiring, on the real mounted `/chat` surface, where the
//     question is whether the pass is armed on a cold load at all, whether it is
//     re-armed on a thread switch, and whether the reader's scroll-up reaches it
//     through the column's own lock rather than through a test double.
//
// Every check drives HEIGHT, never time-of-day: jsdom does no layout, so the
// container's metrics are stubbed and grown deliberately, which is exactly the
// post-mount growth the defect was made of.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// The mounted list reaches two cookie-bound server actions and the AG-UI run
// panel. Replaced here for the reasons set out in
// `conversation-column-inventory.test.tsx`; none of them is part of the scroll
// behaviour this file measures.
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({ InlineAgentRunCard: () => null }));

import { startScrollSettlePin, type ScrollSettleEnv } from "../scroll-settle";
import { chatSurfaceElement } from "./conversation-column-harness";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The test doubles: a frame queue, a timer, a ResizeObserver and a measurable
// container. Together they are "a browser that lays out when told to".
// ---------------------------------------------------------------------------

/** A rAF queue nothing runs until a test drains it. */
function createFrameQueue() {
  const queued = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    requestFrame(callback: () => void): number {
      const handle = nextHandle++;
      queued.set(handle, callback);
      return handle;
    },
    cancelFrame(handle: number): void {
      queued.delete(handle);
    },
    get pending(): number {
      return queued.size;
    },
    /** Run queued frames, including frames those frames schedule. */
    flush(maxFrames = 60): number {
      let ran = 0;
      while (queued.size > 0 && ran < maxFrames) {
        const [handle, callback] = queued.entries().next().value as [number, () => void];
        queued.delete(handle);
        callback();
        ran += 1;
      }
      return ran;
    },
  };
}

/** A single-shot timer a test fires by hand — the settle deadline. */
function createTimerSlot() {
  let pending: (() => void) | null = null;
  return {
    setTimer(callback: () => void): number {
      pending = callback;
      return 1;
    },
    clearTimer(): void {
      pending = null;
    },
    get armed(): boolean {
      return pending !== null;
    },
    fire(): void {
      const callback = pending;
      pending = null;
      callback?.();
    },
  };
}

type FakeObserver = {
  targets: Element[];
  disconnected: boolean;
  fire(): void;
};

/** Records what was observed, and lets a test report a late layout. */
function createObserverFactory() {
  const created: FakeObserver[] = [];
  const factory = (onChange: () => void) => {
    const observer: FakeObserver = {
      targets: [],
      disconnected: false,
      fire: onChange,
    };
    created.push(observer);
    return {
      observe(target: Element) {
        observer.targets.push(target);
      },
      disconnect() {
        observer.disconnected = true;
      },
    };
  };
  return { created, factory };
}

/**
 * Give an element the scroll metrics jsdom will not compute, and let a test grow
 * them the way late-laying-out content does.
 */
function stubScrollMetrics(element: Element, scrollHeight: number, clientHeight = 600) {
  let height = scrollHeight;
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return {
    growTo(next: number) {
      height = next;
    },
    get scrollHeight() {
      return height;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = value;
    },
    /** True when the container is pinned to its newest content. */
    get atBottom() {
      return top === height;
    },
  };
}

// ---------------------------------------------------------------------------
// The pass, driven frame by frame.
// ---------------------------------------------------------------------------

describe("the settle pass re-pins until the content height stops moving", () => {
  let frames: ReturnType<typeof createFrameQueue>;
  let timer: ReturnType<typeof createTimerSlot>;
  let observers: ReturnType<typeof createObserverFactory>;
  let container: HTMLDivElement;
  let metrics: ReturnType<typeof stubScrollMetrics>;
  let pins: number;
  let locked: boolean;
  let env: ScrollSettleEnv;

  beforeEach(() => {
    frames = createFrameQueue();
    timer = createTimerSlot();
    observers = createObserverFactory();
    container = document.createElement("div");
    container.appendChild(document.createElement("div"));
    document.body.appendChild(container);
    metrics = stubScrollMetrics(container, 700);
    pins = 0;
    locked = false;
    env = {
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      createObserver: observers.factory,
    };
  });

  afterEach(() => {
    container.remove();
  });

  /** The column's pin, reduced to what the pass can observe of it. */
  const pin = () => {
    pins += 1;
    metrics.scrollTop = container.scrollHeight;
  };

  const start = (overrides: Partial<Parameters<typeof startScrollSettlePin>[0]> = {}) =>
    startScrollSettlePin({
      container,
      pin,
      isLocked: () => locked,
      stableFrames: 3,
      env,
      ...overrides,
    });

  it("pins again on every height change, and lands at the bottom of the SETTLED height", () => {
    const pass = start();

    // The cold load's first measurement: one screen of a much longer thread.
    frames.flush(1);
    expect(pins).toBe(1);
    expect(metrics.scrollTop).toBe(700);

    // Markdown and highlighted code lay out...
    metrics.growTo(1900);
    frames.flush(1);
    // ...then a run panel and the auto-sized textareas.
    metrics.growTo(3400);
    frames.flush(1);

    expect(pins).toBe(3);
    // The landing point is the SETTLED height, which is the whole defect: the
    // single-shot pin stopped at 700 and the thread unrolled below it.
    expect(metrics.scrollTop).toBe(3400);
    expect(metrics.atBottom).toBe(true);
  });

  it("lets the frame loop go idle once the height holds, without a pin per frame", () => {
    const pass = start();
    frames.flush();

    // Quiet layout: the loop stops asking after the stable run.
    expect(frames.pending).toBe(0);
    expect(pins).toBe(1);
    // Still ALIVE, watching — the pass has not been stopped, only quieted.
    expect(pass.active).toBe(true);
    expect(observers.created[0]?.disconnected).toBe(false);
  });

  it("wakes on a LATE layout (an image, a diagram) and re-pins to the new bottom", () => {
    start();
    frames.flush();
    expect(pins).toBe(1);

    // An image finishes loading long after the first quiet moment.
    metrics.growTo(2600);
    observers.created[0]!.fire();
    frames.flush();

    expect(pins).toBe(2);
    expect(metrics.scrollTop).toBe(2600);
  });

  it("observes the container AND its children — the growth is never the container's own box", () => {
    start();
    frames.flush(1);
    const targets = observers.created[0]!.targets;
    expect(targets).toContain(container);
    expect(targets).toContain(container.children[0]);
  });

  it("picks up a child that arrives late behind the list's lazy boundary", () => {
    start();
    frames.flush(1);
    const late = document.createElement("section");
    container.appendChild(late);
    metrics.growTo(1500);
    observers.created[0]!.fire();
    frames.flush();
    expect(observers.created[0]!.targets).toContain(late);
  });

  it("ENDS the moment the reader's scroll lock engages, and never pins over them", () => {
    start();
    frames.flush(1);
    expect(pins).toBe(1);

    // The reader scrolls up while the thread is still laying out.
    locked = true;
    metrics.scrollTop = 200;
    metrics.growTo(4000);
    observers.created[0]!.fire();
    frames.flush();

    expect(pins).toBe(1);
    expect(metrics.scrollTop).toBe(200);
    expect(observers.created[0]!.disconnected).toBe(true);
    expect(frames.pending).toBe(0);
  });

  it("disconnects the observer at the settle deadline — the pass cannot outlive its window", () => {
    const pass = start();
    frames.flush();
    expect(observers.created[0]!.disconnected).toBe(false);

    timer.fire();

    expect(pass.active).toBe(false);
    expect(observers.created[0]!.disconnected).toBe(true);
    // A resize reported after the window is over changes nothing.
    metrics.growTo(9000);
    observers.created[0]!.fire();
    frames.flush();
    expect(metrics.scrollTop).toBe(700);
    expect(frames.pending).toBe(0);
  });

  it("stop() is idempotent, cancels the pending frame and clears the deadline", () => {
    const pass = start();
    expect(frames.pending).toBe(1);

    pass.stop();
    pass.stop();

    expect(pass.active).toBe(false);
    expect(frames.pending).toBe(0);
    expect(timer.armed).toBe(false);
    expect(observers.created[0]!.disconnected).toBe(true);
  });

  it("still corrects a cold load where the runtime has NO ResizeObserver", () => {
    start({ env: { ...env, createObserver: () => null } });

    frames.flush(1);
    metrics.growTo(2200);
    frames.flush(1);

    expect(pins).toBe(2);
    expect(metrics.scrollTop).toBe(2200);
  });
});

// ---------------------------------------------------------------------------
// The column, on the real `/chat` surface.
// ---------------------------------------------------------------------------

describe("the conversation column arms the settle pass on a cold thread load", () => {
  let frames: ReturnType<typeof createFrameQueue>;
  let observers: ReturnType<typeof createObserverFactory>;
  let originalRaf: typeof globalThis.requestAnimationFrame;
  let originalCancel: typeof globalThis.cancelAnimationFrame;
  let originalObserver: unknown;

  beforeEach(() => {
    frames = createFrameQueue();
    observers = createObserverFactory();
    originalRaf = globalThis.requestAnimationFrame;
    originalCancel = globalThis.cancelAnimationFrame;
    originalObserver = (globalThis as Record<string, unknown>).ResizeObserver;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      frames.requestFrame(() => callback(0))) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      frames.cancelFrame(handle)) as typeof globalThis.cancelAnimationFrame;
    // jsdom ships no ResizeObserver, so the column would otherwise run the
    // frame-loop-only path. The double is what a browser gives it.
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      private readonly api: { observe(t: Element): void; disconnect(): void };
      constructor(callback: () => void) {
        this.api = observers.factory(callback);
      }
      observe(target: Element) {
        this.api.observe(target);
      }
      unobserve() {}
      disconnect() {
        this.api.disconnect();
      }
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    (globalThis as Record<string, unknown>).ResizeObserver = originalObserver;
  });

  /** Mount `/chat` and hand back its scroll container, measurable. */
  async function mountChatThread(threadId: string) {
    const view = render(chatSurfaceElement({ threadId }));
    await waitFor(() =>
      expect(view.container.querySelector("[data-conversation-list]")).not.toBeNull(),
    );
    const scroller = view.container.querySelector<HTMLElement>(
      "[data-parity-surface='chat'] > div > div.overflow-y-auto",
    );
    expect(scroller, "the column's scroll container").not.toBeNull();
    // One screen of a much longer thread — the height the single-shot pin read,
    // in a viewport shorter than it, so a scroll-up is a real one.
    const metrics = stubScrollMetrics(scroller!, 600, 400);
    return { view, scroller: scroller!, metrics };
  }

  it("keeps re-pinning as the thread lays out, so the reload lands on the last message", async () => {
    const { scroller, metrics } = await mountChatThread("thread-cold-a");

    frames.flush();
    expect(metrics.scrollTop).toBe(600);

    // Markdown, highlighted code and the run panel expand after mount.
    metrics.growTo(2400);
    observers.created[0]!.fire();
    frames.flush();
    expect(metrics.scrollTop).toBe(2400);

    // The auto-sized textareas grow last.
    metrics.growTo(3100);
    observers.created[0]!.fire();
    frames.flush();

    expect(metrics.atBottom).toBe(true);
    expect(scroller.scrollTop).toBe(3100);
  });

  it("stops re-pinning the moment the reader scrolls up mid-settle", async () => {
    const { scroller, metrics } = await mountChatThread("thread-cold-b");
    frames.flush();

    // The reader scrolls up while the thread is still growing. The scroll is a
    // REAL one through the column's own handler, not a poked ref — the flag that
    // marks programmatic scrolls is already cleared by the flushed frames.
    metrics.scrollTop = 150;
    fireEvent.scroll(scroller);

    metrics.growTo(3000);
    observers.created[0]!.fire();
    frames.flush();

    expect(metrics.scrollTop).toBe(150);
    expect(observers.created[0]!.disconnected).toBe(true);
  });

  it("re-arms on a thread switch — a second cold load gets its own pass", async () => {
    const { view } = await mountChatThread("thread-cold-c");
    frames.flush();
    expect(observers.created).toHaveLength(1);

    view.rerender(chatSurfaceElement({ threadId: "thread-cold-d" }));
    await waitFor(() => expect(observers.created.length).toBeGreaterThan(1));

    // The first thread's pass is over; the second thread has a live one.
    expect(observers.created[0]!.disconnected).toBe(true);
    expect(observers.created[1]!.disconnected).toBe(false);

    const scroller = view.container.querySelector<HTMLElement>(
      "[data-parity-surface='chat'] > div > div.overflow-y-auto",
    )!;
    const metrics = stubScrollMetrics(scroller, 800, 400);
    frames.flush();
    metrics.growTo(2900);
    observers.created[1]!.fire();
    frames.flush();
    expect(metrics.scrollTop).toBe(2900);
  });

  it("leaves nothing behind on unmount — no observer, no frame loop", async () => {
    const { view } = await mountChatThread("thread-cold-e");
    frames.flush();
    expect(observers.created[0]!.disconnected).toBe(false);

    view.unmount();

    expect(observers.created[0]!.disconnected).toBe(true);
    expect(frames.pending).toBe(0);
  });
});
