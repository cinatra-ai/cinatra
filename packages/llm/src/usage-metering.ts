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
 * `createAdapter()`). That function now returns a METERED adapter: a transparent
 * proxy that emits a usage event for every response carrying usage, on every
 * response-producing method, whoever called it. Instrumentation is therefore
 * STRUCTURAL — a future call site cannot silently bypass the ledger, because
 * there is no other way to obtain an adapter.
 *
 * ATTRIBUTION. The transport layer can see the provider, the model and the
 * adapter input's `logLabel`, but not the caller's skill/telemetry context. A
 * caller supplies that through {@link withUsageAttribution}, an AsyncLocalStorage
 * frame read at emit time. Absent frame ⇒ the honest defaults (skillLabel null,
 * requested/effective provider null) — never a dropped row.
 *
 * THE ONE OPT-OUT. {@link withCallerEmittedUsage} silences the proxy for calls
 * whose caller emits a RICHER row itself (today: the llm-bridge media branch,
 * which knows the dispatch's requested/effective provider and the calling agent
 * id). It exists so the two emitters can never double-count. It is deliberately
 * a single greppable name, and `src/__tests__/llm-usage-ledger-chokepoint.test.ts`
 * pins the allowlist of files permitted to use it, so a new opt-out cannot appear
 * unnoticed.
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
  /** Overrides the adapter input's `logLabel` when the caller knows better. */
  agentLabel?: string | null;
  skillLabel?: string | null;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
  /**
   * INTERNAL — set only by {@link withCallerEmittedUsage}. When true the
   * metering proxy stays silent because the caller emits the row itself.
   */
  usageEmittedByCaller?: boolean;
};

const attributionStore = new AsyncLocalStorage<UsageAttribution>();

/**
 * Run `fn` with extra usage attribution in scope. Nested frames MERGE onto the
 * enclosing one (a caller that only knows the skill does not erase an outer
 * frame's provider telemetry).
 */
export function withUsageAttribution<T>(
  attribution: UsageAttribution,
  fn: () => T,
): T {
  const parent = attributionStore.getStore();
  return attributionStore.run({ ...parent, ...attribution }, fn);
}

/**
 * Suppress transport-layer metering for `fn` because the CALLER emits the usage
 * row itself. The one legitimate reason to use this is a caller that can emit a
 * strictly richer row than the transport seam can see; anything else belongs in
 * {@link withUsageAttribution} instead.
 */
export function withCallerEmittedUsage<T>(fn: () => T): T {
  return withUsageAttribution({ usageEmittedByCaller: true }, fn);
}

export function getUsageAttribution(): UsageAttribution | undefined {
  return attributionStore.getStore();
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
 * The ONE place a `source: "llm"` usage event is constructed inside
 * `packages/llm`. Keeping the shape in one function is what lets the
 * `usage_events` columns be trusted across paths that otherwise share nothing
 * (synchronous generate, streaming steps, batch outcomes).
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
/** Marks an `onUsageData` callback that already emits, so we do not double-emit. */
const METERED_USAGE_CALLBACK = Symbol.for("cinatra.llm.usage-metered-callback");

export function isMeteredAdapter(adapter: unknown): boolean {
  return Boolean(
    adapter && (adapter as Record<symbol, unknown>)[METERED_ADAPTER] === true,
  );
}

/**
 * Tag an `onUsageData` callback as self-emitting. The proxy then passes it
 * through untouched instead of wrapping it, so a caller that built its own
 * emitter (see `createStreamUsageEmitter`) still produces exactly one row per
 * usage report.
 */
export function markMeteredUsageCallback<T extends (usage: LlmUsageData) => void>(
  callback: T,
): T {
  (callback as unknown as Record<symbol, unknown>)[METERED_USAGE_CALLBACK] = true;
  return callback;
}

function isMeteredUsageCallback(callback: unknown): boolean {
  return Boolean(
    typeof callback === "function" &&
      (callback as unknown as Record<symbol, unknown>)[METERED_USAGE_CALLBACK] === true,
  );
}

/** Adapter methods that answer with an `LlmResponse` (and therefore with usage). */
const RESPONSE_METHODS = new Set([
  "generate",
  "generateWithFileInput",
  "generateFromMediaFile",
]);

type AdapterCallInput = {
  model?: string;
  logLabel?: string;
  onUsageData?: (usage: LlmUsageData) => void;
};

/**
 * Wrap an adapter so every response-producing call is metered.
 *
 * A PROXY rather than a spread copy on purpose: `LlmProviderAdapter` has ten
 * OPTIONAL members and core probes their PRESENCE to decide behaviour
 * (`readBatchSupport` reads `submitBatch`/`batchV2`, `resolveDefaultImageAdapter`
 * reads `generateImage`, `uploadFile`/`deleteFile` are probed before use). A
 * spread would have to enumerate them and would silently drop any member added
 * to the ABI later; the proxy is transparent by construction.
 *
 * Metering NEVER changes what a caller observes: the response object is returned
 * untouched, and `emitUsageEvent` itself never throws.
 */
export function meterLlmProviderAdapter(
  adapter: LlmProviderAdapter,
): LlmProviderAdapter {
  if (isMeteredAdapter(adapter)) return adapter;

  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === METERED_ADAPTER) return true;
      // Deliberately reading off `target` rather than forwarding a `receiver`:
      // a connector getter that reads a sibling member would otherwise re-enter
      // this trap with the proxy as `this`. Data members and methods both
      // resolve identically off `target`.
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;

      if (typeof prop === "string" && RESPONSE_METHODS.has(prop)) {
        return async (input: AdapterCallInput): Promise<LlmResponse> => {
          const attribution = getUsageAttribution();
          const response = (await Reflect.apply(value, target, [
            input,
          ])) as LlmResponse;
          if (response?.usage && attribution?.usageEmittedByCaller !== true) {
            emitLlmUsage({
              provider: target.provider,
              model: response.model ?? input?.model ?? target.defaultModel,
              operation: "generate",
              logLabel: input?.logLabel ?? attribution?.agentLabel ?? null,
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
        };
      }

      if (prop === "stream") {
        return async (input: AdapterCallInput): Promise<void> => {
          const attribution = getUsageAttribution();
          const callerOnUsageData = input?.onUsageData;
          if (
            attribution?.usageEmittedByCaller === true ||
            isMeteredUsageCallback(callerOnUsageData)
          ) {
            return Reflect.apply(value, target, [input]) as Promise<void>;
          }
          const model = input?.model ?? target.defaultModel;
          const logLabel = input?.logLabel ?? attribution?.agentLabel ?? null;
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
        };
      }

      return value;
    },
  });
}
