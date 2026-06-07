/**
 * Minimal stub of @cinatra-ai/nango-connector for the
 * root-level vitest config. The real package pulls in @/lib/nango, auth, DB
 * access, and the Nango SDK — none of which src/__tests__/* tests actually
 * need because they mock the connector via vi.mock().
 *
 * Only the surface our tests rely on is exported here. This stub also
 * provides ensureNangoIntegration +
 * CINATRA_NANGO_PROVIDER_CONFIG_KEYS because a2a-dev-auto-connect.ts imports
 * them; the tests still mock everything via vi.mock.
 */
export type NangoConnectorKey = string;

export const CINATRA_NANGO_PROVIDER_CONFIG_KEYS = {
  a2aServer: "cinatra-a2a-server",
  apollo: "cinatra-apollo",
  claude: "cinatra-anthropic",
  gemini: "cinatra-google-gemini",
  github: "cinatra-github",
  gmail: "cinatra-gmail",
  googleCalendar: "cinatra-google-calendar",
  googleOAuth: "cinatra-google-oauth",
  linkedin: "cinatra-linkedin",
  openai: "cinatra-openai",
  wordpress: "cinatra-wordpress",
  youtube: "cinatra-youtube",
} as const;

export async function ensureNangoIntegration(
  _input: { provider: string; providerConfigKey: string; displayName: string },
): Promise<unknown> {
  return null;
}

export async function getNangoConnection(
  _providerConfigKey: string,
  _connectionId: string,
): Promise<unknown> {
  return null;
}

export async function importNangoConnection(
  _input: Record<string, unknown>,
): Promise<unknown> {
  return null;
}

export function isNangoConfigured(): boolean {
  return false;
}

export function listSavedNangoConnections(
  _key: string,
): Array<{ providerConfigKey: string; connectionId: string; metadata?: Record<string, unknown> }> {
  return [];
}
