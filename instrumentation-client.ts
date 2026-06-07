// Next.js client-side instrumentation entry point.
// Re-exports sentry.client.config side-effects so Sentry initializes
// before the first navigation.
import "./sentry.client.config";
