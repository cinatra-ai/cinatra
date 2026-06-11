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
vi.mock("@/lib/wordpress-api", () => ({
  getWordPressAPISettings: vi.fn(() => ({ instances: [{ id: "wp1" }, { id: "wp2" }] })),
}));
vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: vi.fn(() => ({ instances: [] })),
}));
vi.mock("@/lib/better-auth-oauth-client", () => ({
  countExternalMcpOAuthClients: vi.fn(async () => 3),
}));
vi.mock("@cinatra-ai/google-oauth-connection", () => ({
  getGoogleOAuthStatus: vi.fn(async () => ({ status: "connected" })),
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

  it("every registry entry carries a manifest-resolved vendor + setup href", () => {
    for (const entry of listConnectorRegistryEntries()) {
      expect(entry.vendor.length).toBeGreaterThan(0);
      expect(entry.setupHref).toBe(`/connectors/${entry.vendor}/${entry.slug}/${entry.setupSubroute}`);
    }
  });
});
