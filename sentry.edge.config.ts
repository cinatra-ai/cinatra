// Sentry edge-runtime initialization.
// Runs in the Edge runtime only. OTel/Node integrations are not available.
import * as Sentry from "@sentry/nextjs";

import {
  buildSentryClientOptions,
  shouldInitSentry,
} from "@cinatra-ai/errors";

if (shouldInitSentry()) {
  Sentry.init(buildSentryClientOptions({ runtime: "edge" }));
}
