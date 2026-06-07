import { describe, expect, it } from "vitest";
import {
  applyTextDelta,
  applyToolCallEvent,
  applyToolResultEvent,
  hydrateLegacyParts,
  type AssistantMessagePart,
} from "../assistant-parts";

describe("applyTextDelta", () => {
  it("creates a new text part when parts is empty", () => {
    const result = applyTextDelta([], "Hello");
    expect(result).toEqual([{ kind: "text", content: "Hello" }]);
  });

  it("extends the tail text part when the last part is text", () => {
    const parts: AssistantMessagePart[] = [{ kind: "text", content: "Hello " }];
    const result = applyTextDelta(parts, "world");
    expect(result).toEqual([{ kind: "text", content: "Hello world" }]);
  });

  it("pushes a new text part when the tail is a tool_call", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "text", content: "Checking… " },
      { kind: "tool_call", id: "t1", name: "agent_list", status: "completed" },
    ];
    const result = applyTextDelta(parts, "Found one!");
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ kind: "text", content: "Found one!" });
  });

  it("is a no-op for an empty delta", () => {
    const parts: AssistantMessagePart[] = [{ kind: "text", content: "Hi" }];
    const result = applyTextDelta(parts, "");
    expect(result).toBe(parts);
  });

  it("treats whitespace-only deltas as content (caller decides whether to skip)", () => {
    const parts: AssistantMessagePart[] = [{ kind: "text", content: "Hi" }];
    const result = applyTextDelta(parts, "\n\n");
    expect(result).toEqual([{ kind: "text", content: "Hi\n\n" }]);
  });
});

describe("applyToolCallEvent", () => {
  it("appends a new tool_call part with status=running", () => {
    const result = applyToolCallEvent([], {
      id: "call_1",
      name: "agent_source_list",
      serverLabel: "cinatra",
    });
    expect(result).toEqual([
      {
        kind: "tool_call",
        id: "call_1",
        name: "agent_source_list",
        status: "running",
        serverLabel: "cinatra",
      },
    ]);
  });

  it("preserves text parts already in the trace", () => {
    const parts: AssistantMessagePart[] = [{ kind: "text", content: "Checking…" }];
    const result = applyToolCallEvent(parts, {
      id: "call_1",
      name: "agent_list",
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: "text", content: "Checking…" });
    expect(result[1]).toMatchObject({ kind: "tool_call", id: "call_1", status: "running" });
  });

  it("dedupes by id (no duplicate tool_call parts on retry)", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "call_1", name: "agent_list", status: "running" },
    ];
    const result = applyToolCallEvent(parts, {
      id: "call_1",
      name: "agent_list",
    });
    expect(result).toBe(parts);
  });

  it("treats serverLabel as optional", () => {
    const result = applyToolCallEvent([], { id: "call_1", name: "agent_list" });
    expect((result[0] as { serverLabel?: string }).serverLabel).toBeUndefined();
  });
});

describe("applyToolResultEvent", () => {
  it("mutates matching tool_call to completed and attaches resultLabel", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "call_1", name: "agent_list", status: "running" },
    ];
    const result = applyToolResultEvent(parts, {
      id: "call_1",
      resultLabel: "6 agent found",
    });
    expect(result[0]).toMatchObject({
      kind: "tool_call",
      id: "call_1",
      status: "completed",
      resultLabel: "6 agent found",
    });
  });

  it("preserves serverLabel from the matching tool_call when the event doesn't supply one", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "c1", name: "n", status: "running", serverLabel: "cinatra" },
    ];
    const result = applyToolResultEvent(parts, { id: "c1", resultLabel: "ok" });
    expect((result[0] as { serverLabel?: string }).serverLabel).toBe("cinatra");
  });

  it("overwrites serverLabel when the event supplies one", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "c1", name: "n", status: "running", serverLabel: "cinatra" },
    ];
    const result = applyToolResultEvent(parts, {
      id: "c1",
      resultLabel: "ok",
      serverLabel: "external-x",
    });
    expect((result[0] as { serverLabel?: string }).serverLabel).toBe("external-x");
  });

  it("returns the same reference when no matching tool_call exists (stray tool_result)", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "c1", name: "n", status: "running" },
    ];
    const result = applyToolResultEvent(parts, { id: "no-such-id", resultLabel: "x" });
    expect(result).toBe(parts);
  });

  it("supports a status: 'failed' override", () => {
    const parts: AssistantMessagePart[] = [
      { kind: "tool_call", id: "c1", name: "n", status: "running" },
    ];
    const result = applyToolResultEvent(parts, { id: "c1", status: "failed" });
    expect((result[0] as { status: string }).status).toBe("failed");
  });
});

describe("hydrateLegacyParts", () => {
  it("returns null when the message has no content and no tool calls", () => {
    expect(hydrateLegacyParts({ content: "", thoughtGroups: [] })).toBeNull();
  });

  it("returns null when content is only whitespace and no tool calls", () => {
    expect(hydrateLegacyParts({ content: "   \n  ", thoughtGroups: [] })).toBeNull();
  });

  it("hydrates a content-only message to a single text part", () => {
    expect(hydrateLegacyParts({ content: "Hello", thoughtGroups: [] })).toEqual([
      { kind: "text", content: "Hello" },
    ]);
  });

  it("emits tool calls FIRST then content (mirrors legacy visual order)", () => {
    const result = hydrateLegacyParts({
      content: "Done.",
      thoughtGroups: [
        {
          toolCalls: [
            { id: "c1", name: "agent_list", status: "completed", resultLabel: "6 found" },
            { id: "c2", name: "agent_run", status: "completed", resultLabel: "queued" },
          ],
        },
      ],
    });
    expect(result).toHaveLength(3);
    expect(result?.[0]).toMatchObject({ kind: "tool_call", id: "c1" });
    expect(result?.[1]).toMatchObject({ kind: "tool_call", id: "c2" });
    expect(result?.[2]).toEqual({ kind: "text", content: "Done." });
  });

  it("flattens tool calls across multiple thoughtGroups", () => {
    const result = hydrateLegacyParts({
      content: "",
      thoughtGroups: [
        { toolCalls: [{ id: "a", name: "n", status: "completed" }] },
        { toolCalls: [{ id: "b", name: "m", status: "running" }] },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result?.[0]).toMatchObject({ id: "a" });
    expect(result?.[1]).toMatchObject({ id: "b", status: "running" });
  });

  it("preserves resultLabel and serverLabel on hydrated tool calls", () => {
    const result = hydrateLegacyParts({
      content: "",
      thoughtGroups: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "agent_list",
              status: "completed",
              resultLabel: "6 agent found",
              serverLabel: "cinatra",
            },
          ],
        },
      ],
    });
    expect(result?.[0]).toMatchObject({
      kind: "tool_call",
      resultLabel: "6 agent found",
      serverLabel: "cinatra",
    });
  });
});
