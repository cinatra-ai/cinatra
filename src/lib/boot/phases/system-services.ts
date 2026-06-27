// System-services boot phases (engineering #302).
//
// The always-on (dev AND prod) host services started at boot, extracted verbatim
// from `instrumentation.node.ts`. All `degraded`/`retryable`: each had its own
// log+swallow ("non-fatal"); none aborted boot. They are labeled `degraded` when a
// failure leaves the process durably running with reduced functionality (telemetry
// off, usage events unrecorded) vs `retryable` for an idempotent re-seed.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function systemServicesPhases(): BootPhase[] {
  return [
    {
      name: "assistant-bootstrap",
      policy: "retryable",
      run: async () => {
        // Seed built-in assistant users (@cinatra) on every startup. Idempotent.
        const { ensureAssistantBootstrap } = await import("@/lib/auth");
        await ensureAssistantBootstrap();
      },
    },
    {
      name: "otel-tracing",
      policy: "degraded",
      run: async () => {
        // Initialize the OTel NodeTracerProvider so tracer.startSpan() calls
        // produce spans that reach PostgresSpanExporter. Idempotent.
        // Non-fatal — OTel bootstrap failure must not prevent the server starting,
        // but the process then serves WITHOUT tracing (degraded).
        const { initializeOtelTracing } = await import("@/lib/otel-bootstrap");
        await initializeOtelTracing();
      },
    },
    {
      name: "usage-event-subscriber",
      policy: "degraded",
      run: async () => {
        // Start the metric-cost-api usage event subscriber so LLM and connector
        // usage events are persisted from the first request. Internal idempotency
        // guard makes the duplicate call from registerCapabilities() harmless.
        const { startUsageEventSubscriber } = await import("@cinatra-ai/metric-cost-api");
        startUsageEventSubscriber();
      },
    },
    {
      name: "anthropic-skill-sync-map",
      policy: "retryable",
      run: async () => {
        // Register the table-backed Anthropic skill sync map so the delivery
        // resolver resolves real refs instead of the fail-loud null stub.
        // Idempotent; also called lazily by the sync service. Inert behaviour is
        // enforced downstream by the governance gate.
        const { ensureAnthropicSkillSyncMapRegistered } = await import(
          "@/lib/anthropic-skill-sync-service"
        );
        ensureAnthropicSkillSyncMapRegistered();
      },
    },
  ];
}
