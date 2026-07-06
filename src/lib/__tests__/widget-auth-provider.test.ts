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

const CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";

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

  it("resolves the connector-registered store once it is published", () => {
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/wordpress-mcp-connector",
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
    // NOT be resolved — the resolver is pinned to the owning connector package.
    registerCapabilityProvider(CAPABILITY, {
      packageName: "@cinatra-ai/some-other-extension",
      impl: validStore,
    });
    expect(resolveWordPressWidgetAuth()).toBeNull();
    expect(() => requireWordPressWidgetAuth()).toThrow(/widget-auth capability unavailable/);
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
