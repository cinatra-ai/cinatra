import "server-only";

// Host-side resolution of the `social-media-system` capability (the
// lazy/guarded host-access cutover): the social-media-connector registers its
// provider-neutral publish facade as a capability provider from
// `register(ctx)`; the host's blog LinkedIn publish step resolves it HERE at
// call time — never by value-importing the package.
//
// Degraded mode: provider absent → null; the publish step fails with a
// descriptive error through its existing per-step failure path.

import type { SocialMediaSystemProvider } from "@cinatra-ai/sdk-extensions";
import { SOCIAL_MEDIA_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract.
function isSocialMediaSystemProvider(impl: unknown): impl is SocialMediaSystemProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { publishPost?: unknown }).publishPost === "function";
}

/** The live social-media publish facade, or null when the connector is absent. */
export function resolveSocialMediaSystem(): SocialMediaSystemProvider | null {
  const match = resolveCapabilityProviders(SOCIAL_MEDIA_SYSTEM_CAPABILITY).find((p) =>
    isSocialMediaSystemProvider(p.impl),
  );
  return (match?.impl as SocialMediaSystemProvider | undefined) ?? null;
}

/** Fail-loud resolution for features that cannot proceed without the facade. */
export function requireSocialMediaSystem(): SocialMediaSystemProvider {
  const provider = resolveSocialMediaSystem();
  if (!provider) {
    throw new Error(
      "Social-media system unavailable — the social-media connector extension is not " +
        "installed/active. Install/activate it to publish posts.",
    );
  }
  return provider;
}
