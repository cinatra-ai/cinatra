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

/**
 * cinatra#1940 (P3) — a THIRD context-named helper added by the creation-
 * conversion PR (the design's "the ONLY new mint" was drafted before this
 * caller's authority gap was found while grounding P3 against live source;
 * disclosed in the PR body). External-A2A peer dispatch
 * (`src/lib/a2a-server.ts`'s `createRunWithAuthority` wiring) for a
 * NON-`HumanUser` principal (Service/Internal/External A2A peers) — the one
 * genuinely principal-less child-run dispatch surface; a `HumanUser` A2A
 * dispatch instead resolves the delegating member via
 * `resolveRunCreationAuthority` like every other caller.
 */
export function mintExternalA2ADispatchAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}

/**
 * cinatra#1940 (P3) — a caller the design's caller matrix did not enumerate
 * (found while grounding P3 against live source, not present at the design's
 * `a728c95b` grounding commit's relevant paths). The PM dynamic-dispatch tick
 * (`src/lib/project-dispatch.ts`, cinatra#1032) creates a project worker run
 * with no session — same system-dispatcher shape as the three helpers above.
 */
export function mintProjectDispatchAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}

/**
 * cinatra#1940 (P3) — a second caller the design's caller matrix did not
 * enumerate (found while grounding P3 against live source). The lifecycle-
 * repair delivery drain (`packages/agents/src/lifecycle-repair-dispatch-store.ts`,
 * cinatra#2047/#2037) creates a deterministic repair run with no session —
 * same system-dispatcher shape as the helpers above.
 */
export function mintLifecycleRepairDispatchAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("agent-run-dispatch", orgId);
}
