import { describe, it, expect, vi } from "vitest";
import { createGuardedSseSink } from "../sse-sink";

const encoder = { encode: (s: string) => new TextEncoder().encode(s) };

describe("createGuardedSseSink (#503)", () => {
  it("enqueues an SSE frame while the stream is open", () => {
    const enqueue = vi.fn();
    const sink = createGuardedSseSink({ enqueue, desiredSize: 1 }, encoder);
    sink.send("done", { ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const frame = new TextDecoder().decode(enqueue.mock.calls[0][0]);
    expect(frame).toBe('event: done\ndata: {"ok":true}\n\n');
  });

  it("no-ops (no throw, no enqueue) when the stream is torn down (desiredSize null)", () => {
    const enqueue = vi.fn();
    const sink = createGuardedSseSink({ enqueue, desiredSize: null }, encoder);
    expect(() => sink.send("error", { message: "x" })).not.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("no-ops after markClosed() — the finally/cancel path", () => {
    const enqueue = vi.fn();
    const sink = createGuardedSseSink({ enqueue, desiredSize: 1 }, encoder);
    sink.markClosed();
    expect(sink.isClosed).toBe(true);
    sink.send("done", {});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("swallows an enqueue throw and stops writing afterwards", () => {
    // Simulates the controller closing between the desiredSize check and enqueue.
    const enqueue = vi.fn(() => {
      throw new TypeError("Invalid state: Controller is already closed");
    });
    const sink = createGuardedSseSink({ enqueue, desiredSize: 1 }, encoder);
    expect(() => sink.send("error", { message: "x" })).not.toThrow();
    expect(sink.isClosed).toBe(true);
    // a subsequent send is now a clean no-op
    enqueue.mockClear();
    sink.send("done", {});
    expect(enqueue).not.toHaveBeenCalled();
  });
});
