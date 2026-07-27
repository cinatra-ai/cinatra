// ---------------------------------------------------------------------------
// Org-write authority FORWARD plumbing (extracted from index.tsx,
// cinatra#1939 S3 wave 2 file-size ratchet).
// ---------------------------------------------------------------------------
//
// The transport mounts two host-side mint callbacks on
// CreateMcpServerMountOptions (via the OrgWriteAuthorityForwardOptions
// intersection) and, once per request, resolves the frame's org-write
// authority by caller class through `resolveFrameOrgWriteAuthority`. The
// resolved value is carried OPAQUELY on the request store
// (`orgWriteAuthority: unknown`); this package never inspects it. Moved
// verbatim from packages/mcp-server/src/index.tsx.
// ---------------------------------------------------------------------------
import { shouldMintSessionOrgWriteAuthority } from "./request-context";
import type { DelegatedMcpActor } from "./request-context";

export type OrgWriteAuthorityForwardOptions = {
  /**
   * Host-side session mint for the org-write authority (cinatra#1939 S3).
   * Called at most once per request, AFTER the full identity chain has
   * settled and ONLY when `shouldMintSessionOrgWriteAuthority` admits the
   * caller (cookie session or chat-OBO with a resolved membership role — an
   * agent-run delegation is grounded in the RUN and gets its authority from
   * the host run verifier instead). The returned value is carried OPAQUELY
   * on the request store (`orgWriteAuthority`); this package never inspects
   * it. Optional — omitting it leaves every frame unstamped and org-write
   * seam writers fail closed.
   */
  mintOrgWriteAuthority?: (input: {
    userId: string;
    orgId: string;
    orgRole: "org_owner" | "org_admin" | "member";
  }) => unknown;
  /**
   * Host-side RUN mint for the org-write authority (cinatra#1939 S3) — the
   * agent-run counterpart of `mintOrgWriteAuthority`. Called ONLY for an
   * `agent_run` delegation whose token carried the `att` (execution attempt)
   * claim; the host implementation verifies the triple against the run row
   * (live-attempt predicate, claimed-vs-current attempt match) and returns
   * the authority or undefined. A rejected promise reads as undefined — the
   * frame stays unstamped, never a transport failure.
   */
  mintRunOrgWriteAuthority?: (input: {
    runId: string;
    orgId: string;
    executionAttemptId: string;
  }) => Promise<unknown>;
};

/**
 * Resolve the org-write authority for one request frame (cinatra#1939 S3), by
 * caller class:
 *   - agent_run delegation → the RUN mint (host verifies the token's
 *     `att` triple against the run row's live attempt); no `att` claim or
 *     no wired mint → unstamped. A rejected mint promise also reads as
 *     unstamped — never a transport failure.
 *   - session / chat-OBO → the membership mint, gated by
 *     `shouldMintSessionOrgWriteAuthority` (which is what excludes the
 *     run/widget delegations from THAT branch).
 * Either way, absence just means seam writers refuse — fail-closed.
 */
export async function resolveFrameOrgWriteAuthority(params: {
  delegatedActor: DelegatedMcpActor | null | undefined;
  options: OrgWriteAuthorityForwardOptions;
  resolvedUserId: string | null | undefined;
  resolvedOrgId: string | null | undefined;
  resolvedOrgRole: "org_owner" | "org_admin" | "member" | undefined;
}): Promise<unknown> {
  const { delegatedActor, options, resolvedUserId, resolvedOrgId, resolvedOrgRole } = params;
  if (delegatedActor?.delegation === "agent_run") {
    if (!options.mintRunOrgWriteAuthority || !delegatedActor.executionAttemptId) {
      return undefined;
    }
    try {
      return await options.mintRunOrgWriteAuthority({
        runId: delegatedActor.runId,
        orgId: delegatedActor.orgId,
        executionAttemptId: delegatedActor.executionAttemptId,
      });
    } catch (error) {
      console.warn("[mcp-server] run org-write mint rejected — frame stays unstamped", {
        runId: delegatedActor.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  if (
    options.mintOrgWriteAuthority &&
    resolvedUserId &&
    resolvedOrgId &&
    resolvedOrgRole &&
    shouldMintSessionOrgWriteAuthority({
      delegatedActor,
      userId: resolvedUserId,
      orgId: resolvedOrgId,
      orgRole: resolvedOrgRole,
    })
  ) {
    return options.mintOrgWriteAuthority({
      userId: resolvedUserId,
      orgId: resolvedOrgId,
      orgRole: resolvedOrgRole,
    });
  }
  return undefined;
}
