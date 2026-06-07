# @cinatra-ai/metric-usage-api

Captures LLM and connector token/usage events at call time and exposes them as
MCP primitives. It provides a lightweight in-process event bus that LLM
orchestration and connectors emit to, plus read-only MCP tools that surface
aggregated token usage (delegating pricing/persistence to
`@cinatra-ai/metric-cost-api`).

## Public API

- `emitUsageEvent(event)` — emit a usage event (never throws)
- `onUsageEvent(handler)` — subscribe to usage events; returns an unsubscribe function
- `createMetricUsageMcpModule()` — MCP module exposing usage primitives via `registerCapabilities`
- `UsageEvent` — union of usage event shapes (type)
- `LlmUsageEvent` — LLM token usage event with provider, model, and token counts (type)
- `ApolloUsageEvent` — Apollo connector usage event with request/result/credit counts (type)

The MCP module registers two primitives:

- `metric_usage_events` — daily token usage time-series (optional `days`: 7, 30, or 90)
- `metric_usage_summary` — token usage summary by provider (optional `days`: 7, 30, or 90)

## Usage

```ts
import { emitUsageEvent, onUsageEvent } from "@cinatra-ai/metric-usage-api";

const unsubscribe = onUsageEvent((event) => {
  // persist or aggregate the usage event
});

emitUsageEvent({
  source: "llm",
  provider: "openai",
  model: "gpt-5",
  operation: "generate",
  agentLabel: null,
  skillLabel: null,
  inputTokens: 1200,
  outputTokens: 350,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  idempotencyKey: "req-123",
  occurredAt: new Date().toISOString(),
});

unsubscribe();
```

## Docs

See https://docs.cinatra.ai
