// Shared, app-graph-free factory for the Cinatra Better Auth plugin tuple.
//
// SINGLE SOURCE OF TRUTH for the plugin LIST (and through it, the schema)
// Better Auth uses. Imported by:
//   - src/lib/auth.ts (the runtime — spreads this tuple, then appends
//     `nextCookies()` for Next.js cookie integration)
//   - scripts/better-auth-migrate.mts (the bootstrap migration `make setup`
//     runs in plain Node — applies the schema via `getMigrations()`)
//
// This module is intentionally restricted to dependencies loadable in plain
// Node (and the Next.js bundler):
//   - `better-auth/plugins` for the four core plugins (username / twoFactor /
//     admin / organization)
//   - `./better-auth-schema` for the schema-bearing *data*
//   - `@cinatra-ai/mcp-server/auth-plugins` for the MCP auth pair (pure)
// NO React, NO Next.js, NO `@/` aliases, NO `server-only`, NO database access;
// fully erasable syntax (no enum / namespace / decorators) so Node 24's
// native type-stripping loads it for the migration runner.
//
// Return type is a precisely-typed MUTABLE tuple (no `readonly`, no widened
// `BetterAuthPlugin[]`). Better Auth derives `auth.$Infer` (and its typed
// server API) from the static type of the `plugins` array passed to
// `betterAuth()`; a widened array erases plugin-contributed fields
// (`session.activeOrganizationId`, `user.role`, `team.slug`, ...). The
// drift-guard test (src/lib/__tests__/better-auth-schema.test.ts) asserts
// that both runtime and migration consume this factory; the CI typecheck
// pins the tuple length at the runtime call site to catch a stray push /
// append outside the factory.

import { admin as adminPlugin, organization, twoFactor, username } from "better-auth/plugins";
import {
  buildMcpAuthPlugins,
  DEFAULT_MCP_SCOPES,
  type McpAuthPlugins,
  type McpAuthPluginsOptions,
} from "@cinatra-ai/mcp-server/auth-plugins";

// The explicit `.ts` extension is REQUIRED for Node's native type-stripping
// loader. The Next.js bundler accepts both with and without — but
// `scripts/better-auth-migrate.mts` imports this module transitively via
// plain Node (no jiti / tsx), where `allowImportingTsExtensions` in
// tsconfig.json + bundler resolution would otherwise mask the failure.
import {
  cinatraAuthAdditionalUserFields,
  cinatraOrganizationOptions,
} from "./better-auth-schema.ts";

// Re-export the pure MCP pieces so callers can build the MCP tuple via the
// same module they import the rest of the factory from.
export {
  buildMcpAuthPlugins,
  DEFAULT_MCP_SCOPES,
  cinatraAuthAdditionalUserFields,
  cinatraOrganizationOptions,
  type McpAuthPlugins,
  type McpAuthPluginsOptions,
};

// If a future change exposes upstream schema-bearing knobs through these
// wrappers (e.g. `admin({ schema: {...} })`, `organization({ schema, ...,
// dynamicAccessControl })`, `oauthProvider({ schema: {...} })`), the
// parity test in `src/lib/__tests__/better-auth-schema.test.ts` must be
// updated to assert the new behavior — those upstream options are
// schema-bearing and would otherwise drift silently between runtime and
// migration. Today the wrappers only expose behavior hooks, so the parity
// test's per-table assertions are sufficient.

/** Behavioral options that flow through the `admin()` plugin. */
export type CinatraAdminPluginOptions = {
  /** When true, admin sessions are allowed to impersonate other admins (dev). */
  allowImpersonatingAdmins?: boolean;
};

/** Behavioral options that flow through the `organization()` plugin. */
export type CinatraOrganizationPluginOptions = {
  /**
   * Authoritative server gate for `POST /api/auth/organization/create`.
   * Better Auth passes the full user record (`& Record<string, any>` so
   * additional fields like `role` are present). Mirror the upstream
   * signature so the typecheck succeeds without leaking a narrower shape.
   */
  allowUserToCreateOrganization?: (
    user: Record<string, unknown>,
  ) => Promise<boolean> | boolean;
  /**
   * Runtime-only Better Auth organization lifecycle hooks. BEHAVIORAL, not
   * schema-bearing: the bootstrap migration never creates organizations, so it
   * omits them, and they do not affect `getSchema()` (the drift-guard test).
   * Threaded through the shared factory so `organization()` keeps exactly one
   * construction site. cinatra#1494 injects `beforeCreateTeam` here to give
   * Better Auth's default team a slug (`public.team.slug` is NOT NULL).
   */
  organizationHooks?: NonNullable<
    Parameters<typeof organization>[0]
  >["organizationHooks"];
  /**
   * Runtime-only Better Auth invitation-email callback. BEHAVIORAL, not
   * schema-bearing: Better Auth invokes it after creating an `invitation` row,
   * and it does not affect `getSchema()` (the drift-guard test), so the
   * bootstrap migration omits it. cinatra#1565 injects it so org-member
   * invitations actually dispatch the accept link (Better Auth ships NO default
   * sender — without this the row is created but nothing is sent). Threaded
   * through the shared factory so `organization()` keeps exactly one
   * construction site.
   */
  sendInvitationEmail?: NonNullable<
    Parameters<typeof organization>[0]
  >["sendInvitationEmail"];
  /**
   * Invitation verification pin (cinatra#1907). BEHAVIORAL, not
   * schema-bearing. A custom `advanced.database.generateId` (the entity-id
   * override in src/lib/auth.ts) flips Better Auth's invitation
   * accept/reject/get default to verified-email-only — but this app
   * deliberately permits `emailVerified=false` accounts. Defaulted to `false`
   * below via `??` (NEVER a truthiness-conditional spread: the value is falsy
   * and would be silently dropped) so current invitation behavior is
   * preserved exactly. Tightening invitation policy is a separate product
   * decision, not a side effect of the id-format change.
   */
  requireEmailVerificationOnInvitation?: boolean;
};

