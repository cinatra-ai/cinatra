/**
 * toMuxSseResponse tests.
 *
 * Verifies the multiplexed A2A + AG-UI SSE adapter:
 *   - emits A2A frames as `data: <json>\n\n`
 *   - emits AG-UI frames as `event: ag-ui\ndata: <json>\n\n`
 *   - both generators pumped concurrently (both terminate independently)
 *   - abort cascades to both generators
 *   - A2A throw → JSON-RPC error envelope frame
 *   - AG-UI throw → isolated (logged, no envelope)
 *   - SSE headers identical to toSseResponse
 *   - keepalive appears on idle streams
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type { JSONRPCResponse } from "@a2a-js/sdk";

import { toMuxSseResponse } from "../mux-sse-response";

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeA2AGen(
  chunks: JSONRPCResponse[],
  opts: { delayMs?: number; throwAt?: number } = {},
): AsyncGenerator<JSONRPCResponse> {
  async function* gen(): AsyncGenerator<JSONRPCResponse> {
    let i = 0;
    for (const chunk of chunks) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throwAt !== undefined && i === opts.throwAt) {
        throw new Error("boom");
      }
      yield chunk;
      i++;
    }
  }
  return gen();
}

function makeAgUiGen(
  events: unknown[],
  opts: { delayMs?: number; throwAt?: number } = {},
): AsyncGenerator<unknown> {
  async function* gen(): AsyncGenerator<unknown> {
    let i = 0;
    for (const event of events) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throwAt !== undefined && i === opts.throwAt) {
        throw new Error("ag-ui boom");
      }
      yield event;
      i++;
    }
  }
  return gen();
}

function makeA2AChunk(id: number): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: { kind: "status-update", taskId: `t${id}`, status: { state: "working" } },
  } as unknown as JSONRPCResponse;
}

function makeAgUiEvent(type: string): unknown {
  return { type, threadId: "th1", runId: "r1" };
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toMuxSseResponse", () => {
  it("emits A2A chunks as bare `data:` frames (no event name)", async () => {
    const chunks = [makeA2AChunk(1), makeA2AChunk(2)];
    const response = toMuxSseResponse(makeA2AGen(chunks), makeAgUiGen([]));
    const body = await readAll(response.body!.getReader());
    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      expect(f.startsWith("data: ")).toBe(true);
      expect(f).not.toContain("event: ag-ui");
    }
  });

  it("emits AG-UI events as `event: ag-ui\\ndata:` frames", async () => {
    const events = [makeAgUiEvent("RUN_STARTED"), makeAgUiEvent("RUN_FINISHED")];
    const response = toMuxSseResponse(makeA2AGen([]), makeAgUiGen(events));
    const body = await readAll(response.body!.getReader());
    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      expect(f.startsWith("event: ag-ui\ndata: ")).toBe(true);
    }
  });

  it("contains frames from both generators in the output", async () => {
    const a2aChunks = [makeA2AChunk(1), makeA2AChunk(2)];
    const agUiEvents = [makeAgUiEvent("STATE_SNAPSHOT"), makeAgUiEvent("RUN_FINISHED")];
    const response = toMuxSseResponse(makeA2AGen(a2aChunks), makeAgUiGen(agUiEvents));
    const body = await readAll(response.body!.getReader());
    expect(body).toContain("data: " + JSON.stringify(makeA2AChunk(1)));
    expect(body).toContain(
      "event: ag-ui\ndata: " + JSON.stringify(makeAgUiEvent("STATE_SNAPSHOT")),
    );
  });

  it("AG-UI frames can appear AFTER A2A finishes (independent termination)", async () => {
    // A2A has 1 fast chunk; AG-UI has 2 delayed chunks — tests that A2A
    // finishing does NOT call agUiGen.return() and cut the AG-UI stream.
    const a2aChunks = [makeA2AChunk(1)];
    const agUiEvents = [makeAgUiEvent("STATE_SNAPSHOT"), makeAgUiEvent("RUN_FINISHED")];
    const response = toMuxSseResponse(
      makeA2AGen(a2aChunks),
      makeAgUiGen(agUiEvents, { delayMs: 20 }),
    );
    const body = await readAll(response.body!.getReader());

    // Both frame types present
    expect(body).toContain("data: " + JSON.stringify(makeA2AChunk(1)));
    expect(body).toContain(
      "event: ag-ui\ndata: " + JSON.stringify(makeAgUiEvent("RUN_FINISHED")),
    );

    // The last AG-UI frame appears at a higher offset than the A2A frame
    const a2aPos = body.lastIndexOf("data: " + JSON.stringify(makeA2AChunk(1)));
    const agUiPos = body.lastIndexOf(
      "event: ag-ui\ndata: " + JSON.stringify(makeAgUiEvent("RUN_FINISHED")),
    );
    expect(agUiPos).toBeGreaterThan(a2aPos);
  });

  it("sets SSE + proxy-safe headers", () => {
    const response = toMuxSseResponse(makeA2AGen([]), makeAgUiGen([]));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("A2A generator throw emits JSON-RPC error envelope as a data: frame", async () => {
    const a2a = makeA2AGen([makeA2AChunk(1), makeA2AChunk(2)], { throwAt: 1 });
    const response = toMuxSseResponse(a2a, makeAgUiGen([]));
    const body = await readAll(response.body!.getReader());
    expect(body).toContain('"code":-32603');
    expect(body).toContain('"message":"boom"');
    // Error frame is a `data:` frame (not an `event: ag-ui` frame)
    const errorFrameIdx = body.indexOf('"code":-32603');
    const frameStart = body.lastIndexOf("\n\n", errorFrameIdx) + 2;
    expect(body.slice(frameStart, frameStart + 6)).toBe("data: ");
  });

  it("AG-UI generator throw does NOT emit an error envelope; A2A frames still arrive", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a2aChunks = [makeA2AChunk(1), makeA2AChunk(2)];
      const agUi = makeAgUiGen([makeAgUiEvent("A")], { throwAt: 0 });
      const response = toMuxSseResponse(makeA2AGen(a2aChunks), agUi);
      const body = await readAll(response.body!.getReader());

      // A2A frames still arrive
      expect(body).toContain("data: " + JSON.stringify(makeA2AChunk(1)));
      // No JSON-RPC error envelope from the AG-UI failure
      expect(body).not.toContain('"code":-32603');
      // console.warn was called with the AG-UI error
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("abortSignal closes the stream promptly", async () => {
    const ac = new AbortController();
    const a2a = makeA2AGen([makeA2AChunk(1)], { delayMs: 500 });
    const agUi = makeAgUiGen([makeAgUiEvent("A")], { delayMs: 500 });
    const response = toMuxSseResponse(a2a, agUi, ac.signal);
    // Abort before either generator yields
    ac.abort();
    const body = await readAll(response.body!.getReader());
    // Stream closed promptly; minimal output
    expect(body.length).toBeLessThan(50);
  });

  it("emits a keepalive comment on idle streams", async () => {
    vi.useFakeTimers();

    let resolveYield: ((v: JSONRPCResponse | null) => void) | null = null;
    async function* idleA2A(): AsyncGenerator<JSONRPCResponse> {
      const p = new Promise<JSONRPCResponse | null>((resolve) => {
        resolveYield = resolve;
      });
      const chunk = await p;
      if (chunk) yield chunk;
    }
    async function* emptyAgUi(): AsyncGenerator<unknown> {
      // yields nothing immediately
    }

    const response = toMuxSseResponse(idleA2A(), emptyAgUi());
    const reader = response.body!.getReader();

    // Advance fake timers past the keepalive interval (15s).
    await vi.advanceTimersByTimeAsync(15_000);

    // Read one chunk — must be the keepalive comment.
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toBe(": keepalive\n\n");

    // Cleanup: resolve the generator with null to close the A2A stream.
    (resolveYield as ((v: JSONRPCResponse | null) => void) | null)?.(null);
    vi.useRealTimers();
    await readAll(reader);
  });
});
