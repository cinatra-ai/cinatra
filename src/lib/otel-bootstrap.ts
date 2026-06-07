import "server-only";

// ---------------------------------------------------------------------------
// OpenTelemetry tracer-provider bootstrap.
// Called once at Next.js server startup via src/instrumentation.node.ts#register().
// Idempotent: re-invocation is a no-op (dev hot-reload invokes register()
// multiple times).
// ---------------------------------------------------------------------------

let initialized = false;

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
  provider.register(
    sentryPropagator || sentryContextManager
      ? {
          ...(sentryPropagator ? { propagator: sentryPropagator } : {}),
          ...(sentryContextManager
            ? { contextManager: sentryContextManager }
            : {}),
        }
      : undefined,
  );

  initialized = true;
  console.info(
    `[otel-bootstrap] NodeTracerProvider registered (service=${serviceName}${sentryEnabled ? ", sentry=on" : ""})`,
  );
}
