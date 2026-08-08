// @vitest-environment jsdom
/**
 * cinatra#2503 — behavioural pin on `useSetupGateRecovery`, the shell's recovery
 * from an INDETERMINATE setup gate.
 *
 * The gate fails OPEN when the completeness read errors: the shell renders
 * instead of bouncing the user to /setup (that bounce was the bug). But a root
 * layout is not re-rendered by ordinary client navigation, so that fail-open
 * guess would sit in the router cache until a hard reload. The hook re-derives
 * it exactly once.
 *
 * "Exactly once" is the whole contract and it has TWO failure modes, in
 * opposite directions — which is why this is a real render test and not a
 * source-text assertion:
 *
 *   NEVER  — the first version claimed the ref when SCHEDULING the timer.
 *            StrictMode runs the effect, cleans it up (cancelling the timer),
 *            then runs it again; the second pass saw a claimed ref and bailed,
 *            so no refresh ever happened. Caught by the StrictMode case below.
 *   REPEATEDLY — an unguarded refresh against a still-broken backend is a poll
 *            loop, i.e. a redirect loop traded for a request loop. Caught by
 *            the re-render case below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";

import { useSetupGateRecovery, SETUP_GATE_RETRY_MS } from "@/components/app-shell";

function Probe({
  indeterminate,
  refresh,
}: {
  indeterminate: boolean;
  refresh: () => void;
}) {
  useSetupGateRecovery(indeterminate, refresh, SETUP_GATE_RETRY_MS);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSetupGateRecovery", () => {
  it("re-derives once when the gate is indeterminate", () => {
    const refresh = vi.fn();
    render(<Probe indeterminate refresh={refresh} />);
    expect(refresh).not.toHaveBeenCalled(); // not immediate — the backend needs a moment
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("STILL re-derives under StrictMode's simulated remount", () => {
    // The regression that motivated the fix: mount → cleanup → mount. A
    // schedule-time ref claim is spent by the cancelled first pass, and the
    // recovery silently never fires.
    const refresh = vi.fn();
    render(
      <StrictMode>
        <Probe indeterminate refresh={refresh} />
      </StrictMode>,
    );
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never fires more than once, however long the backend stays broken", () => {
    const refresh = vi.fn();
    const { rerender } = render(<Probe indeterminate refresh={refresh} />);
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The re-render must actually RE-RUN the effect, or this proves nothing: a
    // rerender with identical deps is skipped by React and would pass even with
    // both ref guards deleted. `router.refresh()` produces a fresh RSC payload,
    // so a new callback identity is the realistic shape of the second run.
    for (let i = 0; i < 3; i++) {
      rerender(<Probe indeterminate refresh={() => refresh()} />);
      vi.advanceTimersByTime(SETUP_GATE_RETRY_MS * 10);
    }
    // Still one. A second retry here is the poll loop the ref guard exists for.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all on a determinate gate", () => {
    const refresh = vi.fn();
    render(<Probe indeterminate={false} refresh={refresh} />);
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS * 10);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not fire after unmount", () => {
    const refresh = vi.fn();
    const { unmount } = render(<Probe indeterminate refresh={refresh} />);
    unmount();
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS * 10);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the retry available when a gate flips determinate before it fires", () => {
    // Cleanup here comes from a dependency change, not a real remount, so the
    // retry must not be silently consumed.
    const refresh = vi.fn();
    const { rerender } = render(<Probe indeterminate refresh={refresh} />);
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS / 2);
    rerender(<Probe indeterminate={false} refresh={refresh} />);
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS * 2);
    expect(refresh).not.toHaveBeenCalled();

    rerender(<Probe indeterminate refresh={refresh} />);
    vi.advanceTimersByTime(SETUP_GATE_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
