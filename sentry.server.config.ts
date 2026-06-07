// Sentry server-side initialization.
// Runs in the Node.js runtime only. Initialized once per process from
// src/instrumentation.node.ts BEFORE the OTel NodeTracerProvider is created,
// so that Sentry's OpenTelemetry pieces can be attached to Cinatra's existing
// provider in src/lib/otel-bootstrap.ts.
//
// Key contract: `skipOpenTelemetrySetup: true` — Cinatra owns the OTel
// provider; Sentry contributes SpanProcessor/Sampler/Propagator/context to it.
import * as Sentry from "@sentry/nextjs";

import {
  buildSentryClientOptions,
  shouldInitSentry,
} from "@cinatra-ai/errors";

if (shouldInitSentry()) {
  Sentry.init(buildSentryClientOptions({ runtime: "node" }));
}
