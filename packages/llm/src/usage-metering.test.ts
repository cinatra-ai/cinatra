/**
 * The usage-metering choke point (cinatra#2578).
 *
 * These tests pin the properties that make the `usage_events` ledger trustworthy
 * rather than merely present:
 *
 *  1. metering is applied by WRAPPING an adapter, so any holder of an adapter is
 *     counted — the caller does not have to remember to emit;
 *  2. a streaming turn emits one row PER usage report with a DISTINCT
 *     idempotency key (the shared-key bug silently discarded every step after
 *     the first, because `usage_events` de-duplicates on that column);
 *  3. the proxy is transparent — optional adapter members keep their presence
 *     and their behaviour, since core probes them to decide what a provider can
 *     do;
 *  4. the caller-emitted opt-out actually silences the proxy, so the one call
 *     site that emits a richer row is not counted twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitUsageEventMock } = vi.hoisted(() => ({
  emitUsageEventMock: vi.fn(),
}));
vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: emitUsageEventMock,
}));

import {
  meterLlmProviderAdapter,
  isMeteredAdapter,
  withUsageAttribution,
  withCallerEmittedUsage,
  markMeteredUsageCallback,
} from "./usage-metering";
import type {
  LlmProviderAdapter,
  LlmUsageData,
  LlmResponse,
  StreamInput,
} from "./types";

const usage = (inputTokens: number): LlmUsageData => ({
  inputTokens,
  outputTokens: 5,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
});

function makeAdapter(
  overrides: Partial<LlmProviderAdapter> = {},
): LlmProviderAdapter {
  return {
    provider: "openai",
    defaultModel: "test-default-model",
    generate: vi.fn(
      async (): Promise<LlmResponse> => ({
        text: "ok",
        status: null,
        incompleteReason: null,
        rawBody: "",
        model: "answered-model",
        usage: usage(10),
      }),
    ),
    stream: vi.fn(async () => undefined),
    ...overrides,
  } as LlmProviderAdapter;
}

/**
 * A complete `StreamInput`. `LlmStreamCallbacks` members are REQUIRED on the
 * ABI, so building the input here (rather than casting a partial) keeps these
 * tests honest about the shape the adapter really receives.
 */
function streamInput(overrides: Partial<StreamInput> = {}): StreamInput {
  return {
    system: "s",
    messages: [],
    onTextDelta: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onStepStart: () => {},
    onStepEnd: () => {},
    onError: () => {},
    ...overrides,
  } as StreamInput;
}

const emitted = () =>
  emitUsageEventMock.mock.calls.map((call) => call[0] as Record<string, unknown>);

beforeEach(() => {
  emitUsageEventMock.mockClear();
});

describe("meterLlmProviderAdapter — generate", () => {
  it("emits one row for a response carrying usage, without the caller doing anything", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await adapter.generate({ system: "s", prompt: "p", logLabel: "agent-x" });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      source: "llm",
      provider: "openai",
      // The model the provider SAID answered wins over the requested one.
      model: "answered-model",
      operation: "generate",
      agentLabel: "agent-x",
      skillLabel: null,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("emits nothing when the provider reported no usage", async () => {
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        generate: vi.fn(async () => ({
          text: "ok",
          status: null,
          incompleteReason: null,
          rawBody: "",
          usage: undefined,
        })) as LlmProviderAdapter["generate"],
      }),
    );

    await adapter.generate({ system: "s", prompt: "p" });

    expect(emitted()).toHaveLength(0);
  });

  it("falls back to the adapter's default model when nothing else names one", async () => {
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        generate: vi.fn(async () => ({
          text: "ok",
          status: null,
          incompleteReason: null,
          rawBody: "",
          usage: usage(3),
        })) as LlmProviderAdapter["generate"],
      }),
    );

    await adapter.generate({ system: "s", prompt: "p" });

    expect(emitted()[0]?.model).toBe("test-default-model");
  });

  it("carries the caller's attribution frame onto the row", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await withUsageAttribution(
      {
        skillLabel: "skill-abc",
        requestedProvider: "anthropic",
        effectiveProvider: "openai",
      },
      () => adapter.generate({ system: "s", prompt: "p" }),
    );

    expect(emitted()[0]).toMatchObject({
      skillLabel: "skill-abc",
      requestedProvider: "anthropic",
      effectiveProvider: "openai",
    });
  });

  it("returns the adapter's response untouched", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());
    const response = await adapter.generate({ system: "s", prompt: "p" });
    expect(response.text).toBe("ok");
    expect(response.usage).toEqual(usage(10));
  });

  it("meters generateWithFileInput and generateFromMediaFile too", async () => {
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        generateWithFileInput: vi.fn(async () => ({
          text: "f",
          status: null,
          incompleteReason: null,
          rawBody: "",
          usage: usage(7),
        })),
        generateFromMediaFile: vi.fn(async () => ({
          text: "m",
          status: null,
          incompleteReason: null,
          rawBody: "",
          usage: usage(9),
        })),
      } as Partial<LlmProviderAdapter>),
    );

    await adapter.generateWithFileInput!({
      system: "s",
      prompt: "p",
      fileId: "file-1",
    });
    await adapter.generateFromMediaFile!({
      system: "s",
      mediaFileUri: "files/x",
      mimeType: "audio/mpeg",
    });

    expect(emitted().map((row) => row.inputTokens)).toEqual([7, 9]);
  });
});

