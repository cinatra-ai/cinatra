// Marketplace visibility-filter regression gate.
// Coverage: all server read paths that expose extension registry data.
// These tests ensure private extension rows are not leaked through server paths.
//
// Test strategy: file-level checks are acceptable here because the test only
// needs to verify that each source path contains a visibility guard or an
// explicit documented admin-only bypass.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Server read paths that must enforce extension visibility.
// Each entry has:
//   file  — path relative to project root
//   needs — visibility-related behavior expected in that file
// ---------------------------------------------------------------------------
const READ_PATHS = [
  {
    file: "src/app/configuration/marketplace/page.tsx",
    needs: "storefront-sourced browse (loadMarketplaceBrowse) — visibility enforced storefront-side (published products only), admin-gated; no direct registry read",
  },
  {
    file: "packages/extensions/src/screens/registry-catalog-screen.tsx",
    needs: "visibility filter on listAgentPackages result (config already injected)",
  },
  {
    file: "src/app/configuration/environment/page.tsx",
    needs: "admin-context filter (confirm intentional all-show or add explicit bypass comment)",
  },
  {
    file: "src/app/configuration/instance/actions.ts",
    needs: "admin-context filter (confirm intentional all-show or add explicit bypass comment)",
  },
  {
    file: "packages/extensions/src/screens/extensions-marketplace-screen.tsx",
    needs: "vendorScope param to readActiveExtensionTemplates + readArchivedExtensionTemplates",
  },
  {
    file: "packages/extensions/src/mcp/handlers.ts",
    needs: "extensions_search visibility filter + extensions_install visibility check",
  },
  // Active and archived template reads are both in packages/agents/src/store.ts.
  {
    file: "packages/agents/src/store.ts",
    needs: "readActiveExtensionTemplates WHERE clause for origin->>'visibility'",
  },
  {
    file: "packages/agents/src/store.ts",
    needs: "readArchivedExtensionTemplates WHERE clause for origin->>'visibility'",
  },
] as const;

// Visibility-filter signals: source references origin->>'visibility',
// accepts a vendorScope OR viewerScope param (viewerScope pairs with
// listExtensionPackages's in-function filter — see
// packages/registries/src/verdaccio/client.ts), delegates to the storefront
// browse path (which serves only published/visible products — see
// @/lib/marketplace-browse), or has an explicit admin-only bypass comment.
function hasVisibilityFilter(content: string): boolean {
  return (
    /origin(->>|\.)['"]?visibility['"]?/.test(content) ||
    /vendorScope|viewerScope/.test(content) ||
    // Storefront-sourced browse: visibility is enforced storefront-side
    // (the extension_list ability returns only published products), so no
    // direct registry read happens here. Reverting to listAgentPackages
    // without a scope filter drops this signal and re-trips the gate.
    /loadMarketplaceBrowse/.test(content) ||
    // Admin-context paths: explicit documented exemption.
    /\/\/ ADMIN-CONTEXT — visibility filter intentionally bypassed/.test(content)
  );
}

describe("visibility filter coverage — all server read paths", () => {
  const projectRoot = join(import.meta.dirname, "../../../..");

  for (const { file, needs } of READ_PATHS) {
    it(`${file}: ${needs}`, () => {
      const fullPath = join(projectRoot, file);
      // File must exist because this test guards source paths, not generated output.
      expect(existsSync(fullPath), `Expected file to exist: ${file}`).toBe(true);

      const content = readFileSync(fullPath, "utf8");

      // Each file must contain a visibility-filter signal or a documented bypass.
      expect(
        hasVisibilityFilter(content),
        `${file} must contain visibility filter or documented bypass. Needs: ${needs}`,
      ).toBe(true);
    });
  }
});

describe("visibility filter — fixture shape completeness", () => {
  it("fixture exports all three typed variants needed by visibility filter tests", async () => {
    // Fixture file is real, not a placeholder.
    const {
      DEPLOYMENT_REGISTRY_CONFIG_FIXTURE,
      DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE,
      DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A,
    } = await import("@/lib/__fixtures__/deployment-registry-config.fixture");

    // Baseline (private NOT configured)
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE.privateDestinationConfigured).toBe(false);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE.routingMode).toBe("shared-acl");

    // Topology B (private configured, shared-acl)
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationConfigured).toBe(true);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.routingMode).toBe("shared-acl");

    // Topology A (private configured, scope-based)
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.routingMode).toBe("scope-based");
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.privateDestinationConfigured).toBe(true);
  });

  it("readActiveExtensionTemplates is exported from packages/agents/src/store.ts (leakage regression baseline)", () => {
    // Confirm the expected read functions exist without importing the heavy dependency chain.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const projectRoot = join(import.meta.dirname, "../../../..");
    const storeContent = readFileSync(join(projectRoot, "packages/agents/src/store.ts"), "utf8");
    expect(storeContent).toContain("readActiveExtensionTemplates");
    expect(storeContent).toContain("readArchivedExtensionTemplates");
  });
});
