// cinatra#975 Wave 2 — the widget-auth store inversion. The vendor store moved
// OUT of core into the wordpress-mcp-connector, which registers it as the
// `@cinatra-ai/host:wordpress-widget-auth` capability from its register(ctx).
// Core's connect/token + wordpress-webhook surfaces resolve it lazily and MUST
// FAIL LOUD (never silent) when the capability is unresolved — this test pins
// that degradation.
//
// engineering#534 S1 — resolution is now ASYNC and unions the build-time
// (baked) declarer arm with a runtime (marketplace-installed, admin-granted,
// trusted-signed) arm. This file exercises the BAKED arm (the real generated
// tree carries the wordpress-mcp-connector entry) plus the union edges that need
// a live baked owner: a conflicting runtime owner (fail closed) and a throwing
// runtime lookup (baked owner unaffected). The pure runtime-arm matrix lives in
// `widget-auth-provider-runtime-grant.test.ts`, which mocks an EMPTY generated
// tree to simulate a released image with no baked widget connector.

import { describe, expect, it, beforeEach } from "vitest";

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
  markPackageSignedActivated,
  __resetSignedTrustedRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  resolveWordPressWidgetAuth,
  requireWordPressWidgetAuth,
  type WidgetAuthResolveDeps,
} from "@/lib/widget-auth-provider";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";

const CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";
const TOKEN_KEY = "wordpress_widget_auth";

// The owner pin is DERIVED (core-extension-instance-coupling-ban: core never
// names a specific extension): the unique GENERATED_WIDGET_STREAM_AGENTS entry
// whose manifest-declared auth.tokenConfigKey is the wordpress widget-auth
// store key. This test file (gate-exempt) pins the real-world owner value so a
// silent manifest regression is caught here.
const OWNER = "@cinatra-ai/wordpress-mcp-connector";

const validStore = {
  read: () => ({ apiKey: "k", webhookSecret: "s", generatedAt: "2026-01-01T00:00:00Z" }),
  generate: () => ({ apiKey: "k2", webhookSecret: "s2", generatedAt: "2026-01-02T00:00:00Z" }),
};

// A deps stub whose ownership-grant query returns `pkg` as the sole APPROVED
// GLOBAL owner (the resolver queries only global scope, orgId:null). `null`
// returns no approved owner.
function depsGrantingGlobal(pkg: string | null): WidgetAuthResolveDeps {
  return {
    ownershipGrantDeps: {
      schema: "cinatra",
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes("SELECT package_name") && text.includes("org_id IS NULL")) {
          return (pkg ? [{ package_name: pkg }] : []) as T[];
        }
        return [] as T[];
      },
    },
  };
}

const depsThrowing: WidgetAuthResolveDeps = {
  ownershipGrantDeps: {
    schema: "cinatra",
    query: async () => {
      throw new Error("simulated grant-store outage");
    },
  },
};

describe("widget-auth-provider — baked arm + union edges (real generated tree)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    __resetSignedTrustedRegistry();
  });

  it("resolveWordPressWidgetAuth() returns null when the connector is absent", async () => {
    expect(await resolveWordPressWidgetAuth(depsGrantingGlobal(null))).toBeNull();
  });

  it("requireWordPressWidgetAuth() FAILS LOUD (throws) when the capability is unresolved", async () => {
    await expect(requireWordPressWidgetAuth(depsGrantingGlobal(null))).rejects.toThrow(
      /widget-auth capability unavailable[\s\S]*wordpress-mcp-connector/,
    );
  });

  it("derives the owner pin from the generated widget-stream manifest declaration", () => {
    const declaring = Object.values(GENERATED_WIDGET_STREAM_AGENTS).filter(
      (e) => e.auth.tokenConfigKey === TOKEN_KEY,
    );
    expect(declaring).toHaveLength(1);
    expect(declaring[0]!.packageName).toBe(OWNER);
  });

  it("resolves the connector-registered store once it is published (baked owner)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: OWNER, impl: validStore });
    const store = await requireWordPressWidgetAuth(depsGrantingGlobal(null));
    expect(store.read()).toEqual({
      apiKey: "k",
      webhookSecret: "s",
      generatedAt: "2026-01-01T00:00:00Z",
    });
    expect(store.generate().webhookSecret).toBe("s2");
  });

  it("IGNORES a same-id provider from a NON-owner package (anti-spoof) and fails loud", async () => {
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/some-other-extension",
      impl: validStore,
    });
    expect(await resolveWordPressWidgetAuth(depsGrantingGlobal(null))).toBeNull();
    await expect(requireWordPressWidgetAuth(depsGrantingGlobal(null))).rejects.toThrow(
      /widget-auth capability unavailable/,
    );
  });

  it("anti-spoof holds even when the spoofer registers ALONGSIDE the owner (owner wins)", async () => {
    const spoofStore = {
      read: () => ({ apiKey: "spoofed", webhookSecret: "spoofed", generatedAt: "2026-01-03T00:00:00Z" }),
      generate: () => ({ apiKey: "spoofed2", webhookSecret: "spoofed2", generatedAt: "2026-01-04T00:00:00Z" }),
    };
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/some-other-extension",
      impl: spoofStore,
    });
    registerCapabilityProvider(CAPABILITY, { packageName: OWNER, impl: validStore });
    expect((await requireWordPressWidgetAuth(depsGrantingGlobal(null))).read()?.apiKey).toBe("k");
  });

  it("IGNORES a structurally-invalid provider (guard) and still fails loud", async () => {
    registerCapabilityProvider(CAPABILITY, {
      packageName: OWNER,
      impl: { read: "not-a-function" },
    });
    expect(await resolveWordPressWidgetAuth(depsGrantingGlobal(null))).toBeNull();
    await expect(requireWordPressWidgetAuth(depsGrantingGlobal(null))).rejects.toThrow(
      /widget-auth capability unavailable/,
    );
  });

  // --- union edges (baked owner present) ------------------------------------

  it("UNION fail-closed: a runtime grant naming a DIFFERENT package than the baked owner → null", async () => {
    // Baked arm = OWNER (has a provider); runtime arm = a different signed,
    // provider-backed, granted package → two distinct owners → fail closed.
    const other = "@cinatra-ai/rogue-widget-connector";
    registerCapabilityProvider(CAPABILITY, { packageName: OWNER, impl: validStore });
    registerCapabilityProvider(CAPABILITY, { packageName: other, impl: validStore });
    markPackageSignedActivated(other);
    expect(await resolveWordPressWidgetAuth(depsGrantingGlobal(other))).toBeNull();
    await expect(requireWordPressWidgetAuth(depsGrantingGlobal(other))).rejects.toThrow(
      /no unique trusted owner/,
    );
  });

  it("UNION baked owner UNAFFECTED when the runtime grant lookup THROWS (fail closed on arm b only)", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: OWNER, impl: validStore });
    // arm(b) throws → swallowed+logged → null; arm(a) still resolves OWNER.
    expect((await requireWordPressWidgetAuth(depsThrowing)).read()?.apiKey).toBe("k");
  });

  it("UNION converges when the runtime grant names the SAME package as the baked owner", async () => {
    registerCapabilityProvider(CAPABILITY, { packageName: OWNER, impl: validStore });
    markPackageSignedActivated(OWNER);
    // both arms → {OWNER} → size 1 → resolves.
    expect((await requireWordPressWidgetAuth(depsGrantingGlobal(OWNER))).read()?.apiKey).toBe("k");
  });
});
