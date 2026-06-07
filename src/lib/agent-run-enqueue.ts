import "server-only";

// Single chokepoint for enqueueing agent runs. Every producer of
// `BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION` goes through
// `enqueueAgentRun(record, opts)` so the connector preflight runs exactly once
// before the BullMQ enqueue.
//
// The dual-pattern CI gate at `scripts/audit/agent-builder-enqueue-gate.mjs`
// blocks the `BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION` and raw
// `"AGENT_BUILDER_EXECUTION"` literal outside a 5-file allowlist:
//   - src/lib/agent-run-enqueue.ts (this file — the chokepoint)
//   - src/lib/background-jobs.ts (worker dispatcher; consumer side)
//   - packages/agents/src/orchestrator-execution.ts (cancel-only callback)
//   - packages/agents/src/review-task-actions.ts (same-run re-enqueue)
//   - packages/agents/src/execution.ts (setup-loop same-run re-enqueue)
// `packages/a2a/src/agent-executor.ts` takes an injected
// `createAndEnqueueAgentRun` contract via `setAgentRunEnqueueContract`.

import type { JobsOptions } from "bullmq";
import {
  BACKGROUND_JOB_NAMES,
  enqueueBackgroundJob,
} from "@/lib/background-jobs";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  enforceConnectorPolicy,
  type ConnectorPolicyMode,
} from "@/lib/connector-policy";

export type AgentRunEnqueueOptions = Pick<
  JobsOptions,
  "jobId" | "priority" | "delay" | "attempts" | "backoff"
> & {
  /**
   * ActorContext that initiated the run. Used (a) to thread auth context
   * through to the worker (existing behavior) AND (b) to evaluate the
   * connector preflight policy in `mode: "use"`.
   */
  actorContext?: ActorContext;
  /**
   * Per-template connector dependency map (the `connectorDependencies`
   * Record<packageId, semverRange> persisted on agent_templates).
   * Empty/undefined means "no connector preflight needed".
   */
  connectorDependencies?: Record<string, string>;
  /**
   * Caller hint — when true, the preflight runs but failures are logged
   * as warnings rather than thrown. Used by the dev-preview path so an
   * operator can preview an agent that isn't yet wired to its connectors.
   */
  softPreflight?: boolean;
};

export class ConnectorNotConfiguredError extends Error {
  override readonly name = "ConnectorNotConfiguredError";
  readonly code = "CONNECTOR_NOT_CONFIGURED" as const;
  readonly packageId: string;
  readonly settingsHref: string;
  readonly reason?: string;

  constructor(packageId: string, reason?: string) {
    super(
      `Agent run blocked: ${packageId} is not configured for this actor` +
        (reason ? ` (${reason})` : ""),
    );
    this.packageId = packageId;
    this.reason = reason;
    // Derive the slug from the canonical `@cinatra-ai/<slug>` packageId.
    const slug = packageId.replace(/^@cinatra-ai\//, "");
    this.settingsHref = `/connectors/cinatra-ai/${slug}/setup`;
  }
}

async function runConnectorPreflight(
  connectorDependencies: Record<string, string> | undefined,
  actor: ActorContext | undefined,
  mode: ConnectorPolicyMode,
): Promise<void> {
  if (!connectorDependencies) return;
  for (const packageId of Object.keys(connectorDependencies)) {
    if (actor) {
      // Run-start connector authority. Route through the canonical helper so
      // every connector decision emits a structured audit event. Policy: each
      // declared dependency is treated as required and fail-closes on deny.
      // Required-vs-optional handling is deferred until the connector-
      // dependency manifest can express a requirement level.
      const { requireConnectorAuthority } = await import("@/lib/connector-authority");
      const decision = await requireConnectorAuthority(packageId, actor, { mode, requirement: "required" });
      if (!decision.allowed) {
        throw new ConnectorNotConfiguredError(packageId, decision.reason);
      }
    } else {
      // No actor to attribute (system / cookieless path) — keep the
      // un-audited synchronous gate and preserve current behavior.
      const decision = enforceConnectorPolicy(packageId, actor, mode);
      if (!decision.allowed) {
        throw new ConnectorNotConfiguredError(packageId, decision.reason);
      }
    }
  }
}

export type EnqueueAgentRunResult = {
  runId: string;
  jobId: string;
  status: "queued";
};

export async function enqueueAgentRun(
  record: { runId: string },
  options: AgentRunEnqueueOptions = {},
): Promise<EnqueueAgentRunResult> {
  const {
    actorContext,
    connectorDependencies,
    softPreflight = false,
    ...jobOptions
  } = options;

  try {
    await runConnectorPreflight(connectorDependencies, actorContext, "use");
  } catch (err) {
    if (softPreflight && err instanceof ConnectorNotConfiguredError) {
      console.warn(
        `[agent-run-enqueue] soft-preflight: ${err.message} (settings: ${err.settingsHref})`,
      );
    } else {
      throw err;
    }
  }

  const enqueueOptions: Parameters<typeof enqueueBackgroundJob>[2] = {
    ...jobOptions,
  };
  if (actorContext) {
    enqueueOptions.actorContext = actorContext;
  }

  const jobId = await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
    { runId: record.runId },
    enqueueOptions,
  );

  return {
    runId: record.runId,
    jobId: jobId ?? record.runId,
    status: "queued",
  };
}

// ---------------------------------------------------------------------------
// A2A injected-contract surface. `packages/a2a/src/agent-executor.ts` stays
// away from the hardcoded job name literal. The a2a package only sees
// `CreateAndEnqueueAgentRun` and never imports BACKGROUND_JOB_NAMES.
// ---------------------------------------------------------------------------

export type CreateAndEnqueueAgentRun = (
  record: { runId: string },
  options?: AgentRunEnqueueOptions,
) => Promise<EnqueueAgentRunResult>;

let injectedContract: CreateAndEnqueueAgentRun | undefined;

export function setAgentRunEnqueueContract(
  contract: CreateAndEnqueueAgentRun,
): void {
  injectedContract = contract;
}

export function getAgentRunEnqueueContract(): CreateAndEnqueueAgentRun {
  return injectedContract ?? enqueueAgentRun;
}
