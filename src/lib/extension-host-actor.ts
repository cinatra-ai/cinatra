import "server-only";

// Cross-invocation actor resolution for the extension host `ctx`.
//
// A connector's `register(ctx)` ports (`settings`, `secrets`, `nango`,
// `objects`, `authSession`, `telemetry`) must resolve the CURRENT actor
// — and its organization — from the TRUSTED request/run context, under EVERY
// invocation path, never from caller-supplied input. The cookie-only
// `getActorContext()` (auth-session) returns `undefined` for MCP/worker/A2A
// traffic, so a connector tool invoked over MCP would see no org. This module
// unifies the three trusted context stores in priority order:
//
//   1. llm `actorContextStorage` — set by `withActorContext()` at the A2A route
//      boundary and across LLM/agent orchestration (worker, A2A, agent runs).
//   2. `mcpRequestContextStorage` — set at the MCP transport boundary; this is
//      where connector-registered MCP tools (`ctx.mcp.registerTool`) execute.
//   3. cookie session (`@/lib/auth-session` `getActorContext()`) — UI / server
//      actions / setup pages.
//
// All three are AsyncLocalStorage-backed (or request-cookie-backed) trusted
// stores; none derive identity from the connector's own input. Returns `null`
// when no actor can be resolved (a genuinely unauthenticated path) — callers
// turn that into a fail-loud "no actor / no organization" error, never a
// silent default.

import type { ActorContext } from "@/lib/authz/actor-context";

export type ExtensionActorSummary = {
  userId: string | null;
  organizationId: string | null;
  orgRole: string | null;
};

/**
 * Resolve the full kernel `ActorContext` for the current invocation, trying
 * each trusted context store in priority order. Returns `null` when none
 * resolve. Every store access is defensively guarded so a context where one
 * store's module is unavailable still falls through to the next.
 */
export async function resolveExtensionActorContext(): Promise<ActorContext | null> {
  return (await resolveTrustedContext()).actor;
}

/**
 * The narrow `{ userId, organizationId, orgRole }` summary the host
 * `authSession` port returns and the scoped ports use for org keying.
 *
 * `userId` is the human SUBJECT on whose behalf the call runs — NOT the acting
 * principal. For a model / delegated / A2A MCP actor the acting principal is a
 * model or service account, but the SAME trusted store still carries the human
 * subject's id; a connector needs THAT for user-owned routing (e.g. selecting
 * the user's sender identity). CRITICAL: the subject id and the org/actor are
 * derived from the SAME store (see `resolveTrustedContext`), so they can never
 * be combined across stores (e.g. a top-level MCP subject paired with an A2A
 * org). Returns `null` for a pure service/system/worker context with no human
 * subject.
 */
export async function resolveExtensionActorSummary(): Promise<ExtensionActorSummary | null> {
  const { actor, subjectUserId } = await resolveTrustedContext();
  if (!actor && !subjectUserId) return null;
  return {
    userId: subjectUserId,
    organizationId: actor?.organizationId ?? null,
    orgRole: actor?.orgRole ?? null,
  };
}

type TrustedResolution = { actor: ActorContext | null; subjectUserId: string | null };

/**
 * Resolve the trusted context ONCE from a SINGLE authoritative store, returning
 * BOTH the acting-principal `ActorContext` and the human-SUBJECT userId derived
 * from the SAME store — so the two are never combined across stores (which would
 * pair, e.g., a top-level MCP subject with an A2A organization). Stores are
 * tried in priority order; the FIRST that resolves wins for BOTH fields.
 */
async function resolveTrustedContext(): Promise<TrustedResolution> {
  // 1. Worker / A2A / LLM-orchestration: the llm actor-context store (sync).
  try {
    const { getActorContext: getLlmActorContext } = await import("@cinatra-ai/llm");
    const a = getLlmActorContext() as ActorContext | undefined;
    if (a) return { actor: a, subjectUserId: subjectUserIdOfActor(a) };
  } catch {
    // @cinatra-ai/llm not loadable in this context — fall through.
  }

  // 2. MCP transport: the request-context store set at the transport boundary.
  try {
    const mcp = await resolveFromMcpRequestContext();
    if (mcp) return mcp;
  } catch {
    // not inside an MCP request — fall through.
  }

  // 3. Cookie session (UI / server actions / setup pages).
  try {
    const { getActorContext } = await import("@/lib/auth-session");
    const a = await getActorContext();
    if (a) return { actor: a, subjectUserId: a.principalType === "HumanUser" ? a.principalId : null };
  } catch {
    // no request/cookie context — fall through.
  }

  return { actor: null, subjectUserId: null };
}

/** The human-subject userId carried by a kernel ActorContext (NOT the acting principal). */
function subjectUserIdOfActor(a: ActorContext): string | null {
  if (a.principalType === "HumanUser") return a.principalId;
  return a.runAsUserId ?? a.delegatedBy ?? null;
}

/**
 * Resolve the actor's organization id from the trusted context, or throw a
 * fail-loud error. Scoped ports (`settings`/`secrets`/`nango`) call this when
 * an org is REQUIRED so a connector can never silently read another tenant's
 * config by reaching a context where the org failed to resolve.
 */
export async function requireExtensionOrganizationId(packageName: string): Promise<string> {
  const summary = await resolveExtensionActorSummary();
  const orgId = summary?.organizationId;
  if (!orgId) {
    throw new Error(
      `[ExtensionHostContext] ${packageName}: an organization-scoped host port was used but ` +
        `no organizationId could be resolved from the trusted request/run context ` +
        `(cookie, MCP, or worker). Refusing to fall back to a global/ambient scope.`,
    );
  }
  return orgId;
}

// ---------------------------------------------------------------------------

async function resolveFromMcpRequestContext(): Promise<TrustedResolution | null> {
  const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server");
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  const { buildActorContextFromPrimitive } = await import("@/lib/authz/build-actor-context");

  // A2A is an AUTHORITATIVE carrier: when present, derive BOTH the principal AND
  // the subject userId STRICTLY from `a2aActorContext` — NEVER mix an A2A
  // identity with the top-level (cookie-session-derived) `userId`/`orgId`. The
  // subject is `a2a.userId ?? null` (an A2A carrier with no user has NO human
  // subject — do NOT borrow the top-level `ctx.userId`, which would pair a
  // top-level subject with the A2A org). Mirrors the host MCP registry's "A2A
  // takes precedence, never partially fall through" convention.
  const a2a = ctx.a2aActorContext;
  if (a2a) {
    const orgId = a2a.orgId ?? null;
    const actor = buildActorContextFromPrimitive(
      {
        actorType: "a2a",
        source: "a2a",
        ...(a2a.userId ? { userId: a2a.userId } : {}),
        ...(a2a.orgId !== undefined ? { orgId: a2a.orgId } : {}),
        ...(a2a.clientId ? { clientId: a2a.clientId } : {}),
        ...(a2a.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
      },
      orgId,
      {},
    ) as ActorContext;
    return { actor, subjectUserId: a2a.userId ?? null };
  }

  // Non-A2A MCP (cookie / delegated model actor): top-level fields are trusted
  // (stamped at the transport boundary). The subject is the top-level `ctx.userId`.
  const userId = ctx.userId ?? undefined;
  const orgId = ctx.orgId ?? null;
  if (!userId && !orgId) return null;
  const actor = buildActorContextFromPrimitive(
    {
      actorType: "model",
      source: "mcp",
      ...(userId ? { userId } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
    },
    orgId,
    { ...(ctx.platformRole ? { platformRole: ctx.platformRole } : {}) },
  ) as ActorContext;
  return { actor, subjectUserId: userId ?? null };
}
