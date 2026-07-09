// Vitest stub for `@/lib/auth` in skills unit tests.
//
// The real module instantiates better-auth at module-load time and throws
// unless BETTER_AUTH_SECRET (and the rest of the host-app boot env) is present,
// while pulling in @cinatra-ai/mcp-server, the Nango/Google-OAuth React UI and
// the wider host-app boot graph — none of it reachable from this package's
// vitest config. Skills tests reach this module transitively via
// auth-session.ts (imported by @cinatra-ai/agents/auth-policy). The stub
// returns minimal shapes so module-load succeeds; a test that actually
// exercises an auth.* function vi.mock()s it at the test level. Mirrors the
// agents package's @/lib/auth mock.

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
