import "server-only";

// Host-side resolution of the `blog-system` capability (the lazy/guarded
// host-access cutover): the blog-connector registers its facade entry points
// (draft-payload build, image materialization, the legacy WP content-converter
// lookup) as a capability provider from `register(ctx)`; the host's blog
// surfaces (src/lib/blog/*) resolve them HERE at call time — never by
// value-importing the package.
//
// Degraded mode: provider absent (connector not installed/active) →
// `resolveBlogSystem()` returns null; callers degrade per feature
// (draft build / image materialization throw a descriptive error surfaced by
// their existing failure paths; the WP content-convert primitive falls back
// to its passthrough result).

import type { BlogSystemProvider } from "@cinatra-ai/sdk-extensions";
import { BLOG_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract.
function isBlogSystemProvider(impl: unknown): impl is BlogSystemProvider {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as {
    buildDraftPayload?: unknown;
    materializeBlogImage?: unknown;
    getWordPressContentConverter?: unknown;
  };
  return (
    typeof candidate.buildDraftPayload === "function" &&
    typeof candidate.materializeBlogImage === "function" &&
    typeof candidate.getWordPressContentConverter === "function"
  );
}

/** The live blog-system facade, or null when the blog-connector is absent. */
export function resolveBlogSystem(): BlogSystemProvider | null {
  const match = resolveCapabilityProviders(BLOG_SYSTEM_CAPABILITY).find((p) =>
    isBlogSystemProvider(p.impl),
  );
  return (match?.impl as BlogSystemProvider | undefined) ?? null;
}

/** Fail-loud resolution for features that cannot proceed without the facade. */
export function requireBlogSystem(): BlogSystemProvider {
  const provider = resolveBlogSystem();
  if (!provider) {
    throw new Error(
      "Blog system unavailable — the blog connector extension is not installed/active. " +
        "Install/activate it to build blog drafts or materialize blog images.",
    );
  }
  return provider;
}
