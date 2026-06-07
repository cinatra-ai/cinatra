// Host-side parity test between the CLI-safe catalog descriptors and the
// server-only loader map at src/lib/connector-setup-pages.ts. If a new
// descriptor lands without a loader entry (or vice versa), this test fires
// fast at typecheck/test time instead of waiting for a runtime 404.

import { describe, expect, it } from "vitest";
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  assertSetupPagesParityWithCatalog,
  hasConnectorSetupPage,
  listConnectorSetupPageSlugs,
} from "@/lib/connector-setup-pages";
import { slugRequiresSetupPageLoader } from "@/lib/connectors-registry.server";

describe("connector setup-page loader map parity", () => {
  it("assertSetupPagesParityWithCatalog() does not throw (schema-config exempt)", () => {
    // The parity check is schema-config-aware: a connector whose static manifest
    // declares `uiSurface: "schema-config"` ships NO React page and is exempt.
    expect(() =>
      assertSetupPagesParityWithCatalog(slugRequiresSetupPageLoader),
    ).not.toThrow();
  });

  it("every catalog descriptor that needs a React page has a loader entry", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      if (!slugRequiresSetupPageLoader(d.slug)) continue; // schema-config: no loader
      expect(hasConnectorSetupPage(d.slug), `loader for ${d.slug}`).toBe(true);
    }
  });

  it("the loader map has no entries that are not in the catalog", () => {
    const catalogSlugs = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.slug));
    for (const loaderSlug of listConnectorSetupPageSlugs()) {
      expect(catalogSlugs.has(loaderSlug), `orphan loader ${loaderSlug}`).toBe(
        true,
      );
    }
  });
});
