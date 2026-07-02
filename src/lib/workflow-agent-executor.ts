import "server-only";

// Host wiring for the release-workflows agent_task step.
//
// The durable reconciler in @cinatra-ai/workflows is a leaf package and
// cannot reach the app-layer enqueue chokepoint (`@/lib/agent-run-enqueue`) or
// the agents store. So the host injects two functions at engine boot:
//
//   • buildWorkflowAgentTaskExecutor() — dispatches a child agent run for a
//     workflow agent_task and returns `running` + childRunId.
//   • getWorkflowChildRunStatus()       — polls that child run to terminal.
//
// Idempotency: the reconciler computes a per-attempt key
// `${workflowId}:${taskId}:${attemptNo}` and passes it VERBATIM to createAgentRun.
// An at-least-once redispatch of the SAME attempt resolves (race-safely) to the
// SAME child run; a retry (new attemptNo → new key) spawns a fresh run.

import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import {
  getAuthoringStepDescendants,
  getArtifactsForAuthoringStep,
} from "@/lib/artifacts/authoring-recursion-ledger";
import {
  createAgentRun,
  readAgentRunById,
  readAgentTemplateById,
  readAgentTemplateByPackageName,
  readAgentVersionsByTemplate,
  TERMINAL_RUN_STATUSES,
  type AgentRunStatus,
} from "@cinatra-ai/agents";
import { isAgentRuntimeRunnable } from "@cinatra-ai/agents/runtime-install-gate";
import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions/canonical-store";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import type {
  Executor,
  ExecutorInput,
  ExecutorOutcome,
  ChildRunStatus,
} from "@cinatra-ai/workflows/engine";
import type { ChildRunProvenance } from "@cinatra-ai/workflows/scope";

/** Mirror of agentRefSchema (@cinatra-ai/workflows/spec). */
type AgentRefLike = { package?: string; name?: string; version?: string; templateId?: string };

/** Resolve the agent template a workflow agent_task references. Prefer an
 *  explicit templateId, else the canonical package name. Null = unresolvable. */
async function resolveTemplate(ref: AgentRefLike) {
  if (ref.templateId) {
    const byId = await readAgentTemplateById(ref.templateId);
    if (byId) return byId;
  }
  if (ref.package) {
    const byPkg = await readAgentTemplateByPackageName(ref.package);
    if (byPkg) return byPkg;
  }
  return null;
}

/**
 * RUNTIME-LIFECYCLE GATE (cinatra#659, fail-CLOSED on runtime archive). True iff
 * the agent the `agent_task` references is runnable per the canonical
 * `installed_extension` source of truth: a disabled/uninstalled (archived) agent
 * must NOT be dispatched even though its `agent_templates` row still exists.
 * CG-1: a template with NO canonical row (legacy/bundled/ungoverned) or a `null`
 * packageName is ALLOWED (the bundled floor — same rule the skills + agent_run
 * gates use). Fail-OPEN on a canonical-store outage (never block a workflow on a
 * degraded status store; the executor's tenancy/ownership gates are the real authz
 * boundary). Reuses the SAME pure gate as `agent_run` / the picker / `agent_list`.
 */
