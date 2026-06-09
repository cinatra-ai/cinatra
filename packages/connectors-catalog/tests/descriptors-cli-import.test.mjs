// Plain-Node smoke test — exercises the import path that
// `packages/cli/src/agents-install.mjs` will use. Runs under vitest but
// MUST NOT transitively pull anything that requires bundler/Next.js
// resolution. If this test starts failing because some dependency leaked in,
// the catalog has been broken by the change you just made.

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_DESCRIPTORS,
  getConnectorDescriptorByPackageId,
  getConnectorDescriptorBySlug,
  listConnectorDescriptors,
} from "../src/descriptors.mjs";
import {
  PRIMITIVE_TO_CONNECTOR_OVERRIDES,
  lookupPrimitiveOverride,
} from "../src/overrides.mjs";

// Connectors that legitimately expose NO outbound MCP primitives, so their
// mcpPrimitivePrefixes array is intentionally empty: the inbound MCP-client
// registry (it registers external clients, it does not call out) and the
// embeddable assistant chat-widget connectors (no server-side primitives).
const MCP_LESS_CONNECTOR_SLUGS = new Set([
  "mcp-client-connector",
  "wordpress-assistant-connector",
  "drupal-assistant-connector",
]);

describe("connector descriptors (CLI-safe surface)", () => {
  it("ships the canonical 19-entry catalog", () => {
    expect(CONNECTOR_DESCRIPTORS).toHaveLength(19);
  });

  it("every descriptor has the required fields with non-empty values", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      expect(d.packageId, `packageId for ${d.slug}`).toMatch(/^@cinatra-ai\//);
      expect(d.slug, `slug for ${d.packageId}`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(d.displayName.length).toBeGreaterThan(0);
      expect(["admin", "workspace"]).toContain(d.defaultVisibility);
      if (!MCP_LESS_CONNECTOR_SLUGS.has(d.slug)) {
        // Every MCP-bearing connector must ship at least one prefix; an empty
        // array here for a non-exempt slug is a real catalog regression.
        expect(
          d.mcpPrimitivePrefixes.length,
          `mcpPrimitivePrefixes for ${d.slug}`,
        ).toBeGreaterThan(0);
      }
      for (const prefix of d.mcpPrimitivePrefixes) {
        expect(prefix, `prefix for ${d.slug}`).toMatch(/_$/);
      }
      expect(d.setupSubroute).toBe("setup");
    }
  });

  it("packageId is unique across the catalog", () => {
    const ids = CONNECTOR_DESCRIPTORS.map((d) => d.packageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("slug is unique across the catalog", () => {
    const slugs = CONNECTOR_DESCRIPTORS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("visibility split matches the dev-fixture expectation (12 admin / 7 workspace)", () => {
    const admin = CONNECTOR_DESCRIPTORS.filter((d) => d.defaultVisibility === "admin");
    const workspace = CONNECTOR_DESCRIPTORS.filter((d) => d.defaultVisibility === "workspace");
    expect(admin).toHaveLength(12);
    expect(workspace).toHaveLength(7);
    // Sanity: the split must account for every descriptor (no third tier).
    expect(admin.length + workspace.length).toBe(CONNECTOR_DESCRIPTORS.length);
  });

  it("listConnectorDescriptors returns a defensive copy", () => {
    const a = listConnectorDescriptors();
    a[0].displayName = "MUTATED";
    a[0].mcpPrimitivePrefixes.push("hacked_");
    const b = listConnectorDescriptors();
    expect(b[0].displayName).not.toBe("MUTATED");
    expect(b[0].mcpPrimitivePrefixes).not.toContain("hacked_");
  });

  it("lookups by packageId and slug round-trip", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      expect(getConnectorDescriptorByPackageId(d.packageId)).toEqual(d);
      expect(getConnectorDescriptorBySlug(d.slug)).toEqual(d);
    }
    expect(getConnectorDescriptorByPackageId("@cinatra-ai/missing")).toBeUndefined();
    expect(getConnectorDescriptorBySlug("missing")).toBeUndefined();
  });
});

describe("primitive overrides (CLI-safe surface)", () => {
  it("has the required email_send → gmail-connector entry", () => {
    expect(PRIMITIVE_TO_CONNECTOR_OVERRIDES.email_send).toBe(
      "@cinatra-ai/gmail-connector",
    );
  });

  it("every override target resolves to a known descriptor", () => {
    const ids = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.packageId));
    for (const [primitive, packageId] of Object.entries(
      PRIMITIVE_TO_CONNECTOR_OVERRIDES,
    )) {
      expect(ids.has(packageId), `${primitive} → ${packageId}`).toBe(true);
    }
  });

  it("lookupPrimitiveOverride returns the target or undefined", () => {
    expect(lookupPrimitiveOverride("email_send")).toBe(
      "@cinatra-ai/gmail-connector",
    );
    expect(lookupPrimitiveOverride("nonexistent_primitive")).toBeUndefined();
  });
});
