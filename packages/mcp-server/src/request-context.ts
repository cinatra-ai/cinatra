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
 * - `public_site_widget`: an authenticated end user driving the S5
 *   WordPress/Drupal public-site widget through `/api/assistants/chat`. The
 *   transport maps this to a dedicated CLOSED, kind-keyed `delegated-widget`
 *   tool policy (NOT the broad chat allowlist) that caps the token to the one
 *   CMS-edit primitive for its bound `kind`. `platformRole` is union-narrowed
 *   to `"member"` (NEVER `platform_admin`): the widget OBO token omits the role
 *   claim and the verifier hard-codes `member`, so the platform-admin
 *   immediate-allow can't trigger for a widget delegation. `instanceId` is the
 *   SERVER-DERIVED canonical row (verified-origin re-pin) the boundary asserts
 *   the tool-arg instance against. (Transport wiring — verifier + tool policy
 *   + `jti` turn-binding — lands in a later S5 wave; this branch is the type
 *   contract they build against.)
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
    }
  | {
      delegation: "public_site_widget";
      /** The authenticated end user (cwu_ claim). */
      userId: string;
      /** The end user's org — REQUIRED (the widget path is org-scoped). */
      orgId: string;
      /**
       * The SERVER-DERIVED canonical instance id (the verified-origin re-pin).
       * The boundary asserts the model-supplied `*_content_editor_run`
       * `instanceId` arg equals THIS value (fail-closed `instance_pin_mismatch`),
       * re-imposing the OLD route's origin pin across the model-chosen-instance
       * seam. Never a forgeable body/tool field.
       */
      instanceId: string;
      /**
       * The connector KIND (from the token's `knd` claim). Binds the token to
       * its editor primitive — a `wordpress` widget token can never drive a
       * `drupal_content_editor_run` and vice versa.
       */
      kind: "wordpress" | "drupal";
      /**
       * Per-turn nonce (the token's `jti`). The transport records it against the
       * active thread/turn so the token cannot be replayed on a DIFFERENT
       * turn/thread; the token's short TTL bounds the residual window.
       */
      jti: string;
      /**
       * ALWAYS `"member"` — union-narrowed, NEVER `platform_admin`. The widget
       * OBO token omits the role claim and the verifier hard-codes `member`, so
       * the platform-admin immediate-allow at the boundary is un-triggerable for
       * a widget delegation (the platform-admin suppression, imposed at mint).
       */
      platformRole: "member";
    };

/**
 * Fail-closed tool-policy dispatch over the VERIFIED delegation type. The
 * `public_site_widget` actor maps to the CLOSED, kind-keyed `delegated-widget`
 * policy and NEVER falls through to "unrestricted"; `chat` maps to the narrow
 * chat allowlist; `agent_run` / no delegation stay unrestricted at registration
 * (per-handler authz + `enforceMcpBoundary` still gate mutations).
 * `widgetDelegationKind` is the VERIFIED `knd` (never caller input) and is
 * undefined for every non-widget mode.
 */
export function selectDelegatedToolPolicy(
  delegatedActor: DelegatedMcpActor | null | undefined,
): {
  toolPolicyMode: "unrestricted" | "delegated-chat" | "delegated-widget";
  widgetDelegationKind: "wordpress" | "drupal" | undefined;
} {
  if (delegatedActor?.delegation === "chat") {
    return { toolPolicyMode: "delegated-chat", widgetDelegationKind: undefined };
  }
  if (delegatedActor?.delegation === "public_site_widget") {
    return { toolPolicyMode: "delegated-widget", widgetDelegationKind: delegatedActor.kind };
  }
  return { toolPolicyMode: "unrestricted", widgetDelegationKind: undefined };
}

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
  /**
   * A run id VERIFIED by a trusted server-side run-bound seam (e.g.
   * `/api/agents/passthrough` after `bindBridgeRunId` proves the executing run
   * from the auth-injected context-id). Run-scoped primitives read THIS — never
   * the ambient `runId` above, which the transport also fills from the
   * caller-controlled `x-cinatra-run-id` header (a legacy/forgeable channel while
   * the #1195 fail-closed cutover is off). The transport NEVER writes this field
   * from any request input; only in-process seam code that has itself verified
   * the run may set it. Undefined for every ordinary request. (An OBO
   * `delegation:"agent_run"` actor is the OTHER verified run source — its runId
   * is a signed token claim — so a run-scoped primitive trusts that too.)
   */
  verifiedRunScopeId?: string;
  /**
   * A per-gate-resume submission id VERIFIED by a trusted server-side run-bound
   * seam (eng#548 #1625). Stamped ONLY alongside `verifiedRunScopeId` by the
   * same seam (`/api/agents/passthrough` after `bindBridgeRunId`), read
   * server-side from the context-id-bound run row's `a2aTaskId` (a fresh task id
   * per WayFlow input-required interrupt — distinct per gate re-entry, stable per
   * transport retry of the same resume). The run-scoped test-delivery send
   * primitive reads THIS as the `(run_id, submission_id)` ledger dedupe identity
   * — never a caller-supplied value. The transport NEVER writes this field from
   * request input; undefined for every ordinary request.
   */
  verifiedSubmissionId?: string;
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
// Run-context precedence for one MCP request (#1195).
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
//
// FAIL-CLOSED CUTOVER DENIAL (`failClosed`, dormant until the flip slice):
// once the durable path dominates, the legacy registry + header channels are
// retired. `failClosed` is the verified core of that retirement — when set, a
// run id that ONLY a legacy channel could supply is REFUSED (`denied` + the
// `deniedChannel`), never tagged via the forgeable key. Verified channels
// (obo/durable) are untouched. It is left OFF in production wiring: the
// enforcement point that turns `denied` into a rejected run-scoped write, and
// the switch that activates it, land TOGETHER in the owner-gated registry-
// removal slice, which only runs once evaluateRegistryCutoverReadiness
// (agent-run-context-durable.ts) reports the served-by metric has proven no
// production traffic still rides the registry. Dropping the run id WITHOUT a
// paired enforcement point would be fail-OPEN (an unattributed run-scoped
// write, worse than a denied one), so the two are never split.
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

