import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  clearNangoConnectionRecords,
  deleteNangoConnection,
  ensureNangoIntegration,
  getNangoConnection,
  getNangoOAuthCallbackUrl,
  getNangoSystem,
  getPrimarySavedNangoConnection,
} from "@/lib/nango-system";
// This package barrel is intentionally SERVER-ONLY and exposes the Google OAuth
// RUNTIME facade (settings/status/token refresh) consumed by auth.ts + layout.tsx
// + the host google-oauth-connector provider binder. The operator-facing setup UI
// lives IN the google-oauth-connector extension (its own setup-page →
// settings-form → settings-panel, behind the manage-gated save action). Keeping
// the barrel free of any "use client" form also keeps the @/app/campaigns/actions
// graph (-> agents/objects/mcp) out of every server consumer of this barrel.

type GoogleScopedConnectorKey = "googleOAuth" | "gmail" | "googleCalendar" | "youtube";

type GoogleOAuthStoredSettings = {
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
};

type GoogleOAuthSettings = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
};

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(",");

function readStoredSettings(): GoogleOAuthStoredSettings {
  return readConnectorConfigFromDatabase<GoogleOAuthStoredSettings>("google_oauth", {});
}

function writeStoredSettings(value: GoogleOAuthStoredSettings) {
  writeConnectorConfigToDatabase("google_oauth", value);
}

export async function getGoogleOAuthSettings(): Promise<GoogleOAuthSettings> {
  // BOOT-ORDER PIN (cinatra#151 item 9a — the ONE module-eval-time nango
  // path): auth.ts awaits this at module TOP LEVEL, BEFORE static-bundle
  // activation registers the nango-system surface. An unresolved surface
  // degrades to the stored DB row (nangoCredentials = null in the existing
  // fallback chain) — NEVER a throw; runtime reads after activation see live
  // Nango values. Pinned by the boot-order test.
  const nangoSystem = getNangoSystem();
  const nangoCredentials = nangoSystem
    ? await nangoSystem.getNangoOAuth2IntegrationCredentials(nangoSystem.providerConfigKeys.googleOAuth)
    : null;
  const stored = readStoredSettings();

  return {
    // Prefer Nango as source of truth; fall back to DB copy for resilience across Nango restarts
    clientId: nangoCredentials?.clientId ?? stored.clientId,
    clientSecret: nangoCredentials?.clientSecret ?? stored.clientSecret,
    redirectUri: stored.redirectUri ?? (nangoSystem ? nangoSystem.getNangoOAuthCallbackUrl() : undefined),
  };
}

export async function getGoogleOAuthStatus() {
  const settings = await getGoogleOAuthSettings();
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth");
  if (savedConnection) {
    return {
      status: "connected" as const,
      accountEmail: savedConnection.email,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  if (settings.clientId && settings.clientSecret) {
    return {
      status: "connected" as const,
      accountEmail: undefined,
      detail: "Google OAuth is configured for Cinatra.",
    };
  }

  if (settings.clientId || settings.clientSecret || settings.redirectUri) {
    return {
      status: "incomplete" as const,
      accountEmail: undefined,
      detail: "Save the Google OAuth client values and connect a Google account to enable Gmail and Calendar access.",
    };
  }

  return {
    status: "not_connected" as const,
    accountEmail: undefined,
    detail: undefined,
  };
}

export async function getUserGoogleOAuthStatus(userId: string) {
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth", {
    scope: "user",
    userId,
  });

  if (savedConnection) {
    return {
      status: "connected" as const,
      accountEmail: savedConnection.email,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  return {
    status: "not_connected" as const,
    accountEmail: undefined,
    detail: "Connect your Google account to enable Gmail and Google Calendar access.",
  };
}

export async function saveGoogleOAuthSettings(input: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}) {
  const current = await getGoogleOAuthSettings();
  const normalizedRedirectUri = input.redirectUri?.trim() || current.redirectUri || getNangoOAuthCallbackUrl();
  const nextSettings: GoogleOAuthSettings = {
    clientId: input.clientId?.trim() || current.clientId,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
    redirectUri: normalizedRedirectUri,
  };
  await ensureGoogleOAuthIntegration(nextSettings);
  writeStoredSettings({
    redirectUri: nextSettings.redirectUri,
    clientId: nextSettings.clientId,
    clientSecret: nextSettings.clientSecret,
  });
  return nextSettings;
}

export async function clearGoogleOAuthConnection() {
  writeStoredSettings({
    redirectUri: getNangoOAuthCallbackUrl(),
  });
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth");
  await deleteNangoConnection(
    savedConnection?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
    savedConnection?.connectionId ?? "cinatra-google-oauth",
  );
  await clearNangoConnectionRecords("googleOAuth");
}

export async function clearUserGoogleOAuthConnection(userId: string) {
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth", {
    scope: "user",
    userId,
  });

  if (savedConnection) {
    await deleteNangoConnection(
      savedConnection.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
      savedConnection.connectionId,
    );
  }

  await clearNangoConnectionRecords("googleOAuth", {
    scope: "user",
    userId,
  });
}

export async function refreshGoogleOAuthAccessTokenIfNeeded(input?: { userId?: string; connectorKey?: GoogleScopedConnectorKey }) {
  const connectorKey: GoogleScopedConnectorKey = input?.connectorKey ?? "googleOAuth";
  const savedConnection = input?.userId
    ? getPrimarySavedNangoConnection(connectorKey, {
        scope: "user",
        userId: input.userId,
      }) ?? getPrimarySavedNangoConnection("googleOAuth", {
        scope: "user",
        userId: input.userId,
      })
    : getPrimarySavedNangoConnection(connectorKey) ?? getPrimarySavedNangoConnection("googleOAuth");
  if (!savedConnection) {
    throw new Error("Google OAuth is not connected.");
  }
  const nangoConnection = await getNangoConnection(
    savedConnection.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
    savedConnection.connectionId,
    { forceRefresh: true, refreshToken: true },
  );
  const nangoCredentials = (nangoConnection as {
    credentials?: {
      type?: string;
      access_token?: string;
      refresh_token?: string;
      expires_at?: string | Date;
    };
    end_user?: {
      email?: string;
    };
  } | null);

  if (nangoCredentials?.credentials?.type !== "OAUTH2" || !nangoCredentials.credentials.access_token) {
    throw new Error("Unable to load the Google OAuth access token from Nango.");
  }

  return {
    accessToken: nangoCredentials.credentials.access_token,
    refreshToken: nangoCredentials.credentials.refresh_token,
    tokenExpiresAt:
      typeof nangoCredentials.credentials.expires_at === "string"
        ? nangoCredentials.credentials.expires_at
        : nangoCredentials.credentials.expires_at instanceof Date
          ? nangoCredentials.credentials.expires_at.toISOString()
          : undefined,
    accountEmail: nangoCredentials.end_user?.email ?? savedConnection.email,
  };
}

export async function googleApiFetch<T>(input: {
  url: string;
  method?: string;
  body?: unknown;
}, options?: { userId?: string; connectorKey?: GoogleScopedConnectorKey }) {
  const settings = await refreshGoogleOAuthAccessTokenIfNeeded(options);
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${settings.accessToken}`,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Google API request failed.");
  }
  return payload;
}

async function ensureGoogleOAuthIntegration(settings: GoogleOAuthSettings) {
  if (!settings.clientId || !settings.clientSecret) {
    return;
  }

  await ensureNangoIntegration({
    provider: "google",
    providerConfigKey: CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
    displayName: "Cinatra Google OAuth",
    credentials: {
      type: "OAUTH2",
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      scopes: GOOGLE_SCOPES,
    },
  });
}
