import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmUsageEvent } from "@cinatra-ai/metric-contracts";

// ---------------------------------------------------------------------------
// Telemetry: subscriber writes requested_provider + effective_provider into
// usage_events rows.
//
// Hermetic — NO live Postgres, NO live emitter. The subscriber registers a
// handler via onUsageEvent(); we capture that handler via the mock and invoke
// it directly with crafted LlmUsageEvents, then assert on the mocked
// insertUsageEvent payload.
// ---------------------------------------------------------------------------

const { mockInsertUsageEvent, mockOnUsageEvent, mockComputeLlmCostUsd } = vi.hoisted(() => {
  const mockInsertUsageEvent = vi.fn();
  const mockOnUsageEvent = vi.fn();
  const mockComputeLlmCostUsd = vi.fn();
  return { mockInsertUsageEvent, mockOnUsageEvent, mockComputeLlmCostUsd };
});

vi.mock("../src/store", () => ({ insertUsageEvent: mockInsertUsageEvent }));
vi.mock("../src/pricing", () => ({
  computeLlmCostUsd: mockComputeLlmCostUsd,
  computeApolloCostUsd: vi.fn().mockReturnValue(0),
}));
vi.mock("@cinatra-ai/metric-contracts", () => ({
  onUsageEvent: mockOnUsageEvent,
}));

// startUsageEventSubscriber holds a module-level `started` flag; reset by
// re-importing per test (vi.resetModules) so each test re-registers and we
// can capture the fresh handler.
async function loadSubscriber(): Promise<(event: LlmUsageEvent) => Promise<void>> {
  vi.resetModules();
  let capturedHandler: ((event: LlmUsageEvent) => Promise<void>) | null = null;
  mockOnUsageEvent.mockImplementation((handler: (event: LlmUsageEvent) => Promise<void>) => {
    capturedHandler = handler;
    return () => {};
  });
  const mod = await import("../src/event-subscriber");
  mod.startUsageEventSubscriber();
  if (!capturedHandler) {
    throw new Error("Subscriber did not register a handler via onUsageEvent");
  }
  return capturedHandler;
}

function baseEvent(overrides: Partial<LlmUsageEvent> = {}): LlmUsageEvent {
  return {
    source: "llm",
    provider: "gemini",
    model: "gemini-2.5-flash",
    operation: "generate",
    agentLabel: "synthetic-test-agent",
    skillLabel: null,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    idempotencyKey: "fixed-key-for-test",
    occurredAt: "2026-05-11T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockInsertUsageEvent.mockReset();
  mockOnUsageEvent.mockReset();
  mockComputeLlmCostUsd.mockReset();
  mockComputeLlmCostUsd.mockResolvedValue(0.001);
});

describe("subscriber provider-routing telemetry", () => {
  it("WRITE-BOTH: requested+effective both populated when provider was honored", async () => {
    const handler = await loadSubscriber();
    await handler(baseEvent({ requestedProvider: "gemini", effectiveProvider: "gemini" }));
    expect(mockInsertUsageEvent).toHaveBeenCalledTimes(1);
    const payload = mockInsertUsageEvent.mock.calls[0][0];
    expect(payload.requestedProvider).toBe("gemini");
    expect(payload.effectiveProvider).toBe("gemini");
  });

  it("WRITE-FALLBACK: requested+effective preserved as distinct values when adapter fell back", async () => {
    const handler = await loadSubscriber();
    await handler(baseEvent({ requestedProvider: "gemini", effectiveProvider: "openai" }));
    expect(mockInsertUsageEvent).toHaveBeenCalledTimes(1);
    const payload = mockInsertUsageEvent.mock.calls[0][0];
    expect(payload.requestedProvider).toBe("gemini");
    expect(payload.effectiveProvider).toBe("openai");
  });

  it("WRITE-BACKCOMPAT: legacy emitter (no fields) yields null/null — never undefined", async () => {
    const handler = await loadSubscriber();
    // No requestedProvider / effectiveProvider in the event — legacy emitters
    // without these provider fields must continue to work.
    await handler(baseEvent());
    expect(mockInsertUsageEvent).toHaveBeenCalledTimes(1);
    const payload = mockInsertUsageEvent.mock.calls[0][0];
    expect(payload.requestedProvider).toBeNull();
    expect(payload.effectiveProvider).toBeNull();
    // Critical: NOT undefined — Drizzle treats undefined and null differently
    // for nullable columns. We need an explicit NULL to land in Postgres.
    expect(payload.requestedProvider).not.toBeUndefined();
    expect(payload.effectiveProvider).not.toBeUndefined();
  });

  it("WRITE-PRESERVE-EXISTING: existing `provider` column unchanged when new fields populated alongside", async () => {
    const handler = await loadSubscriber();
    await handler(
      baseEvent({
        provider: "openai",
        requestedProvider: "gemini",
        effectiveProvider: "openai",
      }),
    );
    expect(mockInsertUsageEvent).toHaveBeenCalledTimes(1);
    const payload = mockInsertUsageEvent.mock.calls[0][0];
    // The existing `provider` column is preserved verbatim; the new fields are
    // added alongside it, not instead of it.
    expect(payload.provider).toBe("openai");
    expect(payload.requestedProvider).toBe("gemini");
    expect(payload.effectiveProvider).toBe("openai");
  });
});
