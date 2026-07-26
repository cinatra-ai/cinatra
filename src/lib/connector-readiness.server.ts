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
} from "@/lib/nango-system";
// The wordpress/drupal instance stores are CONNECTOR-owned since cinatra#975
// Wave 3 — the readiness probes resolve the relocated clients lazily and
// degrade to not-connected (0 instances) when the owning connector is absent,
// the same posture as the manifest-resolved module probes below.
import {
  resolveDrupalInstanceAdmin,
  resolveWordPressInstanceAdmin,
} from "@/lib/connector-client-providers";
import { resolveWordPressWidgetAuth } from "@/lib/widget-auth-provider";
import { countExternalMcpOAuthClients } from "@/lib/better-auth-oauth-client";
import { getGoogleOAuthStatus } from "@cinatra-ai/google-oauth-connection";
import { loadConnectorModule } from "@/lib/connector-modules.server";
// cinatra#2073: Twenty + Plane are WORKSPACE-scoped connectors — their
// connection lives in an instance-global workspace row, NOT the viewer's
// personal Nango scope. Both readiness signals are HOST-owned (the same reads
// the connectors' own status pages reflect), so the grid badge resolves from
// the scope the connection actually lives in.
import {
  getExternalMcpServerById,
  TWENTY_WORKSPACE_ROW_ID,
} from "@/lib/external-mcp-registry";
import { readConnectorConfigFromDatabase } from "@/lib/database";
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
    countReadiness(resolveWordPressInstanceAdmin()?.getAPISettings().instances.length ?? 0),
  // The WordPress widget connector's OWN readiness is whether its widget
  // credentials have been generated on this page (the API key + webhook secret
  // the WP plugin pastes) — the single thing this setup page controls. WordPress
  // instances belong to the wordpress connector (probed above); this page's own
  // connection signal is the generated credential pair. `resolveWordPressWidgetAuth`
  // returns null when the owning connector isn't installed/active or no unique
  // trusted owner resolves (fail-closed → not connected); `read()` returns null
  // until credentials are generated. Feeds both the /connectors grid badge and
  // the host Connection status card on this connector's Setup tab (ask-6).
  "wordpress-assistant-connector": async () => {
    const svc = await resolveWordPressWidgetAuth();
    return connectedWhen(Boolean(svc?.read()));
  },
  "drupal-mcp-connector": async () =>
    countReadiness(resolveDrupalInstanceAdmin()?.listInstances().length ?? 0),
  "a2a-server-connector": async () => countReadiness(listSavedNangoConnections("a2aServer").length),
  // Twenty CRM (cinatra#2073): a WORKSPACE-scoped external-MCP connector. Its
  // connection is the instance-global `external_mcp_servers` singleton
  // (TWENTY_WORKSPACE_ROW_ID), resolved by fixed row id — NEVER the viewer's
  // personal scope. `enabled` + a bound Nango connection = healthy (the same
  // signal `getTwentyConnectionState` reads for the connector's status page), so
  // an org member with no personal connection row still sees Connected.
  //
  // Fail-CLOSED on scope (codex): the fixed id is NOT reserved — the generic
  // external-MCP write handler accepts a caller-supplied `id` with a personal
  // (`user`) scope, so a spoofed personal row named `twenty-workspace` could
  // otherwise light the WORKSPACE badge for other viewers. Require the row be
  // genuinely `scope === "workspace"` (what `saveTwentyConnection` always
  // writes), so a personal row can never resolve the workspace badge.
  "twenty-connector": async () => {
    const row = getExternalMcpServerById(TWENTY_WORKSPACE_ROW_ID);
    return connectedWhen(
      row?.scope === "workspace" && row.enabled && Boolean(row.nangoConnectionId),
    );
  },
  // Plane (cinatra#2073): a WORKSPACE-scoped connector whose connection is the
  // instance-global connector-config row (encrypted PAT + workspace/project),
  // the SAME signal its setup page reflects via `loadInstanceConfig()`. Read
  // that row through the host connector-config store on the connector's OWN
  // namespaced key (`<packageId>:instance` — the exact path the connector's
  // `register(ctx)` deps bind to). The package id is DERIVED from the catalog
  // slug via the registry (never a hardcoded extension-instance literal — the
  // core-extension-instance-coupling-ban), so the badge stays workspace-scoped,
  // never personal, with no cross-org fail-open.
  "plane-connector": async () => {
    const descriptor = getConnectorDescriptorBySlug("plane-connector");
    if (!descriptor) return connectedWhen(false);
    return connectedWhen(
      Boolean(
        readConnectorConfigFromDatabase<{ instanceId?: string } | null>(
          `${descriptor.packageId}:instance`,
          null,
        ),
      ),
    );
  },
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