async function agentTemplateRuntimeRunnable(packageName: string | null | undefined): Promise<boolean> {
  if (packageName == null) return true; // CG-1: untracked legacy/bundled template
  let status: "active" | "archived" | undefined;
  try {
    status = (await readEffectiveStatusByPackageNames([packageName])).get(packageName);
  } catch (err) {
    // Canonical-store outage → fail-OPEN (never invent an archive).
    console.warn(
      `[workflow-agent-executor] effective-status read failed for "${packageName}" — treating as runnable (fail-open):`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
  return isAgentRuntimeRunnable({ packageName, effectiveStatus: status });
}

/**
 * Agent re-auth probe. True iff the referenced agent resolves to a template
 * available in `orgId`, using the SAME resolution + tenancy gate the agent_task
 * executor enforces at dispatch — so a workflow can never start (or be
 * instantiated) referencing an agent it could not actually execute. The host
 * injects this as the `agentExists` probe into both the instantiate handler and
 * the start-time re-auth in `startWorkflow`.
 */
export async function workflowAgentRefAvailable(agentRef: unknown, orgId: string): Promise<boolean> {
  const ref = (agentRef ?? {}) as AgentRefLike;
  const template = await resolveTemplate(ref);
  if (!template) return false;
  // Tenancy: a null-origin (public) template is allowed in any org; otherwise it
  // MUST belong to the workflow's org (mirrors the executor's AGENT_CROSS_ORG gate).
  if (template.orgId !== null && template.orgId !== orgId) return false;
  // Runtime-lifecycle gate (cinatra#659): a workflow must not START / be
  // instantiated referencing a disabled/uninstalled agent.
  if (!(await agentTemplateRuntimeRunnable(template.packageName))) return false;
  return true;
}

/**
 * The host-injected agent_task executor. Dispatches a child agent run and
 * returns `running` + childRunId; the reconciler polls it via
 * getWorkflowChildRunStatus. Never throws — every failure is returned as a
 * `failed` outcome so the reconciler can retry / dead-letter the task.
 */
export function buildWorkflowAgentTaskExecutor(): Executor {
  return async (input: ExecutorInput): Promise<ExecutorOutcome> => {
    const { task, idempotencyKey } = input;
    const prov = input.provenance as unknown as ChildRunProvenance;
    const ref = (task.agentRef ?? {}) as AgentRefLike;
    // Wrap the WHOLE body: resolveTemplate / readAgentVersionsByTemplate run
    // before any inner try, so an unexpected throw must still resolve to a
    // structured `failed` outcome, never bubble.
    try {
      const template = await resolveTemplate(ref);
      if (!template) {
        return {
          status: "failed",
          error: {
            code: "AGENT_UNRESOLVED",
            message: `agent_task ${task.key}: could not resolve agent ${ref.templateId ?? ref.package ?? "(none)"}`,
          },
        };
      }

      // Tenancy fail-closed: the resolved template MUST belong to the workflow's
      // auth-derived org, or be a public/null-origin template. A foreign-org
      // template would let a workflow in org A execute org B's agent under A's
      // tenancy and cost attribution.
      if (template.orgId !== null && template.orgId !== prov.orgId) {
        return {
          status: "failed",
          error: {
            code: "AGENT_CROSS_ORG",
            message: `agent_task ${task.key}: agent ${template.id} is not available in org ${prov.orgId}`,
          },
        };
      }

      // Runtime-lifecycle gate (cinatra#659), fail-CLOSED on runtime archive —
      // defense-in-depth. `workflowAgentRefAvailable` already gates START/
      // instantiate, but an instance instantiated while the agent was live can
      // reach dispatch AFTER the agent is disabled/uninstalled. Refuse dispatch
      // of an archived agent here too. CG-1: a no-row/null-package template is
      // allowed (the bundled floor); fail-OPEN on a status-store outage.
      if (!(await agentTemplateRuntimeRunnable(template.packageName))) {
        return {
          status: "failed",
          error: {
            code: "AGENT_NOT_INSTALLED",
            message: `agent_task ${task.key}: agent ${template.id} is disabled or uninstalled (no active install)`,
          },
        };
      }

      // Pin the run to the latest published version snapshot (mirrors the
      // agent_run MCP handler).
      const versions = await readAgentVersionsByTemplate(template.id);
      const latestVersionId = versions[0]?.id;

      const runId = `run_${randomUUID()}`;
      const run = await createAgentRun({
        id: runId,
        templateId: template.id,
        versionId: latestVersionId,
        inputParams: (task.input ?? {}) as Record<string, unknown>,
        runBy: prov.runBy ?? undefined,
        // Tenant is the workflow's auth-derived org, never a body id.
        orgId: prov.orgId,
        projectId: prov.projectId ?? null,
        // Idempotent dispatch provenance.
        idempotencyKey,
        workflowId: prov.workflowId,
        workflowTaskId: prov.workflowTaskId,
      });

      // Enqueue when THIS dispatch inserted the run, OR when an idempotent hit
      // (run.id !== runId) is still `queued` — the prior dispatch may have
      // crashed between createAgentRun and enqueueAgentRun, and the lease-based
      // re-dispatch must repair that gap or the child run polls as queued
      // forever. The worker's queued→running CAS guards any double-enqueue. We
      // use softPreflight because the delegated reconciler has no live session
      // actor — a missing/unconfigured connector then surfaces as a run failure
      // at execution (captured by retry/dead-letter), not a hard enqueue block.
      if (run.id === runId || run.status === "queued") {
        await enqueueAgentRun(
          { runId: run.id },
          { connectorDependencies: template.connectorDependencies, softPreflight: true },
        );
      }

      return { status: "running", childRunId: run.id };
    } catch (err) {
      return { status: "failed", error: { code: "AGENT_DISPATCH_FAILED", message: (err as Error).message } };
    }
  };
}

/**
 * Host-injected child-run poller. Maps an agent_run status to the engine's
 * ChildRunStatus. Read with NO actor — a system read; the reconciler is the
 * delegated owner of the run. Null = run not found (transient → poll next tick).
 */
export async function getWorkflowChildRunStatus(childRunId: string): Promise<ChildRunStatus | null> {
  const run = await readAgentRunById(childRunId);
  if (!run) return null;
  const status = run.status as AgentRunStatus;
  // surface agent-run structured final output for foreach
  // materialization. The canonical WayFlow shape (packages/agents/src/
  // execution.ts) wraps each step in `{ kind: "wayflow_response", output,
  // output_data, history }`. The `output_data` slot carries the structured
  // EndNode outputs that map directly to the materializer's expected
  // `{ items: [...] }` contract; `output` is the free-form text. Prefer
  // `output_data` and fall back to `output` only when it's a structured object.
  // For non-object payloads we return null — the foreach materializer will then
  // surface `foreach_invalid_source_output` cleanly rather than silently
  // materializing 0 children.
  let output: Record<string, unknown> | null = null;
  if (Array.isArray(run.stepResults) && run.stepResults.length > 0) {
    const last = run.stepResults[run.stepResults.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last)) {
      const wrapper = last as Record<string, unknown>;
      if (wrapper.output_data && typeof wrapper.output_data === "object" && !Array.isArray(wrapper.output_data)) {
        output = wrapper.output_data as Record<string, unknown>;
      } else if (wrapper.output && typeof wrapper.output === "object" && !Array.isArray(wrapper.output)) {
        output = wrapper.output as Record<string, unknown>;
      }
    }
  }
  // Compute produced artifacts via the authoring ledger run-tree walk. On
  // terminal success we surface every artifact representation emitted under
  // this child run's subtree (including descendant agent runs). The ledger
  // helpers filter for status='committed' so aborted steps don't surface.
  // On non-terminal / failed runs we skip the lookup — the reconciler only
  // consumes producedArtifacts on the success-settle path.
  let producedArtifacts: Array<{ kind: string; ref: string; authoringStepId: string }> = [];
  const isSuccess =
    TERMINAL_RUN_STATUSES.has(status) && status !== "failed" && status !== "stopped";
  if (isSuccess && run.orgId) {
    // No try/catch here: a ledger/query failure must surface as a transient
    // error so the reconciler's existing retry path can re-poll on the next
    // tick. Swallowing would convert a transient failure into a permanent
    // missing workflow_artifact binding for this task.
    producedArtifacts = await computeProducedArtifacts(run.orgId, childRunId);
  }
  return {
    status,
    terminal: TERMINAL_RUN_STATUSES.has(status),
    failed: status === "failed" || status === "stopped",
    hitl: status === "pending_approval",
    error: run.error ? { message: run.error } : null,
    // The child run id itself is always linked by the engine (kind:"agent_run").
    // Richer object-level artifact linking (the run's produced objects) can be
    // layered on later — they live in the objects table keyed by run id.
    artifacts: [],
    output,
    producedArtifacts,
  };
}

/**
 * Walk the agent_run tree rooted at `rootRunId` via `parent_run_id` (down to
 * a bounded depth) and resolve every committed authoring artifact emitted
 * anywhere in that tree. Returns the host-injection shape consumed by the
 * workflow reconciler.
 */
async function computeProducedArtifacts(
  orgId: string,
  rootRunId: string,
): Promise<Array<{ kind: string; ref: string; authoringStepId: string }>> {
  const conn = getPostgresConnectionString();
  const schema = postgresSchema.replaceAll('"', '""');
  const client = new PgClient({ connectionString: conn });
  await client.connect();
  let runIds: string[] = [];
  let rootStepIds: string[] = [];
  try {
    // Step 1: collect every descendant run id (bounded walk, max 32 levels —
    // matches the authoring-ledger depth bound).
    const runRes = await client.query<{ id: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id, parent_run_id, 0 AS distance
           FROM "${schema}"."agent_runs"
          WHERE id = $1 AND org_id = $2
         UNION ALL
         SELECT r.id, r.parent_run_id, d.distance + 1
           FROM "${schema}"."agent_runs" r
           JOIN descendants d ON r.parent_run_id = d.id
          WHERE r.org_id = $2 AND d.distance < 32
       )
       SELECT id FROM descendants`,
      [rootRunId, orgId],
    );
    runIds = runRes.rows.map((row) => row.id);
    if (runIds.length === 0) return [];

    // Step 2: ledger root steps for each run.
    const stepRes = await client.query<{ authoring_step_id: string }>(
      `SELECT authoring_step_id FROM "${schema}"."authoring_invocation_ledger"
         WHERE org_id = $1 AND run_id = ANY($2::text[])`,
      [orgId, runIds],
    );
    rootStepIds = stepRes.rows.map((row) => row.authoring_step_id);
  } finally {
    await client.end().catch(() => {});
  }
  if (rootStepIds.length === 0) return [];

  // Step 3: for each root step, walk descendants and bulk-fetch artifact refs.
  const allStepIds = new Set<string>();
  for (const rootStepId of rootStepIds) {
    const descendants = getAuthoringStepDescendants(orgId, rootStepId);
    for (const d of descendants) allStepIds.add(d.stepId);
  }
  if (allStepIds.size === 0) return [];

  const artifacts = getArtifactsForAuthoringStep(orgId, [...allStepIds]);
  return artifacts.map((a) => ({
    kind: a.kind,
    ref: `${a.artifactId}:${a.representationRevisionId}`,
    authoringStepId: a.stepId,
  }));
}
