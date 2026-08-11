/**
 * The usage-metering CHOKE POINT (cinatra#2578).
 *
 * THE PROBLEM THIS SOLVES. Before this module every producer of a
 * `usage_events` row was a hand-written `emitUsageEvent(...)` call sitting NEXT
 * TO an adapter call. That made the ledger an opt-in convention: a new call site
 * that resolved an adapter and called `generate()` / `stream()` was billed by the
 * provider and invisible to `/analytics/llm`, and nothing failed. The ledger
 * under-reported real OpenAI spend by ~10x.
 *
 * THE SEAM. Every provider adapter in this repo is minted in exactly ONE place —
 * `registry.ts::resolveProviderAdapter` (the only caller of a connector's
 * `createAdapter()`). That function returns a METERED adapter: a transparent
 * proxy that emits a usage event for every response carrying usage, on every
 * response-producing method, whoever called it. Instrumentation is therefore
 * STRUCTURAL — a future call site cannot silently bypass the ledger, because
 * there is no other way to obtain an adapter.
 *
 * COUNTED VS PRICED (cinatra#2641). Most metered methods answer with usage, so
 * their rows carry both a count and dollars. `generateImage` answers with an
 * image and nothing else while the provider bills per image, so its row is
 * COUNTED and left UNPRICED (`cost_usd` NULL) instead of being dropped — see
 * {@link IMAGE_METHOD}. "The call is in the ledger" and "the spend is measured"
 * are tracked separately on purpose; collapsing them is how a $0 row starts
 * reading as "free".
 *
 * ATTRIBUTION. The transport layer can see the provider, the model and the
 * adapter input's `logLabel`, but not the caller's skill/telemetry context. A
 * caller supplies that through {@link withUsageAttribution}, an AsyncLocalStorage
 * frame read at emit time. Absent frame ⇒ the honest defaults (skillLabel null,
 * requested/effective provider null) — never a dropped row.
 *
 * NO OPT-OUT EXISTS, deliberately. Callers that once emitted their own row (the
 * llm-bridge media branch) now publish their extra attribution through the frame
 * instead, so there is exactly ONE producer of a `source:"llm"` row: this module.
 * Double counting is impossible by construction rather than by convention, and
 * no row can be built from a partial hand-copied usage object.
 * `src/__tests__/llm-usage-ledger-chokepoint.test.ts` pins that property.
 *
 * STREAM IDEMPOTENCY — the chat-path bug this module also fixes. A streaming
 * turn reports usage once PER STEP (an agentic chat turn routinely runs 10+
 * steps). The previous `createStreamUsageEmitter` minted ONE `idempotencyKey` for
 * the whole stream and reused it for every report, and `insertUsageEvent` does
 * `onConflictDoNothing(idempotency_key)` — so every step after the first was
 * silently discarded at the database. Each usage report now carries its own key.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { emitUsageEvent } from "@cinatra-ai/metric-usage-api";
import type { LlmUsageOperation } from "@cinatra-ai/metric-usage-api";
import type {
  LlmProvider,
  LlmProviderAdapter,
  LlmResponse,
  LlmUsageData,
} from "./types";

// ---------------------------------------------------------------------------
// Attribution frame
// ---------------------------------------------------------------------------

export type UsageAttribution = {
  /**
   * WINS over the adapter input's `logLabel`. A caller that names the agent
   * knows more than the transport label the adapter input happens to carry.
   */
  agentLabel?: string | null;
  skillLabel?: string | null;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
};

const attributionStore = new AsyncLocalStorage<UsageAttribution>();

/**
 * Run `fn` with extra usage attribution in scope.
 *
 * MERGE SEMANTICS. A nested frame layers onto the enclosing one and an ABSENT
 * key (`undefined`, or simply not passed) leaves the parent's value intact — a
 * caller that only knows the skill must not blank out an outer frame's provider
 * telemetry. An explicit `null` DOES override: that is a caller saying "there is
 * no skill here", which is information, not an omission.
 */
