import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for the @cinatra-ai/blog-connector facade.
//
// Imported at boot to:
//   1. Configure the blog-connector facade with host-side routing.
//   2. Register the generic `defaultBlogConnector`.
//   3. Bind the SDK blog-connector provider slot to the facade's registration
//      sink, so any BUNDLED site connector self-registers (via its own
//      serverEntry) WITHOUT the host naming a vendor scope. The provider replays
//      any connector that activated before this binder ran (boot-order
//      independence), so the static-bundle loader and this binder may run in any
//      order.
//
// After this module loads, `buildBlogDraftPayloadThroughSystem(input)` from
// any caller routes via the registered connector.
//
// Routing chain (matches `email-connector:resolveConnectorId` shape):
//   1. explicit `connectorId` if caller passed one
//   2. `instanceBlogConnectorId` (from `WordPressInstanceSettings.blogConnectorId`)
//   3. generic `"default"` connector
// ---------------------------------------------------------------------------

import {
  configureBlogSystem,
  defaultBlogConnector,
  registerBlogConnector,
  blogConnectorRegistry,
  type BlogConnector,
} from "@cinatra-ai/blog-connector";
import { setBlogConnectorProvider } from "@cinatra-ai/sdk-extensions";
import { materializeBlogImageArtifact } from "@/lib/blog-image-materializer";
import { createBlogProjectStore } from "@/lib/blog-project-store";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability registered under "blog-connector" carries an
// `impl: unknown`. Validate the BlogConnector shape before the facade trusts it,
// so a mis-registered provider can never reach a draft-build call.
function isBlogConnector(impl: unknown): impl is BlogConnector {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as {
    definition?: { connectorId?: unknown; name?: unknown; slug?: unknown };
    buildDraftPayload?: unknown;
  };
  return (
    typeof candidate.definition?.connectorId === "string" &&
    typeof candidate.definition?.name === "string" &&
    typeof candidate.definition?.slug === "string" &&
    typeof candidate.buildDraftPayload === "function"
  );
}

async function resolveConnectorId(opts: {
  explicitConnectorId?: string;
  instanceBlogConnectorId?: string;
}): Promise<string> {
  if (opts.explicitConnectorId) {
    return opts.explicitConnectorId;
  }
  if (opts.instanceBlogConnectorId) {
    return opts.instanceBlogConnectorId;
  }
  // Fallback — the always-present generic connector.
  if (!blogConnectorRegistry.get("default")) {
    throw new Error(
      "@cinatra-ai/blog-connector: `default` connector is not registered. " +
        "Add a `registerBlogConnector(defaultBlogConnector)` call in src/lib/register-blog-providers.ts.",
    );
  }
  return "default";
}

let _registered = false;

export function registerBlogProviders(): void {
  if (_registered) return;
  _registered = true;

  configureBlogSystem({
    resolveConnectorId,
    materializeBlogImage: materializeBlogImageArtifact,
    projectStore: createBlogProjectStore(),
    // Lazily surface connectors that self-registered via the capability registry
    // (`ctx.capabilities.registerProvider("blog-connector", …)` in a bundled/
    // hot-installed vendor connector's serverEntry). Pulled on every facade read,
    // so a teardown (invalidateProvidersForPackage) is reflected immediately and
    // the host names no vendor scope. The structural guard rejects malformed impls.
    resolveConnectorProviders: () =>
      resolveCapabilityProviders("blog-connector")
        .map((p) => p.impl)
        .filter(isBlogConnector),
  });

  registerBlogConnector(defaultBlogConnector);

  // Bind the SDK blog-connector provider slot to the facade's registration sink.
  // A bundled site connector's serverEntry calls `registerBlogConnectorViaProvider`
  // (importing ONLY the SDK), which routes here — so the host registers EVERY
  // bundled site connector generically, naming no vendor scope. The provider has
  // already replayed any connector that activated before this binder ran.
  setBlogConnectorProvider({
    registerBlogConnector: (connector) =>
      registerBlogConnector(connector as Parameters<typeof registerBlogConnector>[0]),
  });
}

// Auto-register on module load — boot paths import this module at startup.
registerBlogProviders();
