import { describe, it, expect, beforeEach } from "vitest";
import { emitUsageEvent, onUsageEvent } from "../src/index";
import type { UsageEvent, LlmUsageEvent } from "../src/index";

// The bus is a globalThis singleton. Reset it between tests so listener counts
// are deterministic regardless of import order.
beforeEach(() => {
  (globalThis as { __cinatraUsageEventEmitter?: unknown }).__cinatraUsageEventEmitter = undefined;
});

function llmEvent(overrides: Partial<LlmUsageEvent> = {}): LlmUsageEvent {
  return {
    source: "llm",
    provider: "anthropic",
    model: "test-model",
    operation: "generate",
    agentLabel: null,
    skillLabel: null,
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    idempotencyKey: "k",
    occurredAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("metric-contracts usage-event bus", () => {
  it("delivers an emitted event to a subscriber (single shared bus)", () => {
    const received: UsageEvent[] = [];
    const off = onUsageEvent((e) => received.push(e));
    emitUsageEvent(llmEvent({ model: "delivered" }));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ source: "llm", model: "delivered" });
    off();
  });

  it("unsubscribe stops delivery", () => {
    const received: UsageEvent[] = [];
    const off = onUsageEvent((e) => received.push(e));
    off();
    emitUsageEvent(llmEvent());
    expect(received).toHaveLength(0);
  });

  it("emit never throws even with no subscribers", () => {
    expect(() => emitUsageEvent(llmEvent())).not.toThrow();
  });

  it("SINGLE emitter backs every import path (no per-package copy)", async () => {
    // Codex-requested identity proof. The cycle break is only safe if there is
    // exactly ONE emitter instance: a producer (e.g. metric-usage-api, which
    // re-exports emitUsageEvent from this package) emitting must reach a
    // consumer (e.g. metric-cost-api's subscriber, which calls onUsageEvent
    // from this package). Both go through this module. Prove the emit path and
    // the subscribe path — imported via DIFFERENT specifiers — share one bus.
    const viaIndex = await import("../src/index");
    const viaBus = await import("../src/bus");
    const received: UsageEvent[] = [];
    const off = viaBus.onUsageEvent((e) => received.push(e)); // subscribe via the bus module
    viaIndex.emitUsageEvent(llmEvent({ model: "single-instance" })); // emit via the index re-export
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ model: "single-instance" });
    off();
  });
});
