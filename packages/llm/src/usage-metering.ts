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
 * their rows carry both a count and dollars. `generateImage` is billed PER IMAGE
 * rather than per token, so it is metered on its own arm — see
 * {@link IMAGE_METHOD}. An adapter that reports the ABI's optional image usage
 * makes its row PRICEABLE (the subscriber prices it when its per-image card has
 * a rate for that provider and model); one that reports nothing gets the
 * COUNTED, UNPRICED row (`cost_usd` NULL) instead of being dropped. "The call is
 * in the ledger" and "the spend is measured" are tracked separately on purpose;
 * collapsing them is how a $0 row starts reading as "free".
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
  LlmImageResponse,
  LlmImageUsage,
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
  /**
   * The PER-IMAGE unit an `operation:"image"` row is priced in (cinatra#2641).
   * Absent ⇒ the adapter reported no image usage and the row stays unpriced.
   */
  imageCount?: number;
  /**
   * Whether `usage.inputTokens` on an image row is a REPORT rather than the
   * placeholder zero the NOT NULL column requires (cinatra#2641). The quantity
   * itself is never duplicated — two copies could disagree.
   */
  imagePromptTokensReported?: boolean;
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
    imageCount: params.imageCount,
    imagePromptTokensReported: params.imagePromptTokensReported,
    idempotencyKey: params.idempotencyKey,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    requestedProvider: params.requestedProvider ?? null,
    effectiveProvider: params.effectiveProvider ?? null,
  });
}

// ---------------------------------------------------------------------------
// The metering proxy
// ---------------------------------------------------------------------------

/**
 * The OUTWARD brand: a metered adapter ANSWERS `true` for this symbol, so code
 * that holds one can ask what it is holding.
 *
 * Answering with it is all it does. It is NOT what {@link isMeteredAdapter}
 * decides on, because the value would then come from an object the connector
 * controls: a connector that set this symbol on a RAW adapter would be handed
 * straight back by the idempotence guard below, unwrapped — a connector-side
 * opt-out, in the one seam whose whole point is that no opt-out exists.
 */
const METERED_ADAPTER = Symbol.for("cinatra.llm.usage-metered-adapter");

/**
 * The RECORD of what this module actually minted — the only thing the
 * idempotence guard trusts, because nothing outside this file can put an entry
 * in it. Weak, so a metered adapter is still collectable.
 *
 * That makes idempotence MODULE-LOCAL: a second copy of this package would not
 * recognise the first copy's proxies and would wrap one again. It cannot arise
 * from the seam, because the single wrap site — `resolveProviderAdapter`, pinned
 * as the only caller of a connector's `createAdapter()` by
 * `src/__tests__/llm-usage-ledger-chokepoint.test.ts` — wraps an adapter the
 * connector has just minted, never one it received already wrapped. Trusting the
 * global symbol instead would trade that impossible case for a reachable one.
 */
const meteredAdapters = new WeakSet<object>();

export function isMeteredAdapter(adapter: unknown): boolean {
  // `has` answers false for anything that cannot be held weakly, so a primitive
  // (or `undefined`) needs no guard of its own.
  return meteredAdapters.has(adapter as object);
}

/** Adapter methods that answer with an `LlmResponse` (and therefore with usage). */
const RESPONSE_METHODS = new Set([
  "generate",
  "generateWithFileInput",
  "generateFromMediaFile",
]);

/**
 * The image method — response-producing and billed in a NON-TOKEN unit
 * (cinatra#2641).
 *
 * It is separated from {@link RESPONSE_METHODS} because its answer is not an
 * `LlmResponse` and its bill is not a token count: the provider charges per
 * produced image. Before this branch existed the call fell through to the
 * pass-through arm below and produced NO ledger row at all, which is how billed
 * image generation stayed invisible to `/analytics/llm`.
 *
 * TWO STATES, both honest. The ABI's image response MAY carry `model` + `usage`
 * ({@link LlmImageUsage}, a per-image unit). An adapter that attests BOTH yields
 * a PRICEABLE row, which the subscriber prices when its per-image card holds a
 * rate for that provider and model. An adapter that reports nothing — or reports
 * usage it cannot attribute to a model — yields the COUNTED, UNPRICED row this
 * arm has always written (`cost_usd` NULL, the shape cinatra#2582 established
 * for the Graphiti hand-over): the ledger states the one thing that is true —
 * an image call happened, on this provider, for this caller — and leaves the
 * dollars UNKNOWN rather than inventing a price. Nothing about the second state
 * changed, so no adapter has to move for the ledger to keep working.
 */
const IMAGE_METHOD = "generateImage";

