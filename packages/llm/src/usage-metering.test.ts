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
 *  4. there is NO opt-out — this module is the only producer of a `source:"llm"`
 *     row, so double counting is impossible by construction;
 *  5. a FROZEN adapter is metered like any other (cinatra#2670) — the shape a
 *     defensive connector ships is exactly the one a proxy over the adapter
 *     itself could not carry a wrapper for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitUsageEventMock } = vi.hoisted(() => ({
  emitUsageEventMock: vi.fn(),
}));
vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: emitUsageEventMock,
}));

import * as metering from "./usage-metering";
import {
  meterLlmProviderAdapter,
  isMeteredAdapter,
  withUsageAttribution,
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

  it("lets the attribution frame's agentLabel WIN over the transport logLabel", async () => {
    // The frame is the caller's precise knowledge ("blog-draft-writer-agent");
    // `logLabel` is whatever generic label the transport happened to carry.
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await withUsageAttribution({ agentLabel: "precise-agent" }, () =>
      adapter.generate({ system: "s", prompt: "p", logLabel: "generic-transport-label" }),
    );

    expect(emitted()[0]?.agentLabel).toBe("precise-agent");
  });

  it("falls back to the transport logLabel when the frame names no agent", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());
    await adapter.generate({ system: "s", prompt: "p", logLabel: "chat-step" });
    expect(emitted()[0]?.agentLabel).toBe("chat-step");
  });

  it("but an explicit null agent OVERRIDES the transport logLabel", async () => {
    // Absent means "I did not say" and the transport fills in; `null` means
    // "there is no agent here", which the frame's merge semantics promise to
    // honour. The two must not collapse into one `??`.
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await withUsageAttribution({ agentLabel: null }, () =>
      adapter.generate({ system: "s", prompt: "p", logLabel: "chat-step" }),
    );

    expect(emitted()[0]?.agentLabel).toBeNull();
  });

  it("an inner frame layers onto an outer one instead of blanking it", async () => {
    // A caller that only knows the skill must not erase an outer frame's
    // provider telemetry — the merge drops ABSENT keys, not stated ones.
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await withUsageAttribution(
      { requestedProvider: "anthropic", effectiveProvider: "openai" },
      () =>
        withUsageAttribution({ skillLabel: "inner-skill" }, () =>
          adapter.generate({ system: "s", prompt: "p" }),
        ),
    );

    expect(emitted()[0]).toMatchObject({
      skillLabel: "inner-skill",
      requestedProvider: "anthropic",
      effectiveProvider: "openai",
    });
  });

  it("an explicit null DOES override — it states a fact, it is not an omission", async () => {
    const adapter = meterLlmProviderAdapter(makeAdapter());

    await withUsageAttribution({ skillLabel: "outer-skill" }, () =>
      withUsageAttribution({ skillLabel: null }, () =>
        adapter.generate({ system: "s", prompt: "p" }),
      ),
    );

    expect(emitted()[0]?.skillLabel).toBeNull();
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

});

