// A `schema-config` connector (model B) ships NO React setup page — the host
// renders it from `cinatra.configSchema`. This test locks that such a connector
// is LISTABLE / REGISTERABLE through the server registry WITHOUT a setup-page
// loader entry, while bundled-react connectors still resolve their loader.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mark ONE real catalog connector (tailscale) as schema-config in the static
// manifest, and keep another (github) as bundled-react. The registry reads
// `uiSurface` from this manifest to decide whether a loader is required.
// github (not openai/gemini) is the bundled-react fixture: the LLM cluster
// (openai 0.1.6; anthropic/gemini/apollo 0.1.4; apify 0.1.4) converted to
// schema-config, so the real generated setup-pages map no longer carries their
// loaders — the parity assertion below reads that real map, so the
// bundled-react fixture must be a connector that genuinely still ships a React
// setup page.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {
    "@cinatra-ai/tailscale-connector": {
      packageName: "@cinatra-ai/tailscale-connector",
      uiSurface: "schema-config",
      configSchema: {
        fields: [{ kind: "secret", key: "apiKey", label: "API key" }],
      },
      requestedHostPorts: ["ui", "secrets"],
    },
    "@cinatra-ai/github-connector": {
      packageName: "@cinatra-ai/github-connector",
      uiSurface: "bundled-react",
      configSchema: null,
      requestedHostPorts: [],
    },
    // The real catalog's schema-config conversions (openai 0.1.6; anthropic,
    // gemini, apollo 0.1.4; apify 0.1.4): mirror them here so the parity
    // assertion (which iterates the REAL catalog + REAL generated map) sees
    // them exempt from needing a loader, matching the regenerated setup-pages
    // map that no longer carries their loaders.
    ...Object.fromEntries(
      [
        "@cinatra-ai/openai-connector",
        "@cinatra-ai/anthropic-connector",
        "@cinatra-ai/gemini-connector",
        "@cinatra-ai/apollo-connector",
        "@cinatra-ai/apify-connector",
      ].map((packageName) => [
        packageName,
        {
          packageName,
          uiSurface: "schema-config",
          configSchema: {
            fields: [{ kind: "secret", key: "apiKey", label: "API key" }],
          },
          requestedHostPorts: ["ui", "secrets"],
        },
      ]),
    ),
  },
}));

import {
  connectorRequiresSetupPageLoader,
  slugRequiresSetupPageLoader,
  getConnectorRegistryEntryBySlug,
  getConnectorRegistryEntryByPackageId,
  listConnectorRegistryEntries,
} from "@/lib/connectors-registry.server";
import { assertSetupPagesParityWithCatalog } from "@/lib/connector-setup-pages";

describe("schema-config connectors are listable without a setup-page loader", () => {
  it("a schema-config descriptor reports it needs no React loader", () => {
    expect(connectorRequiresSetupPageLoader("@cinatra-ai/tailscale-connector")).toBe(false);
    expect(slugRequiresSetupPageLoader("tailscale-connector")).toBe(false);
  });

  it("a bundled-react descriptor still reports it needs a React loader", () => {
    expect(connectorRequiresSetupPageLoader("@cinatra-ai/github-connector")).toBe(true);
    expect(slugRequiresSetupPageLoader("github-connector")).toBe(true);
  });

  it("a connector the static manifest does not cover defaults to needing a loader", () => {
    expect(connectorRequiresSetupPageLoader("@cinatra-ai/unmapped-connector")).toBe(true);
  });

  it("registers a schema-config connector with loadSetupPage === null (no throw)", () => {
    const bySlug = getConnectorRegistryEntryBySlug("tailscale-connector");
    expect(bySlug).toBeDefined();
    expect(bySlug?.loadSetupPage).toBeNull();

    const byPackageId = getConnectorRegistryEntryByPackageId("@cinatra-ai/tailscale-connector");
    expect(byPackageId).toBeDefined();
    expect(byPackageId?.loadSetupPage).toBeNull();
  });

  it("still resolves a real loader for a bundled-react connector", () => {
    const entry = getConnectorRegistryEntryBySlug("github-connector");
    expect(entry).toBeDefined();
    expect(typeof entry?.loadSetupPage).toBe("function");
  });

  it("lists the full catalog without throwing on the schema-config connector", () => {
    const entries = listConnectorRegistryEntries();
    const tailscale = entries.find((e) => e.slug === "tailscale-connector");
    expect(tailscale, "tailscale is listed").toBeDefined();
    expect(tailscale?.loadSetupPage).toBeNull();
    // The loaderless schema-config connector does not break listing the rest.
    expect(entries.length).toBeGreaterThan(1);
  });

  it("setup-page parity is satisfied when the schema-config connector is exempt", () => {
    // With tailscale marked schema-config, removing its loader entry would still
    // pass parity because the predicate exempts it.
    expect(() =>
      assertSetupPagesParityWithCatalog(slugRequiresSetupPageLoader),
    ).not.toThrow();
  });
});
