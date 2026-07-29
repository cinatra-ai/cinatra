import "server-only";
/**
 * cinatra#1940 (P3) — the run-creation authority RESOLVER.
 *
 * `createAgentRun` / `createAgentRunPendingInput` are now guarded
 * (`guardedRunWrite`, capability `run.execute`). Most callers already have an
 * unambiguous authority to mint (a session, or a system dispatcher purpose —
 * see `agent-run-authority-mint.ts`). Two callers instead receive an ambient
 * FRAME that may or may not already carry a usable authority:
 *
 *   - the MCP `agent_run` primitive (`mcp/handlers.ts`): the frame's
 *     `orgWriteAuthority` is forwarded from `mcpRequestContextStorage`
 *     (registry.ts) for EVERY primitive, session-backed or agent-OBO;
 *   - the ALS `agent-as-tool` child dispatch (`mcp/agent-tools-registry.ts`):
 *     no `orgWriteAuthority` concept exists on the ALS `ActorContext` at all.
 *
 * This is a RESOLVER, not a minter — it does not import the R2-restricted
 * mint module, and it mints nothing itself; it only decides which
 * already-available authority (if any) a caller should use.
 *
 * Resolution order:
 *   1. A frame-carried authority that is FOR THIS ORG and `can("run.execute")`
 *      — used as-is. A run-bound authority (`VerifiedRunRef`) never satisfies
 *      this: `RUN_CAPABILITIES` (authority.ts) holds only
 *      `"content.write"`/`"run.complete"`, never `"run.execute"` — so an
 *      OBO/run frame authority always falls through to step 2. This is the
 *      free structural win the design calls out: a run can never dispatch
 *      another run by forwarding its own authority.
 *   2. The delegating-principal pattern (the `D-OBO-RESUME` precedent at
 *      `mcp/handlers.ts` — the OBO/agent-as-tool token always carries the
 *      run OWNER's identity): resolve the frame's human-principal userId via
 *      `resolveOrgRoleForUser` → `sessionAuthorityFromResolvedRole`.
 *      Fail-closed for a non-member (the cross-org owner ruling).
 *   3. Neither ⇒ `undefined` — the `guardedRunWrite` seam refuses `"missing"`.
 *
 * Deliberately takes explicit frame hints rather than reading ambient storage
 * itself: each caller already has its own carrier in scope (MCP's
 * `request.actor`, or the ALS `ActorContext`) and passing it explicitly keeps
 * this resolver a pure function, unit-testable without faking
 * AsyncLocalStorage stores.
 */
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";

export interface RunCreationFrameHints {
  /** A frame-carried authority, if the caller's transport already stamped
   *  one (e.g. MCP's `request.actor.orgWriteAuthority`). */
  readonly orgWriteAuthority?: OrgWriteAuthority;
  /** The frame's delegating human principal id (MCP `actor.userId` / ALS
   *  `principalId` for a `HumanUser` principal). Omit when the frame carries
   *  no human identity (e.g. a non-`HumanUser` ALS principal). */
  readonly userId?: string;
}

export async function resolveRunCreationAuthority(
  orgId: string,
  frame: RunCreationFrameHints,
): Promise<OrgWriteAuthority | undefined> {
  const frameAuthority = frame.orgWriteAuthority;
  if (
    frameAuthority &&
    frameAuthority.orgId === orgId &&
    frameAuthority.can("run.execute")
  ) {
    return frameAuthority;
  }

  if (frame.userId) {
    const role = await resolveOrgRoleForUser(orgId, frame.userId);
    if (role === undefined) {
      // Fail-closed for a non-member — the cross-org owner ruling
      // (2026-07-26): a delegating principal not on the run's org never
      // drives its dispatch, even indirectly.
      return undefined;
    }
    return sessionAuthorityFromResolvedRole(orgId, role);
  }

  return undefined;
}