/**
 * Build the admin plugin with cinatra's behavioral defaults. The plugin's
 * schema is option-independent — `allowImpersonatingAdmins` is behavior-only.
 * Wrapped so the return type is `ReturnType<typeof buildCinatraAdminPlugin>`
 * (precisely typed) instead of `ReturnType<typeof adminPlugin>` (generic).
 */
export function buildCinatraAdminPlugin(opts: CinatraAdminPluginOptions = {}) {
  return adminPlugin({
    allowImpersonatingAdmins: opts.allowImpersonatingAdmins ?? false,
  });
}

/**
 * Build the organization plugin with cinatra's shared schema-bearing options
 * (`teams` + `team.slug` additionalField) spread in. Behavioral runtime hooks
 * are layered on top. Wrapped so the return type captures cinatra's exact
 * options literal, preserving the `team.slug` inference Better Auth derives
 * from the `schema.team.additionalFields` object.
 */
export function buildCinatraOrganizationPlugin(
  opts: CinatraOrganizationPluginOptions = {},
) {
  return organization({
    ...cinatraOrganizationOptions,
    ...(opts.allowUserToCreateOrganization
      ? { allowUserToCreateOrganization: opts.allowUserToCreateOrganization }
      : {}),
    ...(opts.organizationHooks
      ? { organizationHooks: opts.organizationHooks }
      : {}),
    ...(opts.sendInvitationEmail
      ? { sendInvitationEmail: opts.sendInvitationEmail }
      : {}),
    requireEmailVerificationOnInvitation:
      opts.requireEmailVerificationOnInvitation ?? false,
  });
}

/**
 * Shape of the Cinatra-owned plugin tuple Better Auth sees, BEFORE the
 * runtime adds `nextCookies()`. The migration uses this shape directly.
 *
 * Order is load-bearing — Better Auth's `$Infer` is derived from the static
 * type of the array literal, so swapping order silently changes the inferred
 * shape. Keep additions append-only.
 */
export type CinatraBetterAuthPlugins = [
  ReturnType<typeof username>,
  ReturnType<typeof twoFactor>,
  ReturnType<typeof buildCinatraAdminPlugin>,
  ReturnType<typeof buildCinatraOrganizationPlugin>,
  ...McpAuthPlugins,
];

export type BuildCinatraBetterAuthPluginsOptions = {
  admin?: CinatraAdminPluginOptions;
  organization?: CinatraOrganizationPluginOptions;
  /**
   * The pre-built MCP auth pair — `[jwt(), oauthProvider({...})]`. Built
   * by the caller so behavioral inputs (validAudiences from
   * `getPublicMcpServerUrl()`, page paths, scopes, TTLs) stay at the
   * caller's I/O boundary. The runtime calls
   * `createMcpServerAuthPlugins({...})`; the migration calls
   * `buildMcpAuthPlugins({validAudiences: [<placeholder>], ...})`.
   */
  mcpAuthPlugins: McpAuthPlugins;
};

/**
 * The single source of truth for the Cinatra Better Auth plugin tuple.
 *
 * Both `src/lib/auth.ts` (runtime) and `scripts/better-auth-migrate.mts`
 * (bootstrap migration) consume this — any plugin add / remove / reorder
 * shows up in both places at once. Schema-bearing data lives in
 * `./better-auth-schema`; behavioral inputs are injected.
 */
export function buildCinatraBetterAuthPlugins(
  opts: BuildCinatraBetterAuthPluginsOptions,
): CinatraBetterAuthPlugins {
  return [
    username(),
    twoFactor(),
    buildCinatraAdminPlugin(opts.admin),
    buildCinatraOrganizationPlugin(opts.organization),
    ...opts.mcpAuthPlugins,
  ];
}
