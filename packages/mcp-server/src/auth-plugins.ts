// Pure, app-graph-free entry for the MCP-server-side Better Auth plugin pair.
//
// Imported by:
//   - packages/mcp-server/src/index.tsx (the runtime wrapper
//     `createMcpServerAuthPlugins` calls into this module after computing
//     validAudiences / scopes from the live server-only / DB state).
//   - src/lib/better-auth-plugins.ts (the shared Cinatra plugin tuple builder
//     that both src/lib/auth.ts and scripts/better-auth-migrate.mts consume).
//
// This module is intentionally restricted to dependencies loadable in plain
// Node (and the Next.js bundler):
//   - `better-auth/plugins` for `jwt`
//   - `@better-auth/oauth-provider` for `oauthProvider`
// NO React, NO Next.js, NO `@/` aliases, NO `server-only`, NO database
// access. The behavioral inputs (validAudiences, page paths, scopes, TTLs)
// are injected by the caller — `getPublicMcpServerUrl()` (which reads the DB
// via the server-only `@/lib/database`) stays inside the runtime wrapper at
// packages/mcp-server/src/index.tsx, not here.
//
// The return type is an EXACT mutable tuple so Better Auth's `$Infer` (which
// is derived from the static type of the `plugins: [...]` array passed to
// `betterAuth()`) survives both spread into the shared builder and a direct
// runtime call. A widened `BetterAuthPlugin[]` (or a `readonly` `as const`
// tuple that is not assignable to Better Auth's mutable plugin-array type)
// would erase the typed plugin-contributed fields app-wide.

import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

export const DEFAULT_MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "mcp:connect",
] as const;

export type McpAuthPluginsOptions = {
  /**
   * Audience URLs accepted by oauth-provider when validating issued JWTs.
   * RFC 8707 binds tokens to a `resource`; the resolved URL must appear here
   * so verifyMcpAccessToken accepts the token. Behavioral, not schema-
   * affecting. Required so callers cannot silently ship with the wrong set.
   */
  validAudiences: string[];
  /** OAuth scopes advertised by the authorization server. Behavioral. */
  scopes: readonly string[];
  /** OAuth UI page paths. Behavioral. */
  loginPage: string;
  consentPage: string;
  signupPage: string;
  /** Token TTLs in seconds. Behavioral. */
  accessTokenExpiresIn?: number;
  refreshTokenExpiresIn?: number;
  /** Grant types the authorization server advertises. Behavioral. */
  grantTypes?: readonly (
    | "authorization_code"
    | "client_credentials"
    | "refresh_token"
  )[];
  /** Dynamic-client-registration knobs. Behavioral. */
  allowDynamicClientRegistration?: boolean;
  allowPublicClientPrelogin?: boolean;
  allowUnauthenticatedClientRegistration?: boolean;
  clientRegistrationDefaultScopes?: readonly string[];
  clientRegistrationAllowedScopes?: readonly string[];
  /** Suppresses the well-known oauthAuthServerConfig warning. Behavioral. */
  silenceOauthAuthServerConfigWarning?: boolean;
};

/**
 * The pair the MCP server contributes to the Better Auth plugin list. The
 * exact tuple shape pins the order (jwt → oauthProvider) and the per-element
 * return types so spreading into a larger `plugins` array preserves the
 * static type Better Auth's `$Infer` consumes.
 *
 * MUTABLE (not `readonly`): Better Auth's `BetterAuthOptions.plugins` is typed
 * `BetterAuthPlugin[]` (mutable). A `readonly` tuple is not assignable to it
 * and silently widens to `BetterAuthPlugin[]` when passed via `as` — erasing
 * `$Infer`.
 */
export type McpAuthPlugins = [
  ReturnType<typeof jwt>,
  ReturnType<typeof oauthProvider>,
];

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const DEFAULT_GRANT_TYPES: ReadonlyArray<
  "authorization_code" | "client_credentials" | "refresh_token"
> = ["authorization_code", "client_credentials", "refresh_token"];

/**
 * Build the `[jwt(), oauthProvider({...})]` pair the MCP server contributes
 * to Better Auth. Pure and side-effect-free; all I/O lives at the call site.
 */
export function buildMcpAuthPlugins(
  options: McpAuthPluginsOptions,
): McpAuthPlugins {
  const scopes = [...options.scopes];
  const grantTypes = [...(options.grantTypes ?? DEFAULT_GRANT_TYPES)];
  const clientRegistrationDefaultScopes = [
    ...(options.clientRegistrationDefaultScopes ?? scopes),
  ];
  const clientRegistrationAllowedScopes = [
    ...(options.clientRegistrationAllowedScopes ?? scopes),
  ];
  const validAudiences = [...options.validAudiences];
  return [
    jwt(),
    oauthProvider({
      scopes,
      allowDynamicClientRegistration:
        options.allowDynamicClientRegistration ?? true,
      allowPublicClientPrelogin: options.allowPublicClientPrelogin ?? true,
      allowUnauthenticatedClientRegistration:
        options.allowUnauthenticatedClientRegistration ?? true,
      clientRegistrationDefaultScopes,
      clientRegistrationAllowedScopes,
      grantTypes,
      loginPage: options.loginPage,
      consentPage: options.consentPage,
      signup: { page: options.signupPage },
      validAudiences,
      accessTokenExpiresIn:
        options.accessTokenExpiresIn ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn:
        options.refreshTokenExpiresIn ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
      silenceWarnings: {
        oauthAuthServerConfig:
          options.silenceOauthAuthServerConfigWarning ?? true,
      },
    }),
  ];
}
