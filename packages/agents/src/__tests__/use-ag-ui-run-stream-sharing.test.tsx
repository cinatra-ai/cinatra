// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgUiRunStream } from "../use-ag-ui-run-stream";

class EventSourceStub {
  static sources: EventSourceStub[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    EventSourceStub.sources.push(this);
  }

  emit(event: Record<string, unknown>) {
    act(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) })));
  }
}

beforeEach(() => {
  EventSourceStub.sources = [];
  vi.stubGlobal("EventSource", EventSourceStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({
  runId = "shared-run",
  enabled = true,
  initialStatus = "queued",
}: {
  runId?: string;
  enabled?: boolean;
  initialStatus?: string;
}) {
  const result = useAgUiRunStream(runId, { enabled, initialStatus });
  return (
    <div>
      <span data-testid="status">{result.status}</span>
      <span data-testid="text">{result.streamedText}</span>
      <span data-testid="error">{result.error}</span>
      <span data-testid="interrupt">{result.interruptContext?.reviewTaskId}</span>
      <span data-testid="frames">{JSON.stringify(result.dataPartFrames)}</span>
    </div>
  );
}

describe("run stream sharing", () => {
  it("shares one source between two hooks, isolates another run, and closes after the last listener leaves", () => {
    const watcher = render(<Probe />);
    const panel = render(<Probe />);
    expect(EventSourceStub.sources).toHaveLength(1);
    const source = EventSourceStub.sources[0];
    expect(source.url).toBe("/api/agents/runs/shared-run/stream");

    const other = render(<Probe runId="other/run" />);
    expect(EventSourceStub.sources).toHaveLength(2);
    const otherSource = EventSourceStub.sources[1];
    expect(otherSource.url).toBe("/api/agents/runs/other%2Frun/stream");

    source.emit({ type: "RUN_STARTED" });
    source.emit({ type: "TEXT_MESSAGE_CONTENT", delta: "Shared output" });
    expect(watcher.container.textContent).toContain("runningShared output");
    expect(panel.container.textContent).toContain("runningShared output");
    expect(other.container.textContent).toBe("queued[]");

    watcher.unmount();
    expect(source.close).not.toHaveBeenCalled();
    source.emit({ type: "TEXT_MESSAGE_CONTENT", delta: " continues" });
    expect(panel.container.textContent).toContain("Shared output continues");
    panel.unmount();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(otherSource.close).not.toHaveBeenCalled();
    other.unmount();
    expect(otherSource.close).toHaveBeenCalledTimes(1);

    render(<Probe />);
    expect(EventSourceStub.sources).toHaveLength(3);
  });

  it("replays already received content and interrupts to a later subscriber without another connection", () => {
    const watcher = render(<Probe />);
    const source = EventSourceStub.sources[0];
    source.emit({ type: "RUN_STARTED" });
    source.emit({ type: "TEXT_MESSAGE_CONTENT", delta: "Earlier output" });
    source.emit({ type: "DATA_PART", data: { answer: 42 } });
    source.emit({
      type: "INTERRUPT",
      schema: {},
      values: {},
      reviewTaskId: "review-1",
    });

    const panel = render(<Probe />);
    expect(EventSourceStub.sources).toHaveLength(1);
    expect(panel.container.textContent).toBe(watcher.container.textContent);
    expect(panel.container.textContent).toContain("pending_approvalEarlier outputreview-1");
    source.emit({ type: "RESUME" });
    expect(panel.container.textContent).toBe(watcher.container.textContent);
    expect(panel.container.textContent).not.toContain("review-1");
  });

  it.each([
    [{ type: "RUN_FINISHED", status: "completed" }, "completed"],
    [{ type: "RUN_FINISHED", status: "stopped" }, "stopped"],
    [{ type: "RUN_ERROR", message: "Run failed" }, "failed"],
  ])("delivers terminal event %j to every listener and closes only once", (event, status) => {
    const watcher = render(<Probe />);
    const panel = render(<Probe />);
    const source = EventSourceStub.sources[0];
    source.emit(event);
    expect(watcher.container.querySelector('[data-testid="status"]')?.textContent).toBe(status);
    expect(panel.container.querySelector('[data-testid="status"]')?.textContent).toBe(status);
    expect(source.close).toHaveBeenCalledTimes(1);

    const latePanel = render(<Probe />);
    expect(EventSourceStub.sources).toHaveLength(1);
    expect(latePanel.container.textContent).toBe(panel.container.textContent);
    watcher.unmount();
    panel.unmount();
    latePanel.unmount();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("releases only the changing hook when its run changes or it becomes disabled", () => {
    const watcher = render(<Probe />);
    const panel = render(<Probe />);
    const source = EventSourceStub.sources[0];
    source.emit({ type: "TEXT_MESSAGE_CONTENT", delta: "Old run" });
    panel.rerender(<Probe runId="new-run" />);
    expect(source.close).not.toHaveBeenCalled();
    expect(EventSourceStub.sources).toHaveLength(2);
    expect(panel.container.textContent).not.toContain("Old run");

    const newSource = EventSourceStub.sources[1];
    panel.rerender(<Probe runId="new-run" enabled={false} />);
    expect(newSource.close).toHaveBeenCalledTimes(1);
    expect(source.close).not.toHaveBeenCalled();
    watcher.unmount();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("preserves each hook's failed seed when fanning out replayed lifecycle events", () => {
    const live = render(<Probe />);
    const source = EventSourceStub.sources[0];
    source.emit({ type: "RUN_STARTED" });
    const failed = render(<Probe initialStatus="failed" />);
    source.emit({ type: "TEXT_MESSAGE_CONTENT", delta: "Partial output" });
    expect(EventSourceStub.sources).toHaveLength(1);
    expect(live.container.textContent).toBe("runningPartial output[]");
    expect(failed.container.textContent).toBe("failedPartial output[]");
  });
});
