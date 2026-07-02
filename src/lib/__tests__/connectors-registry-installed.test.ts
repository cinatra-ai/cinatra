// The /connectors index must render ONLY cards whose connector extension is
// actually installed/bundled in the running image (cinatra#607). The catalog
// lists every first-party connector cinatra knows about, but a connector absent
// from the running image is OMITTED from the generated manifest — so manifest
// membership is the authoritative installed/bundled predicate. This test locks
// `isConnectorInstalled` against a partial manifest (one catalog connector
// present, another absent) so a not-bundled connector is filtered out instead
// of dead-ending at the "requires a rebuild" setup state.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mark ONE real catalog connector (openai) as present in the manifest and leave
// another real catalog connector (apollo) ABSENT — i.e. not bundled in this
// image. `isConnectorInstalled` is membership in this manifest.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {
    "@cinatra-ai/openai-connector": {
      packageName: "@cinatra-ai/openai-connector",
      uiSurface: "bundled-react",
      configSchema: null,
      requestedHostPorts: [],
      displayName: "OpenAI",
      logo: null,
      scope: "cinatra-ai",
    },
  },
}));

import {
  isConnectorInstalled,
  listConnectorRegistryEntries,
} from "@/lib/connectors-registry.server";

describe("isConnectorInstalled gates the /connectors set to bundled connectors", () => {
  it("is true for a connector present in the running image's manifest", () => {
    expect(isConnectorInstalled("@cinatra-ai/openai-connector")).toBe(true);
  });

  it("is false for a catalog connector absent from the manifest (not bundled)", () => {
    expect(isConnectorInstalled("@cinatra-ai/apollo-connector")).toBe(false);
  });

  it("is false for a package the catalog/manifest does not cover at all", () => {
    expect(isConnectorInstalled("@cinatra-ai/not-a-real-connector")).toBe(false);
  });

  it("is false for an inherited prototype key (own-key membership only)", () => {
    // A bare `in` check would report "constructor"/"toString" as installed; the
    // predicate must use own-key membership so prototype keys never leak a card.
    expect(isConnectorInstalled("constructor")).toBe(false);
    expect(isConnectorInstalled("toString")).toBe(false);
  });

  it("filtering the full registry by the predicate keeps only installed entries", () => {
    // The registry still LISTS the full catalog (that's the catalog's job); the
    // /connectors page narrows it. Applying the same predicate here reproduces
    // that narrowing: only the bundled connector survives.
    const installed = listConnectorRegistryEntries().filter((entry) =>
      isConnectorInstalled(entry.packageId),
    );
    const slugs = installed.map((e) => e.slug);
    expect(slugs).toContain("openai-connector");
    expect(slugs).not.toContain("apollo-connector");
    // Every surviving entry is, by definition, installed.
    expect(installed.every((e) => isConnectorInstalled(e.packageId))).toBe(true);
  });
});