/** The two legacy/forgeable run-id channels (in-process registry + the raw
 *  x-cinatra-* headers). obo and durable are the VERIFIED channels. */
export type LegacyRunContextChannel = "registry" | "header";

export type ResolvedRequestRunContext = {
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
  /** Which channel supplied the run id (the cutover metric dimension). */
  servedBy: RunContextServedBy;
  /** True when a durable "invalid" outcome suppressed the legacy channels. */
  suppressed: boolean;
  /**
   * True when `failClosed` REFUSED a run id that only a legacy/forgeable
   * channel could supply (#1195 fail-closed cutover posture). The run id and
   * legacy provenance are dropped and `servedBy` collapses to "none"; a
   * verified channel (obo / durable) is NEVER denied. Always false when
   * `failClosed` is not set (the transition default). Distinct from
   * `suppressed`: suppression is the durable-"invalid" self-defense that fires
   * regardless of the flag; denial is the deliberate cutover refusal of the
   * weak channels — an enforcement point must treat `denied` (not merely a
   * missing run id) as the signal to reject a run-scoped write before it
   * persists (see the module note on the flip slice).
   */
  denied: boolean;
  /** The legacy channel whose run id was fail-closed-refused, if any. */
  deniedChannel?: LegacyRunContextChannel;
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
  /**
   * Fail-closed cutover control (#1195). When true, a run id that would be
   * served ONLY by a legacy/forgeable channel (registry or header — i.e. no
   * verified obo/durable id is available) is REFUSED rather than tagged:
   * the run id and all legacy provenance are dropped, `servedBy` becomes
   * "none", and `denied`/`deniedChannel` report the refusal. Verified
   * channels are never affected. DEFAULT (unset / false) is byte-identical to
   * the transition behavior. This is the verified core of the deny posture;
   * production wiring keeps it OFF until the registry-removal (flip) slice
   * lands the enforcement + activation together, gated on the served-by
   * cutover metric proving no production traffic still rides the registry
   * (see evaluateRegistryCutoverReadiness).
   */
  failClosed?: boolean;
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

  // A verified run id (signed OBO token, or the durable binding resolved
  // through the run row) is authoritative and is NEVER fail-closed-denied.
  // An empty string is NOT a run identity: normalize it to absent so a
  // degenerate "" verified id can neither win the run id nor (its real
  // hazard) suppress the fail-closed refusal of a genuine legacy channel.
  const nonEmpty = (v: string | undefined): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const verifiedRunId =
    nonEmpty(input.delegatedRunId) ?? nonEmpty(durableCtx?.runId);

  // The legacy channel that WOULD supply the run id when no verified id exists.
  const legacyChannel: LegacyRunContextChannel | undefined = registryCtx?.runId
    ? "registry"
    : headerRunId
      ? "header"
      : undefined;

  // Fail-closed refusal applies ONLY to a legacy-only run id. It is orthogonal
  // to `suppressed`: when a durable "invalid" already dropped the legacy
  // channels, `legacyChannel` is undefined here, so `denied` stays false.
  const denied =
    input.failClosed === true &&
    verifiedRunId === undefined &&
    legacyChannel !== undefined;
  const deniedChannel = denied ? legacyChannel : undefined;

  // Under denial the legacy channels are dropped as a UNIT (run id +
  // provenance), exactly like suppression — never a partial downgrade.
  const effRegistryCtx = denied ? undefined : registryCtx;
  const effHeaderRunId = denied ? undefined : headerRunId;
  const effHeaderAgentId = denied ? undefined : headerAgentId;
  const effHeaderPackageVersion = denied ? undefined : headerPackageVersion;
  const effHeaderAgentSpecVersion = denied ? undefined : headerAgentSpecVersion;

  const legacyRunId = effRegistryCtx?.runId ?? effHeaderRunId;
  const runId = verifiedRunId ?? legacyRunId;

  const servedBy: RunContextServedBy = input.delegatedRunId
    ? "obo"
    : durableCtx?.runId
      ? "durable"
      : effRegistryCtx?.runId
        ? "registry"
        : effHeaderRunId
          ? "header"
          : "none";

  return {
    runId,
    agentId: durableCtx?.agentId ?? effRegistryCtx?.agentId ?? effHeaderAgentId,
    packageVersion:
      durableCtx?.packageVersion ??
      effRegistryCtx?.packageVersion ??
      effHeaderPackageVersion,
    agentSpecVersion:
      durableCtx?.agentSpecVersion ??
      effRegistryCtx?.agentSpecVersion ??
      effHeaderAgentSpecVersion,
    servedBy,
    suppressed,
    denied,
    deniedChannel,
  };
}