describe("meterLlmProviderAdapter — stream", () => {
  it("emits one row PER usage report with DISTINCT idempotency keys", async () => {
    // The regression this locks: a multi-step chat turn reports usage once per
    // step. A single shared key made `insertUsageEvent`'s
    // onConflictDoNothing(idempotency_key) drop every step but the first, which
    // is how 14 provider requests became 1 ledger row.
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        stream: vi.fn(async (input: { onUsageData?: (u: LlmUsageData) => void }) => {
          input.onUsageData?.(usage(1));
          input.onUsageData?.(usage(2));
          input.onUsageData?.(usage(3));
        }) as unknown as LlmProviderAdapter["stream"],
      }),
    );

    await adapter.stream(streamInput({ logLabel: "chat" }));

    const rows = emitted();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.inputTokens)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.operation === "stream")).toBe(true);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(3);
  });

  it("still calls the caller's own onUsageData", async () => {
    const seen: number[] = [];
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        stream: vi.fn(async (input: { onUsageData?: (u: LlmUsageData) => void }) => {
          input.onUsageData?.(usage(4));
        }) as unknown as LlmProviderAdapter["stream"],
      }),
    );

    await adapter.stream(
      streamInput({
        onUsageData: (u: LlmUsageData) => {
          seen.push(u.inputTokens);
        },
      }),
    );

    expect(seen).toEqual([4]);
    expect(emitted()).toHaveLength(1);
  });

  it("defers to an already-metered onUsageData instead of double-counting", async () => {
    const ownEmitter = markMeteredUsageCallback(vi.fn());
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        stream: vi.fn(async (input: { onUsageData?: (u: LlmUsageData) => void }) => {
          input.onUsageData?.(usage(6));
        }) as unknown as LlmProviderAdapter["stream"],
      }),
    );

    await adapter.stream(streamInput({ onUsageData: ownEmitter }));

    expect(ownEmitter).toHaveBeenCalledTimes(1);
    expect(emitted()).toHaveLength(0);
  });
});

describe("meterLlmProviderAdapter — transparency and opt-out", () => {
  it("is idempotent: wrapping an already-metered adapter changes nothing", () => {
    const once = meterLlmProviderAdapter(makeAdapter());
    const twice = meterLlmProviderAdapter(once);
    expect(twice).toBe(once);
    expect(isMeteredAdapter(twice)).toBe(true);
    expect(isMeteredAdapter(makeAdapter())).toBe(false);
  });

  it("preserves the PRESENCE and ABSENCE of optional members core probes", async () => {
    const withBatch = meterLlmProviderAdapter(
      makeAdapter({
        submitBatch: vi.fn(async () => ({
          batchId: "b1",
          inputFileId: "file-in",
          status: "validating" as const,
        })),
        generateImage: vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
      } as Partial<LlmProviderAdapter>),
    );
    const withoutBatch = meterLlmProviderAdapter(makeAdapter());

    expect(typeof withBatch.submitBatch).toBe("function");
    expect(typeof withBatch.generateImage).toBe("function");
    expect(withoutBatch.submitBatch).toBeUndefined();
    expect(withoutBatch.generateImage).toBeUndefined();
    expect(withBatch.provider).toBe("openai");
    expect(withBatch.defaultModel).toBe("test-default-model");
    // A pass-through member still does its job and is NOT metered.
    await withBatch.generateImage!({ prompt: "p" });
    expect(emitted()).toHaveLength(0);
  });

  it("stays silent inside withCallerEmittedUsage on both generate and stream", async () => {
    const adapter = meterLlmProviderAdapter(
      makeAdapter({
        stream: vi.fn(async (input: { onUsageData?: (u: LlmUsageData) => void }) => {
          input.onUsageData?.(usage(8));
        }) as unknown as LlmProviderAdapter["stream"],
      }),
    );

    await withCallerEmittedUsage(() =>
      adapter.generate({ system: "s", prompt: "p" }),
    );
    await withCallerEmittedUsage(() => adapter.stream(streamInput()));

    expect(emitted()).toHaveLength(0);
  });

  it("does not leak the opt-out to a sibling call outside the frame", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());
    await withCallerEmittedUsage(() =>
      adapter.generate({ system: "s", prompt: "p" }),
    );
    await adapter.generate({ system: "s", prompt: "p" });
    expect(emitted()).toHaveLength(1);
  });
});
