import "server-only";
import { randomUUID } from "node:crypto";
import { onUsageEvent } from "@cinatra-ai/metric-contracts";
import type { UsageEvent } from "@cinatra-ai/metric-contracts";
import { insertUsageEvent } from "./store";
import { computeLlmCostUsd, computeApolloCostUsd, batchRateMultiplier } from "./pricing";

let started = false;

export function startUsageEventSubscriber(): void {
  if (started) return;
  started = true;

  onUsageEvent(async (event: UsageEvent) => {
    try {
      if (event.source === "llm") {
        const costUsd = await computeLlmCostUsd({
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens,
          cacheReadInputTokens: event.cacheReadInputTokens,
          cacheCreationInputTokens: event.cacheCreationInputTokens,
          // cinatra#2578: asynchronous batch work is billed at half the
          // synchronous rate this module's card carries. Pricing a batch row off
          // the plain card would overstate that spend ~2x.
          rateMultiplier:
            event.operation === "batch"
              ? batchRateMultiplier(event.provider)
              : 1,
        });
        await insertUsageEvent({
          id: randomUUID(),
          occurredAt: new Date(event.occurredAt),
          source: "llm",
          provider: event.provider,
          requestedProvider: event.requestedProvider ?? null,
          effectiveProvider: event.effectiveProvider ?? null,
          model: event.model,
          operation: event.operation ?? "generate",
          agentLabel: event.agentLabel,
          skillLabel: event.skillLabel ?? null,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens,
          reasoningOutputTokens: event.reasoningOutputTokens,
          creditsConsumed: 0,
          costUsd: costUsd?.toFixed(8) ?? null,
          idempotencyKey: event.idempotencyKey,
        });
      } else if (event.source === "graphiti") {
        // cinatra#2582. One episode handed to the knowledge-graph indexer, whose
        // per-episode OpenAI fan-out is billed on the injected key and is NOT
        // reported back by the wrapper. Persisted with `cost_usd` NULL — the
        // dashboard's own "unknown cost" counter is the honest surface for it.
        // Zeroing the token columns is a schema NOT-NULL requirement, not a
        // claim: the dollars live in the NULL cost, never in a made-up estimate.
        await insertUsageEvent({
          id: randomUUID(),
          occurredAt: new Date(event.occurredAt),
          source: "graphiti",
          provider: event.provider,
          model: null,
          operation: event.operation,
          agentLabel: null,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          creditsConsumed: 0,
          costUsd: null,
          idempotencyKey: event.idempotencyKey,
        });
      } else if (event.source === "apollo") {
        const costUsd = computeApolloCostUsd({
          operation: event.operation,
          creditsConsumed: event.creditsConsumed,
        });
        await insertUsageEvent({
          id: randomUUID(),
          occurredAt: new Date(event.occurredAt),
          source: "apollo",
          provider: "apollo",
          model: null,
          operation: event.operation,
          agentLabel: event.agentLabel,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          creditsConsumed: event.creditsConsumed,
          costUsd: costUsd.toFixed(8),
          idempotencyKey: event.idempotencyKey,
        });
      }
    } catch (err) {
      // Never throw from subscriber — a DB failure must not crash the LLM call
      console.error("[metric-cost-api] Failed to record usage event:", err);
    }
  });
}
