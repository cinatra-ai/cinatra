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

// cinatra#2935 (lifecycle-b W5d) — the platform's report now rides on a start's
// answer beside the run id. The card is drawn from that answer, so the pin is
// asserted against the answer's REAL shape rather than trusted to be additive.
describe("the run-card pin, once a start's answer carries the platform's report", () => {
  const RUN_ID = "06a703fe-e779-4ba5-852c-73c41c513924";
  const REPORT =
    "Dispatched `@cinatra-ai/blog-draft-writer-agent` " +
    `(runId: \`${RUN_ID}\`, status: \`queued\`). The run started.`;

  it("reads the SAME run out of an answer with the report as one without it", () => {
    const withReport = JSON.stringify({ runId: RUN_ID, status: "queued", message: REPORT });
    const withoutReport = JSON.stringify({ runId: RUN_ID, status: "queued" });
    expect(extractAgentRunIdFromResult(withReport)).toBe(RUN_ID);
    expect(extractAgentRunIdFromResult(withReport)).toBe(
      extractAgentRunIdFromResult(withoutReport),
    );
  });

  it("reads the same run out of the widget door's answer, which relays that report", () => {
    const widgetAnswer = JSON.stringify({
      ok: true,
      runId: RUN_ID,
      status: "queued",
      message: REPORT,
    });
    expect(extractAgentRunIdFromResult(widgetAnswer)).toBe(RUN_ID);
  });

  it("a REFUSED start pins no run, because its answer carries no run id", () => {
    const refused = JSON.stringify({
      ok: false,
      message: "You can't start this agent. Nothing was started.",
    });
    expect(extractAgentRunIdFromResult(refused)).toBeNull();
  });
});

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

  it("S5 (cinatra#2390): a classification CODE on the error sink event rides the RUN_ERROR frame", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("error", { message: "skills not synced yet", code: "anthropic_skill_not_synced" });
    await adapter.drain();
    const err = published.find((e) => e.type === "RUN_ERROR") as {
      message: string;
      code?: string;
    };
    expect(err.message).toBe("skills not synced yet");
    expect(err.code).toBe("anthropic_skill_not_synced");
  });

  it("S5 (cinatra#2390): ensureTerminal(message, code) carries the code; an absent code emits none", async () => {
    const withCode = collectingAdapter();
    withCode.adapter.start();
    withCode.adapter.ensureTerminal("classified failure", "assistant_run_failed");
    await withCode.adapter.drain();
    const coded = withCode.published.find((e) => e.type === "RUN_ERROR") as { code?: string };
    expect(coded.code).toBe("assistant_run_failed");

    const withoutCode = collectingAdapter();
    withoutCode.adapter.start();
    withoutCode.adapter.send("error", { message: "plain" });
    await withoutCode.adapter.drain();
    const plain = withoutCode.published.find((e) => e.type === "RUN_ERROR") as Record<
      string,
      unknown
    >;
    expect("code" in plain).toBe(false);
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

describe("createAgUiSinkAdapter — durable content accumulation (PR1 EXPAND)", () => {
  it("accumulates the full assistant text + an ordered part trace", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "Hel" });
    adapter.send("text", { content: "lo" });
    adapter.send("tool_call", { id: "t1", name: "objects_list", serverLabel: "cinatra" });
    adapter.send("tool_result", { id: "t1", name: "objects_list", serverLabel: "cinatra", resultLabel: "0 found", result: "[]" });
    adapter.send("text", { content: "done" });
    adapter.send("citations", { citations: [{ title: "A", url: "https://a.example" }] });
    adapter.send("done", {});
    await adapter.drain();
    const durable = adapter.durableContent();
    expect(durable).not.toBeNull();
    // Full concatenated assistant text (more than terminal text).
    expect(durable!.content).toBe("Hellodone");
    expect(durable!.format).toBe("assistant-turn-v1");
    expect(durable!.role).toBe("assistant");
    // Ordered trace: text segment (sealed at the tool call) / tool_call /
    // tool_result / text segment / citations. Tool parts are LOSSLESS at the
    // sink boundary — serverLabel/resultLabel/result are retained for faithful
    // reconstruction after Redis loss (the AG-UI wire drops them by the reducer
    // gap, durability keeps them).
    expect(durable!.parts).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_call", id: "t1", name: "objects_list", serverLabel: "cinatra" },
      { type: "tool_result", id: "t1", name: "objects_list", serverLabel: "cinatra", resultLabel: "0 found", result: "[]" },
      { type: "text", text: "done" },
      { type: "citations", citations: [{ title: "A", url: "https://a.example" }] },
    ]);
    // A turn that minted no renderable view carries NO `dataParts` key at all
    // (cinatra#2823 S9j field-presence discipline) — the citations DATA_PART is
    // durable as the ordered part above, and must not be counted twice.
    expect("dataParts" in durable!).toBe(false);
  });

  // ── the durable DATA_PART half of the S9j persistence bridge (cinatra#2823) ──

  it("KEEPS the lifecycle DATA_PART it minted, so a reload can redraw the card", async () => {
    const { adapter, published } = collectingAdapter();
    const envelope = JSON.stringify({
      $cinatraLifecycleView: 1,
      viewType: "artifact_review_gate",
      ref: "gate-ref-1",
    });
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "artifact_review_gate_render", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
      result: envelope,
    });
    adapter.send("done", {});
    await adapter.drain();
    const onTheWire = published
      .filter((e) => e.type === "DATA_PART")
      .map((e) => (e as { data: unknown }).data);
    // The point of the bridge, in one assertion: what the wire carried and what
    // the durable row keeps are the SAME payload. A card that existed only on
    // the wire is a card that disappears on the next reload.
    expect(onTheWire).toEqual([
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-ref-1" },
    ]);
    expect(adapter.durableContent()!.dataParts).toEqual(onTheWire);
  });

  it("KEEPS the agent_run pin, in emission order, beside a lifecycle view", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "agent_run" });
    adapter.send("tool_result", { id: "t1", name: "agent_run", result: JSON.stringify({ runId: "run-A" }) });
    adapter.send("tool_call", { id: "t2", name: "verification_record_render", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t2",
      name: "verification_record_render",
      serverLabel: "cinatra",
      result: JSON.stringify({ $cinatraLifecycleView: 1, viewType: "verification_summary", ref: "v-1" }),
    });
    adapter.send("done", {});
    await adapter.drain();
    expect(adapter.durableContent()!.dataParts).toEqual([
      { kind: "agent_run", toolCallId: "t1", runId: "run-A" },
      { viewType: "verification_summary", schemaVersion: 1, ref: "v-1" },
    ]);
  });

  // ── the SLOT the durable row records out of band (cinatra#2823 round 3) ────

  it("records the PRODUCING SLOT beside the payload, never inside it", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "agent_run" });
    adapter.send("tool_result", { id: "t1", name: "agent_run", result: JSON.stringify({ runId: "run-A" }) });
    adapter.send("tool_call", { id: "t2", name: "artifact_review_gate_render", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t2",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
      result: JSON.stringify({ $cinatraLifecycleView: 1, viewType: "artifact_review_gate", ref: "gate-ref-1" }),
    });
    adapter.send("done", {});
    await adapter.drain();
    const durable = adapter.durableContent()!;
    // The payload is the byte-identical strict object a `.strict()` parser
    // accepts on re-read — the slot is NOT in it, or reload would re-emit it as
    // payload and the parser would reject the card.
    expect(durable.dataParts).toEqual([
      { kind: "agent_run", toolCallId: "t1", runId: "run-A" },
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-ref-1" },
    ]);
    // ...and the slot rides a sibling array, positionally aligned. `agent_run`
    // carries its `toolCallId` as a payload FIELD of that kind and is not a
    // stamped slot, so its entry is null.
    expect(durable.dataPartSlots).toEqual([null, "t2"]);
    // The row's stamp is the WIRE's stamp — one statement, not two.
    const stamped = published.find(
      (e) => e.type === "DATA_PART" && (e as { data: { viewType?: string } }).data.viewType,
    ) as { toolCallId?: string };
    expect(stamped.toolCallId).toBe("t2");
  });

  it("OMITS dataPartSlots when nothing was stamped (byte-identical to before)", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "agent_run" });
    adapter.send("tool_result", { id: "t1", name: "agent_run", result: JSON.stringify({ runId: "run-A" }) });
    adapter.send("done", {});
    await adapter.drain();
    const durable = adapter.durableContent()!;
    expect(durable.dataParts).toEqual([{ kind: "agent_run", toolCallId: "t1", runId: "run-A" }]);
    expect("dataPartSlots" in durable).toBe(false);
  });

  it("keeps NO dataParts for a refused envelope — nothing was minted to keep", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "artifact_review_gate_render", serverLabel: "not-cinatra" });
    adapter.send("tool_result", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "not-cinatra",
      result: JSON.stringify({ $cinatraLifecycleView: 1, viewType: "artifact_review_gate", ref: "forged" }),
    });
    adapter.send("done", {});
    await adapter.drain();
    expect("dataParts" in adapter.durableContent()!).toBe(false);
  });

  it("preserves the citation boundary in the durable part trace (text A / citations / text B)", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "A" });
    adapter.send("citations", { citations: [{ title: "S", url: "https://s.example" }] });
    adapter.send("text", { content: "B" });
    adapter.send("done", {});
    await adapter.drain();
    const durable = adapter.durableContent();
    // Ordered trace keeps the boundary; content is still the full concatenation.
    expect(durable!.content).toBe("AB");
    expect(durable!.parts).toEqual([
      { type: "text", text: "A" },
      { type: "citations", citations: [{ title: "S", url: "https://s.example" }] },
      { type: "text", text: "B" },
    ]);
    // The AG-UI WIRE is unchanged: citations does NOT seal the text segment, so
    // there is exactly ONE TEXT_MESSAGE_START/END pair around the whole text.
    expect(published.filter((e) => e.type === "TEXT_MESSAGE_START")).toHaveLength(1);
    expect(published.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1);
  });

  it("returns null when the turn produced nothing (immediate error)", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("error", { message: "boom" });
    await adapter.drain();
    expect(adapter.durableContent()).toBeNull();
  });

  it("captures partial text produced before a terminal error", async () => {
    const { adapter } = collectingAdapter();
    adapter.start();
    adapter.send("text", { content: "partial" });
    adapter.send("error", { message: "boom" });
    await adapter.drain();
    expect(adapter.durableContent()).toEqual({
      format: "assistant-turn-v1",
      role: "assistant",
      content: "partial",
      parts: [{ type: "text", text: "partial" }],
    });
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

// ---------------------------------------------------------------------------
// The lifecycle typed-view producer arm (cinatra#2565, epic #2564 S1).
// The recognizer's own matrix lives in lifecycle-view-envelope.test.ts; these
// cases pin what the SINK does with its verdict — including the invariants the
// tool_result arm already had, which this slice must not have moved.
// ---------------------------------------------------------------------------

describe("createAgUiSinkAdapter — lifecycle typed-view DATA_PART", () => {
  const lifecycleEnvelope = JSON.stringify({
    $cinatraLifecycleView: 1,
    viewType: "artifact_review_gate",
    ref: "ref-abc",
  });

  it("mints a ref-only DATA_PART after TOOL_CALL_END for an allowlisted first-party tool", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
    });
    adapter.send("tool_result", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
      result: lifecycleEnvelope,
    });
    adapter.send("done", {});
    await adapter.drain();
    const types = published.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "DATA_PART",
      "RUN_FINISHED",
    ]);
    const part = published.find((e) => e.type === "DATA_PART") as { data: unknown };
    expect(part.data).toEqual({
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref: "ref-abc",
    });
  });

  it("mints NOTHING for the same envelope from an external MCP server (forged card)", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "external-hostile",
    });
    adapter.send("tool_result", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "external-hostile",
      result: lifecycleEnvelope,
    });
    adapter.send("done", {});
    await adapter.drain();
    expect(published.filter((e) => e.type === "DATA_PART")).toHaveLength(0);
  });

  it("mints NOTHING on the refusal path, and the persisted result carries no identifiers", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
    });
    adapter.send("tool_result", {
      id: "t1",
      name: "artifact_review_gate_render",
      serverLabel: "cinatra",
      result: "Not available to you.",
    });
    adapter.send("done", {});
    await adapter.drain();
    expect(published.filter((e) => e.type === "DATA_PART")).toHaveLength(0);
    // The durable content is what lands in `assistant_turns.content` and is
    // re-fed to the model — the RESULT must not become an enumeration oracle.
    // (The tool NAME is already visible from the tool_call chip and says only
    // which primitive ran, never which row it was asked about.)
    const durable = adapter.durableContent();
    const result = durable?.parts.find((p) => p.type === "tool_result") as {
      result?: string;
    };
    expect(result.result).toBe("Not available to you.");
    expect(result.result).not.toMatch(/\d/);
    expect(result.result).not.toMatch(/run-|task-|ref-|rt[0-9]/i);
  });

  it("REGRESSION: an ordinary tool result still emits TOOL_CALL_END only", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "objects_list", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t1",
      name: "objects_list",
      serverLabel: "cinatra",
      result: JSON.stringify([{ id: "o1" }]),
    });
    adapter.send("done", {});
    await adapter.drain();
    expect(published.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
  });

  it("REGRESSION: the agent_run pin and a lifecycle view do not interfere", async () => {
    const { adapter, published } = collectingAdapter();
    adapter.start();
    adapter.send("tool_call", { id: "t1", name: "agent_run", serverLabel: "cinatra" });
    adapter.send("tool_result", {
      id: "t1",
      name: "agent_run",
      serverLabel: "cinatra",
      result: JSON.stringify({ runId: "child-run-9" }),
    });
    adapter.send("done", {});
    await adapter.drain();
    const parts = published.filter((e) => e.type === "DATA_PART") as Array<{ data: unknown }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].data).toEqual({
      kind: "agent_run",
      toolCallId: "t1",
      runId: "child-run-9",
    });
  });
});
