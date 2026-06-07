// ---------------------------------------------------------------------------
// resolveActorIdentity
//
// Pure function composing three identity sources in priority order so the MCP
// transport handler can populate mcpRequestContextStorage.userId for cookieless
// requests (Claude Code on localhost, tunneled service-accounts) without losing
// the existing cookie-session regression.
//
// Priority:
//   1. cookie session     (sessionUser?.id)                       — existing
//   2. Bearer JWT clientId → service_accounts.created_by
//   3. localhost dev fallback (A2A_DEV_BYPASS + isLocalhost)
//      → SELECT id FROM public."user" WHERE role='admin'
//        ORDER BY "createdAt" ASC LIMIT 1                         — new
//
// Mirrors the existing resolvedOrgId fallback at index.tsx ~973-980 exactly.
// All DB reads are non-fatal: any error → fall through to null and let
// downstream authz deny.
// ---------------------------------------------------------------------------

import type { ServiceAccountActorIdentity } from "./service-accounts";

export type ActorIdentityPool = {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type ResolveActorIdentityInput = {
  /** Session user from `auth.api.getSession({ headers })`, or undefined when no cookie. */
  sessionUser: { id?: string | null } | undefined;
  /** Decoded JWT clientId from `decodeJwtClientId(authHeader)`, or undefined. */
  requestClientId: string | undefined;
  /** The incoming Request (used only for env/isLocalhost decisions by the caller). */
  request: Request;
  /** Subset of process.env passed in for testability. */
  env: { A2A_DEV_BYPASS?: string };
  /** Result of `isLocalhostRequest(request)` — passed in to keep this module pure. */
  isLocalhost: boolean;
  /** Service-account lookup. Defaults to readServiceAccountByClientId. */
  readServiceAccount: (
    clientId: string,
  ) => Promise<ServiceAccountActorIdentity | null>;
  /** DB pool for the first-admin localhost fallback (betterAuthPool in prod). */
  pool: ActorIdentityPool;
};

/**
 * Resolve the userId to attach to mcpRequestContextStorage. Returns null when
 * no source yields a usable id — caller must then leave userId null and let
 * downstream authz deny per the existing contract.
 */
export async function resolveActorIdentity(
  input: ResolveActorIdentityInput,
): Promise<string | null> {
  const { sessionUser, requestClientId, env, isLocalhost, readServiceAccount, pool } = input;

  // 1. Cookie session wins if present (regression preserved).
  if (sessionUser?.id) return sessionUser.id;

  // 2. Bearer-token / service-account path.
  if (requestClientId) {
    const account = await readServiceAccount(requestClientId);
    if (account?.userId) return account.userId;
  }

  // 3. Localhost dev fallback — gated on BOTH A2A_DEV_BYPASS=true AND
  //    isLocalhostRequest(request). Mirrors resolvedOrgId fallback shape.
  if (env.A2A_DEV_BYPASS === "true" && isLocalhost) {
    try {
      const result = await pool.query<{ id: string }>(
        'SELECT id FROM public."user" WHERE role = \'admin\' ORDER BY "createdAt" ASC LIMIT 1',
      );
      const id = result.rows[0]?.id;
      if (id) return id;
    } catch (error) {
      // non-fatal — fall through to null. Logged so operators can diagnose
      // dev-mode regressions when the localhost-admin lookup fails.
      console.warn("[actor-identity] localhost-admin lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}
