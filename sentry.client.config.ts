// Sentry browser initialization.
// Loaded by instrumentation-client.ts at the start of every page navigation.
//
// Browser-side DSN comes from NEXT_PUBLIC_SENTRY_DSN (Next.js only inlines
// envs prefixed with NEXT_PUBLIC_ into the client bundle). For convenience,
// the helper also falls back to SENTRY_DSN when both are set at build time.
import * as Sentry from "@sentry/nextjs";

import {
  buildSentryClientOptions,
  shouldInitSentry,
} from "@cinatra-ai/errors";

if (shouldInitSentry()) {
  Sentry.init(buildSentryClientOptions({ runtime: "browser" }));
}