export function withUsageAttribution<T>(
  attribution: UsageAttribution,
  fn: () => T,
): T {
  const parent = attributionStore.getStore();
  const stated = Object.fromEntries(
    Object.entries(attribution).filter(([, value]) => value !== undefined),
  ) as UsageAttribution;
  return attributionStore.run({ ...parent, ...stated }, fn);
}

export function getUsageAttribution(): UsageAttribution | undefined {
  return attributionStore.getStore();
}

/**
 * The agent label a row carries: the frame's if it STATED one, else the
 * transport's `logLabel`.
 *
 * `??` cannot do this. An absent `agentLabel` means "I did not say", and the
 * transport label should fill in; an explicit `null` means "there is no agent
 * here", which {@link withUsageAttribution}'s merge semantics promise to honour
 * — and `??` would silently re-attribute that row to whatever generic label the
 * transport happened to carry. Only `undefined` is an omission.
 */
function resolveAgentLabel(
  attribution: UsageAttribution | undefined,
  logLabel: string | null | undefined,
): string | null {
  if (attribution && attribution.agentLabel !== undefined) {
    return attribution.agentLabel;
  }
  return logLabel ?? null;
}

// ---------------------------------------------------------------------------
// The single emitter
// ---------------------------------------------------------------------------

export type EmitLlmUsageParams = {
  provider: LlmProvider;
  model: string | null | undefined;
  operation: LlmUsageOperation;
  logLabel?: string | null;
  skillLabel?: string | null;
  usage: LlmUsageData;
  idempotencyKey: string;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
  occurredAt?: string;
};

/**
 * The ONE place a `source: "llm"` usage event is constructed. Keeping the shape
 * in one function is what lets the `usage_events` columns be trusted across
 * paths that otherwise share nothing (synchronous generate, streaming steps,
 * batch outcomes, the admin key probe) — in particular the cache/reasoning
 * counters, which a hand-written emitter tended to hardcode to zero.
 */
export function emitLlmUsage(params: EmitLlmUsageParams): void {
  emitUsageEvent({
    source: "llm",
    provider: params.provider,
    model: params.model ?? "unknown",
    operation: params.operation,
    agentLabel: params.logLabel ?? null,
    skillLabel: params.skillLabel ?? null,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    cachedInputTokens: params.usage.cachedInputTokens,
    reasoningOutputTokens: params.usage.reasoningOutputTokens,
    cacheReadInputTokens: params.usage.cacheReadInputTokens,
    cacheCreationInputTokens: params.usage.cacheCreationInputTokens,
    idempotencyKey: params.idempotencyKey,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    requestedProvider: params.requestedProvider ?? null,
    effectiveProvider: params.effectiveProvider ?? null,
  });
}

// ---------------------------------------------------------------------------
// The metering proxy
// ---------------------------------------------------------------------------

/** Marks an adapter as already metered so wrapping is idempotent. */
const METERED_ADAPTER = Symbol.for("cinatra.llm.usage-metered-adapter");

export function isMeteredAdapter(adapter: unknown): boolean {
  return Boolean(
    adapter && (adapter as Record<symbol, unknown>)[METERED_ADAPTER] === true,
  );
}

/** Adapter methods that answer with an `LlmResponse` (and therefore with usage). */
const RESPONSE_METHODS = new Set([
  "generate",
  "generateWithFileInput",
  "generateFromMediaFile",
]);

/**
 * The image method — response-producing, billed, and reporting NO usage
 * (cinatra#2641).
 *
 * It is separated from {@link RESPONSE_METHODS} because there is nothing to read
 * off its answer: the ABI's `generateImage` resolves to `{ imageData, mimeType }`
 * — no usage object, no model name — while the provider bills per image. Before
 * this branch the call fell through to the pass-through arm below and produced
 * NO ledger row at all, which is how billed image generation stayed invisible to
 * `/analytics/llm`.
 *
 * So the row is COUNTED AND UNPRICED, the shape cinatra#2582 established for the
 * Graphiti hand-over: the ledger states the one thing that is true — an image
 * call happened, on this provider, for this caller — and leaves the dollars
 * UNKNOWN (`cost_usd` NULL, the dashboard's own unknown-cost surface) rather than
 * inventing a price. Extending the ABI so an image response can carry its own
 * usage is what would make the path priceable; that remains cinatra#2641's open
 * half and is a connector change, not a wrapper.
 */
