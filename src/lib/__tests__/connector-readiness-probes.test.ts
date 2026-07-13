// The /connectors cards resolve readiness through the registry's per-connector
// probes, which the built-in probe module registers from host-owned signals and
// manifest-resolved connector modules. This locks the wiring: probes register
// for catalog connectors, resolve through the generated entry-module map, and
// an unprobed connector falls back to "not connected".

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Host-owned readiness signals — mocked so the probe module imports stay light.
vi.mock("@/lib/nango-system", () => ({
  getPrimarySavedNangoConnections: vi.fn(() => ({
    gmail: { connectionId: "c1" },
    googleCalendar: null,
    linkedin: null,
    youtube: null,
  })),
  listSavedNangoConnections: vi.fn(() => [{ connectionId: "a2a-1" }]),
}));
// The wordpress/drupal instance stores are CONNECTOR-owned (cinatra#975
// Wave 3): the probes resolve the relocated clients lazily. The drupal
// resolver returns null here (connector absent) to pin the degraded
// not-connected posture.
vi.mock("@/lib/connector-client-providers", () => ({
  resolveWordPressInstanceAdmin: vi.fn(() => ({
    getAPISettings: () => ({ instances: [{ id: "wp1" }, { id: "wp2" }] }),
  })),
  resolveDrupalInstanceAdmin: vi.fn(() => null),
}));
vi.mock("@/lib/better-auth-oauth-client", () => ({
  countExternalMcpOAuthClients: vi.fn(async () => 3),
}));
vi.mock("@cinatra-ai/google-oauth-connection", () => ({
  getGoogleOAuthStatus: vi.fn(async () => ({ status: "connected" })),
}));
// The WordPress widget-auth host service (its read() returns the generated
// credential pair or null; the resolver returns null when the owning connector
// is not installed/active). Mocked so the readiness import stays light and each
// test can drive the credential state.
vi.mock("@/lib/widget-auth-provider", () => ({
  resolveWordPressWidgetAuth: vi.fn(async () => null),
}));

// Manifest-resolved connector modules — the probe consumes each module's
// status export through the generated entry-module map.
vi.mock("@/lib/connector-modules.server", () => ({
  loadConnectorModule: vi.fn(async (slug: string) => {
    if (slug === "apollo-connector") {
      return { getApolloAPIStatus: () => ({ status: "connected" }) };
    }
    if (slug === "tailscale-connector") {
      return { getTailscaleConnectionStatus: () => ({ connected: false }) };
    }
    return null;
  }),
}));

import "@/lib/connector-readiness.server";
import {
  getConnectorRegistryEntryBySlug,
  listConnectorRegistryEntries,
} from "@/lib/connectors-registry.server";
import { resolveWordPressWidgetAuth } from "@/lib/widget-auth-provider";

const CTX = { userId: "user-1" };

describe("built-in connector readiness probes", () => {
  it("a module-backed probe reports the connector's own status", async () => {
    const entry = getConnectorRegistryEntryBySlug("apollo-connector");
    expect(entry).toBeDefined();
    await expect(entry!.readinessProbe(CTX)).resolves.toEqual({ connected: true });
  });

  it("a host-signal probe carries the connected count label", async () => {
    const wordpress = getConnectorRegistryEntryBySlug("wordpress-mcp-connector");
    await expect(wordpress!.readinessProbe(CTX)).resolves.toEqual({
      connected: true,
      connectedLabel: "2",
    });
    const mcpClient = getConnectorRegistryEntryBySlug("mcp-client-connector");
    await expect(mcpClient!.readinessProbe(CTX)).resolves.toEqual({
      connected: true,
      connectedLabel: "3",
    });
  });

  it("a per-user probe resolves from the actor's saved connections", async () => {
    const gmail = getConnectorRegistryEntryBySlug("gmail-connector");
    await expect(gmail!.readinessProbe(CTX)).resolves.toEqual({ connected: true });
    await expect(gmail!.readinessProbe({ userId: null })).resolves.toEqual({ connected: false });
  });

  it("a connector without a probe (and a disconnected one) reports not connected", async () => {
    const github = getConnectorRegistryEntryBySlug("github-connector");
    await expect(github!.readinessProbe(CTX)).resolves.toEqual({ connected: false });
    const tailscale = getConnectorRegistryEntryBySlug("tailscale-connector");
    await expect(tailscale!.readinessProbe(CTX)).resolves.toEqual({ connected: false });
    const drupal = getConnectorRegistryEntryBySlug("drupal-mcp-connector");
    await expect(drupal!.readinessProbe(CTX)).resolves.toEqual({
      connected: false,
      connectedLabel: undefined,
    });
  });

  it("the wordpress-assistant widget probe reflects generated credentials", async () => {
    // ask-6: this connector's OWN readiness is whether its widget credentials
    // (API key + webhook secret) have been generated — the one thing its Setup
    // tab controls. It seeds both the /connectors grid badge and the host
    // Connection status card on the Setup tab.
    const wp = getConnectorRegistryEntryBySlug("wordpress-assistant-connector");
    expect(wp).toBeDefined();
    const mocked = vi.mocked(resolveWordPressWidgetAuth);

    // credentials generated → connected
    mocked.mockResolvedValueOnce({
      read: () => ({ apiKey: "k", webhookSecret: "s", generatedAt: "t" }),
      generate: vi.fn(),
    });
    await expect(wp!.readinessProbe(CTX)).resolves.toEqual({ connected: true });

    // no credentials yet → not connected
    mocked.mockResolvedValueOnce({ read: () => null, generate: vi.fn() });
    await expect(wp!.readinessProbe(CTX)).resolves.toEqual({ connected: false });

    // connector not installed / no unique trusted owner (resolver null) → not connected
    mocked.mockResolvedValueOnce(null);
    await expect(wp!.readinessProbe(CTX)).resolves.toEqual({ connected: false });
  });

  it("every registry entry carries a manifest-resolved vendor + setup href", () => {
    for (const entry of listConnectorRegistryEntries()) {
      expect(entry.vendor.length).toBeGreaterThan(0);
      expect(entry.setupHref).toBe(`/connectors/${entry.vendor}/${entry.slug}/${entry.setupSubroute}`);
    }
  });
});
