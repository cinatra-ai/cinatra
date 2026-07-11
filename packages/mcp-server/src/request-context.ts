import { AsyncLocalStorage } from "node:async_hooks";
import type { OboCeilingChain } from "./obo-ceiling";

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
      /**
       * The agent's anchored scope-ceiling CHAIN, minted into the OBO token and
       * re-derived + validated (containment) at mint. Carried here so the
       * transport can stamp it onto the request frame; no surface enforces it
       * yet. Always present on a valid agent-run token — a missing chain fails
       * closed at the verifier (never reconstructs this actor).
       */
      oboCeiling: OboCeilingChain;
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
  /**
   * The agent-run OBO scope-ceiling chain for this frame, forwarded from the
   * delegated `agent_run` actor (the signed token claim). Present only for
   * agent-run-OBO delegations; undefined for chat / session / machine callers.
   * Carried so the boundary can read it; no surface enforces it yet.
   */
  oboCeiling?: OboCeilingChain;
};

/**
 * The canonical MCP request-context AsyncLocalStorage. Public consumers import
 * this from the package facade (`@cinatra-ai/mcp-server`); package-internal
 * files import it relatively from THIS module (the same backing instance — no
 * `Symbol.for` global, no duplicate ALS). The transport boundary in index.tsx
 * is the only writer of an authenticated frame; downstream registries read it.
 */
export const mcpRequestContextStorage = new AsyncLocalStorage<McpRequestContext>();

// ---------------------------------------------------------------------------
// Run-context precedence for one MCP request (#1195, first slice).
//
// Pure and synchronous so the contract is directly unit-testable; the MCP
// transport handler (index.tsx) resolves the durable binding ONCE per request
// (an immutable result — no second read may race the first) and feeds every
// channel in here. Lives in THIS module (the request-context frame it fills)
// rather than a new file so the locked route graphs don't grow (route-graph
// ratchet): request-context.ts is already reachable wherever index.tsx is.
//
// Channel precedence for the run id:
//   1. "obo"      — a delegated agent-run OBO token (signed at mint; carries
//                   the run id). Independent of redis state: it survives a
//                   durable "invalid" outcome.
//   2. "durable"  — the durable binding resolved through the run row
//                   (readAgentRunByTokenHash) — verified run identity.
//   3. "registry" — the legacy in-process registry (transition fallback,
//                   consulted ONLY when the durable outcome is "absent").
//   4. "header"   — the legacy x-cinatra-* headers (last resort, same gate).
//
// FAIL-CLOSED SUPPRESSION: a durable outcome of "invalid" (present-but-
// malformed value, token-miss, or verification error after a binding was
// found) suppresses the registry AND header channels entirely — the run id
// AND every provenance field. A positive stale/corrupt-credential signal is
// never downgraded into weaker, forgeable channels. Provenance metadata
// (agentId / packageVersion / agentSpecVersion) is UNTRUSTED tagging input
// on every channel — never an authorization input.
// ---------------------------------------------------------------------------

export type DurableRunContextResolution =
  | {
      outcome: "resolved";
      ctx: {
        runId: string;
        agentId?: string;
        packageVersion?: string;
        agentSpecVersion?: string;
      };
    }
  | { outcome: "invalid" }
  | { outcome: "absent" };

export type RunContextServedBy =
  | "obo"
  | "durable"
  | "registry"
  | "header"
  | "none";

export type RegistryRunContext = {
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
};

export type ResolvedRequestRunContext = {
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
  /** Which channel supplied the run id (the cutover metric dimension). */
  servedBy: RunContextServedBy;
  /** True when a durable "invalid" outcome suppressed the legacy channels. */
  suppressed: boolean;
};

export function resolveRequestRunContext(input: {
  /** delegatedActor.runId when delegation === "agent_run"; else undefined. */
  delegatedRunId?: string;
  /** The ONE per-request durable resolution (undefined when not consulted —
   *  e.g. a delegated request or no bearer). */
  durable?: DurableRunContextResolution;
  registryCtx?: RegistryRunContext;
  headerRunId?: string;
  headerAgentId?: string;
  headerPackageVersion?: string;
  headerAgentSpecVersion?: string;
}): ResolvedRequestRunContext {
  const suppressed = input.durable?.outcome === "invalid";
  const durableCtx =
    input.durable?.outcome === "resolved" ? input.durable.ctx : undefined;

  // Legacy channels are gated by suppression as a UNIT (run id + provenance).
  const registryCtx = suppressed ? undefined : input.registryCtx;
  const headerRunId = suppressed ? undefined : input.headerRunId;
  const headerAgentId = suppressed ? undefined : input.headerAgentId;
  const headerPackageVersion = suppressed
    ? undefined
    : input.headerPackageVersion;
  const headerAgentSpecVersion = suppressed
    ? undefined
    : input.headerAgentSpecVersion;

  const legacyRunId = registryCtx?.runId ?? headerRunId;
  const runId = input.delegatedRunId ?? durableCtx?.runId ?? legacyRunId;

  const servedBy: RunContextServedBy = input.delegatedRunId
    ? "obo"
    : durableCtx?.runId
      ? "durable"
      : registryCtx?.runId
        ? "registry"
        : headerRunId
          ? "header"
          : "none";

  return {
    runId,
    agentId: durableCtx?.agentId ?? registryCtx?.agentId ?? headerAgentId,
    packageVersion:
      durableCtx?.packageVersion ??
      registryCtx?.packageVersion ??
      headerPackageVersion,
    agentSpecVersion:
      durableCtx?.agentSpecVersion ??
      registryCtx?.agentSpecVersion ??
      headerAgentSpecVersion,
    servedBy,
    suppressed,
  };
}
