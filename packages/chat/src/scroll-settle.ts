// ---------------------------------------------------------------------------
// PIN A SCROLL CONTAINER UNTIL ITS CONTENT HEIGHT SETTLES (cinatra#2740).
// ---------------------------------------------------------------------------
// A conversation column pins itself to the newest message by assigning
// `scrollTop = scrollHeight`. That assignment is only as good as the height it
// reads, and on a COLD thread load the height it reads is wrong.
//
// The messages arrive asynchronously, so the pin runs the moment the list
// populates — with the message elements MOUNTED but not yet LAID OUT. Markdown,
// syntax-highlighted code, embedded run panels and the auto-sized textareas all
// grow after that first paint. So `scrollHeight` is under-measured, the pin
// lands short, and the rest of the thread then unrolls BELOW the landing point.
// On a long thread the first measurement is roughly one screen, which is why the
// reader ends up near the top of the conversation.
//
// While a turn STREAMS the same code looks correct, because the pin re-fires on
// every chunk and each re-fire reads a taller container. A static reload has no
// further message change: exactly one shot, no correction.
//
// This module is that missing correction, and nothing else. It owns no state
// the caller does not already own, renders nothing, and reads exactly one
// number — the container's own `scrollHeight`.
//
// THE PASS, in three rules:
//
//   · MEASURE ON FRAMES. Each animation frame re-reads `scrollHeight`. A height
//     that CHANGED means content laid out after the last pin, so the pass pins
//     again. A height that held for `stableFrames` consecutive frames means the
//     layout is quiet, so the frame loop goes idle. Height is measured rather
//     than trusted from a resize entry because the growth can come from ANY
//     descendant, and `scrollHeight` is the one number the pin actually uses.
//
//   · STAY ALERT, CHEAPLY. Some content lands much later than the first quiet
//     moment (highlighting, a diagram, an image, an embed). So the pass keeps a
//     ResizeObserver on the container and its children while it lives; a late
//     growth wakes the frame loop back up instead of holding a rAF loop open for
//     seconds. The observer is optional: where the runtime has none, the frame
//     loop alone still corrects the common case.
//
//   · END, ALWAYS. The pass stops on the settle deadline, and the caller stops
//     it on a thread switch and on unmount. It also stops the moment the
//     caller's scroll lock engages: a reader who scrolled up mid-settle owns the
//     viewport, and a pass that pinned over them would be a worse defect than
//     the one it fixes.
// ---------------------------------------------------------------------------

/** The subset of `ResizeObserver` the pass uses. */
export type ScrollSettleObserver = {
  observe(target: Element): void;
  disconnect(): void;
};

/** Every scheduling primitive the pass touches, so a test can drive them. */
export type ScrollSettleEnv = {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Return `null` where the runtime has no ResizeObserver. */
  createObserver(onChange: () => void): ScrollSettleObserver | null;
};

export type ScrollSettleOptions = {
  /** The scroll container whose `scrollHeight` the pin reads. */
  container: Element;
  /** The caller's pin. It stays responsible for the lock and the programmatic-scroll flag. */
  pin: () => void;
  /** True once the reader has scrolled up on purpose. */
  isLocked: () => boolean;
  /** Consecutive unchanged frames that count as "laid out". */
  stableFrames?: number;
  /** Hard ceiling on the whole pass. */
  maxSettleMs?: number;
  /** Test seam. Anything omitted falls back to the real runtime. */
  env?: Partial<ScrollSettleEnv>;
};

export type ScrollSettlePass = {
  /** Idempotent. Cancels the pending frame, clears the deadline, disconnects the observer. */
  stop(): void;
  /** False once the pass has ended, by settle, deadline, lock or caller. */
  readonly active: boolean;
};

/**
 * Three frames of unchanged height. Long enough that a pin is not spent on every
 * intermediate layout step, short enough that the frame loop is idle within
 * ~50ms of the content going quiet.
 */
export const DEFAULT_STABLE_FRAMES = 3;

/**
 * The settle window. Long enough to cover highlighting, a diagram and a late
 * image on a slow machine; short enough that the observer is gone well before a
 * reader could mistake a re-pin for the page moving on its own.
 */
export const DEFAULT_MAX_SETTLE_MS = 2500;

/** The real runtime's scheduling primitives, resolved at call time. */
function runtimeEnv(): ScrollSettleEnv {
  const raf =
    typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : null;
  const caf =
    typeof globalThis.cancelAnimationFrame === "function"
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : null;
  return {
    // A runtime without rAF (a non-browser render target) still gets a settle
    // pass, one timer tick per frame.
    requestFrame: raf ?? ((callback) => setTimeout(callback, 16) as unknown as number),
    cancelFrame: caf ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)),
    setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    createObserver: (onChange) =>
      typeof globalThis.ResizeObserver === "function"
        ? new globalThis.ResizeObserver(() => onChange())
        : null,
  };
}

/**
 * Start a settle pass over `container`. Returns the handle the caller must stop
 * on a thread switch and on unmount; the pass otherwise ends on its own.
 */
export function startScrollSettlePin(options: ScrollSettleOptions): ScrollSettlePass {
  const { container, pin, isLocked } = options;
  const stableFrames = options.stableFrames ?? DEFAULT_STABLE_FRAMES;
  const maxSettleMs = options.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS;
  const base = runtimeEnv();
  const env: ScrollSettleEnv = { ...base, ...options.env };

  let active = true;
  let frame: number | null = null;
  let stable = 0;
  // -1 can never equal a real `scrollHeight`, so the first frame always pins.
  let lastHeight = -1;
  const observedTargets = new Set<Element>();
  let observer = env.createObserver(onContentResized);
  let deadline: number | null = env.setTimer(stop, maxSettleMs);

  function stop(): void {
    if (!active) return;
    active = false;
    if (frame !== null) {
      env.cancelFrame(frame);
      frame = null;
    }
    if (deadline !== null) {
      env.clearTimer(deadline);
      deadline = null;
    }
    observer?.disconnect();
    observer = null;
    observedTargets.clear();
  }

  /**
   * Observe the container AND its current element children. The container's own
   * box does not change when its content grows (it is the fixed-height scroll
   * viewport), so the children are the targets that actually report layout; and
   * the list itself arrives behind a lazy boundary, so the child set is re-read
   * on every frame rather than captured once.
   */
  function syncObservedTargets(): void {
    if (!observer) return;
    if (!observedTargets.has(container)) {
      observer.observe(container);
      observedTargets.add(container);
    }
    for (const child of Array.from(container.children)) {
      if (observedTargets.has(child)) continue;
      observer.observe(child);
      observedTargets.add(child);
    }
  }

  function scheduleFrame(): void {
    if (!active || frame !== null) return;
    frame = env.requestFrame(() => {
      frame = null;
      measure();
    });
  }

  /** Late layout (highlighting, a diagram, an image) wakes the frame loop. */
  function onContentResized(): void {
    if (!active) return;
    stable = 0;
    scheduleFrame();
  }

  function measure(): void {
    if (!active) return;
    // The reader's lock outranks the pass, always.
    if (isLocked()) {
      stop();
      return;
    }
    syncObservedTargets();
    const height = container.scrollHeight;
    if (height !== lastHeight) {
      lastHeight = height;
      stable = 0;
      pin();
    } else {
      stable += 1;
    }
    // Stable: let the frame loop go idle and leave the observer to wake it.
    if (stable >= stableFrames) return;
    scheduleFrame();
  }

  syncObservedTargets();
  scheduleFrame();

  return {
    stop,
    get active() {
      return active;
    },
  };
}
