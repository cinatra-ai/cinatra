// cinatra#975 Wave 2 — the widget-auth store inversion. The vendor store moved
// OUT of core into the wordpress-mcp-connector, which registers it as the
// `@cinatra-ai/host:wordpress-widget-auth` capability from its register(ctx).
// Core's connect/token + wordpress-webhook surfaces resolve it lazily and MUST
// FAIL LOUD (never silent) when the capability is unresolved — this test pins
// that degradation.

import { describe, expect, it, beforeEach } from "vitest";

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  resolveWordPressWidgetAuth,
  requireWordPressWidgetAuth,
} from "@/lib/widget-auth-provider";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";

const CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";

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

describe("widget-auth-provider — lazy resolution + fail-loud degradation", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
  });

  it("resolveWordPressWidgetAuth() returns null when the connector is absent", () => {
    expect(resolveWordPressWidgetAuth()).toBeNull();
  });

  it("requireWordPressWidgetAuth() FAILS LOUD (throws) when the capability is unresolved", () => {
    expect(() => requireWordPressWidgetAuth()).toThrow(
      /widget-auth capability unavailable[\s\S]*wordpress-mcp-connector/,
    );
  });

  it("derives the owner pin from the generated widget-stream manifest declaration", () => {
    // Exactly ONE generated entry declares the wordpress widget-auth token
    // store, and its packageName is the owning connector — the manifest-derived
    // trust anchor resolveWordPressWidgetAuth() pins on.
    const declaring = Object.values(GENERATED_WIDGET_STREAM_AGENTS).filter(
      (e) => e.auth.tokenConfigKey === "wordpress_widget_auth",
    );
    expect(declaring).toHaveLength(1);
    expect(declaring[0]!.packageName).toBe(OWNER);
  });

  it("resolves the connector-registered store once it is published", () => {
    registerCapabilityProvider(CAPABILITY, {
      packageName: OWNER,
      impl: validStore,
    });
    const store = requireWordPressWidgetAuth();
    expect(store.read()).toEqual({
      apiKey: "k",
      webhookSecret: "s",
      generatedAt: "2026-01-01T00:00:00Z",
    });
    expect(store.generate().webhookSecret).toBe("s2");
  });

  it("IGNORES a same-id provider from a NON-owner package (anti-spoof) and fails loud", () => {
    // Another active extension registering under the same host-prefixed id must
    // NOT be resolved — the resolver is pinned to the manifest-derived owning
    // connector package (packageName is host-injected, so it is truthful; a
    // spoofer would have to become the unique manifest-declared owner of the
    // wordpress_widget_auth token store, a reviewed generated-tree change).
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/some-other-extension",
      impl: validStore,
    });
    expect(resolveWordPressWidgetAuth()).toBeNull();
    expect(() => requireWordPressWidgetAuth()).toThrow(/widget-auth capability unavailable/);
  });

  it("anti-spoof holds even when the spoofer registers ALONGSIDE the owner (owner wins)", () => {
    const spoofStore = {
      read: () => ({ apiKey: "spoofed", webhookSecret: "spoofed", generatedAt: "2026-01-03T00:00:00Z" }),
      generate: () => ({ apiKey: "spoofed2", webhookSecret: "spoofed2", generatedAt: "2026-01-04T00:00:00Z" }),
    };
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/some-other-extension",
      impl: spoofStore,
    });
    registerCapabilityProvider(CAPABILITY, {
      packageName: OWNER,
      impl: validStore,
    });
    expect(requireWordPressWidgetAuth().read()?.apiKey).toBe("k");
  });

  it("IGNORES a structurally-invalid provider (guard) and still fails loud", () => {
    // A provider whose impl is missing the required members must not satisfy the
    // structural guard — the resolver treats it as absent (fail-loud), never
    // hands a half-built surface to the credential/webhook paths.
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      impl: { read: "not-a-function" },
    });
    expect(resolveWordPressWidgetAuth()).toBeNull();
    expect(() => requireWordPressWidgetAuth()).toThrow(/widget-auth capability unavailable/);
  });
});
