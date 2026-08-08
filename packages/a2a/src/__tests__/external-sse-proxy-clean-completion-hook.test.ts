/**
 * cinatra#2497 — the external SSE proxy's clean-completion hook.
 *
 * The external-A2A terminal path materializes the run's declared artifact
 * bindings and can land a run `failed` AFTER a perfectly clean stream. That
 * needs two things from the proxy, and this suite pins both:
 *
 *   1. the run's structured declared outputs (its artifact DATA parts, merged) —
 *      the external analogue of the WayFlow EndNode sentinel DataPart, which is
 *      what the materializer resolves `titleFrom`/`contentFrom` against;
 *   2. terminal AG-UI event OWNERSHIP — the proxy must NOT announce
 *      RUN_FINISHED on a clean stream when the caller still has to decide the
 *      verdict, or the panel gets a success followed by a contradicting error.
 *
 * The hook fires on CLEAN completion only: a timeout or a broken generator must
 * leave the caller's success path unreached and the proxy's own RUN_ERROR intact.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { A2AStreamEventData } from "../external-client";

const published = vi.hoisted(() => ({
  events: [] as Array<{ runId: string; event: unknown }>,
}));

vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async (runId: string, event: unknown) => {
    published.events.push({ runId, event });
  }),
}));

type FakeEvent = Record<string, unknown>;

function makeFakeStream(events: FakeEvent[], options?: { throwAfter?: number }) {
  async function* gen(): AsyncGenerator<A2AStreamEventData, void, undefined> {
    let yielded = 0;
    for (const ev of events) {
      if (typeof options?.throwAfter === "number" && yielded >= options.throwAfter) {
        throw new Error("stream aborted");
      }
      yield ev as unknown as A2AStreamEventData;
      yielded += 1;
    }
  }
  return gen();
}

function dataArtifact(data: Record<string, unknown>): FakeEvent {
  return {
    kind: "artifact-update",
    artifact: { name: "result", parts: [{ kind: "data", data }] },
  };
}

describe("cinatra#2497 — startExternalSseProxyFromStream onCleanCompletion", () => {
  beforeEach(() => {
    published.events = [];
  });

  it("hands the caller every artifact DATA part, merged in arrival order", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([
        { kind: "status-update", status: { state: "working" } },
        dataArtifact({ title: "First title", content: "body" }),
        // A later part wins on a repeated key — last write is the run's answer.
        dataArtifact({ title: "Final title" }),
        { kind: "status-update", status: { state: "completed" } },
      ]),
      "submitted",
      "run-2497-a",
      { onCleanCompletion: (result) => seen.push(result) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.outputs).toEqual({ title: "Final title", content: "body" });
    expect(seen[0]!.lastRemoteState).toBe("completed");
  });

  it("hands the caller null when the stream carried no data part at all", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([
        {
          kind: "artifact-update",
          artifact: { name: "result", parts: [{ kind: "text", text: "prose only" }] },
        },
      ]),
      "submitted",
      "run-2497-b",
      { onCleanCompletion: (result) => seen.push(result) },
    );

    // Called exactly once (the completion IS clean) with an unambiguous
    // "this run surfaced no structured declared outputs" payload.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.outputs).toBeNull();
    // No status-update on the stream ⇒ the caller's peeked initial status stands.
    expect(seen[0]!.lastRemoteState).toBe("submitted");
  });

  it("reports the remote's LAST announced state — a failed task also ends its stream cleanly", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([
        { kind: "status-update", status: { state: "working" } },
        dataArtifact({ title: "partial" }),
        { kind: "status-update", status: { state: "failed" } },
      ]),
      "submitted",
      "run-2497-i",
      { onCleanCompletion: (result) => seen.push(result) },
    );

    // The hook still fires (the STREAM was clean) — it is the caller's job to
    // read the state and refuse any success-only write. Conflating the two is
    // how a remotely-failed task would get artifacts written for it.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.lastRemoteState).toBe("failed");
  });

  it("reads BOTH the state and the DATA parts off a full `task` frame, without bridging it", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    await startExternalSseProxyFromStream(
      // A conformant peer may send NOTHING but a final Task: no status-update,
      // no artifact-update. Missing its artifacts' data parts would leave the
      // caller with `outputs: null` and falsely fail every declared binding.
      makeFakeStream([
        {
          kind: "task",
          id: "t-1",
          contextId: "c-1",
          status: { state: "completed" },
          artifacts: [
            { name: "result", parts: [{ kind: "data", data: { title: "T", content: "C" } }] },
            { name: "extra", parts: [{ kind: "text", text: "prose" }] },
          ],
        },
      ]),
      "submitted",
      "run-2497-j",
      { onCleanCompletion: (result) => seen.push(result) },
    );

    expect(seen[0]!.lastRemoteState).toBe("completed");
    expect(seen[0]!.outputs).toEqual({ title: "T", content: "C" });
    // Bridging behaviour is unchanged: a `task` frame is still not published.
    const bridged = published.events.map((e) => (e.event as { type?: string }).type);
    expect(bridged.filter((t) => t === "artifact")).toHaveLength(0);
    expect(bridged.filter((t) => t === "status")).toHaveLength(1); // only the initial one
  });

  it("merges `task`-frame DATA parts after artifact-update ones, in arrival order", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([
        dataArtifact({ title: "streamed", content: "C" }),
        {
          kind: "task",
          id: "t-1",
          contextId: "c-1",
          status: { state: "completed" },
          artifacts: [{ name: "result", parts: [{ kind: "data", data: { title: "final" } }] }],
        },
      ]),
      "submitted",
      "run-2497-k",
      { onCleanCompletion: (result) => seen.push(result) },
    );

    expect(seen[0]!.outputs).toEqual({ title: "final", content: "C" });
  });

  it("suppresses RUN_FINISHED so the caller owns the terminal AG-UI event", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const agUiTypes: string[] = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([dataArtifact({ title: "T", content: "C" })]),
      "submitted",
      "run-2497-c",
      {
        publishAgUiEvent: (event) => {
          agUiTypes.push(String((event as { type?: string }).type));
        },
        onCleanCompletion: () => undefined,
      },
    );

    expect(agUiTypes).toContain("RUN_STARTED");
    expect(agUiTypes).not.toContain("RUN_FINISHED");
    expect(agUiTypes).not.toContain("RUN_ERROR");
  });

  it("still emits RUN_FINISHED for a caller that does not take the hook", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const agUiTypes: string[] = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([dataArtifact({ title: "T" })]),
      "submitted",
      "run-2497-d",
      {
        publishAgUiEvent: (event) => {
          agUiTypes.push(String((event as { type?: string }).type));
        },
      },
    );

    expect(agUiTypes).toContain("RUN_FINISHED");
  });

  it("does NOT fire on a broken generator, and keeps the proxy's own RUN_ERROR", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];
    const agUiTypes: string[] = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([dataArtifact({ title: "T" }), dataArtifact({ content: "C" })], {
        throwAfter: 1,
      }),
      "submitted",
      "run-2497-e",
      {
        publishAgUiEvent: (event) => {
          agUiTypes.push(String((event as { type?: string }).type));
        },
        onCleanCompletion: (result) => seen.push(result),
      },
    );

    expect(seen).toHaveLength(0);
    expect(agUiTypes).toContain("RUN_ERROR");
    expect(agUiTypes).not.toContain("RUN_FINISHED");
  });

  it("does NOT fire on a max-duration timeout", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const seen: Array<{ outputs: Record<string, unknown> | null; lastRemoteState: string }> = [];

    async function* slowStream(): AsyncGenerator<A2AStreamEventData, void, undefined> {
      yield dataArtifact({ title: "T" }) as unknown as A2AStreamEventData;
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield dataArtifact({ content: "C" }) as unknown as A2AStreamEventData;
    }

    await startExternalSseProxyFromStream(slowStream(), "submitted", "run-2497-f", {
      maxDurationMs: 10,
      onCleanCompletion: (result) => seen.push(result),
    });

    expect(seen).toHaveLength(0);
    const reasons = published.events
      .map((e) => e.event as { type?: string; reason?: string })
      .filter((e) => e.type === "error")
      .map((e) => e.reason);
    expect(reasons).toContain("timeout");
  });

  it("a throwing hook is swallowed — the proxy still resolves and emits exactly one done", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      startExternalSseProxyFromStream(
        makeFakeStream([dataArtifact({ title: "T" })]),
        "submitted",
        "run-2497-g",
        {
          onCleanCompletion: () => {
            throw new Error("caller blew up");
          },
        },
      ),
    ).resolves.toBeUndefined();

    const doneCount = published.events.filter(
      (e) => (e.event as { type?: string }).type === "done",
    ).length;
    expect(doneCount).toBe(1);
    errorSpy.mockRestore();
  });

  it("leaves the DATA_PART AG-UI emission and text accumulation untouched", async () => {
    const { startExternalSseProxyFromStream } = await import("../external-sse-proxy");
    const agUi: Array<Record<string, unknown>> = [];
    const persisted: string[] = [];

    await startExternalSseProxyFromStream(
      makeFakeStream([
        {
          kind: "artifact-update",
          artifact: {
            name: "result",
            parts: [
              { kind: "text", text: "hello" },
              { kind: "data", data: { title: "T" } },
            ],
          },
        },
      ]),
      "submitted",
      "run-2497-h",
      {
        publishAgUiEvent: (event) => {
          agUi.push(event as Record<string, unknown>);
        },
        persistStreamedText: (text) => {
          persisted.push(text);
        },
        onCleanCompletion: () => undefined,
      },
    );

    expect(persisted).toEqual(["hello"]);
    const dataParts = agUi.filter((e) => e.type === "DATA_PART");
    expect(dataParts).toHaveLength(1);
    expect(dataParts[0]).toMatchObject({ data: { title: "T" }, partIndex: 0 });
  });
});
