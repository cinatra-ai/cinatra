# @cinatra-ai/errors

Sentry integration helpers for the Cinatra Next.js app. Wraps `@sentry/nextjs` with
shared runtime config, PII scrubbing, and server-side capture helpers behind two
entry points: a runtime-safe main (browser/edge/node) and a `server-only` subpath.

## Public API

### `@cinatra-ai/errors` (runtime-safe)

- `shouldInitSentry()` — true when a DSN is configured
- `buildSentryClientOptions({ runtime })` — init options per runtime
- `beforeSendFilter(event)` — scrub PII from events before send
- `beforeBreadcrumbFilter(breadcrumb)` — scrub PII from breadcrumbs
- `SentryClientRuntime` — `"node" | "edge" | "browser"` runtime tag
- `SentryClientOptions` — Sentry init options shape

### `@cinatra-ai/errors/server` (server-only)

Re-exports the runtime-safe surface above, plus:

- `getSentry()` — lazily load the Sentry namespace, or `null` when disabled
- `getSentrySync()` — already-loaded namespace, or `null`
- `captureBackgroundJobError(err, meta)` — capture a job failure with tags
- `captureClientError(err, meta?)` — capture an error with an optional component tag
- `withSentryServerAction(fn, opts?)` — wrap a server action to capture and rethrow

## Usage

```ts
// sentry.client.config.ts
import { shouldInitSentry, buildSentryClientOptions } from "@cinatra-ai/errors";
import * as Sentry from "@sentry/nextjs";

if (shouldInitSentry()) {
  Sentry.init(buildSentryClientOptions({ runtime: "browser" }));
}
```

```ts
// server context only
import { captureBackgroundJobError } from "@cinatra-ai/errors/server";

await captureBackgroundJobError(err, { jobName, jobId, queueName });
```

## Docs

See https://docs.cinatra.ai
