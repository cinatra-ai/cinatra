// Vitest stub for `@/lib/auth`.
//
// The real module instantiates better-auth at module-load time and pulls
// in @cinatra-ai/mcp-server, @cinatra-ai/google-oauth-connection (through @/lib/nango
// to @cinatra-ai/nango-connector and React UI), and other host-app boot graph.
// None of these are reachable from this package's vitest config.
//
// Tests that exercise auth-policy.ts transitively touch this module via
// auth-session.ts. The stub returns minimal shapes so module-load
// succeeds; tests that actually exercise auth.* functions must vi.mock
// them at the test level (existing pattern for store/handlers tests).

export const auth = {
  api: {} as Record<string, unknown>,
  $context: {} as unknown,
} as never;

export function getBetterAuthConsoleSettings() {
  return {};
}

export async function hasAnyBetterAuthUsers() {
  return false;
}

export async function ensureInitialAdminBootstrap(_userId: string) {
  return undefined;
}

export async function ensureDefaultOrganizationMembership(_userId: string) {
  return undefined;
}

export async function ensureGoogleAvatarSync(_userId: string) {
  return undefined;
}

export async function resolveAssistantUserByClientId(_clientId: string) {
  return null;
}

export async function ensureAssistantBootstrap() {
  return undefined;
}
