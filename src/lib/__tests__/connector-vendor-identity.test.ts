// #12 connector vendor-identity end-state (eng#159 / owner ruling eng#183 dec. 2):
// a connector declares its OWN vendor identity in its manifest (`cinatra.vendor`).
// This test locks that the host connectors-registry — the trust boundary that
// ACCEPTS the manifest-declared identity — reads that declared vendor through and
// BRANDS the key as a `ConnectorVendorKey` (read-compat: a plain string at
// runtime). The SDK owns NO vendor roster (open marketplace); a NOVEL vendor key
// is accepted exactly like a first-party one, and a connector that declares no
// vendor resolves to null. Authoritative shape/ownership/uniqueness/provider-
// mapping verification is the marketplace publish gate's job (separate repo).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Two real catalog connectors carry a self-declared `vendor` in the static
// manifest — one first-party (openai) and one with a NOVEL vendor key
// (tailscale → "acme-novel") to prove the host accepts an arbitrary key with no
// SDK roster. A third (the github/google one) declares NO vendor → null.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {
    "@cinatra-ai/openai-connector": {
      packageName: "@cinatra-ai/openai-connector",
      scope: "cinatra-ai",
      vendor: { key: "openai", name: "OpenAI" },
    },
    "@cinatra-ai/tailscale-connector": {
      packageName: "@cinatra-ai/tailscale-connector",
      scope: "cinatra-ai",
      vendor: { key: "acme-novel", name: "Acme Novel Vendor" },
    },
    "@cinatra-ai/google-oauth-connector": {
      packageName: "@cinatra-ai/google-oauth-connector",
      scope: "cinatra-ai",
      // no `vendor` declared → connectorVendorIdentity returns null
    },
  },
}));

import { connectorVendorIdentity } from "@/lib/connectors-registry.server";

describe("connectorVendorIdentity — host accepts the connector's manifest-declared vendor key", () => {
  it("reads a first-party connector's self-declared vendor identity from its manifest", () => {
    const identity = connectorVendorIdentity("@cinatra-ai/openai-connector");
    expect(identity).not.toBeNull();
    expect(identity?.key).toBe("openai");
    expect(identity?.name).toBe("OpenAI");
  });

  it("accepts a NOVEL vendor key with no SDK roster (open marketplace)", () => {
    const identity = connectorVendorIdentity("@cinatra-ai/tailscale-connector");
    expect(identity).not.toBeNull();
    // A key no first-party connector shipped is accepted verbatim — the SDK
    // enumerates no authoritative vendor list; the connector owns its identity.
    expect(identity?.key).toBe("acme-novel");
    expect(identity?.name).toBe("Acme Novel Vendor");
  });

  it("the branded key is read-compat — a plain string at runtime (=== round-trip)", () => {
    const identity = connectorVendorIdentity("@cinatra-ai/openai-connector");
    // The ConnectorVendorKey brand is type-only: at runtime the value is the
    // identical string, so it flows into any string slot and compares ===.
    expect(typeof identity?.key).toBe("string");
    expect(identity?.key === "openai").toBe(true);
    const asString: string = identity!.key;
    expect(asString).toBe("openai");
  });

  it("returns null for a connector that declares no vendor identity", () => {
    expect(connectorVendorIdentity("@cinatra-ai/google-oauth-connector")).toBeNull();
  });

  it("returns null for a connector the static manifest does not cover", () => {
    expect(connectorVendorIdentity("@cinatra-ai/unmapped-connector")).toBeNull();
  });
});
