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

// Cadence of the widget-stream runtime-approved-slug snapshot refresher (the
// upper bound on how long a revoked slug lingers as a redirect-SKIP; the
// in-handler resolver is the real wall, so a lingering slug still 404s). Env-
// overridable, clamped to a sane floor so a misconfig cannot hammer the DB.
const WIDGET_STREAM_SLUG_REFRESH_DEFAULT_MS = 60_000;
const WIDGET_STREAM_SLUG_REFRESH_MIN_MS = 5_000;
const WIDGET_STREAM_SLUG_REFRESH_MAX_MS = 24 * 60 * 60 * 1000; // 24h — well under setInterval's 32-bit ceiling
function resolveWidgetStreamSlugRefreshIntervalMs(): number {
  const raw = process.env.CINATRA_WIDGET_STREAM_RUNTIME_SLUG_REFRESH_MS;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return WIDGET_STREAM_SLUG_REFRESH_DEFAULT_MS;
  // Clamp BOTH ways: a floor so a typo can't hammer the DB, a ceiling so an
  // oversized value can't overflow setInterval into a ~1ms hot loop.
  return Math.min(
    WIDGET_STREAM_SLUG_REFRESH_MAX_MS,
    Math.max(WIDGET_STREAM_SLUG_REFRESH_MIN_MS, Math.floor(n)),
  );
}

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
    {
      name: "widget-stream-runtime-slug-refresher",
      policy: "degraded",
      run: async () => {
        // Start the per-replica background refresher that keeps the sign-in
        // wall's runtime-approved widget-stream slug snapshot warm (widget-stream
        // runtime trust, slice 4). Each replica refreshes independently — no
        // cross-replica coherence is needed because the snapshot is pure
        // liveness (redirect-skip only; the in-handler resolver is the real
        // wall). `degraded`: if it fails to start, the snapshot stays cold and
        // runtime-approved widget routes 307 to /sign-in until it recovers — a
        // fail-closed liveness blip, never an open route; the process serves on.
        const { GENERATED_WIDGET_STREAM_PUBLIC_PATHS } = await import(
          "@/lib/generated/widget-stream-public-paths"
        );
        const {
          deriveBuildTimeWidgetSlugs,
          startWidgetStreamRuntimeSlugRefresher,
        } = await import("@/lib/widget-stream-runtime-slug-snapshot");
        const { defaultApprovedWidgetStreamSlugEnumerator } = await import(
          "@/lib/widget-stream-runtime-slug-enumerator"
        );
        const intervalMs = resolveWidgetStreamSlugRefreshIntervalMs();
        startWidgetStreamRuntimeSlugRefresher({
          enumerate: defaultApprovedWidgetStreamSlugEnumerator(),
          buildTimeSlugs: deriveBuildTimeWidgetSlugs(
            GENERATED_WIDGET_STREAM_PUBLIC_PATHS,
          ),
          intervalMs,
        });
        console.log(
          `[widget-stream-runtime-slug-snapshot] refresher started (every ${intervalMs}ms; pure-liveness redirect-skip, in-handler resolver is the wall)`,
        );
      },
    },
  ];
}
