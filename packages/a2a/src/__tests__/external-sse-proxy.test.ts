/**
 * Tests for the external SSE proxy stream bridge.
 *
 * Tests `startExternalSseProxyFromStream(stream, initialStatus, runId, options?)` in
 * `packages/a2a/src/external-sse-proxy.ts`. The function bridges a pre-started
 * A2A SSE AsyncGenerator into the local Redis run event channel.
 *
 * Contract:
 *   - Publishes initial status immediately.
 *   - Maps status-update -> { type: "status" }, artifact-update -> { type: "artifact" }.
 *   - Emits a final { type: "done" } exactly once per run.
 *   - On generator error: publishes { type: "error", reason } then exactly one { type: "done" }.
 *   - On timeout (abort): publishes { type: "error", reason: "timeout" } then exactly one { type: "done" }.
 *   - Unknown/malformed events: console.warn + skip (never crashes iteration).
 *   - Always resolves (never rejects).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { A2AStreamEventData } from "../external-client";

// ---------------------------------------------------------------------------
// Hoisted mock state — streaming-bridge mocked so tests don't need live Redis.
// ---------------------------------------------------------------------------

const published = vi.hoisted(() => ({
  events: [] as Array<{ runId: string; event: unknown }>,
}));

vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async (runId: string, event: unknown) => {
    published.events.push({ runId, event });
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type FakeEvent = Record<string, unknown>;

function makeFakeStream(events: FakeEvent[], options?: { throwAfter?: number }) {
  async function* gen(): AsyncGenerator<A2AStreamEventData, void, undefined> {
    let yielded = 0;
    for (const ev of events) {
      if (
        typeof options?.throwAfter === "number" &&
        yielded >= options.throwAfter
      ) {
        throw new Error("stream aborted");
      }
      yield ev as unknown as A2AStreamEventData;
      yielded += 1;
    }
  }
  return gen();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startExternalSseProxyFromStream", () => {
  beforeEach(() => {
    published.events = [];
  });

  it("publishes mapped status-update, artifact-update, and final done events", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");

    const stream = makeFakeStream([
      { kind: "status-update", status: { state: "working" } },
      {
        kind: "artifact-update",
        artifact: { name: "result", parts: [{ kind: "text", text: "hello" }] },
      },
      { kind: "status-update", status: { state: "completed" } },
    ]);

    await startExternalSseProxyFromStream(stream, "submitted", "run-42");

    // Every published event MUST be keyed on the runId the caller passed in.
    for (const entry of published.events) {
      expect(entry.runId).toBe("run-42");
    }

    // Every stream MUST terminate with exactly one `done` event.
    const doneCount = published.events.filter(
      (e) => (e.event as { type?: string }).type === "done",
    ).length;
    expect(doneCount).toBe(1);

    // At least one artifact event should have been published.
    const hasArtifact = published.events.some(
      (e) => (e.event as { type?: string }).type === "artifact",
    );
    expect(hasArtifact).toBe(true);
  });

  it("publishes an error event and exactly one done on generator failure", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");

    const stream = makeFakeStream(
      [
        { kind: "status-update", status: { state: "working" } },
        { kind: "status-update", status: { state: "working" } },
      ],
      { throwAfter: 1 },
    );

    await startExternalSseProxyFromStream(stream, "submitted", "run-err");

    const types = published.events.map(
      (e) => (e.event as { type?: string }).type,
    );
    // Exactly one terminal done.
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    // Error event observed before done.
    expect(types).toContain("error");
    const errorIdx = types.indexOf("error");
    const doneIdx = types.indexOf("done");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errorIdx);
  });

  // -------------------------------------------------------------------------
  // Timeout path — polling generator so the abort-check in the
  // for-await loop fires without hanging the test forever.
  // -------------------------------------------------------------------------
  it("fires timeout error + done and stops the proxy when maxDurationMs elapses", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");

    // Generator that polls every 1ms — the for-await loop's abort check fires
    // between yields once the proxy's internal timeout fires.
    async function* slowStream(): AsyncGenerator<A2AStreamEventData, void, undefined> {
      yield { kind: "status-update", status: { state: "working" } } as unknown as A2AStreamEventData;
      for (let i = 0; i < 10_000; i++) {
        await new Promise<void>((r) => setTimeout(r, 1));
        yield { kind: "status-update", status: { state: "working" } } as unknown as A2AStreamEventData;
      }
    }

    await startExternalSseProxyFromStream(slowStream(), "submitted", "run-timeout", {
      maxDurationMs: 25,
    });

    const types = published.events.map(
      (e) => (e.event as { type?: string }).type,
    );
    const reasons = published.events
      .map((e) => (e.event as { reason?: string }).reason)
      .filter(Boolean);

    // Exactly one terminal done (single-done invariant even under timeout).
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    // Timeout error carries reason: "timeout".
    expect(reasons).toContain("timeout");
    // Error comes before done.
    const errorIdx = types.indexOf("error");
    const doneIdx = types.indexOf("done");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errorIdx);
  });

  // -------------------------------------------------------------------------
  // Unknown-kind + malformed event paths — warn and skip.
  // -------------------------------------------------------------------------
  it("logs console.warn and skips unknown event kinds and malformed events", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* silence in test output */
    });

    async function* weirdStream(): AsyncGenerator<A2AStreamEventData, void, undefined> {
      yield { kind: "weird-unsupported" } as unknown as A2AStreamEventData;
      yield "not-an-object" as unknown as A2AStreamEventData;
      yield { kind: "message" } as unknown as A2AStreamEventData;
      yield { kind: "task" } as unknown as A2AStreamEventData;
      yield { kind: "status-update", status: { state: "working" } } as unknown as A2AStreamEventData;
    }

    await startExternalSseProxyFromStream(weirdStream(), "submitted", "run-weird");

    // Proxy must not have crashed; terminal done still emitted exactly once.
    const types = published.events.map(
      (e) => (e.event as { type?: string }).type,
    );
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    // console.warn fired for at least the unknown kind + malformed event.
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // None of the unsupported kinds led to a published artifact event.
    expect(types.includes("artifact")).toBe(false);
    // The valid status-update AFTER the skipped events was still published.
    const statusEvents = published.events.filter(
      (e) => (e.event as { type?: string }).type === "status",
    );
    // initial submitted + working
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Single-done invariant — always resolves, never rejects.
  // -------------------------------------------------------------------------
  it("always resolves (never rejects) on happy, error, and timeout paths", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");

    // Happy path.
    await expect(
      startExternalSseProxyFromStream(
        makeFakeStream([{ kind: "status-update", status: { state: "completed" } }]),
        "submitted",
        "run-happy",
      ),
    ).resolves.toBeUndefined();

    // Error path.
    await expect(
      startExternalSseProxyFromStream(
        makeFakeStream(
          [{ kind: "status-update", status: { state: "working" } }],
          { throwAfter: 0 },
        ),
        "submitted",
        "run-err-resolves",
      ),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // persistStreamedText(text) is called EXACTLY ONCE on clean completion with
  // the concatenated accumulated text of all text parts.
  // ---------------------------------------------------------------------------
  it("calls persistStreamedText once on clean completion with accumulated text", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const persisted: string[] = [];

    const stream = makeFakeStream([
      { kind: "status-update", status: { state: "working" } },
      {
        kind: "artifact-update",
        artifact: { name: "result", parts: [{ kind: "text", text: "Hello, " }] },
      },
      {
        kind: "artifact-update",
        artifact: { name: "result", parts: [{ kind: "text", text: "World!" }] },
      },
      { kind: "status-update", status: { state: "completed" } },
    ]);

    await startExternalSseProxyFromStream(stream, "submitted", "run-persist-ok", {
      publishAgUiEvent: () => undefined,
      persistStreamedText: (text: string) => {
        persisted.push(text);
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain("Hello, ");
    expect(persisted[0]).toContain("World!");
    expect(persisted[0].endsWith("\n\n")).toBe(false);
  });

  it("does NOT call persistStreamedText on timeout", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const persisted: string[] = [];

    async function* slowStream(): AsyncGenerator<A2AStreamEventData, void, undefined> {
      yield { kind: "status-update", status: { state: "working" } } as unknown as A2AStreamEventData;
      for (let i = 0; i < 10_000; i++) {
        await new Promise<void>((r) => setTimeout(r, 1));
        yield { kind: "status-update", status: { state: "working" } } as unknown as A2AStreamEventData;
      }
    }

    await startExternalSseProxyFromStream(slowStream(), "submitted", "run-persist-timeout", {
      maxDurationMs: 25,
      publishAgUiEvent: () => undefined,
      persistStreamedText: (text: string) => {
        persisted.push(text);
      },
    });

    expect(persisted).toHaveLength(0);
  });

  it("does NOT call persistStreamedText on generator error", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const persisted: string[] = [];

    const stream = makeFakeStream(
      [
        { kind: "artifact-update", artifact: { name: "r", parts: [{ kind: "text", text: "partial" }] } },
        { kind: "status-update", status: { state: "working" } },
      ],
      { throwAfter: 1 },
    );

    await startExternalSseProxyFromStream(stream, "submitted", "run-persist-err", {
      publishAgUiEvent: () => undefined,
      persistStreamedText: (text: string) => {
        persisted.push(text);
      },
    });

    expect(persisted).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Each artifact-update with a kind:"data" part yields a DATA_PART event via
  // publishAgUiEvent carrying the data object verbatim.
  // ---------------------------------------------------------------------------
  it("emits one DATA_PART per kind:data artifact part", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const agUi: Array<Record<string, unknown>> = [];

    const stream = makeFakeStream([
      {
        kind: "artifact-update",
        artifact: {
          name: "structured",
          parts: [
            { kind: "data", data: { foo: 1 } },
            { kind: "text", text: "hello" },
            { kind: "data", data: { bar: 2 } },
          ],
        },
      },
      { kind: "status-update", status: { state: "completed" } },
    ]);

    await startExternalSseProxyFromStream(stream, "submitted", "run-data-part", {
      publishAgUiEvent: (event) => {
        agUi.push(event);
      },
    });

    const dataPartEvents = agUi.filter((e) => e.type === "DATA_PART");
    expect(dataPartEvents).toHaveLength(2);
    expect(dataPartEvents[0]).toMatchObject({ type: "DATA_PART", data: { foo: 1 } });
    expect(dataPartEvents[1]).toMatchObject({ type: "DATA_PART", data: { bar: 2 } });
  });
});
