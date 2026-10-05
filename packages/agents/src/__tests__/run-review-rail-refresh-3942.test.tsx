// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

import { parseRunReviewSlot } from "../lifecycle-card-runtime";
import { useRunReviewRailRefresh } from "../use-run-review-rail-refresh";

function Probe({
  seed,
  initialTasks,
  runId = "run-3942",
  enabled = true,
}: {
  seed: unknown;
  initialTasks?: readonly string[];
  runId?: string;
  enabled?: boolean;
}) {
  const slot = parseRunReviewSlot(seed);
  useRunReviewRailRefresh({
    runId,
    reviewTaskId: slot?.reviewTaskId,
    initialReviewTaskIds: initialTasks,
    refresh: enabled ? refresh : undefined,
  });
  return null;
}

const seed = (task: string | null, ticket: string) => ({
  reviewGate: { ref: ticket, awaiting: true, reviewTaskId: task },
});

beforeEach(() => refresh.mockReset());
afterEach(cleanup);

describe("the existing seed parser's optional display-refresh identity", () => {
  it("retains an old seed's exact shape and preserves a new seed's stable identity", () => {
    expect(parseRunReviewSlot({ reviewGate: { ref: "opaque", awaiting: false } })).toEqual({
      ref: "opaque", awaiting: false,
    });
    expect(parseRunReviewSlot(seed("task-1", "opaque"))).toEqual({
      ref: "opaque", awaiting: true, reviewTaskId: "task-1",
    });
  });

  it.each([null, false, 42, "", "   ", {}, []])("rejects malformed identity %j without inventing a task", (reviewTaskId) => {
    expect(parseRunReviewSlot({ reviewGate: { ref: "opaque", awaiting: false, reviewTaskId } })).toEqual({
      ref: "opaque", awaiting: false, reviewTaskId: null,
    });
  });

  it.each([null, true, 42, "not-a-slot", []])("refuses malformed slot %j", (reviewGate) => {
    expect(parseRunReviewSlot({ reviewGate })).toBeNull();
  });
});

describe("the page refresh follows real gate identities, not opaque ticket nonces", () => {
  it("refreshes once for a new task, retains that guard across ticket renewals, and permits the next task", () => {
    const { rerender } = render(<Probe seed={seed(null, "")} />);
    rerender(<Probe seed={seed("task-1", "nonce-1")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<Probe seed={seed("task-1", "nonce-2")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<Probe seed={seed("task-2", "nonce-3")} />);
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender(<Probe seed={seed("task-1", "nonce-4")} />);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("seeds a refreshed/remounted server-known task, including StrictMode's repeated effect", () => {
    const page = render(<StrictMode><Probe initialTasks={["task-1"]} seed={seed("task-1", "nonce-1")} /></StrictMode>);
    expect(refresh).not.toHaveBeenCalled();
    page.unmount();
    render(<Probe initialTasks={["task-1"]} seed={seed("task-1", "nonce-2")} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes a slot gate missing from the actual server rail seed", () => {
    const { rerender } = render(<Probe initialTasks={[]} seed={seed("task-1", "nonce-1")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<Probe initialTasks={["task-1"]} seed={seed("task-1", "nonce-2")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("seeds every actually drawn gate, including historical gates", () => {
    const { rerender } = render(<Probe initialTasks={["task-1", "task-2"]} seed={seed("task-1", "nonce-1")} />);
    rerender(<Probe initialTasks={["task-1", "task-2"]} seed={seed("task-2", "nonce-2")} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps independent run identities and server seeds separate", () => {
    const { rerender } = render(<Probe runId="run-1" initialTasks={["task-1"]} seed={seed("task-1", "nonce-1")} />);
    rerender(<Probe runId="run-2" initialTasks={[]} seed={seed("task-1", "nonce-2")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["chat", "widget"])("does not refresh a %s host that did not enable page ownership", () => {
    const { rerender } = render(<Probe enabled={false} seed={seed(null, "")} />);
    rerender(<Probe enabled={false} seed={seed("task-1", "nonce-1")} />);
    expect(refresh).not.toHaveBeenCalled();
  });
});
