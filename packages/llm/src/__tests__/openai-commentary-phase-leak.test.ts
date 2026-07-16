/**
 * Regression guard for cinatra#1694: gpt-5.5 emits its raw chain-of-thought
 * as a `message` item with phase="commentary" — NOT as a `reasoning` item —
 * so the item-type leak guard passed it straight into the user-visible reply,
 * concatenated onto the real answer (phase="final_answer").
 *
 * These tests drive the REAL adapter paths (stream, un-streamed fallback,
 * generate, generateWithFileInput) with scripted Responses API shapes and pin:
 *   - commentary text NEVER reaches onTextDelta / the returned text,
 *   - final_answer text always does,
 *   - messages with NO phase keep their current behavior (legacy models and
 *     stream shapes that predate the field),
 *   - the non-streaming extractors no longer depend on the
 *     "final answer happens to come last" ordering accident.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { responsesCreate, responsesStream } = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  responsesStream: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: responsesCreate, stream: responsesStream };
    constructor(_opts: unknown) {}
  },
}));

// Provider surfaces resolve to "absent" — the adapter's log-writer lookup
// no-ops; the extraction paths under test are independent of the surface.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import { createOpenAIProviderAdapter } from "../providers/openai";

const COMMENTARY_TEXT = "(wait? tool result missing? We shouldn't spam. But no tool.";
const FINAL_TEXT = "Sorry — I can't create that dashboard from here.";

function messageItem(phase: string | undefined, text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    ...(phase !== undefined ? { phase } : {}),
    content: [{ type: "output_text", text }],
  };
}

function scriptedStream(events: unknown[], finalResponse: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalResponse: async () => finalResponse,
  };
}

function collectCallbacks() {
  const chunks: string[] = [];
  const errors: Error[] = [];
  return {
    chunks,
    errors,
    callbacks: {
      onTextDelta: (delta: string) => {
        chunks.push(delta);
      },
      onToolCall: () => {},
      onToolResult: () => {},
      onStepStart: () => {},
      onStepEnd: () => {},
      onError: (error: Error) => {
        errors.push(error);
      },
    },
  };
}

beforeEach(() => {
  responsesCreate.mockReset();
  responsesStream.mockReset();
});

describe("stream — output_text.delta phase guard", () => {
  it("drops commentary-item deltas and emits only final_answer deltas", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    const { chunks, errors, callbacks } = collectCallbacks();

    responsesStream.mockReturnValue(
      scriptedStream(
        [
          { type: "response.output_item.added", item: { type: "message", phase: "commentary" } },
          { type: "response.output_text.delta", delta: COMMENTARY_TEXT },
          { type: "response.output_item.done" },
          { type: "response.output_item.added", item: { type: "message", phase: "final_answer" } },
          { type: "response.output_text.delta", delta: FINAL_TEXT },
          { type: "response.output_item.done" },
        ],
        {
          status: "completed",
          output: [messageItem("commentary", COMMENTARY_TEXT), messageItem("final_answer", FINAL_TEXT)],
        },
      ),
    );

    await adapter.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], ...callbacks });

    expect(errors).toEqual([]);
    expect(chunks.join("")).toBe(FINAL_TEXT);
    expect(chunks.join("")).not.toContain("wait? tool result missing");
  });

  it("keeps emitting for message items with no phase (pre-phase models/streams)", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    const { chunks, errors, callbacks } = collectCallbacks();

    responsesStream.mockReturnValue(
      scriptedStream(
        [
          { type: "response.output_item.added", item: { type: "message" } },
          { type: "response.output_text.delta", delta: "Hello" },
          { type: "response.output_item.done" },
        ],
        { status: "completed", output: [messageItem(undefined, "Hello")] },
      ),
    );

    await adapter.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], ...callbacks });

    expect(errors).toEqual([]);
    expect(chunks.join("")).toBe("Hello");
  });

  it("keeps the legacy fail-open path: deltas with NO output_item.added events still emit", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    const { chunks, errors, callbacks } = collectCallbacks();

    responsesStream.mockReturnValue(
      scriptedStream(
        [{ type: "response.output_text.delta", delta: "legacy text" }],
        { status: "completed", output: [] },
      ),
    );

    await adapter.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], ...callbacks });

    expect(errors).toEqual([]);
    expect(chunks.join("")).toBe("legacy text");
  });

  it("un-streamed fallback (no delta events) filters commentary items from finalResponse output", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    const { chunks, errors, callbacks } = collectCallbacks();

    responsesStream.mockReturnValue(
      scriptedStream([], {
        status: "completed",
        output: [messageItem("commentary", COMMENTARY_TEXT), messageItem("final_answer", FINAL_TEXT)],
      }),
    );

    await adapter.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], ...callbacks });

    expect(errors).toEqual([]);
    expect(chunks.join("")).toBe(FINAL_TEXT);
  });
});

describe("generate — phase guard replaces the last-item-wins accident", () => {
  it("returns final_answer text even when commentary arrives LAST", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });

    responsesCreate.mockResolvedValue({
      status: "completed",
      // Reversed order: the old overwrite semantics ("last output_text wins")
      // would return the commentary here.
      output: [messageItem("final_answer", FINAL_TEXT), messageItem("commentary", COMMENTARY_TEXT)],
    });

    const result = await adapter.generate({ system: "sys", prompt: "hi" });
    expect(result.text).toBe(FINAL_TEXT);
  });

  it("still returns text from a phase-less message (pre-phase models)", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });

    responsesCreate.mockResolvedValue({ status: "completed", output: [messageItem(undefined, "plain answer")] });

    const result = await adapter.generate({ system: "sys", prompt: "hi" });
    expect(result.text).toBe("plain answer");
  });
});

describe("generateWithFileInput — gains the message/phase guard it never had", () => {
  it("returns final_answer text even when commentary arrives LAST", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });

    responsesCreate.mockResolvedValue({
      status: "completed",
      output: [messageItem("final_answer", FINAL_TEXT), messageItem("commentary", COMMENTARY_TEXT)],
    });

    const result = await adapter.generateWithFileInput!({ system: "sys", prompt: "hi", fileId: "file-1" });
    expect(result.text).toBe(FINAL_TEXT);
  });

  it("ignores output_text carried by non-message items (previously read from ANY item)", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });

    responsesCreate.mockResolvedValue({
      status: "completed",
      output: [
        messageItem("final_answer", FINAL_TEXT),
        { type: "reasoning", content: [{ type: "output_text", text: "inner reasoning text" }] },
      ],
    });

    const result = await adapter.generateWithFileInput!({ system: "sys", prompt: "hi", fileId: "file-1" });
    expect(result.text).toBe(FINAL_TEXT);
  });
});
