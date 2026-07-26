import "server-only";
/**
 * cinatra#1939 wave 2 — the agent-run system-dispatch authority mint.
 *
 * The host-side, purpose-scoped mint for the three SYSTEM job contexts that
 * drive an agent run's full lifecycle with NO session — dispatch
 * (`run.execute`) and finalize (`run.complete`). Analogous to
 * `run-authority-mint.ts` (the MCP transport's run mint): the SOLE importer of
 * `mintSystemWriteAuthority` for the `"agent-run-dispatch"` purpose, so the
 * dispatcher-only discipline is enforced at one R2-allowlisted site.
 *
 * Three context-named helpers, all minting the SAME `"agent-run-dispatch"`
 * purpose (kept SEPARATE from `lease-expiry-finalizer`, whose archive/lease
 * audit domain must not be conflated with normal execution). The names make
 * each job's provenance auditable at its call site. §5.2 further restricts WHO
 * may import these helpers to the three job files via the boundary gate — being
 * the sole minting site is not the same as being the sole authorized caller.
 */
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { mintSystemWriteAuthority } from "./authority";

/** The agent-run worker (`packages/agents/src/execution.ts`) driving a run's
 *  full lifecycle — dispatch and terminal finalize — with no session. */
export function mintAgentRunExecutionAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}

/** The trigger-release scheduler (`packages/agents/src/trigger-release-job.ts`)
 *  firing armed runs into the queue (and landing terminal edges on failure). */
export function mintTriggerReleaseAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}

/** The host content-editor dispatch (`src/lib/host-content-editor-dispatch.ts`)
 *  driving synthetic host-carrier runs whose service identity may not be an org
 *  member — one fail-safe system path for the whole editor lifecycle (D-HOST). */
export function mintContentEditorDispatchAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}
