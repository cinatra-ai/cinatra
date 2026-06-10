import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Heavy host deps the binder pulls in at module load — stubbed so the boot-time
// auto-run (registerBlogProviders()) completes in a unit context.
vi.mock("@/lib/blog-image-materializer", () => ({
  materializeBlogImageArtifact: async () => ({}),
}));
vi.mock("@/lib/blog-project-store", () => ({
  createBlogProjectStore: () => ({}),
}));

// Transport-registration cutover: the capability → facade bridge is realized by the blog facade's OWN
// serverEntry activation (`register(ctx)` → configureBlogSystem with the lazy
// ctx.capabilities resolver), not by a host import of the facade package. This
// test exercises the REAL bridge end-to-end: host blog-routing service →
// extension register(ctx) → capability registry → facade visibility →
// teardown → structural guard.
import "@/lib/register-blog-providers";
import { listInstalledBlogConnectors } from "@cinatra-ai/blog-connector";
import { register as registerBlogExtension } from "@cinatra-ai/blog-connector/register";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
  invalidateProvidersForPackage,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

function fakeBlogConnector(id: string) {
  return {
    definition: { connectorId: id, name: id, slug: id, description: "", settingsHref: "", supportsElementor: false },
    buildDraftPayload: async () => ({
      createPayload: { title: "", excerpt: "", status: "draft", content: "" },
    }),
  };
}

// Minimal activation ctx: a capabilities port over the REAL host registry plus
// an inert mcp sink for the tool registration the blog serverEntry performs.
function fakeActivationCtx(): ExtensionHostContext {
  return {
    capabilities: {
      registerProvider: (capability: string, provider: { packageName: string; impl: unknown }) =>
        registerCapabilityProvider(capability, provider),
      resolveProviders: (capability: string) => resolveCapabilityProviders(capability),
    },
    mcp: { registerTool: () => {} },
  } as unknown as ExtensionHostContext;
}

function activateBlogFacade() {
  // The host boot import published blog-routing once, but each test resets the
  // registry — re-publish the narrow routing service the facade requires.
  registerCapabilityProvider("@cinatra-ai/host:blog-routing", {
    packageName: "@cinatra-ai/host",
    impl: { materializeBlogImage: async () => ({}), projectStore: {} },
  });
  registerBlogExtension(fakeActivationCtx());
}

describe("blog facade serverEntry — capability → blog facade bridge", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    activateBlogFacade();
  });

  it("a connector self-registered under the 'blog-connector' capability becomes visible via the facade", () => {
    registerCapabilityProvider("blog-connector", {
      packageName: "@v/x-connector",
      impl: fakeBlogConnector("x"),
    });
    expect(listInstalledBlogConnectors().map((c) => c.definition.connectorId)).toContain("x");
  });

  it("teardown (invalidateProvidersForPackage) removes it from the facade immediately", () => {
    registerCapabilityProvider("blog-connector", {
      packageName: "@v/x-connector",
      impl: fakeBlogConnector("x"),
    });
    invalidateProvidersForPackage("@v/x-connector");
    expect(listInstalledBlogConnectors().map((c) => c.definition.connectorId)).not.toContain("x");
  });

  it("a malformed impl registered under 'blog-connector' is filtered out by the structural guard (list unchanged)", () => {
    const before = listInstalledBlogConnectors()
      .map((c) => c.definition.connectorId)
      .sort();
    registerCapabilityProvider("blog-connector", {
      packageName: "@v/bad-connector",
      impl: { not: "a blog connector" },
    });
    const after = listInstalledBlogConnectors()
      .map((c) => c.definition.connectorId)
      .sort();
    expect(after).toEqual(before);
  });

  it("the facade registers the generic `default` connector at activation", () => {
    expect(listInstalledBlogConnectors().map((c) => c.definition.connectorId)).toContain("default");
  });

  it("activation fails loud when the host blog-routing service is absent", () => {
    __resetCapabilityRegistry();
    expect(() => registerBlogExtension(fakeActivationCtx())).toThrow(/blog-routing/);
  });
});
