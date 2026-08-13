// cinatra#1082 item 1 — the GENERATED maps stay in sync with the schema-config
// conversion (#782).
//
// A `schema-config` connector renders from its `cinatra.configSchema`; it ships
// NO React setup page, so the base-image `GENERATED_CONNECTOR_SETUP_PAGES` map
// must carry no loader for it and its manifest record must say
// `hasSetupPage: false`. That state was regenerated once and then re-verified
// BY HAND on each new `main` — this test is that verification, made permanent:
// it reads the REAL generated maps (not a mock) so any regeneration that
// reintroduces a setup page for a converted connector, or silently drops one
// back off `schema-config`, goes red here instead of at a user's render.
//
// `connector-setup-pages-parity.test.ts` covers the complementary direction
// (a React connector must HAVE a loader); this file covers the conversion
// itself. Both read the same generated artifacts.

import { describe, expect, it } from "vitest";
import { packageIdForSlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { GENERATED_CONNECTOR_SETUP_PAGES } from "@/lib/generated/connector-setup-pages";

/**
 * The five API-key LLM connectors #782 converted to schema-config (model B) and
 * #1082 carries to users. Named explicitly — a generic sweep alone would stay
 * green if one of them silently reverted to `bundled-react`.
 */
const CONVERTED_CONNECTORS = [
  "@cinatra-ai/openai-connector",
  "@cinatra-ai/anthropic-connector",
  "@cinatra-ai/gemini-connector",
  "@cinatra-ai/apify-connector",
  "@cinatra-ai/apollo-connector",
] as const;

const setupPageSlugs = new Set(Object.keys(GENERATED_CONNECTOR_SETUP_PAGES));
const setupPagePackageIds = new Set([...setupPageSlugs].map((slug) => packageIdForSlug(slug)));

describe("generated-map sync — the #782 schema-config conversions (cinatra#1082 item 1)", () => {
  it.each(CONVERTED_CONNECTORS)("%s is schema-config in the generated manifest", (packageName) => {
    const record = STATIC_EXTENSION_MANIFEST[packageName];
    expect(record, `${packageName} missing from STATIC_EXTENSION_MANIFEST`).toBeTruthy();
    expect(record.uiSurface).toBe("schema-config");
    // The surface the host renders from must actually be there — a
    // schema-config record with no schema renders the fail-closed error state.
    expect(record.configSchema, `${packageName} declares no configSchema`).toBeTruthy();
    // Its server entry is what a runtime install activates (no React page).
    expect(record.serverEntry).toBeTruthy();
  });

  it.each(CONVERTED_CONNECTORS)("%s ships NO React setup page", (packageName) => {
    expect(STATIC_EXTENSION_MANIFEST[packageName]?.hasSetupPage).toBe(false);
    expect(setupPagePackageIds.has(packageName)).toBe(false);
  });
});

describe("generated-map sync — the invariant behind the conversion", () => {
  const schemaConfigEntries = Object.values(STATIC_EXTENSION_MANIFEST).filter(
    (r) => r.uiSurface === "schema-config",
  );

  it("covers at least the five converted connectors", () => {
    expect(schemaConfigEntries.length).toBeGreaterThanOrEqual(CONVERTED_CONNECTORS.length);
  });

  it("NO schema-config connector claims a setup page, in either map", () => {
    for (const record of schemaConfigEntries) {
      expect(record.hasSetupPage, `${record.packageName}.hasSetupPage`).toBe(false);
      expect(
        setupPagePackageIds.has(record.packageName),
        `${record.packageName} has a generated setup-page loader`,
      ).toBe(false);
    }
  });

  it("every generated setup-page loader belongs to a connector that is NOT schema-config", () => {
    for (const slug of setupPageSlugs) {
      const record = STATIC_EXTENSION_MANIFEST[packageIdForSlug(slug)];
      // A loader may exist for a connector outside the static manifest closure;
      // what must never happen is a loader for a schema-config one.
      if (!record) continue;
      expect(record.uiSurface, `${slug} loader vs uiSurface`).not.toBe("schema-config");
    }
  });
});
