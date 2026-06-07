// ---------------------------------------------------------------------------
// @cinatra-ai/notifications/host-adapters — THE TRUE LEAF.
//
// This module imports NOTHING from the package server graph
// (service/realtime/recipient-policy/request-actor, no ./server), has NO
// `@/` imports, NO `server-only`, and ZERO runtime dependencies. It exists
// so the boot-reachable host wiring (src/lib/notifications-host.ts) can
// import the setter from here WITHOUT transitively pulling the package
// server modules onto the Next.js boot graph.
//
// It contains ONLY:
//   - the NotificationsHostAdapters contract (explicit host surface),
//   - a package-local STRUCTURAL BetterAuthSessionLike type,
//   - a package-local FULL ActorContext shape,
//   - a module-singleton holder + idempotent setter + internal getter.
// ---------------------------------------------------------------------------

/**
 * Structural copy of `src/lib/authz/enforce.ts:38` BetterAuthSessionLike —
 * the real `@/lib/auth-session` session returned by `getAuthSession()` is
 * structurally assignable to this type, so the host's lazy wrapper
 * `async () => (await import("@/lib/auth-session")).getAuthSession()` typed
 * as `Promise<BetterAuthSessionLike | null>` compiles with NO host
 * auth/session type import in this leaf.
 */
export type BetterAuthSessionLike = {
  user: { id: string; role?: string | null };
  session: { activeOrganizationId?: string | null };
};

/**
 * Discriminated union — field-for-field copy of host
 * `src/lib/authz/actor-context.ts:26`.
 */
export type Principal =
  | { principalType: "HumanUser"; principalId: string }
  | { principalType: "ServiceAccount"; principalId: string; ownerOrgId?: string }
  | { principalType: "ExternalA2AAgent"; principalId: string; agentId?: string }
  | { principalType: "InternalWorker"; principalId: string }
  | { principalType: "System"; principalId: string };

/**
 * Package-local ActorContext — a FULL field-for-field copy of host
 * `src/lib/authz/actor-context.ts:41` (NOT a minimal subset; assignability
 * is package->host so the package type must carry EVERY field incl. the
 * required `authSource` and `policyVersion` and the `Principal` union).
 *
 * Drift-guarded by the bidirectional compile-time assertion in
 * src/lib/notifications-host.ts; host @/lib/authz/actor-context remains the
 * source of truth.
 */
export type ActorContext = Principal & {
  organizationId?: string;
  teamIds?: string[];
  projectIds?: string[];
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
  authSource: "ui" | "worker" | "mcp" | "a2a" | "agent";
  runAsUserId?: string;
  delegatedBy?: string;
  tokenScopes?: string[];
  policyVersion: string;
};

/**
 * The EXPLICIT host surface the package needs (NOT a generic god-port).
 * The host (src/lib/notifications-host.ts) supplies these and
 * the moved server modules call them through `getNotificationsHostAdapters()`.
 *
 * - `getPostgresConnectionString` / `ensurePostgresSchema` / `postgresSchema`
 *   are the three `@/lib/database` symbols service.ts / recipient-policy.ts /
 *   realtime.ts use. `postgresSchema` is the injected replacement for the
 *   `process.env.SUPABASE_SCHEMA` read at recipient-policy.ts:133
 *   (that line is an ENV READ, not just an import).
 * - `runPostgresQueriesSync` is the `@/lib/postgres-sync` symbol.
 * - `getAuthSession` / `buildActorContext` are ASYNC wrappers so the host
 *   can dynamic-import @/lib/auth-session / @/lib/authz/enforce LAZILY
 *   (the @/lib/auth top-level-await
 *   Google-OAuth chain must stay OFF the boot graph). request-actor.ts
 *   awaits them. The host's lazy wrapper returns the REAL Better Auth
 *   session which is structurally assignable to `BetterAuthSessionLike` —
 *   no host type import needed anywhere in the package.
 */
export type NotificationsHostAdapters = {
  getPostgresConnectionString: () => string;
  ensurePostgresSchema: () => void;
  postgresSchema: string;
  runPostgresQueriesSync: (input: {
    connectionString: string;
    queries: Array<{ text: string; values?: unknown[] }>;
  }) => Array<{ rows?: Array<Record<string, unknown>> }>;
  getAuthSession: () => Promise<BetterAuthSessionLike | null>;
  buildActorContext: (
    session: BetterAuthSessionLike,
  ) => Promise<ActorContext>;
};

let adapters: NotificationsHostAdapters | undefined;

/**
 * Register the host adapters. IDEMPOTENT — calling twice with an equivalent
 * adapter is harmless; required because multiple entry paths (the facade,
 * the stream route, AND the BullMQ worker path via background-jobs.ts) each
 * side-effect-register before their first `/server` use.
 */
export function setNotificationsHostAdapters(
  a: NotificationsHostAdapters,
): void {
  adapters = a;
}

/**
 * Internal getter the moved server modules call. Throws a clear error if the
 * host never wired the adapters (a missing top-level
 * `@/lib/notifications-host` side-effect import on some entry path).
 */
export function getNotificationsHostAdapters(): NotificationsHostAdapters {
  if (!adapters) {
    throw new Error(
      "notifications host adapters not set — import \"@/lib/notifications-host\" " +
        "for its registration side-effect before using @cinatra-ai/notifications/server.",
    );
  }
  return adapters;
}
