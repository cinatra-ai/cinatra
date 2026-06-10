import "server-only";

// Built-in readiness probes for the bundled connectors.
//
// Importing this module (side effect) registers a probe per connector into the
// server registry, keyed by the catalog descriptor's packageId. Probes read
// host-owned signals (saved Nango connections, instance settings, the Better
// Auth OAuth-client table) and, where the signal lives in the connector
// package, resolve the connector's server module through the generated
// manifest (`loadConnectorModule`) — the host names no connector package here.
//
// The slug-keyed export shapes below are the host↔connector readiness data
// contract until connectors register their own probes through their
// `register(ctx)` server entries. A connector without a probe falls back to
// the registry default (not connected) — adding a bundled connector requires
// no edit here.

import {
  getPrimarySavedNangoConnections,
  listSavedNangoConnections,
} from "@/lib/nango";
import { getWordPressAPISettings } from "@/lib/wordpress-api";
import { getDrupalAPISettings } from "@/lib/drupal-api";
import { countExternalMcpOAuthClients } from "@/lib/better-auth-oauth-client";
import { getGoogleOAuthStatus } from "@cinatra-ai/google-oauth-connection";
import { loadConnectorModule } from "@/lib/connector-modules.server";
import {
  registerConnectorReadinessProbe,
  type ConnectorReadiness,
  type ConnectorReadinessContext,
  type ConnectorReadinessProbe,
} from "@/lib/connectors-registry.server";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

type StatusModule = { status: string };

function connectedWhen(condition: boolean): ConnectorReadiness {
  return { connected: condition };
}

function countReadiness(count: number, labelSuffix = ""): ConnectorReadiness {
  return {
    connected: count > 0,
    connectedLabel: count > 0 ? `${count}${labelSuffix}` : undefined,
  };
}

function userConnections(ctx: ConnectorReadinessContext) {
  if (!ctx.userId) return null;
  return getPrimarySavedNangoConnections({ scope: "user", userId: ctx.userId });
}

// Probes keyed by connector SLUG. Each probe states the export shape it
// consumes from the connector's manifest-resolved server module.
const BUILT_IN_PROBES: Record<string, ConnectorReadinessProbe> = {
  "openai-connector": async () => {
    const mod = await loadConnectorModule<{
      getConfiguredOpenAIConnection: () => Promise<{ apiKey?: string | null } | null>;
    }>("openai-connector");
    const connection = await mod?.getConfiguredOpenAIConnection();
    return connectedWhen(Boolean(connection?.apiKey));
  },
  "anthropic-connector": async () => {
    const mod = await loadConnectorModule<{ getAnthropicAPIStatus: () => StatusModule }>(
      "anthropic-connector",
    );
    return connectedWhen(mod?.getAnthropicAPIStatus().status === "connected");
  },
  "gemini-connector": async () => {
    const mod = await loadConnectorModule<{ getGeminiAPIStatus: () => StatusModule }>(
      "gemini-connector",
    );
    return connectedWhen(mod?.getGeminiAPIStatus().status === "connected");
  },
  "apollo-connector": async () => {
    const mod = await loadConnectorModule<{ getApolloAPIStatus: () => StatusModule }>(
      "apollo-connector",
    );
    return connectedWhen(mod?.getApolloAPIStatus().status === "connected");
  },
  "apify-connector": async () => {
    const mod = await loadConnectorModule<{ getApifyStatus: () => StatusModule }>(
      "apify-connector",
    );
    return connectedWhen(mod?.getApifyStatus().status === "connected");
  },
  "tailscale-connector": async () => {
    const mod = await loadConnectorModule<{
      getTailscaleConnectionStatus: () => { connected: boolean };
    }>("tailscale-connector");
    return connectedWhen(Boolean(mod?.getTailscaleConnectionStatus().connected));
  },
  // Inbound MCP-client readiness is a host-owned signal (the Better Auth
  // oauthClient table), so the probe needs nothing from the extension.
  "mcp-client-connector": async () => countReadiness(await countExternalMcpOAuthClients()),
  "gmail-connector": async (ctx) => connectedWhen(Boolean(userConnections(ctx)?.gmail)),
  "google-calendar-connector": async (ctx) => {
    const mod = await loadConnectorModule<{
      getStoredGoogleCalendarAppointments: (userId: string) => { appointments: unknown[] };
    }>("google-calendar-connector");
    const appointmentsCount = ctx.userId
      ? (mod?.getStoredGoogleCalendarAppointments(ctx.userId).appointments.length ?? 0)
      : 0;
    return {
      connected: Boolean(userConnections(ctx)?.googleCalendar) || appointmentsCount > 0,
      connectedLabel: appointmentsCount > 0 ? `${appointmentsCount} appt` : undefined,
    };
  },
  "linkedin-connector": async (ctx) => connectedWhen(Boolean(userConnections(ctx)?.linkedin)),
  "youtube-connector": async (ctx) => connectedWhen(Boolean(userConnections(ctx)?.youtube)),
  "wordpress-mcp-connector": async () =>
    countReadiness(getWordPressAPISettings().instances.length),
  "drupal-mcp-connector": async () => countReadiness(getDrupalAPISettings().instances.length),
  "a2a-server-connector": async () => countReadiness(listSavedNangoConnections("a2aServer").length),
  "google-oauth-connector": async () =>
    connectedWhen((await getGoogleOAuthStatus()).status === "connected"),
};

let registered = false;

export function registerBuiltInConnectorReadinessProbes(): void {
  if (registered) return;
  registered = true;
  for (const [slug, probe] of Object.entries(BUILT_IN_PROBES)) {
    const descriptor = getConnectorDescriptorBySlug(slug);
    if (!descriptor) continue; // not in this image's catalog — nothing to probe
    registerConnectorReadinessProbe(descriptor.packageId, probe);
  }
}

// Self-register on import — readiness consumers import this module for the
// side effect (same pattern as @/lib/register-blog-providers).
registerBuiltInConnectorReadinessProbes();
