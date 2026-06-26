import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Discriminated union of the two delegated MCP actor flavors.
 *
 * - `chat`: a human chat user calling via OpenAI's hosted MCP relay. The
 *   transport applies the chat tool-policy allowlist
 *   (`isDelegatedChatMcpToolAllowed`) — read + discovery + dispatch only.
 * - `agent_run`: an agent dispatched by the chat, running its work via the
 *   bridge → orchestration → cinatra-mcp tool. The transport leaves the
 *   tool policy UNRESTRICTED because the dispatched agent's job is to
 *   perform REAL operations (the dispatcher's design intent). Per-handler
 *   authz still gates mutations.
 *
 * Existing callers that only read `userId`, `orgId`, `platformRole` are
 * union-compatible; discriminating callsites must check `actor.delegation`.
 */
export type DelegatedMcpActor =
  | {
      delegation: "chat";
      userId: string;
      orgId: string | null;
      platformRole: "platform_admin" | "member";
    }
  | {
      delegation: "agent_run";
      userId: string;
      orgId: string;
      runId: string;
      platformRole: "platform_admin" | "member";
    };

/**
 * Read by tool registries (e.g. chat registry, objects layer) to build the actor
 * context. Includes `runId`, `agentId`, `packageVersion`, and `agentSpecVersion`
 * so the objects layer's `getActorExt` can stamp full agent run-context
 * provenance on every saved object. The values are forwarded by `/api/llm-bridge`
 * as `X-Cinatra-*` headers and extracted in the transport handler (see index.tsx).
 */
export type McpRequestContext = {
  clientId?: string;
  orgId?: string | null;
  userId?: string | null;
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
  /**
   * Derived from the better-auth session role at the transport boundary.
   * When `"platform_admin"`, agent-side registries stamp the
   * platform_admin hint on the actor envelope so admin-gated handlers can
   * authorise the call without re-reading cookies. Set to `"member"` when a
   * session is present but the user is not admin; left undefined for
   * cookieless transports (Bearer-only Claude Code, A2A) — those continue
   * to fall back to the existing session lookup, which returns null in
   * those contexts and correctly denies elevation.
   */
  platformRole?: "platform_admin" | "member";
  /**
   * The caller's role in the active organization (`orgId` above), resolved
   * ONCE at transport context-build time from the better-auth membership row
   * for the (resolved orgId, resolved userId) pair — owner → `"org_owner"`,
   * admin → `"org_admin"`, member → `"member"` (same mapping as
   * `cachedResolveOrgRole` in src/lib/auth-session.ts). Left undefined when
   * either id is missing, the membership row does not exist, or the lookup
   * fails — downstream gates keep their existing on-demand
   * `resolveOrgRoleForUser` fallback, so absence never widens access.
   *
   * Trust boundary: only the transport handler writes this field, after the
   * request has been authenticated (cookie session, delegated OBO token, or
   * dev-bypass identity). Coherent with `orgId`/`userId` in the same store
   * frame by construction; consumers must not pair it with an orgId from any
   * other source.
   */
  orgRole?: "org_owner" | "org_admin" | "member";
  /**
   * Set when the request authenticated via a chat-delegated on-behalf-of token.
   * `delegatedRestricted` gates the call-time tool guard
   * in `createMcpRuntimeServer` (defense-in-depth on top of registration-time
   * filtering). `delegatedActor` carries the resolved human chat user.
   */
  delegatedActor?: DelegatedMcpActor | null;
  delegatedRestricted?: boolean;
  /**
   * A2A actor context injected by src/app/api/a2a/route.ts after
   * `verifyA2AAccessToken` succeeds. Trust boundary: only the A2A route
   * handler may write this field (see auth-policy.ts:15 trust-boundary note).
   * When present, registry.ts builds actorType:"a2a" with the scopes/teams/projects
   * from the originating user's verified token, not the bot's model identity.
   */
  a2aActorContext?: {
    userId?: string;
    orgId?: string | null;
    tokenScopes?: string[];
    teamIds?: string[];
    projectIds?: string[];
    // Propagate the canonical project-grant axis alongside the binary
    // `projectIds`. Carrier shape includes grants so every forwarder
    // (packages/agents/src/mcp/registry.ts, src/lib/artifacts/mcp.ts) sees and
    // can forward them; `projectIds` stays for back-compat consumers
    // (auth-policy.ts binary shortcuts at :198 / :490-491). Trust boundary:
    // both fields are ONLY written by src/app/api/a2a/route.ts after
    // verifyA2AAccessToken succeeds.
    projectGrants?: Array<{
      projectId: string;
      effectiveRole: "read" | "write" | "admin" | "owner";
      accessSource: "owner" | "user" | "team" | "organization" | "workspace";
    }>;
    clientId?: string;
  } | null;
  /**
   * Project inheritance frame for the lifetime of a single MCP call OR an
   * agent run. Two distinct producers:
   *
   *   1. Transport-boundary set: the chat surface attaches `projectId` for
   *      a chat-driven invocation BEFORE the request hits `agent_run`. The
   *      MCP `agent_run` handler reads this to populate
   *      `CreateAgentRunInput.projectId` so the run row is tagged at insert.
   *
   *   2. Run-worker entry set: `runAgentBuilderExecutionJob` reads
   *      `run.projectId` from the DB row and wraps the execution body in
   *      `mcpRequestContextStorage.run({ ..., projectContext: { projectId } })`.
   *      Every artifact/object write inside the run reads this frame and
   *      inherits the projectId on its row; substrate-excluded types stay NULL.
   *
   * `null` projectId means an ambient (non-project) execution — writes do
   * NOT auto-tag.
   */
  projectContext?: { projectId: string | null };
};

/**
 * The canonical MCP request-context AsyncLocalStorage. Public consumers import
 * this from the package facade (`@cinatra-ai/mcp-server`); package-internal
 * files import it relatively from THIS module (the same backing instance — no
 * `Symbol.for` global, no duplicate ALS). The transport boundary in index.tsx
 * is the only writer of an authenticated frame; downstream registries read it.
 */
export const mcpRequestContextStorage = new AsyncLocalStorage<McpRequestContext>();
