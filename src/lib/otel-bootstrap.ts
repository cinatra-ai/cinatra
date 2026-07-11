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
  // SDK 2.x: the `Resource` class export is gone — resources are built with
  // resourceFromAttributes(). And unlike 1.x, the 2.x provider uses the
  // supplied resource AS-IS (no implicit default-resource merge), so the SDK
  // default resource (telemetry.sdk.* attributes) is merged explicitly to
  // preserve the 1.x behavior.
  const { defaultResource, resourceFromAttributes } = await import(
    "@opentelemetry/resources"
  );
  const { ATTR_SERVICE_NAME } = await import(
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

  // SDK 2.x: provider.addSpanProcessor() was removed — span processors are
  // supplied via the constructor's `spanProcessors` array.
  const spanProcessors: import("@opentelemetry/sdk-trace-base").SpanProcessor[] =
    [new BatchSpanProcessor(new PostgresSpanExporter())];
  if (sentryProcessor) {
    spanProcessors.push(sentryProcessor);
  }

  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    ),
    spanProcessors,
    ...(sentrySampler ? { sampler: sentrySampler } : {}),
  });

  // Propagator: Sentry's when available (production always runs with Sentry;
  // its propagator carries tracecontext). Without Sentry the property is
  // OMITTED so the 2.x register() installs its default composite propagator
  // (W3C tracecontext + baggage) — restoring the default W3C tracecontext
  // propagator that the 1.x bootstrap had to suppress. History: on the 1.x
  // SDK this call passed an explicit `propagator: null` to keep the then-
  // vulnerable W3CBaggagePropagator parse path (GHSA-8988-4f7v-96qf,
  // unbounded allocation, patched >=2.8.0) off the wire; the 2.x SDK ships
  // the patched parser, so the code-enforced suppression is retired exactly
  // as that hardening note planned ("restore tracecontext via the SDK-2.x
  // lift"). cinatra itself still does no cross-service propagation in app
  // code (no propagation.extract/inject).
  provider.register({
    ...(sentryPropagator ? { propagator: sentryPropagator } : {}),
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
