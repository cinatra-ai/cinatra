import "server-only";

// EDGE-BOUND SERVING — A2A DISPATCH BINDING (cinatra#1392 Gap 2).
//
// NOTE: this is the tested, ready-to-wire binding. Its LIVE injection into the
// A2A mount (`src/lib/a2a-server.ts`) rides a FOLLOW-UP: wiring it grows the four
// locked dev-perf route graphs (/api/a2a, /api/mcp, /api/llm-bridge, /chat) by
// +2 reachable first-party modules, and the route-graph ratchet (cinatra#732) is
// shrink-only (a self-raise of the ceiling is blocked by the base-ref ratchet),
// so the injection needs an owner/operator dev-perf baseline bump on main first.
// The fail-closed guard MECHANISM it feeds already ships in MultiAgentExecutor.
//
// The app-side binding the A2A mount wires into MultiAgentExecutor as
// `resolveEdgeBoundServing` (packages/a2a stays free of `@/lib` imports; same DI
// pattern as `createAndEnqueueAgentRun`). It reads the TRUSTED dependent install
// id from the request's ActorContext — the run's SIGNED lineage, established by
// the /api/a2a route's `withActorContext(...)` frame from the verified run row —
// NEVER from client-supplied `userMessage.metadata`, and resolves it against the
// target package's dependency edge via the S5 resolver
// `resolveEdgeBoundAgentVersion`.
//
// The decision is EXHAUSTIVE and FAIL-CLOSED (codex-converged): a resolved edge
// with no install id, or a non-default edge missing a servable snapshot/version,
// REFUSES with evidence — it never silently falls through to a default serve. An
// absent dependent id / no applicable edge is compatibility-preserving (the
// dispatch uses ordinary default / requestedVersion resolution). An unreachable
// non-default pin surfaces the resolver's EdgeBoundAgentServingError as a refuse
// decision (the executor publishes a clean failed event); any OTHER error is
// rethrown so the executor fails the run closed.

import type { EdgeBoundServingDecision } from "@cinatra-ai/a2a";
import { getActorContext } from "@cinatra-ai/llm/actor-context";
import {
  resolveEdgeBoundAgentVersion,
  EdgeBoundAgentServingError,
  type EdgeBoundAgentResolution,
} from "@/lib/extension-edge-bound-agent";

/** Injectable seams (default to the live ActorContext + resolver). */
export type EdgeBoundServingDeps = {
  /** The TRUSTED dependent install id for the current dispatch (ActorContext). */
  getDependentInstallId?: () => string | undefined;
  /** The S5 resolver (edge → servable version / refuse). */
  resolve?: (input: {
    dependentInstallId: string;
    targetPackageName: string;
  }) => Promise<EdgeBoundAgentResolution>;
};

/**
 * Resolve the edge-bound serving decision for a dispatch to `targetPackageName`.
 * Pure over its injected deps so the fail-closed matrix is unit-testable without
 * an ActorContext frame or a DB.
 */
export async function resolveEdgeBoundServingDecision(
  input: { targetPackageName: string },
  deps: EdgeBoundServingDeps = {},
): Promise<EdgeBoundServingDecision> {
  const getDependentInstallId =
    deps.getDependentInstallId ?? (() => getActorContext()?.dependentInstallId);
  const resolve = deps.resolve ?? ((i) => resolveEdgeBoundAgentVersion(i));

  // TRUSTED dependent identity only — never client metadata. Absent ⇒ no
  // edge-bound constraint (compatibility-preserving default resolution).
  const dependentInstallId = getDependentInstallId();
  if (!dependentInstallId) return { kind: "none" };

  let r: EdgeBoundAgentResolution;
  try {
    r = await resolve({ dependentInstallId, targetPackageName: input.targetPackageName });
  } catch (err) {
    if (err instanceof EdgeBoundAgentServingError) {
      // Unreachable non-default pin — refuse-with-evidence (carry the code).
      return { kind: "refuse", code: err.code, message: err.message };
    }
    // Unexpected — fail closed (the executor refuses the run, never a default serve).
    throw err;
  }

  // No applicable edge from this dependent to the target — default resolution.
  if (!r.resolved) return { kind: "none" };

  // A resolved result MUST carry the exact install id; a missing one is a
  // corrupt shape — refuse, never serve the default silently.
  if (!r.resolvedInstallId) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_IDENTITY_MISSING",
      message: `edge-bound serving refused — resolved edge to ${input.targetPackageName} carried no install id`,
    };
  }

  // Resolved edge → the DEFAULT version: serving the default is always fine.
  // Stamp the resolved (default) install id; pin NO snapshot.
  if (r.isDefault) {
    return { kind: "serve", targetInstallId: r.resolvedInstallId };
  }

  // NON-DEFAULT: the resolver only RETURNS (does not throw) with a servable
  // snapshot + version. Defensive fail-close: a non-default result lacking either
  // is a corrupt shape — refuse, never fall through to a default serve.
  if (!r.snapshotId || !r.version) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_AGENT_UNREACHABLE",
      message: `edge-bound serving refused — non-default edge to ${input.targetPackageName} lacks a servable snapshot`,
    };
  }
  return {
    kind: "serve",
    targetInstallId: r.resolvedInstallId,
    snapshotId: r.snapshotId,
    version: r.version,
  };
}
