// Stub for @/lib/auth in root-level vitest runs.
// The real auth.ts imports @cinatra-ai/google-oauth-connection and many other heavy modules.
// Provide minimal stubs for the symbols auth-session.ts needs.
export const auth = {
  api: {
    getSession: async () => null,
  },
};
export async function ensureGoogleAvatarSync() {}
export async function ensureInitialAdminBootstrap() {}
export async function ensureDefaultOrganizationMembership() {}
export async function ensureAssistantBootstrap() {}