/**
 * The token columns an image row carries when the adapter reported nothing:
 * zeros because `usage_events` requires numbers, never because anything was
 * measured. An image bill is denominated in images, so a zeroed cost derived
 * from these zeros would read as "this was free"; the dollars come from the
 * reported image usage instead, or stay NULL.
 */
const UNREPORTED_IMAGE_USAGE: LlmUsageData = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * A count the seam is willing to multiply by money, or `undefined`.
 *
 * Validated rather than trusted. A connector is third-party code, and these
 * numbers reach a dollar rate: a `NaN`, a `1.5`, a negative, an `Infinity` or a
 * `"2"` would mint a nonsense price and store it with the same confidence as a
 * real one. Anything that is not a safe integer at or above `min` is treated as
 * NOT REPORTED, which lands the row in the counted-but-unpriced state it already
 * had. A malformed report therefore costs the ledger its price, never a wrong
 * price.
 */
function readBillableCount(
  value: unknown,
  min: number,
): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? value
    : undefined;
}

/**
 * The model identifier the ADAPTER attested, or `undefined`.
 *
 * Read INDEPENDENTLY of the usage numbers on purpose. An adapter that names the
 * model it addressed but reports no usable count has still told the ledger
 * something true, and labelling that row with the model the CALLER asked for
 * would throw away the better answer. Only PRICING is gated on the pair (see
 * {@link readPriceableImageUsage}).
 */
