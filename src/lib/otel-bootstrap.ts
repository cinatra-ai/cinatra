import "server-only";

// ---------------------------------------------------------------------------
// OpenTelemetry tracer-provider bootstrap.
// Called once at Next.js server startup via src/instrumentation.node.ts#register().
// Idempotent: re-invocation is a no-op (dev hot-reload invokes register()
// multiple times).
// ---------------------------------------------------------------------------

let initialized = false;

// The registered NodeTracerProvider, captured at init so a fatal-error flush
// (src/lib/boot/fatal-error-policy.ts) can force-export buffered spans before the
// process exits. `unknown` to avoid importing the heavy OTel types eagerly; the
// flush narrows to the `forceFlush()` shape defensively.
let registeredProvider: { forceFlush?: () => Promise<void> } | undefined;

export async function initializeOtelTracing(): Promise<void> {
  if (initialized) return;

  // OTel Node SDK does not run on Edge runtime.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Dynamic imports — keep OTel code out of the module graph when the bootstrap
  // is not called (e.g. during tests, client bundle).
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  const { Resource } = await import("@opentelemetry/resources");
  const { SemanticResourceAttributes } = await import(
    "@opentelemetry/semantic-conventions"
  );
  const { PostgresSpanExporter } = await import(
    "@cinatra-ai/metric-cost-api"
  );

  const serviceName = process.env.OTEL_SERVICE_NAME || "cinatra-app";

  // ---------------------------------------------------------------------------
  // Sentry co-ownership.
  //
  // When SENTRY_DSN is set, Sentry contributes SpanProcessor / Sampler /
  // Propagator / context-manager to *this* NodeTracerProvider so its export
  // path runs alongside PostgresSpanExporter without ever calling
  // `provider.register()` a second time.
  //
  // Sentry must already be initialised at this point (sentry.server.config
  // runs first in instrumentation.node.ts). If the client is unavailable,
  // we skip Sentry wiring and continue with Postgres tracing only.
  // ---------------------------------------------------------------------------
  let sentrySampler: import("@opentelemetry/sdk-trace-base").Sampler | undefined;
  let sentryProcessor:
    | import("@opentelemetry/sdk-trace-base").SpanProcessor
    | undefined;
  let sentryPropagator: import("@opentelemetry/api").TextMapPropagator | undefined;
  let sentryContextManager: import("@opentelemetry/api").ContextManager | undefined;

  const sentryEnabled = Boolean(process.env.SENTRY_DSN);
  if (sentryEnabled) {
    try {
      const sentryOtel = await import("@sentry/opentelemetry");
      // @sentry/nextjs re-exports getClient from @sentry/node which re-exports
      // it from @sentry/core. Using the @sentry/nextjs path keeps Cinatra free
      // of a direct @sentry/core peer dependency.
      const sentryNextjs = await import("@sentry/nextjs");
      const client = sentryNextjs.getClient();
      if (client) {
        sentrySampler = new sentryOtel.SentrySampler(client);
        sentryProcessor = new sentryOtel.SentrySpanProcessor();
        sentryPropagator = new sentryOtel.SentryPropagator();
        // @sentry/opentelemetry exports SentryAsyncLocalStorageContextManager
        // directly (it's `wrapContextManagerClass(AsyncLocalStorageContextManager)`
        // pre-applied — see node_modules/@sentry/opentelemetry/build/types/
        // asyncLocalStorageContextManager.d.ts). Using the pre-wrapped class
        // avoids pulling in @opentelemetry/context-async-hooks as a direct
        // dep and matches Sentry SDK's documented Node.js path.
        sentryContextManager = new sentryOtel.SentryAsyncLocalStorageContextManager();
      }
    } catch (err) {
      console.warn(
        "[otel-bootstrap] Sentry OTel integration unavailable:",
        err,
      );
    }
  }

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
    ...(sentrySampler ? { sampler: sentrySampler } : {}),
  });

  provider.addSpanProcessor(new BatchSpanProcessor(new PostgresSpanExporter()));
  if (sentryProcessor) {
    provider.addSpanProcessor(sentryProcessor);
  }
  // Propagator: ALWAYS pass an explicit value. When Sentry is unavailable we
  // pass `null`, NOT undefined. With `undefined`, BasicTracerProvider.register()
  // falls back to OTEL_PROPAGATORS (default `tracecontext,baggage`) and installs
  // a W3CBaggagePropagator as the global propagator. cinatra never extracts or
  // propagates W3C baggage, and @opentelemetry/core's baggage parse path carries
  // an unbounded-allocation advisory (GHSA-8988-4f7v-96qf, patched only in the
  // 2.x SDK we don't yet ship). Passing `null` suppresses the default global
  // propagator entirely, so the vulnerable parser is never wired to inbound
  // headers — the no-exposure stance is enforced by code, not incidental.
  //
  // Tradeoff: with Sentry off this also drops the (safe, non-vulnerable) default
  // W3C `tracecontext` global propagator. That is acceptable here: cinatra does
  // no cross-service context propagation in app code (no propagation.extract/
  // inject anywhere), spans are exported locally to Postgres regardless, and
  // production always runs with Sentry, whose propagator already carries
  // tracecontext. We deliberately do NOT add a direct @opentelemetry/core import
  // for W3CTraceContextPropagator — that would make the vulnerable core@1.30.1 a
  // direct dependency. Restore tracecontext via the SDK-2.x lift when it lands.
  provider.register({
    propagator: sentryPropagator ?? null,
    ...(sentryContextManager ? { contextManager: sentryContextManager } : {}),
  });

  registeredProvider = provider as { forceFlush?: () => Promise<void> };
  initialized = true;
  console.info(
    `[otel-bootstrap] NodeTracerProvider registered (service=${serviceName}${sentryEnabled ? ", sentry=on" : ""})`,
  );
}

/**
 * Best-effort force-flush of the BatchSpanProcessor so the spans buffered around a
 * fatal crash are exported BEFORE the process exits. No-op when tracing was never
 * initialised (e.g. Edge runtime, tests). Never throws — the fatal-exit path must
 * not be wedged by a flush failure (engineering #302).
 */
export async function flushOtelTracing(): Promise<void> {
  const provider = registeredProvider;
  if (!provider || typeof provider.forceFlush !== "function") return;
  try {
    await provider.forceFlush();
  } catch {
    /* best-effort — never block the fatal-exit path */
  }
}