const IMAGE_METHOD = "generateImage";

/**
 * The token columns an image row carries: zeros because `usage_events` requires
 * numbers, never because anything was measured. The unknown lives in the NULL
 * cost — a zeroed cost would read as "this was free".
 */
const UNREPORTED_IMAGE_USAGE: LlmUsageData = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
});

type AdapterCallInput = {
  model?: string;
  logLabel?: string;
  onUsageData?: (usage: LlmUsageData) => void;
};

type GenerateImageInput = {
  model?: string;
  prompt?: string;
  logLabel?: string;
};

type GenerateImageResult = { imageData: string; mimeType: string } | null;

/**
 * Wrap an adapter so every response-producing call is metered.
 *
 * A PROXY rather than a spread copy on purpose: `LlmProviderAdapter` has ten
 * OPTIONAL members and core probes their PRESENCE to decide behaviour
 * (`readBatchSupport` reads `submitBatch`/`batchV2`, `resolveDefaultImageAdapter`
 * reads `generateImage`, `uploadFile`/`deleteFile` are probed before use). A
 * spread would have to enumerate them and would silently drop any member added
 * to the ABI later.
 *
 * Metering NEVER changes what a caller observes: the response object is returned
 * untouched, and `emitUsageEvent` itself never throws.
 */
export function meterLlmProviderAdapter(
  adapter: LlmProviderAdapter,
): LlmProviderAdapter {
  if (isMeteredAdapter(adapter)) return adapter;

  // Member cache. Two reasons it is not optional:
  //   - IDENTITY. `adapter.generate === adapter.generate` must hold; a trap that
  //     built a fresh closure per read would break any caller that compares or
  //     de-duplicates method references.
  //   - BINDING. A pass-through member must be bound to the CONNECTOR object.
  //     Left unbound it would run with `this === proxy`, and a connector adapter
  //     written as a class with `#private` fields throws a brand-check error the
  //     moment it touches one. Connector adapters are third-party code, so the
  //     proxy has to be safe for shapes this repo never sees.
  const members = new Map<string | symbol, unknown>();

  const remember = (prop: string | symbol, value: unknown): unknown => {
    members.set(prop, value);
    return value;
  };

  // The single member resolver both traps go through, so a reflective read and
  // a normal read can never disagree about what `generate` is.
  const readMeteredMember = (prop: string | symbol): unknown => {
    if (prop === METERED_ADAPTER) return true;
    if (members.has(prop)) return members.get(prop);
    // Deliberately reading off `adapter` rather than forwarding a `receiver`:
    // a connector getter that reads a sibling member would otherwise re-enter
    // this trap with the proxy as `this`.
    const target = adapter;
    const value = Reflect.get(target, prop);
    if (typeof value !== "function") return value;

    if (typeof prop === "string" && RESPONSE_METHODS.has(prop)) {
      return remember(prop, async (input: AdapterCallInput): Promise<LlmResponse> => {
        const attribution = getUsageAttribution();
        const response = (await Reflect.apply(value, target, [
          input,
        ])) as LlmResponse;
        if (response?.usage) {
          emitLlmUsage({
            provider: target.provider,
            model: response.model ?? input?.model ?? target.defaultModel,
            operation: "generate",
            logLabel: resolveAgentLabel(attribution, input?.logLabel),
            skillLabel: attribution?.skillLabel ?? null,
            usage: response.usage,
            // Synchronous calls have no provider-stable id at this seam, and
            // two identical calls ARE two billed requests — a random key is
            // the honest choice (a content-derived key would collapse them).
            idempotencyKey: randomUUID(),
            requestedProvider: attribution?.requestedProvider ?? null,
            effectiveProvider: attribution?.effectiveProvider ?? null,
          });
        }
        return response;
      });
    }

    if (prop === "stream") {
      return remember(prop, async (input: AdapterCallInput): Promise<void> => {
        const attribution = getUsageAttribution();
        const callerOnUsageData = input?.onUsageData;
        const model = input?.model ?? target.defaultModel;
        const logLabel = resolveAgentLabel(attribution, input?.logLabel);
        const onUsageData = (usage: LlmUsageData): void => {
          emitLlmUsage({
            provider: target.provider,
            model,
            operation: "stream",
            logLabel,
            skillLabel: attribution?.skillLabel ?? null,
            usage,
            // FRESH per report — a streaming turn reports usage once per
            // step, and a shared key made the database drop every step but
            // the first (cinatra#2578).
            idempotencyKey: randomUUID(),
            requestedProvider: attribution?.requestedProvider ?? null,
            effectiveProvider: attribution?.effectiveProvider ?? null,
          });
          callerOnUsageData?.(usage);
        };
        return Reflect.apply(value, target, [
          { ...input, onUsageData },
        ]) as Promise<void>;
      });
    }

    if (prop === IMAGE_METHOD) {
      return remember(prop, async (
        input: GenerateImageInput,
      ): Promise<GenerateImageResult> => {
        const attribution = getUsageAttribution();
        const result = (await Reflect.apply(value, target, [
          input,
        ])) as GenerateImageResult;
        // WHAT THIS ROW MEANS, precisely: one image invocation that RESOLVED.
        // Not "one billed provider request" — the ABI reports neither whether a
        // request was issued nor whether it was billable, so this seam cannot
        // state that. A `null` answer is booked because the ordinary way to get
        // one is a response that carried no image PART, i.e. a request that DID
        // happen (the rule cinatra#2582 applies to an episode whose
        // acknowledgement we fail to parse); an adapter that returns `null` from
        // a local preflight would be over-counted, and a throw AFTER a billable
        // request is under-counted. Both errors are bounded and stated rather
        // than hidden, and closing them needs the ABI to report the attempt —
        // the same extension that would make the row priceable.
        emitLlmUsage({
          provider: target.provider,
          // Only what the CALLER named. `defaultModel` is the adapter's default
          // TEXT model and naming it here would state a model that did not
          // answer — and, worse, one the rate card knows. Absent ⇒ "unknown",
          // which is what the ABI actually lets this seam see today.
          model: input?.model ?? null,
          operation: "image",
          logLabel: resolveAgentLabel(attribution, input?.logLabel),
          skillLabel: attribution?.skillLabel ?? null,
          usage: UNREPORTED_IMAGE_USAGE,
          // Two resolved invocations need two distinct ledger keys — a
          // shared key would collapse the second at the unique index.
          idempotencyKey: randomUUID(),
          requestedProvider: attribution?.requestedProvider ?? null,
          effectiveProvider: attribution?.effectiveProvider ?? null,
        });
        return result;
      });
    }

    // Every other member passes through BOUND to the connector object.
    return remember(prop, value.bind(target));
  };

  return new Proxy(adapter, {
    get(_target, prop) {
      return readMeteredMember(prop);
    },

    /**
     * Reflective reads see the SAME member the `get` trap hands out.
     *
     * Without this, `Object.getOwnPropertyDescriptor(adapter, "generate").value`
     * would hand back the connector's raw, unmetered function — a hole in the
     * "there is no way to obtain an unmetered adapter" claim. A NON-configurable
     * own property must be reported verbatim (a proxy invariant TypeScript
     * cannot enforce and the runtime throws over), so those are passed through
     * unchanged; adapter methods in practice are ordinary configurable members.
     */
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (!descriptor || !descriptor.configurable) return descriptor;
      if (typeof descriptor.value !== "function") return descriptor;
      return { ...descriptor, value: readMeteredMember(prop) };
    },
  });
}
