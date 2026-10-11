// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

import { parseRunReviewSlot } from "../lifecycle-card-runtime";
import { useRunReviewRailRefresh } from "../lifecycle-card-runtime";

function Probe({
  seed,
  initialTasks,
  railCurrent,
  runId = "run-3942",
  enabled = true,
}: {
  seed: unknown;
  initialTasks?: readonly string[];
  railCurrent?: string | null;
  runId?: string;
  enabled?: boolean;
}) {
  const slot = parseRunReviewSlot(seed);
  useRunReviewRailRefresh({
    runId,
    reviewTaskId: slot?.reviewTaskId,
    initialReviewTaskIds: initialTasks,
    railCurrentReviewTaskId: railCurrent,
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
  it("retains the current seed shape and preserves a new seed's stable identity", () => {
    expect(parseRunReviewSlot({ reviewGate: { ref: "opaque", awaiting: false } })).toEqual({
      ref: "opaque", awaiting: false, producedReviewPark: false,
    });
    expect(parseRunReviewSlot(seed("task-1", "opaque"))).toEqual({
      ref: "opaque", awaiting: true, producedReviewPark: false, reviewTaskId: "task-1",
    });
  });

  it("preserves the merged produced-review park alongside the stable refresh identity", () => {
    expect(parseRunReviewSlot({ reviewGate: {
      ref: "opaque", awaiting: true, producedReviewPark: true, reviewTaskId: "task-1",
    } })).toEqual({
      ref: "opaque", awaiting: true, producedReviewPark: true, reviewTaskId: "task-1",
    });
  });

  it.each([null, false, 42, "", "   ", {}, []])("rejects malformed identity %j without inventing a task", (reviewTaskId) => {
    expect(parseRunReviewSlot({ reviewGate: { ref: "opaque", awaiting: false, reviewTaskId } })).toEqual({
      ref: "opaque", awaiting: false, producedReviewPark: false, reviewTaskId: null,
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

  it("§I.3 refreshes once when drawn B becomes live while the SSR rail still marks A", () => {
    const { rerender } = render(<Probe initialTasks={["task-1", "task-2"]} railCurrent="task-1" seed={seed("task-1", "nonce-1")} />);
    expect(refresh).not.toHaveBeenCalled();
    rerender(<Probe initialTasks={["task-1", "task-2"]} railCurrent="task-1" seed={seed("task-2", "nonce-2")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<Probe initialTasks={["task-1", "task-2"]} railCurrent="task-1" seed={seed("task-2", "nonce-3")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<Probe initialTasks={["task-1", "task-2"]} railCurrent="task-2" seed={seed("task-2", "nonce-4")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("§I.3 a resolved A in history does not refresh when current B is already drawn", () => {
    render(<Probe initialTasks={["task-1", "task-2"]} railCurrent="task-2" seed={seed("task-2", "nonce-B")} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("§I.3 preserves a resolved history slot when the rail has no current pending review", () => {
    const page = render(<StrictMode><Probe initialTasks={["resolved-task"]} railCurrent={null} seed={seed("resolved-task", "nonce-1")} /></StrictMode>);
    expect(refresh).not.toHaveBeenCalled();
    page.rerender(<Probe initialTasks={["resolved-task"]} railCurrent={null} seed={seed("resolved-task", "nonce-2")} />);
    expect(refresh).not.toHaveBeenCalled();
    page.unmount();
    render(<Probe initialTasks={["resolved-task"]} railCurrent={null} seed={seed("resolved-task", "nonce-3")} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("§I.3 still refreshes an unknown new slot once when the rail has no current review", () => {
    const page = render(<Probe initialTasks={["resolved-task"]} railCurrent={null} seed={seed("new-task", "nonce-1")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    page.rerender(<Probe initialTasks={["resolved-task"]} railCurrent={null} seed={seed("new-task", "nonce-2")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    page.unmount();
    render(<Probe initialTasks={["resolved-task", "new-task"]} railCurrent={null} seed={seed("new-task", "nonce-3")} />);
    expect(refresh).toHaveBeenCalledTimes(1);
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
