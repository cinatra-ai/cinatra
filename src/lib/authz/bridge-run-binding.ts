import "server-only";

import { readAgentRunByContextId } from "@cinatra-ai/agents";

// ---------------------------------------------------------------------------
// Bridge run-binding.
//
// The WayFlow bridge-token authenticates only the caller CLASS — it proves a
// request originated from the WayFlow runtime, NOT that the caller may act with
// a specific run's authority. Several bridge callback routes
// (/api/agents/passthrough, /api/auditor/run-skills, /api/auditor/apply) take a
// caller-selected `agent_run_id` from the request BODY and then derive actor
// authority from that run (run.runBy / run.orgId). A bridge-token holder could
// select ANOTHER run's id and borrow its authority.
//
// This mirrors the accepted #265-family mitigation already used by
// /api/llm-bridge: bind the body-selected run id to the AUTH-INJECTED
// `X-Cinatra-A2A-Context-Id` header. That header is set server-side by the
// WayFlow runtime (docker/wayflow/agent_loader.py, from a per-task ContextVar)
// and is NOT writable by the OAS / agent author, so it is a trustworthy
// statement of "which run is actually executing". We resolve the run from the
// context id and REQUIRE the body's `agent_run_id` to equal it. Fail closed:
// absent header, unresolvable context, or mismatch all deny.
//
// COMPANION CHANGE: agent_loader.py must inject X-Cinatra-A2A-Context-Id for
// the passthrough + auditor URLs (it previously injected it only for
// llm-bridge / context-resolve / context-finalize). Both halves ship together;
// without the header these routes fail closed (by design).
// ---------------------------------------------------------------------------

export type BridgeRunBindingResult =
  | { ok: true; runId: string }
  | { ok: false; status: 403; error: string };

/**
 * Verify that a bridge-authed caller's body-selected `agentRunId` is bound to
 * the run actually executing, as proven by the auth-injected context-id header.
 *
 * Returns `{ ok: true, runId }` only when the context-id header resolves to a
 * run AND that run's id equals `agentRunId`. Otherwise returns a 403 denial.
 *
 * Only call this for bridge-authenticated requests — session/JWT callers are
 * gated by their own ownership checks.
 */
export async function bindBridgeRunId(
  req: Request,
  agentRunId: string,
): Promise<BridgeRunBindingResult> {
  const contextId = req.headers.get("x-cinatra-a2a-context-id");
  if (!contextId) {
    return {
      ok: false,
      status: 403,
      error:
        "bridge run-binding required: missing X-Cinatra-A2A-Context-Id (the run executing this callback could not be established)",
    };
  }
  const contextRun = await readAgentRunByContextId(contextId).catch(() => null);
  if (!contextRun) {
    return {
      ok: false,
      status: 403,
      error: "bridge run-binding failed: context id did not resolve to a run",
    };
  }
  if (contextRun.id !== agentRunId) {
    // The body selected a run other than the one actually executing this
    // callback — refuse rather than derive authority from the selected run.
    return {
      ok: false,
      status: 403,
      error:
        "bridge run-binding failed: agent_run_id does not match the executing run",
    };
  }
  return { ok: true, runId: contextRun.id };
}
