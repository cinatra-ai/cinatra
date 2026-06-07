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

// Importing the binder auto-runs registerBlogProviders(), which wires the REAL
// capability resolver into the blog facade via configureBlogSystem. This test
// exercises the actual bridge: capability registry → facade visibility →
// teardown → structural guard.
import "@/lib/register-blog-providers";
import { listInstalledBlogConnectors } from "@cinatra-ai/blog-connector";
import {
  registerCapabilityProvider,
  invalidateProvidersForPackage,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";

function fakeBlogConnector(id: string) {
  return {
    definition: { connectorId: id, name: id, slug: id, description: "", settingsHref: "", supportsElementor: false },
    buildDraftPayload: async () => ({
      createPayload: { title: "", excerpt: "", status: "draft", content: "" },
    }),
  };
}

describe("register-blog-providers — capability → blog facade bridge", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
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
});
