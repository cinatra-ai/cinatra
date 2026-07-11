// Unit matrix for the bespoke-sink → AG-UI producer adapter (cinatra#1218).
// The mapping contract is the exact inverse of the S3 reducer's ratified
// bespoke→AG-UI gaps; the full-pipeline equivalence lives in
// ag-ui-cutover-parity.test.ts — this file pins the adapter's own mechanics:
// fresh segment ids, ordered/awaited publishes, terminal exactly-once, the
// agent_run DATA_PART pin, and drain() failure propagation.

import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import {
  createAgUiSinkAdapter,
  extractAgentRunIdFromResult,
} from "../ag-ui-sink-adapter";

function collectingAdapter(overrides?: {
  publish?: (event: AgUiEvent) => Promise<void>;
}) {
  const published: AgUiEvent[] = [];
  const adapter = createAgUiSinkAdapter({
    runId: "run-1",
    threadId: "thread-1",
    publish:
      overrides?.publish ??
      (async (event) => {
        published.push(event);
      }),
  });
  return { adapter, published };
}

describe("createAgUiSinkAdapter — event mapping", () => {
  it("maps a plain text turn to RUN_STARTED / TEXT_MESSAGE_* / RUN_FINISHED", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "Hel" });
    adapter.send("text", { content: "lo" });
    adapter.send("done", {});
    await adapter.drain();
    expect(published.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(adapter.outcome).toBe("completed");
  });

  it("mints a FRESH messageId per text segment (sealed ids are permanent)", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "before" });
    adapter.send("tool_call", { id: "t1", name: "objects_list" });
    adapter.send("tool_result", { id: "t1", name: "objects_list", resultLabel: "x" });
    adapter.send("text", { content: "after" });
    adapter.send("done", {});
    await adapter.drain();
    const starts = published.filter((e) => e.type === "TEXT_MESSAGE_START");
    expect(starts).toHaveLength(2);
    const [a, b] = starts as Array<AgUiEvent & { messageId: string }>;
    expect(a.messageId).not.toBe(b.messageId);
    // The first segment is sealed BEFORE the tool call starts.
    const types = published.map((e) => e.type);
    expect(types.indexOf("TEXT_MESSAGE_END")).toBeLessThan(types.indexOf("TOOL_CALL_START"));
  });

  it("TOOL_CALL_END carries ONLY the toolCallId (ratified label gap)", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "gmail_email_send", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t1",
      name: "gmail_email_send",
      resultLabel: "Email sent",
      serverLabel: "cinatra",
      result: "{}",
    });
    adapter.send("done", {});
    await adapter.drain();
    const end = published.find((e) => e.type === "TOOL_CALL_END") as Record<string, unknown>;
    expect(end.toolCallId).toBe("t1");
    expect("resultLabel" in end).toBe(false);
    expect("serverLabel" in end).toBe(false);
    expect("result" in end).toBe(false);
  });

  it("emits the agent_run DATA_PART pin (and only for parseable runIds)", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "agent_run" });
    adapter.send("tool_result", {
      id: "t1",
      name: "agent_run",
      result: JSON.stringify({ runId: "child-run-9", status: "queued" }),
    });
    adapter.send("tool_call", { id: "t2", name: "agent_run" });
    adapter.send("tool_result", { id: "t2", name: "agent_run", result: "not json" });
    adapter.send("done", {});
    await adapter.drain();
    const parts = published.filter((e) => e.type === "DATA_PART") as Array<{ data: Record<string, unknown> }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].data).toEqual({ kind: "agent_run", toolCallId: "t1", runId: "child-run-9" });
  });

  it("maps citations to a DATA_PART and drops thinking frames", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("thinking_start", { round: 1 });
    adapter.send("citations", { citations: [{ title: "A", url: "https://a.example" }] });
    adapter.send("thinking_end", { round: 1 });
    adapter.send("done", {});
    await adapter.drain();
    const types = published.map((e) => e.type);
    expect(types).toEqual(["RUN_STARTED", "DATA_PART", "RUN_FINISHED"]);
    const dp = published[1] as { data: Record<string, unknown> };
    expect(dp.data.kind).toBe("citations");
  });

  it("error is terminal: seals open text, emits RUN_ERROR, ignores later events", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "partial" });
    adapter.send("error", { message: "boom" });
    adapter.send("text", { content: "after-terminal" });
    adapter.send("done", {});
    await adapter.drain();
    const types = published.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
    expect(adapter.outcome).toBe("error");
    expect(adapter.terminal).toBe(true);
  });

  it("ensureTerminal publishes RUN_FINISHED exactly once for done-less returns", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "explicit dispatch output" });
    adapter.ensureTerminal();
    adapter.ensureTerminal(); // idempotent
    await adapter.drain();
    expect(published.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(1);
    expect(published.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1);
  });

  it("ensureTerminal(message) publishes RUN_ERROR when the runtime threw", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.ensureTerminal("runtime exploded");
    await adapter.drain();
    const err = published.find((e) => e.type === "RUN_ERROR") as { message: string };
    expect(err.message).toBe("runtime exploded");
    expect(adapter.outcome).toBe("error");
  });

  it("onPublishFailure fires ONCE on the first failure (the route's abort hook)", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const adapter = createAgUiSinkAdapter({
      runId: "run-1",
      threadId: "thread-1",
      publish: async () => {
        calls += 1;
        if (calls >= 2) throw new Error("redis down");
      },
      onPublishFailure: (err) => failures.push(err),
    });
    adapter.start();
    adapter.send("text", { content: "x" });
    adapter.send("text", { content: "y" });
    adapter.send("done", {});
    await expect(adapter.drain()).rejects.toThrow("redis down");
    expect(failures).toHaveLength(1);
  });

  it("drain() rethrows the first publish failure (the log IS the wire)", async () => {
    let calls = 0;
    const { adapter } = collectingAdapter({
      publish: async () => {
        calls += 1;
        if (calls === 2) throw new Error("redis down");
      },
    });
    adapter.start();
    adapter.send("text", { content: "x" });
    adapter.send("done", {});
    await expect(adapter.drain()).rejects.toThrow("redis down");
  });
});

describe("extractAgentRunIdFromResult", () => {
  it("parses the runId out of a JSON result", () => {
    expect(extractAgentRunIdFromResult(JSON.stringify({ runId: "r1" }))).toBe("r1");
  });
  it("is defensive on non-JSON / non-string / missing runId", () => {
    expect(extractAgentRunIdFromResult("nope")).toBeNull();
    expect(extractAgentRunIdFromResult(42)).toBeNull();
    expect(extractAgentRunIdFromResult(JSON.stringify({ status: "ok" }))).toBeNull();
  });
});
