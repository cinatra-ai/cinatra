import "server-only";

// ---------------------------------------------------------------------------
// Host-side blog ROUTING services.
//
// Transport-registration cutover: this module no longer imports the blog facade package. The
// blog facade extension configures ITSELF at activation (its `serverEntry`
// `register(ctx)` calls its own `configureBlogSystem` + registers the generic
// default connector), resolving the two HOST-side impls this module publishes
// under the `@cinatra-ai/host:blog-routing` capability:
//
//   1. the blog-image artifact materializer,
//   2. the blog project store.
//
// This module also keeps the SDK blog-connector provider slot bound, routing a
// site connector's `registerBlogConnectorViaProvider(...)` into the generic
// capability registry (`blog-connector` capability) — the facade resolves that
// capability lazily, so the host still names no vendor scope and boot order
// never matters.
// ---------------------------------------------------------------------------

import { setBlogConnectorProvider } from "@cinatra-ai/sdk-extensions";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";
import { materializeBlogImageArtifact } from "@/lib/blog-image-materializer";
import { createBlogProjectStore } from "@/lib/blog-project-store";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";

let _registered = false;

export function registerBlogProviders(): void {
  if (_registered) return;
  _registered = true;

  registerCapabilityProvider(HOST_CONNECTOR_SERVICE_CAPABILITIES.blogRouting, {
    packageName: "@cinatra-ai/host",
    impl: {
      materializeBlogImage: materializeBlogImageArtifact,
      projectStore: createBlogProjectStore(),
    },
  });

  // SDK slot → capability registry. A connector registered through the slot is
  // keyed by its own connectorId (synthetic per-connector package key, so two
  // site connectors never replace each other) and surfaces to the facade via
  // its lazy `blog-connector` capability resolution.
  setBlogConnectorProvider({
    registerBlogConnector: (connector) =>
      registerCapabilityProvider("blog-connector", {
        packageName: `blog-connector-slot:${connector.definition.connectorId}`,
        impl: connector,
      }),
  });
}

// Auto-register on module load — boot paths import this module at startup.
registerBlogProviders();