describe("meterLlmProviderAdapter — generateImage (cinatra#2641)", () => {
  /**
   * The gap this block closes: `generateImage` reaches a provider, is billed per
   * image, and used to fall through the proxy's pass-through arm — no row, no
   * trace in `/analytics/llm`.
   *
   * The row it books has TWO honest states, and both are pinned here. An adapter
   * that reports the ABI's optional per-image usage hands the seam a model and
   * an image count, and the row is PRICEABLE. An adapter that reports nothing
   * still books a COUNTED, UNPRICED row: the ledger states that an image
   * invocation RESOLVED and leaves the dollars unknown rather than inventing
   * them. Nothing an adapter does can move it into a THIRD state where a price
   * is guessed.
   */
  const imageAdapter = (
    generateImage: LlmProviderAdapter["generateImage"],
  ): LlmProviderAdapter =>
    meterLlmProviderAdapter(
      makeAdapter({ generateImage } as Partial<LlmProviderAdapter>),
    );

  it("books one row per image call, with no caller involvement", async () => {
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "base64", mimeType: "image/png" })),
    );

    const image = await adapter.generateImage!({
      prompt: "a cover image",
      logLabel: "blog-post-image",
    });

    // The response is handed back untouched — metering is never observable.
    expect(image).toEqual({ imageData: "base64", mimeType: "image/png" });
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      source: "llm",
      provider: "openai",
      operation: "image",
      agentLabel: "blog-post-image",
      skillLabel: null,
      // Zeros because the ledger's columns are NOT NULL, never because
      // something was measured. The unknown lives in the NULL cost the
      // subscriber stores for an `image` row.
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  it("never names the adapter's default TEXT model as the image model", async () => {
    // `defaultModel` here is "test-default-model" — a model the rate card can
    // price. Stating it for an image call would be a false claim about which
    // model answered AND would hand the pricing layer a model to price.
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
    );

    await adapter.generateImage!({ prompt: "p" });
    expect(emitted()[0]!.model).toBe("unknown");

    emitUsageEventMock.mockClear();
    await adapter.generateImage!({ prompt: "p", model: "gemini-image-1" } as never);
    expect(emitted()[0]!.model).toBe("gemini-image-1");
  });

  // -------------------------------------------------------------------------
  // The PRICEABLE state — the adapter reports per-image usage (cinatra#2641)
  // -------------------------------------------------------------------------

  it("carries the reported image count and prompt tokens, so the row can be PRICED", async () => {
    // This is the whole pricing mechanism at this layer: the seam forwards what
    // the adapter attested, and the subscriber multiplies it by a per-image
    // rate. Without it the subscriber has nothing to multiply and the row can
    // only be counted.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 2, inputTokens: 1200 },
      })),
    );

    await adapter.generateImage!({ prompt: "p" });

    expect(emitted()[0]).toMatchObject({
      operation: "image",
      model: "gemini-2.5-flash-image",
      imageCount: 2,
      // A real measurement in the real column: Gemini bills the prompt as well
      // as the images, and a row that priced the prompt while reporting zero
      // prompt tokens would contradict its own cost.
      inputTokens: 1200,
      // …and a flag saying that number is a REPORT. The column is NOT NULL, so
      // it cannot distinguish "0" from "unreported" on its own, and pricing
      // depends on that distinction. A flag rather than a second copy of the
      // number: two copies could disagree and store a cost the row does not
      // support.
      imagePromptTokensReported: true,
      // Output tokens stay zero — the images are the output, and they are
      // counted in images.
      outputTokens: 0,
    });
  });

  it("prefers the ATTESTED model over the one the caller asked for", async () => {
    // An image adapter routinely substitutes an image model of its own. The
    // ledger prices per model, so the row has to name the one the adapter
    // attested, not the one that was requested and overridden.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 1 },
      })),
    );

    await adapter.generateImage!({ prompt: "p", model: "asked-for-model" } as never);

    expect(emitted()[0]!.model).toBe("gemini-2.5-flash-image");
  });

  it("refuses to price usage the adapter could not attribute to a model", async () => {
    // The dangerous shape: an adapter reports a count but names no model, so the
    // only model name available is the one the CALLER asked for — which is not
    // evidence of what answered. Pricing that would charge one model's rate for
    // another model's work. The row is still counted, and it still LABELS itself
    // with the requested name; only the count is withheld from the rate card.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        usage: { images: 1, inputTokens: 500 },
      })),
    );

    await adapter.generateImage!({ prompt: "p", model: "asked-for-model" } as never);

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]!.model).toBe("asked-for-model");
    expect(emitted()[0]!.imageCount).toBeUndefined();
    // …and the unattributed prompt tokens do not land in the row either: they
    // would be a measurement the row cannot attribute to anything.
    expect(emitted()[0]!.inputTokens).toBe(0);
    expect(emitted()[0]!.imagePromptTokensReported).toBe(false);
  });

  it("labels the row with the attested model even when the usage is unusable", async () => {
    // The model the adapter names is true whether or not its counts are. Falling
    // back to the CALLER's model here would throw away the better answer for no
    // reason — the row's price is already withheld by the missing count.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 0 },
      })) as unknown as LlmProviderAdapter["generateImage"],
    );

    await adapter.generateImage!({ prompt: "p", model: "asked-for-model" } as never);

    expect(emitted()[0]!.model).toBe("gemini-2.5-flash-image");
    expect(emitted()[0]!.imageCount).toBeUndefined();
  });

  it("keeps the count when the adapter attested a model but no prompt tokens", async () => {
    // Not every image provider bills the prompt. Withholding the count here
    // would make this seam decide a pricing question that belongs to the rate
    // card, which is the layer that knows whether a prompt charge exists.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 1 },
      })),
    );

    await adapter.generateImage!({ prompt: "p" });

    expect(emitted()[0]).toMatchObject({ imageCount: 1, inputTokens: 0 });
    // ABSENT, not 0 — this is the field that stops a provider which bills the
    // prompt from being charged for the images alone.
    expect(emitted()[0]!.imagePromptTokensReported).toBe(false);
  });

  it("distinguishes a REPORTED zero prompt from an unreported one", async () => {
    // `0` is a legitimate report and must survive as a number, or a provider
    // that genuinely billed no prompt tokens would be unpriceable forever.
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 1, inputTokens: 0 },
      })),
    );

    await adapter.generateImage!({ prompt: "p" });

    expect(emitted()[0]!.imagePromptTokensReported).toBe(true);
    expect(emitted()[0]!.inputTokens).toBe(0);
  });

  it("refuses a malformed prompt-token count without losing the image count", async () => {
    const adapter = imageAdapter(
      vi.fn(async () => ({
        imageData: "x",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        usage: { images: 1, inputTokens: -5 },
      })) as unknown as LlmProviderAdapter["generateImage"],
    );

    await adapter.generateImage!({ prompt: "p" });

    // The images were still attested; the prompt count was not usable, so it
    // reaches neither the row nor the rate card, and the card refuses the price.
    expect(emitted()[0]).toMatchObject({ imageCount: 1, inputTokens: 0 });
    expect(emitted()[0]!.imagePromptTokensReported).toBe(false);
  });

  it("reports NO count when the adapter reports no image usage — the negative control", async () => {
    // The pre-existing adapter shape, and the state every connector that has
    // not adopted the ABI addition is in. Absent must stay absent: a defaulted
    // `1` here would price every legacy adapter's calls off a number nobody
    // measured.
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
    );

    await adapter.generateImage!({ prompt: "p" });

    expect(emitted()[0]).toMatchObject({ operation: "image" });
    expect(emitted()[0]!.imageCount).toBeUndefined();
  });

  it("reports no count when the adapter answers no image at all", async () => {
    // `null` is a resolved invocation and is still counted — but there is no
    // response object to read a count off, so it cannot be priced.
    const adapter = imageAdapter(vi.fn(async () => null));

    await adapter.generateImage!({ prompt: "p" });

    expect(emitted()[0]).toMatchObject({ operation: "image" });
    expect(emitted()[0]!.imageCount).toBeUndefined();
  });

  it("refuses a malformed count rather than pricing off it", async () => {
    // A connector is third-party code and this number is multiplied by a dollar
    // rate. Every one of these would mint a nonsense price that is stored with
    // exactly the same confidence as a real one, so each must degrade to the
    // unpriced row instead.
    const malformed: unknown[] = [0, -1, 1.5, NaN, Infinity, "2", null, 2 ** 53];

    for (const images of malformed) {
      emitUsageEventMock.mockClear();
      const adapter = imageAdapter(
        vi.fn(async () => ({
          imageData: "x",
          mimeType: "image/png",
          model: "gemini-2.5-flash-image",
          usage: { images },
        })) as unknown as LlmProviderAdapter["generateImage"],
      );

      await adapter.generateImage!({ prompt: "p" });

      // Counted, exactly as before — losing the PRICE is the failure mode, and
      // losing the ROW would put the spend back where cinatra#2641 found it.
      expect(emitted(), `images=${String(images)}`).toHaveLength(1);
      expect(
        emitted()[0]!.imageCount,
        `images=${String(images)} must not reach the rate card`,
      ).toBeUndefined();
    }
  });

  it("books the call when the adapter answers no image", async () => {
    // The ordinary way to get `null` is a response that carried no image PART —
    // a request that happened. The row states a RESOLVED invocation, which is
    // the strongest claim the ABI supports; dropping it would put that spend
    // back where this change found it.
    const adapter = imageAdapter(vi.fn(async () => null));

    await expect(adapter.generateImage!({ prompt: "p" })).resolves.toBeNull();
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({ operation: "image" });
  });

  it("books NOTHING when the call throws", async () => {
    const adapter = imageAdapter(
      vi.fn(async () => {
        throw new Error("provider refused");
      }),
    );

    await expect(adapter.generateImage!({ prompt: "p" })).rejects.toThrow(
      "provider refused",
    );
    expect(emitted()).toHaveLength(0);
  });

  it("reads the attribution frame, which wins over the transport label", async () => {
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
    );

    await withUsageAttribution(
      {
        agentLabel: "blog-pipeline-agent",
        skillLabel: "blog-image-matcher",
        requestedProvider: "openai",
        effectiveProvider: "gemini",
      },
      () => adapter.generateImage!({ prompt: "p", logLabel: "blog-post-image" }),
    );

    expect(emitted()[0]).toMatchObject({
      agentLabel: "blog-pipeline-agent",
      skillLabel: "blog-image-matcher",
      requestedProvider: "openai",
      effectiveProvider: "gemini",
    });
  });

  it("honours an explicit null agent — the transport label does not sneak back", async () => {
    // The frame's merge semantics say an explicit `null` is INFORMATION ("there
    // is no agent here"), not an omission. A `??` chain cannot tell it from an
    // absent key and would re-attribute the row to the generic transport label.
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
    );

    await withUsageAttribution({ agentLabel: null }, () =>
      adapter.generateImage!({ prompt: "p", logLabel: "blog-post-image" }),
    );

    expect(emitted()[0]?.agentLabel).toBeNull();
  });

  it("gives every image its OWN idempotency key — two invocations are two rows", async () => {
    // `usage_events` de-duplicates on this column, so a reused key would make
    // the second image disappear at the database exactly as the streaming steps
    // did in cinatra#2578.
    const adapter = imageAdapter(
      vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
    );

    await adapter.generateImage!({ prompt: "one" });
    await adapter.generateImage!({ prompt: "two" });

    const keys = emitted().map((row) => row.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("still preserves ABSENCE — a provider without images is not given one", () => {
    // `resolveDefaultImageAdapter` picks an adapter by PROBING `generateImage`.
    // A proxy that manufactured the member would make every provider look
    // image-capable.
    expect(meterLlmProviderAdapter(makeAdapter()).generateImage).toBeUndefined();
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
    // A pass-through member still does its job and is NOT metered. `submitBatch`
    // is the honest example: a batch's tokens arrive on the RESULT rows and are
    // booked there, so metering the submission would double-count.
    // (`generateImage` IS metered — see the image describe block below.)
    await withBatch.submitBatch!({} as never);
    expect(emitted()).toHaveLength(0);
  });

  it("meters a CLASS-based adapter that uses private fields", async () => {
    // Connector adapters are third-party code and may be classes. A pass-through
    // member left unbound would run with `this === proxy`, and the private-brand
    // check on `#calls` throws the moment it is touched — which is why the proxy
    // binds every pass-through member to the connector object.
    class ClassAdapter {
      readonly provider = "openai" as const;
      readonly defaultModel = "class-model";
      #calls = 0;

      async generate(): Promise<LlmResponse> {
        this.#calls += 1;
        return {
          text: "ok",
          status: null,
          incompleteReason: null,
          rawBody: "",
          model: "class-model",
          usage: usage(11),
        };
      }

      async stream(): Promise<void> {}

      async listModels(): Promise<string[]> {
        this.#calls += 1;
        return ["class-model"];
      }
    }

    const adapter = meterLlmProviderAdapter(
      new ClassAdapter() as unknown as LlmProviderAdapter,
    );

    await expect(adapter.listModels!()).resolves.toEqual(["class-model"]);
    await adapter.generate({ system: "s", prompt: "p" });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({ provider: "openai", inputTokens: 11 });
  });

  it("hands a REFLECTIVE read the same metered member as a normal read", async () => {
    // Without a getOwnPropertyDescriptor trap this returns the connector's raw,
    // unmetered function — a hole in "there is no way to obtain an unmetered
    // adapter".
    const adapter = meterLlmProviderAdapter(makeAdapter());
    const descriptor = Object.getOwnPropertyDescriptor(adapter, "generate");

    expect(descriptor?.value).toBe(adapter.generate);
    await (descriptor!.value as LlmProviderAdapter["generate"])({
      system: "s",
      prompt: "p",
    });
    expect(emitted()).toHaveLength(1);
  });

  it("keeps method identity stable across reads", () => {
    // A trap that built a fresh closure per read would break any caller that
    // compares or de-duplicates method references.
    const adapter = meterLlmProviderAdapter(
      makeAdapter({ listModels: vi.fn(async () => ["m"]) } as Partial<LlmProviderAdapter>),
    );
    expect(adapter.generate).toBe(adapter.generate);
    expect(adapter.stream).toBe(adapter.stream);
    expect(adapter.listModels).toBe(adapter.listModels);
  });

  it("exports no bypass, and an unknown frame key cannot become one", async () => {
    // The opt-out this seam once carried is gone on purpose: with no way to
    // silence the proxy, double counting is impossible by construction rather
    // than by an allowlist someone has to maintain.
    expect(
      Object.keys(metering).filter((name) =>
        /callerEmitted|suppress|optOut|skipUsage/i.test(name),
      ),
    ).toEqual([]);

    // Driving the real proxy inside a frame carrying every plausible "off"
    // switch still records the call.
    const adapter = meterLlmProviderAdapter(makeAdapter());
    await withUsageAttribution(
      {
        usageEmittedByCaller: true,
        suppress: true,
        skipUsage: true,
      } as unknown as metering.UsageAttribution,
      () => adapter.generate({ system: "s", prompt: "p" }),
    );
    expect(emitted()).toHaveLength(1);
  });
});

describe("meterLlmProviderAdapter — frozen adapters (cinatra#2670)", () => {
  /**
   * The shape this block is about: an adapter whose `generate` is a
   * NON-CONFIGURABLE, NON-WRITABLE own data property — what a connector gets by
   * calling `Object.freeze` on the object it hands back, i.e. by being careful.
   *
   * A proxy's invariants are checked against ITS TARGET, so while the target was
   * the adapter itself this shape defeated the seam in both directions at once:
   * `metered.generate` threw a `TypeError` (`[[Get]]` may not answer with
   * anything but the target's own non-configurable, non-writable value), and
   * `Object.getOwnPropertyDescriptor(metered, "generate").value` had to be the
   * connector's RAW function — an unmetered callable reachable from a metered
   * adapter, which is the one thing the choke point claims cannot exist. Most of
   * what follows fails against that proxy (7 of this block's 10 tests do); the
   * rest hold the line on what the wrapper's own object may and may not change.
   */
  const frozenAdapter = (
    overrides: Partial<LlmProviderAdapter> = {},
  ): LlmProviderAdapter => Object.freeze(makeAdapter(overrides));

  /** `generate` pinned in place WITHOUT freezing the object around it. */
  function pinnedGenerateAdapter(): LlmProviderAdapter {
    const adapter = makeAdapter();
    Object.defineProperty(adapter, "generate", {
      value: adapter.generate,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    return adapter;
  }

  it("reads and meters a method pinned as non-configurable and non-writable", async () => {
    const adapter = meterLlmProviderAdapter(pinnedGenerateAdapter());

    // Reading it is the assertion: this line threw a TypeError before #2670.
    const generate = adapter.generate;
    expect(typeof generate).toBe("function");

    await generate({ system: "s", prompt: "p" });
    expect(emitted()).toHaveLength(1);
  });

  it("meters a frozen adapter's call exactly once, with the row it always books", async () => {
    const adapter = meterLlmProviderAdapter(frozenAdapter());

    await adapter.generate({ system: "s", prompt: "p", logLabel: "agent-x" });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      source: "llm",
      provider: "openai",
      model: "answered-model",
      operation: "generate",
      agentLabel: "agent-x",
      inputTokens: 10,
    });
  });

  it("hands a REFLECTIVE read the metered member, not the connector's raw function", async () => {
    // The hole this closes: a descriptor read used to be a way to obtain an
    // unmetered callable from a metered adapter.
    const connector = makeAdapter();
    const rawGenerate = connector.generate;
    const adapter = meterLlmProviderAdapter(Object.freeze(connector));

    const descriptor = Object.getOwnPropertyDescriptor(adapter, "generate");

    expect(descriptor?.value).toBe(adapter.generate);
    expect(descriptor?.value).not.toBe(rawGenerate);

    await (descriptor!.value as LlmProviderAdapter["generate"])({
      system: "s",
      prompt: "p",
    });
    expect(emitted()).toHaveLength(1);
  });

  it("keeps method identity stable across repeated ordinary and reflective reads", () => {
    const adapter = meterLlmProviderAdapter(frozenAdapter());
    const generate = adapter.generate;

    expect(adapter.generate).toBe(generate);
    expect(Object.getOwnPropertyDescriptor(adapter, "generate")?.value).toBe(
      generate,
    );
    expect(Object.getOwnPropertyDescriptor(adapter, "generate")?.value).toBe(
      generate,
    );
    expect(adapter.stream).toBe(adapter.stream);
  });

  it("still describes the CONNECTOR's writability, and its refusal still stands", () => {
    // The metered adapter is a distinct object, so its members are redefinable
    // (`configurable: true` is the truth about IT). What a caller consumes is
    // unchanged: the value is metered, the enumerability and writability are the
    // connector's, and a frozen adapter still refuses the write.
    const connector = makeAdapter();
    const rawGenerate = connector.generate;
    const adapter = meterLlmProviderAdapter(Object.freeze(connector));

    expect(Object.getOwnPropertyDescriptor(adapter, "generate")).toMatchObject({
      writable: false,
      enumerable: true,
    });
    expect(() => {
      (adapter as unknown as { generate: unknown }).generate = () => {};
    }).toThrow(TypeError);
    expect(connector.generate).toBe(rawGenerate);
  });

  it("preserves the PRESENCE and ABSENCE optional members are probed by", async () => {
    const withImage = meterLlmProviderAdapter(
      frozenAdapter({
        generateImage: vi.fn(async () => ({
          imageData: "x",
          mimeType: "image/png",
        })),
      } as Partial<LlmProviderAdapter>),
    );
    const withoutImage = meterLlmProviderAdapter(frozenAdapter());

    expect(typeof withImage.generateImage).toBe("function");
    expect("generateImage" in withImage).toBe(true);
    expect(withoutImage.generateImage).toBeUndefined();
    expect("generateImage" in withoutImage).toBe(false);

    await withImage.generateImage!({ prompt: "p" });
    expect(emitted()).toHaveLength(1);
  });

  it("enumerates like the adapter, and a COPY of it carries the metered member", async () => {
    const adapter = meterLlmProviderAdapter(frozenAdapter());

    expect(Object.keys(adapter)).toEqual([
      "provider",
      "defaultModel",
      "generate",
      "stream",
    ]);

    // A spread copies through the same traps, so the copy meters too — the
    // ledger does not depend on holding the proxy itself.
    const copy = { ...adapter } as LlmProviderAdapter;
    await copy.generate({ system: "s", prompt: "p" });
    expect(emitted()).toHaveLength(1);
  });

  it("meters a FROZEN class instance with private fields, and still answers instanceof", async () => {
    // Connector adapters are third-party code: a class, frozen, is an ordinary
    // way to ship one. Its methods live on the PROTOTYPE, so freezing the
    // instance never pins them — what this pins instead is that the facade did
    // not cost the two things a class needs: the private-field binding (the
    // wrapper calls through with `this` = the connector) and the real prototype
    // (`instanceof` still answers).
    class FrozenClassAdapter {
      readonly provider = "openai" as const;
      readonly defaultModel = "class-model";
      #calls = 0;

      async generate(): Promise<LlmResponse> {
        this.#calls += 1;
        return {
          text: "ok",
          status: null,
          incompleteReason: null,
          rawBody: "",
          model: "class-model",
          usage: usage(11),
        };
      }

      async stream(): Promise<void> {}

      async listModels(): Promise<string[]> {
        this.#calls += 1;
        return ["class-model"];
      }
    }

    const connector = Object.freeze(new FrozenClassAdapter());
    const adapter = meterLlmProviderAdapter(
      connector as unknown as LlmProviderAdapter,
    );

    expect(adapter instanceof FrozenClassAdapter).toBe(true);
    await expect(adapter.listModels!()).resolves.toEqual(["class-model"]);
    await adapter.generate({ system: "s", prompt: "p" });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({ provider: "openai", inputTokens: 11 });
  });

  it("is idempotent for a frozen adapter too", () => {
    const once = meterLlmProviderAdapter(frozenAdapter());

    expect(isMeteredAdapter(once)).toBe(true);
    expect(meterLlmProviderAdapter(once)).toBe(once);
  });

  it("refuses to be sealed instead of pretending it was", () => {
    // The caller-visible difference the wrapper's own object makes, in full: it
    // describes ITSELF, and it owns nothing, because every member it answers
    // with is produced by a trap. Sealing it would make the runtime reject the
    // very enumeration the tests above rely on, so all three attempts are
    // refused loudly — and the connector's object is left exactly as it was.
    const connector = makeAdapter();
    const adapter = meterLlmProviderAdapter(connector);
    const frozen = meterLlmProviderAdapter(frozenAdapter());

    expect(() => Object.preventExtensions(adapter)).toThrow(TypeError);
    expect(() => Object.seal(adapter)).toThrow(TypeError);
    expect(() => Object.freeze(adapter)).toThrow(TypeError);
    expect(Object.isExtensible(adapter)).toBe(true);
    expect(Object.isExtensible(connector)).toBe(true);
    expect(Object.keys(adapter)).toContain("generate");

    // Integrity reflection describes the wrapper, NOT the adapter behind it —
    // the one place where reading the metered adapter is not the same as
    // reading the connector's object.
    expect(Object.isFrozen(frozen)).toBe(false);
    expect(Object.isSealed(frozen)).toBe(false);
  });
});

describe("meterLlmProviderAdapter — the wrapper's own object (cinatra#2670)", () => {
  it("does not take a connector's word that it is already metered", async () => {
    // The brand is a symbol from the GLOBAL registry, so an adapter can set it
    // on itself. If the idempotence guard believed it, a connector could hand
    // back an object that is returned unwrapped — an opt-out, in the one seam
    // that has none by construction. The guard reads a module-private record of
    // what this file actually minted instead; the brand stays as the outward
    // answer a metered adapter gives when something asks.
    const connector = makeAdapter() as unknown as Record<symbol, unknown>;
    connector[Symbol.for("cinatra.llm.usage-metered-adapter")] = true;

    expect(isMeteredAdapter(connector)).toBe(false);

    const adapter = meterLlmProviderAdapter(
      connector as unknown as LlmProviderAdapter,
    );
    expect(adapter).not.toBe(connector);
    expect(isMeteredAdapter(adapter)).toBe(true);
    expect(
      (adapter as unknown as Record<symbol, unknown>)[
        Symbol.for("cinatra.llm.usage-metered-adapter")
      ],
    ).toBe(true);

    await adapter.generate({ system: "s", prompt: "p" });
    expect(emitted()).toHaveLength(1);
  });

  it("re-wraps a member the connector replaces behind the proxy's back", async () => {
    // The member cache is keyed by the RAW member it wrapped, so it cannot
    // serve a wrapper for a function that is no longer there. Connector code
    // holding its own reference to the adapter is the case a per-name cache
    // could not see at all.
    const connector = makeAdapter();
    const adapter = meterLlmProviderAdapter(connector);

    const before = adapter.generate;
    await before({ system: "s", prompt: "p" });

    connector.generate = vi.fn(async () => ({
      text: "second",
      status: null,
      incompleteReason: null,
      rawBody: "",
      model: "second-model",
      usage: usage(42),
    })) as LlmProviderAdapter["generate"];

    const after = adapter.generate;
    expect(after).not.toBe(before);
    await after({ system: "s", prompt: "p" });

    expect(emitted()).toHaveLength(2);
    expect(emitted()[1]).toMatchObject({ model: "second-model", inputTokens: 42 });
  });

  it("follows a prototype swap instead of serving the member it cached", async () => {
    const first = { listModels: vi.fn(async () => ["first"]) };
    const second = { listModels: vi.fn(async () => ["second"]) };
    const connector = Object.assign(Object.create(first), makeAdapter());
    const adapter = meterLlmProviderAdapter(connector as LlmProviderAdapter);

    await expect(adapter.listModels!()).resolves.toEqual(["first"]);

    Object.setPrototypeOf(adapter, second);

    expect(Object.getPrototypeOf(adapter)).toBe(second);
    await expect(adapter.listModels!()).resolves.toEqual(["second"]);
  });

  it("meters a method exposed through a GETTER, and describes it stably", async () => {
    // An adapter may expose its methods as accessors. A descriptor read has to
    // answer with the metered member there too, and answer with the SAME getter
    // every time — a fresh closure per read would be a second way for two reads
    // of one member to disagree.
    const raw = vi.fn(async () => ({
      text: "ok",
      status: null,
      incompleteReason: null,
      rawBody: "",
      model: "accessor-model",
      usage: usage(13),
    }));
    const connector = makeAdapter();
    Object.defineProperty(connector, "generate", {
      get: () => raw,
      enumerable: true,
      configurable: true,
    });
    const adapter = meterLlmProviderAdapter(connector);

    const descriptor = Object.getOwnPropertyDescriptor(adapter, "generate");
    expect(typeof descriptor?.get).toBe("function");
    expect(Object.getOwnPropertyDescriptor(adapter, "generate")?.get).toBe(
      descriptor?.get,
    );

    const described = descriptor!.get!() as LlmProviderAdapter["generate"];
    expect(described).toBe(adapter.generate);
    expect(described).not.toBe(raw);

    await described({ system: "s", prompt: "p" });
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({ model: "accessor-model", inputTokens: 13 });
  });

  it("refuses to PIN a member, and refuses BEFORE touching the connector", () => {
    // The facade owns nothing, so it cannot own the non-configurable property
    // such a definition promises — the runtime would throw over the trap's
    // answer, with the connector's object already changed. Refusing first keeps
    // the failure atomic: nothing was defined, and the caller is told so.
    const connector = makeAdapter() as unknown as Record<string, unknown>;
    const adapter = meterLlmProviderAdapter(
      connector as unknown as LlmProviderAdapter,
    );

    expect(
      Reflect.defineProperty(adapter, "pinned", {
        value: 1,
        configurable: false,
      }),
    ).toBe(false);
    expect("pinned" in connector).toBe(false);

    // Omitting the field pins it just as surely — `defineProperty` defaults
    // every unstated attribute of a NEW property to false.
    expect(Reflect.defineProperty(adapter, "unstated", { value: 1 })).toBe(
      false,
    );
    expect("unstated" in connector).toBe(false);

    // An ordinary definition still lands on the connector's object.
    expect(
      Reflect.defineProperty(adapter, "loose", {
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    ).toBe(true);
    expect(connector.loose).toBe(1);
    expect(Object.keys(adapter)).toContain("loose");
  });
});
