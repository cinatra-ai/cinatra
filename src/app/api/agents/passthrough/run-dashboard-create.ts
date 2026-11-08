import "server-only";
// THE RUN'S DASHBOARD WRITE ON THE PASSTHROUGH (cinatra#3092).
//
// `dashboards_create` is the one dashboards tool the passthrough admits. A
// deterministic flow step writes a dashboard as the run the bridge binding
// PROVED (bindBridgeRunId), never as a run the body names:
//
//   - the actor is the run's owner in the run's organization, and it carries
//     the proven run id, so the twin names that run as the producer;
//   - the org-write authority is minted by the SAME function the MCP
//     transport uses for an agent-run frame (mintRunWriteAuthorityForMcp): the
//     run row must be inside a live attempt, and the authority holds only the
//     run capabilities (content.write, run.complete);
//   - the run's OBO ceiling rides along, so the dashboards resolver confines
//     the write the same way it confines an MCP call of the run.
//
// FAIL CLOSED: a run with no owner, no current attempt, or no minted
// authority is refused before the tool runs. The tool's own refusal is a
// non-2xx answer, so the flow step fails visibly instead of ending the run
// without a dashboard.

import { createDashboardPrimitiveHandlers } from "@cinatra-ai/dashboards/mcp";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { mintRunWriteAuthorityForMcp } from "@/lib/org-write/run-authority-mint";

/** The answer when the proven run cannot write content now. */
const RUN_DASHBOARD_WRITE_UNPROVEN =
  "the run cannot write a dashboard: it has no owner, no live attempt or no write authority";

/** The fields of the proven run this write reads. */
type RunForDashboardWrite = {
  readonly id: string;
  readonly orgId: string;
  readonly runBy: string | null | undefined;
  readonly executionAttemptId: string | null | undefined;
  readonly oboCeiling?: unknown;
};

type RunDashboardCreateOutcome =
  | { ok: true; result: { dashboardId: string; dashboard: unknown } }
  | { ok: false; status: number; error: unknown };

export async function runDashboardCreate(params: {
  /** The run id the bridge binding proved. */
  provenRunId: string;
  run: RunForDashboardWrite;
  input: Record<string, unknown>;
}): Promise<RunDashboardCreateOutcome> {
  const { provenRunId, run, input } = params;
  if (run.id !== provenRunId || !run.runBy || !run.executionAttemptId) {
    return { ok: false, status: 403, error: RUN_DASHBOARD_WRITE_UNPROVEN };
  }
  const authority = await mintRunWriteAuthorityForMcp({
    runId: provenRunId,
    orgId: run.orgId,
    executionAttemptId: run.executionAttemptId,
  });
  if (!authority) {
    return { ok: false, status: 403, error: RUN_DASHBOARD_WRITE_UNPROVEN };
  }
  // The same actor fields the dashboards MCP registry stamps from an agent-run
  // frame; nothing comes from the request body.
  const actor = {
    actorType: "model",
    source: "agent",
    userId: run.runBy,
    orgId: run.orgId,
    runId: provenRunId,
    orgWriteAuthority: authority,
    ...(run.oboCeiling ? { oboCeiling: run.oboCeiling } : {}),
  } as unknown as PrimitiveActorContext;
  const result = (await createDashboardPrimitiveHandlers().dashboards_create({
    primitiveName: "dashboards_create",
    input,
    actor,
    mode: "agentic",
  })) as { dashboard?: { id?: unknown }; error?: unknown };
  const dashboardId = result?.dashboard?.id;
  if (typeof dashboardId !== "string") {
    return { ok: false, status: 422, error: result?.error ?? "dashboards_create returned no dashboard" };
  }
  return { ok: true, result: { dashboardId, dashboard: result.dashboard } };
}