function readAttestedImageModel(result: GenerateImageResult): string | undefined {
  const model = result?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * What the ADAPTER attested about an image invocation, reduced to the quantities
 * a price can be built from — or `undefined`, meaning "count the row, price
 * nothing".
 *
 * WHY AN ATTESTED MODEL IS PART OF THE GATE. The ledger looks a rate up by
 * model, and the seam's fallback for a row's model name is the model the CALLER
 * asked for. A requested name is not evidence of which model was addressed: an
 * adapter is free to substitute one, and pricing a substitution off the
 * requested name would charge one model's rate for another model's work. So a
 * `usage` reported WITHOUT an attested `model` is honoured as far as it goes —
 * the row is still counted — and no count reaches the rate card.
 *
 * `promptTokens` stays `undefined` when the adapter reported none, and is NOT
 * collapsed to `0` here. The row's `input_tokens` column cannot preserve that:
 * it is NOT NULL, so "unreported" has to be written as `0`. For a provider that
 * bills the prompt, `0` and "unreported" are opposite answers — reading an
 * unreported prompt as zero would price the images and drop the rest of the
 * bill — so the caller pairs the column with an `imagePromptTokensReported`
 * flag. A flag and not a second copy of the number: two copies could disagree.
 */
function readPriceableImageUsage(
  result: GenerateImageResult,
): { images: number; promptTokens: number | undefined } | undefined {
  if (readAttestedImageModel(result) === undefined) return undefined;

  const images = readBillableCount(result?.usage?.images, 1);
  if (images === undefined) return undefined;

  // Zero prompt tokens IS a legitimate report (`min` 0), unlike zero images.
  return {
    images,
    promptTokens: readBillableCount(result?.usage?.inputTokens, 0),
  };
}

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

type GenerateImageResult = LlmImageResponse | null;

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
 * ITS TARGET IS A FACADE, not the connector's adapter (cinatra#2670). A proxy's
 * invariants are checked against ITS TARGET, so wrapping the adapter itself made
 * a FROZEN adapter — `Object.freeze(adapter)`, or a method defined
 * non-configurable and non-writable — unable to carry a metered method at all:
 * `[[Get]]` may not answer with anything other than the value of the target's own
 * non-configurable, non-writable property, so `metered.generate` threw a
 * `TypeError`, and `[[GetOwnProperty]]` had to report such a property VERBATIM,
 * so `Object.getOwnPropertyDescriptor(metered, "generate").value` handed back the
 * connector's raw, unmetered function. Both failures came from the target rather
 * than from the traps. The target below is therefore an empty, extensible object
 * that owns nothing and can contradict nothing, and every trap answers for the
 * ADAPTER. The other way out — reporting the adapter's own non-configurable
 * property as configurable — the runtime REJECTS while the adapter is the target,
 * and it would misdescribe the connector's object anyway; this design needs no
 * such claim, because the object being described really is the facade.
 *
 * WHAT A CALLER SEES DIFFERENTLY because of the facade, all of it about the
 * OBJECT rather than about its members: `Object.isExtensible` is true and
 * `Object.isFrozen` / `Object.isSealed` are false even for a frozen adapter;
 * `Object.preventExtensions` / `seal` / `freeze` are REFUSED (a `TypeError`)
 * rather than sealing an object whose every member is answered by a trap; a
 * described member reports `configurable: true`, the truth about the facade and
 * the reason a frozen adapter's method can be described at all; and a
 * `defineProperty` that would PIN a member is refused rather than half-applied.
 * Each is stated at the trap that decides it. Everything a caller actually
 * consumes — members and their values, presence, enumeration, the prototype, and
 * ordinary assignment and deletion including a frozen adapter's refusals — reads
 * through to the adapter.
 *
 * WHAT IT STILL DOES NOT DEFEND, stated because "no unmetered callable exists"
 * would otherwise be read as absolute: a class-based adapter's methods live on
 * its PROTOTYPE, and the prototype is the connector's own object (it has to be,
 * or `instanceof` would stop answering). `Object.getPrototypeOf(metered).generate`
 * is therefore the raw method, exactly as it was before this seam existed. The
 * guarantee this module makes is against a call site SILENTLY bypassing the
 * ledger — reaching a provider by resolving an adapter and calling it — not
 * against code that walks a prototype chain to defeat its own instrumentation.
 *
 * Metering never changes the ANSWER a caller observes: the response object is
 * returned untouched, and `emitUsageEvent` itself never throws.
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
  //
  // Each entry is TAGGED with the raw member it wrapped, so it cannot go stale:
  // the resolver re-reads the adapter on every access and reuses the wrapper only
  // while the adapter still answers with that same member. A member replaced by
  // anyone — through this proxy, through a prototype swap, or by connector code
  // holding its own reference — is therefore re-wrapped on the next read instead
  // of being served from a snapshot taken before it moved.
  const members = new Map<string | symbol, { raw: unknown; metered: unknown }>();

  const remember = (
    prop: string | symbol,
    raw: unknown,
    metered: unknown,
  ): unknown => {
    members.set(prop, { raw, metered });
    return metered;
  };

  // The single member resolver both traps go through, so a reflective read and
  // a normal read can never disagree about what `generate` is.
  const readMeteredMember = (prop: string | symbol): unknown => {
    if (prop === METERED_ADAPTER) return true;
    // Deliberately reading off `adapter` rather than forwarding a `receiver`:
    // a connector getter that reads a sibling member would otherwise re-enter
    // this trap with the proxy as `this`.
    const target = adapter;
    const value = Reflect.get(target, prop);
    const cached = members.get(prop);
    if (cached && cached.raw === value) return cached.metered;
    if (typeof value !== "function") return value;

    if (typeof prop === "string" && RESPONSE_METHODS.has(prop)) {
      return remember(prop, value, async (input: AdapterCallInput): Promise<LlmResponse> => {
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
      return remember(prop, value, async (input: AdapterCallInput): Promise<void> => {
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
      return remember(prop, value, async (
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
        const priceable = readPriceableImageUsage(result);
        emitLlmUsage({
          provider: target.provider,
          // What the adapter ATTESTED, then what the caller asked for — the
          // second only ever LABELS the row, never prices it (see
          // `readPriceableImageUsage`). `defaultModel` is deliberately NOT in
          // this chain: it is the adapter's default TEXT model, so naming it
          // would state a model that did not answer — and, worse, one the
          // per-token card knows. Neither ⇒ "unknown".
          model: readAttestedImageModel(result) ?? input?.model ?? null,
          operation: "image",
          logLabel: resolveAgentLabel(attribution, input?.logLabel),
          skillLabel: attribution?.skillLabel ?? null,
          // The prompt tokens this call was billed for, when the adapter
          // reported them — and the ONLY copy of that quantity anywhere in the
          // event. Real measurements go in the real columns: leaving them at
          // zero while pricing them would make the row's own numbers contradict
          // its cost. Nothing reported ⇒ the zeros the schema needs, and the
          // flag below is what remembers which of the two this is.
          usage:
            priceable?.promptTokens === undefined
              ? UNREPORTED_IMAGE_USAGE
              : { ...UNREPORTED_IMAGE_USAGE, inputTokens: priceable.promptTokens },
          // The per-image unit the row is priced in. Read off the RESPONSE and
          // never inferred: "an invocation resolved" does not imply "one image
          // was billed" (a `null` answer bills whatever the provider decided,
          // and a multi-candidate request bills more than the one image
          // returned), so a defaulted 1 here would be a guess wearing a
          // measurement's clothes.
          imageCount: priceable?.images,
          // Whether the `input_tokens` above is a REPORT or the placeholder the
          // NOT NULL column demands. The column cannot carry that distinction
          // itself — "nothing was said" arrives as `0` — and without it a
          // provider that bills the prompt would be charged for the images
          // only. A second copy of the NUMBER would have said the same thing
          // and added a way for the two to disagree, so this is a flag over the
          // one quantity rather than a duplicate of it.
          imagePromptTokensReported: priceable?.promptTokens !== undefined,
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
    return remember(prop, value, value.bind(target));
  };

  // A described ACCESSOR member's replacement getter, memoised per property so a
  // descriptor read is as stable as a member read: two descriptors for the same
  // accessor carry the same `get`, not two closures that merely behave alike.
  const facadeGetters = new Map<string | symbol, () => unknown>();

  const facadeGetter = (prop: string | symbol): (() => unknown) => {
    const existing = facadeGetters.get(prop);
    if (existing) return existing;
    const read = (): unknown => readMeteredMember(prop);
    facadeGetters.set(prop, read);
    return read;
  };

  // The proxy TARGET (see the note above): an empty, extensible object that
  // exists only so that nothing the target owns can contradict what a trap
  // answers. It is never written to; every trap below reads the ADAPTER.
  const facade = Object.create(null) as LlmProviderAdapter;

  const metered = new Proxy(facade, {
    get(_facade, prop) {
      return readMeteredMember(prop);
    },

    /**
     * Reflective reads see the SAME member the `get` trap hands out.
     *
     * Without this, `Object.getOwnPropertyDescriptor(adapter, "generate").value`
     * would hand back the connector's raw, unmetered function — a hole in the
     * "there is no way to obtain an unmetered adapter" claim. It holds for a
     * frozen adapter too, because the descriptor describes the FACADE, and the
     * facade owns no property that could pin the answer; `value`, `writable` and
     * `enumerable` are the adapter's, so enumeration, cloning and write behaviour
     * are unchanged (a frozen adapter still refuses the write `set` forwards).
     *
     * An ACCESSOR member keeps its accessor shape, with a getter that answers
     * exactly what an ordinary read answers — invoked on READ, so a lazy member
     * is still built lazily, and never resolved merely by describing it.
     */
    getOwnPropertyDescriptor(_facade, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(adapter, prop);
      if (!descriptor) return undefined;
      const reported = { ...descriptor, configurable: true };
      if (reported.get) return { ...reported, get: facadeGetter(prop) };
      if (typeof descriptor.value !== "function") return reported;
      return { ...reported, value: readMeteredMember(prop) };
    },

    // PRESENCE is the adapter's: core decides what a provider can do by probing
    // optional members, and the facade knows none of them.
    has(_facade, prop) {
      return prop === METERED_ADAPTER || Reflect.has(adapter, prop);
    },

    ownKeys() {
      return Reflect.ownKeys(adapter);
    },

    getPrototypeOf() {
      return Reflect.getPrototypeOf(adapter);
    },

    setPrototypeOf(_facade, proto) {
      return Reflect.setPrototypeOf(adapter, proto);
    },

    // Writes land on the CONNECTOR's object — including its refusals, so a
    // frozen adapter still rejects them. A connector SETTER runs with the
    // connector as its receiver, for the reason the resolver reads off the
    // adapter: with the proxy as receiver, a setter touching a sibling member
    // would re-enter these traps, and a `#private` field would fail its brand
    // check. The member cache needs no invalidation here — an entry is only
    // reused while the adapter still answers with the member it wrapped.
    set(_facade, prop, value) {
      return Reflect.set(adapter, prop, value);
    },

    /**
     * A definition that would PIN a property is REFUSED before it can touch the
     * adapter. The facade would not own the matching non-configurable property
     * afterwards, so the runtime would throw over the trap's `true` — with the
     * connector's object already mutated — and short of a throw the adapter
     * would hold a pinned member while every descriptor read reported an open
     * one. For a property the adapter does not own yet, OMITTING `configurable`
     * pins it exactly as `false` does: that is what `defineProperty` defaults
     * to. Pinning a member is the CONNECTOR's to do, on its own object, before
     * metering wraps it — which is precisely the frozen adapter this proxy now
     * carries.
     */
    defineProperty(_facade, prop, descriptor) {
      const owned = Reflect.getOwnPropertyDescriptor(adapter, prop);
      const pins = owned
        ? descriptor.configurable === false
        : descriptor.configurable !== true;
      if (pins) return false;
      return Reflect.defineProperty(adapter, prop, descriptor);
    },

    deleteProperty(_facade, prop) {
      return Reflect.deleteProperty(adapter, prop);
    },

    /**
     * REFUSED, loudly, rather than half-done. Sealing the facade would leave a
     * target that owns nothing while every member is answered by a trap, and the
     * runtime would then reject `ownKeys` for naming members the target lacks.
     * There is nothing here to seal; the connector's own object is untouched.
     */
    preventExtensions() {
      return false;
    },
  });

  meteredAdapters.add(metered);
  return metered;
}
