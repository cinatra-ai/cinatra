import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for @cinatra-ai/social-media-connector.
//
// Imported at boot to:
//   1. Configure the social-media-connector facade with host-side routing.
//   2. Register every concrete SocialMediaConnector provider (LinkedIn today;
//      future Twitter/X, Threads, Mastodon providers add their
//      registerSocialMediaConnector calls here).
//
// After this module loads, `publishSocialMediaPostThroughSystem(post)` from
// any caller (workspace package or host) routes via the registered provider.
// ---------------------------------------------------------------------------

import {
  configureSocialMediaSystem,
  registerSocialMediaConnector,
  socialMediaConnectorRegistry,
} from "@cinatra-ai/social-media-connector";
import { linkedInSocialMediaConnector } from "@cinatra-ai/linkedin-connector";

/**
 * Routing chain — explicit `connectorId` → first registered. The chain is
 * intentionally simple; full sender-identity routing (per-org default,
 * per-user override) can be added later via the same `SocialMediaSystemDeps`
 * injection point.
 */
async function resolveConnectorId(opts: {
  explicitConnectorId?: string;
  userId?: string;
  orgId?: string;
}): Promise<string> {
  if (opts.explicitConnectorId) {
    return opts.explicitConnectorId;
  }
  const first = socialMediaConnectorRegistry.listAll()[0];
  if (!first) {
    throw new Error(
      "No social-media connector is registered. Add a `registerSocialMediaConnector(...)` " +
        "call in src/lib/register-social-providers.ts.",
    );
  }
  return first.definition.connectorId;
}

let _registered = false;

export function registerSocialProviders(): void {
  if (_registered) return;
  _registered = true;

  configureSocialMediaSystem({
    resolveConnectorId,
  });

  registerSocialMediaConnector(linkedInSocialMediaConnector);

  // Future providers register here:
  // registerSocialMediaConnector(twitterSocialMediaConnector);
  // registerSocialMediaConnector(threadsSocialMediaConnector);
}

// Auto-register on module load — boot paths import this module at startup
// (via instrumentation.node.ts or worker entrypoints).
registerSocialProviders();
