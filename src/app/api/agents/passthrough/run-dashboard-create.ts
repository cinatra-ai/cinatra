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
//     transport uses for an agent-run frame (mintRunWriteAuthorityForMcp). The
//     claimed attempt is the attempt the binding read when it bound the
//     callback, never a value read later: if the run moved to another attempt
//     after that, the claim is stale and the mint refuses. The authority holds
//     only the run capabilities (content.write, run.complete);
//   - the run's OBO ceiling rides along, so the dashboards resolver confines
//     the write the same way it confines an MCP call of the run. As the model
//     bridge does before it mints an OBO token, the stored ceiling must CONTAIN
//     the chain re-derived from the run's locked template anchor and project
//     launch (deriveOboCeilingChain / oboCeilingContains), or the write is
//     refused.
//
// FAIL CLOSED: a run with no owner, no attempt at binding, an attempt that
// changed since binding, no OBO ceiling, a ceiling that does not contain the
// re-derived anchor chain, or no minted authority is refused
// before the tool runs. The tool's own refusal is a non-2xx answer, so the flow
// step fails visibly instead of ending the run without a dashboard. A tool
// error of an unknown code answers a fixed sentence, never the error's text.

import { readAgentTemplateById } from "@cinatra-ai/agents";
import { createDashboardForRun } from "@cinatra-ai/dashboards/mcp";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { mintRunWriteAuthorityForMcp } from "@/lib/org-write/run-authority-mint";

/** The answer when the proven run cannot write content now. */
const RUN_DASHBOARD_WRITE_UNPROVEN =
  "the run cannot write a dashboard: it has no owner, no live attempt, no valid scope ceiling or no write authority";

/** The answer for a tool error of an unknown code: its text is never sent. */
export const RUN_DASHBOARD_WRITE_FAILED = "dashboards_create failed";

/** The tool's refusal codes whose envelope is the caller's own answer. */
const CALLER_FACING_CODES: ReadonlySet<string> = new Set([
  "forbidden",
  "unauthorized",
  "not_found",
  "invalid_config",
]);

/** The fields of the proven run this write reads. */
type RunForDashboardWrite = {
  readonly id: string;
  readonly orgId: string;
  readonly templateId: string;
  readonly projectId?: string | null;
  readonly runBy: string | null | undefined;
  readonly executionAttemptId: string | null | undefined;
  readonly oboCeiling?: unknown;
};

/** What the bridge binding proved: the run, and its attempt at binding. */
type ProvenBinding = {
  readonly runId: string;
  readonly executionAttemptId: string | null | undefined;
};

type RunDashboardCreateOutcome =
  | { ok: true; result: { dashboardId: string; dashboard: unknown } }
  | { ok: false; status: number; error: unknown };

/** The tool's error as an answer: a known refusal as it is, anything else as
 *  the fixed sentence. */
function toolErrorAnswer(error: unknown): { status: number; error: unknown } {
  const code =
    error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && CALLER_FACING_CODES.has(code)) {
    return { status: 422, error };
  }
  return { status: 500, error: { code: "internal_error", message: RUN_DASHBOARD_WRITE_FAILED } };
}

export async function runDashboardCreate(params: {
  /** The run and attempt the bridge binding proved. */
  binding: ProvenBinding;
  run: RunForDashboardWrite;
  input: Record<string, unknown>;
}): Promise<RunDashboardCreateOutcome> {
  const { binding, run, input } = params;
  const claimedAttemptId = binding.executionAttemptId;
  const ceiling = run.oboCeiling;
  if (
    run.id !== binding.runId ||
    !run.runBy ||
    !claimedAttemptId ||
    run.executionAttemptId !== claimedAttemptId ||
    !Array.isArray(ceiling) ||
    ceiling.length === 0
  ) {
    return { ok: false, status: 403, error: RUN_DASHBOARD_WRITE_UNPROVEN };
  }
  // The model bridge's mint-time ceiling check (src/app/api/llm-bridge/route.ts,
  // before it mints the run's OBO token): re-derive the chain from the run's
  // LOCKED template anchor and project launch, and require the stored chain to
  // contain it. A corrupt anchor, a failed read or a stored chain missing an
  // element refuses.
  const template = await readAgentTemplateById(run.templateId).then(
    (row) => ({ row }),
    () => null,
  );
  const recomputed = template
    ? deriveOboCeilingChain({
        ownerLevel: template.row?.ownerLevel ?? null,
        ownerId: template.row?.ownerId ?? null,
        orgId: run.orgId,
        projectId: run.projectId ?? null,
      })
    : null;
  if (!recomputed || !oboCeilingContains(ceiling as OboCeilingChain, recomputed)) {
    return { ok: false, status: 403, error: RUN_DASHBOARD_WRITE_UNPROVEN };
  }
  // The verifier reads the run row again and refuses unless the claimed
  // attempt is still the current one and the attempt is live.
  const authority = await mintRunWriteAuthorityForMcp({
    runId: binding.runId,
    orgId: run.orgId,
    executionAttemptId: claimedAttemptId,
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
    runId: binding.runId,
    orgWriteAuthority: authority,
    oboCeiling: ceiling,
  } as unknown as PrimitiveActorContext;
  const result = (await createDashboardForRun({
    primitiveName: "dashboards_create",
    input,
    actor,
    mode: "agentic",
  })) as { dashboard?: { id?: unknown }; error?: unknown };
  const dashboardId = result?.dashboard?.id;
  if (typeof dashboardId !== "string") {
    return { ok: false, ...toolErrorAnswer(result?.error) };
  }
  return { ok: true, result: { dashboardId, dashboard: result.dashboard } };
}
