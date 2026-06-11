import {
  CINATRA_NANGO_CONNECTION_IDS,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  clearNangoConnectionRecords,
  deleteNangoConnection,
  getNangoConnection,
  getPrimarySavedNangoConnection,
  isNangoConfigured,
} from "@/lib/nango-system";

export async function getConfiguredYouTubeAccessToken() {
  if (!isNangoConfigured()) {
    return null;
  }

  const savedConnection = getPrimarySavedNangoConnection("youtube");
  const connection = await getNangoConnection(
    savedConnection?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.youtube,
    savedConnection?.connectionId ?? CINATRA_NANGO_CONNECTION_IDS.youtube,
    { forceRefresh: true, refreshToken: true },
  );
  const credentials = (connection as {
    credentials?: {
      type?: string;
      access_token?: string;
    };
  } | null)?.credentials;

  if (credentials?.type === "OAUTH2" && typeof credentials.access_token === "string" && credentials.access_token.trim()) {
    return credentials.access_token;
  }

  return null;
}

export function getYouTubeAPIStatus() {
  const savedConnection = getPrimarySavedNangoConnection("youtube");
  if (savedConnection) {
    return {
      status: "connected" as const,
      detail: `Connected through Nango${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Connect YouTube through Nango to enable YouTube episode discovery.",
  };
}

export async function clearYouTubeAPISettings() {
  const savedConnection = getPrimarySavedNangoConnection("youtube");
  await deleteNangoConnection(
    savedConnection?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.youtube,
    savedConnection?.connectionId ?? CINATRA_NANGO_CONNECTION_IDS.youtube,
  );
  await clearNangoConnectionRecords("youtube");
}
