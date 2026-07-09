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

// A `connectorDependencies` map value (cinatra#1056). Structurally identical to
// `ConnectorDepValue` / `ConnectorDependencyMap` on `@cinatra-ai/agents/store`
// (the persisted shape) — declared locally so this leaf host module needs no
// cross-package import; TS structural typing keeps the two compatible.
type ConnectorDepValue = { range: string; requirement: "required" | "optional" };
type ConnectorDependencyMap = Record<string, string | ConnectorDepValue>;

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
   * Per-template connector dependency map persisted on agent_templates. A value
   * is either a bare semver range (legacy shape) or `{ range, requirement }`
   * (cinatra#1056 — the projected canonical edge's requirement). Empty/undefined
   * means "no connector preflight needed".
   */
  connectorDependencies?: ConnectorDependencyMap;
  /**
   * Caller hint — when true, the preflight runs but failures are logged
   * as warnings rather than thrown. Used by the dev-preview path so an
   * operator can preview an agent that isn't yet wired to its connectors.
   */
  softPreflight?: boolean;
  /**
   * Agent package identity so the LLM-provider availability preflight
   * (cinatra#1062) can read the agent's declared OAS `metadata.cinatra.llm`
   * requirement from the runtime mount and gate the run on provider
   * availability. Omitted by callers that don't carry it → no LLM preflight
   * (the provider is still enforced at the `/api/llm-bridge` step).
   */
  agentPackage?: { name: string; version?: string | null };
};

/**
 * Project a template's run-enqueue dependency inputs into enqueueAgentRun
 * options — the cinatra#1056 canonical connector edges AND the cinatra#1062
 * LLM-provider package identity (whose OAS `metadata.cinatra.llm` requirement the
 * enqueue preflight reads). One shared projection for every run-start call site,
 * so the connector gate and the LLM-provider gate fire identically wherever a run
 * is enqueued from an installed template.
 */
export function enqueueDepsForTemplate(
  template:
    | {
        connectorDependencies?: ConnectorDependencyMap;
        packageName?: string | null;
        packageVersion?: string | null;
      }
    | null
    | undefined,
): Pick<AgentRunEnqueueOptions, "connectorDependencies" | "agentPackage"> {
  return {
    connectorDependencies: template?.connectorDependencies,
    agentPackage: template?.packageName
      ? { name: template.packageName, version: template.packageVersion ?? null }
      : undefined,
  };
}

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

export async function runConnectorPreflight(
  connectorDependencies: ConnectorDependencyMap | undefined,
  actor: ActorContext | undefined,
  mode: ConnectorPolicyMode,
): Promise<void> {
  if (!connectorDependencies) return;
  for (const [packageId, rawValue] of Object.entries(connectorDependencies)) {
    // cinatra#1056: carry the projected edge's requirement through instead of
    // hardcoding "required". A bare-string (legacy) value normalizes to
    // "required". W1 still fail-closes on any deny for BOTH requirements — the
    // optional-dependency SKIP behavior (skip-step-audit) is a later wave; this
    // change only threads the requirement so that wave has it (and so the audit
    // event records the real requirement).
    const requirement: "required" | "optional" =
      typeof rawValue === "string" ? "required" : rawValue.requirement;
    if (actor) {
      // Run-start connector authority. Route through the canonical helper so
      // every connector decision emits a structured audit event carrying the
      // real requirement.
      const { requireConnectorAuthority } = await import("@/lib/connector-authority");
      const decision = await requireConnectorAuthority(packageId, actor, { mode, requirement });
      if (!decision.allowed) {
        throw new ConnectorNotConfiguredError(packageId, decision.reason);
      }
    } else {
      // No actor to attribute — un-audited synchronous gate. With a non-empty
      // map this branch fail-closes on `no_actor` for every dep, so
      // `enqueueAgentRun` derives a run actor BEFORE calling us whenever a map is
      // present (see the self-heal in enqueueAgentRun); this branch remains only
      // as a last-resort guard for a direct caller.
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
    agentPackage,
    ...jobOptions
  } = options;

  // Connector preflight (cinatra#1056). The gate needs a real actor: with a
  // populated `connectorDependencies` map and NO actor, the connector policy
  // fail-closes on `no_actor` for EVERY dep, which would break every legitimate
  // connector-dependent run. So when a map is present but the caller passed no
  // `actorContext`, derive a LOCAL preflight actor from the run row — used ONLY
  // for this preflight, NOT threaded to the worker (so the worker's
  // `__actorContext` propagation is unchanged). If the actor can't be resolved
  // (missing/corrupt run), SKIP the preflight rather than false-deny a run on an
  // infra hiccup — the connector is still authorized at step time (the
  // pre-#1056 behavior). This also makes the existing MCP run path — which
  // passes the map but no actor — safe automatically once the column is
  // populated.
  const hasConnectorDeps =
    !!connectorDependencies && Object.keys(connectorDependencies).length > 0;
  let preflightActor = actorContext;
  if (hasConnectorDeps && !preflightActor) {
    try {
      const [{ readAgentRunById }, { buildActorContextFromRun }] = await Promise.all([
        import("@cinatra-ai/agents/store"),
        import("@/lib/authz/build-actor-context-from-run"),
      ]);
      const run = await readAgentRunById(record.runId);
      if (run?.orgId) {
        preflightActor = await buildActorContextFromRun({
          id: run.id,
          runBy: run.runBy ?? null,
          orgId: run.orgId,
        });
      }
    } catch (err) {
      console.warn(
        `[agent-run-enqueue] connector preflight actor could not be resolved for run ${record.runId}; ` +
          `skipping preflight (connector still checked at step time): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (hasConnectorDeps && preflightActor) {
    try {
      await runConnectorPreflight(connectorDependencies, preflightActor, "use");
    } catch (err) {
      if (softPreflight && err instanceof ConnectorNotConfiguredError) {
        console.warn(
          `[agent-run-enqueue] soft-preflight: ${err.message} (settings: ${err.settingsHref})`,
        );
      } else {
        throw err;
      }
    }
  }

  // LLM-provider availability preflight (cinatra#1062). When the caller supplies
  // the agent package identity, read the agent's declared OAS
  // `metadata.cinatra.llm` requirement from the runtime mount and gate the run on
  // provider availability — mirroring the `/api/llm-bridge` dispatch so a
  // missing/unconfigured provider surfaces BEFORE the run instead of deep at the
  // bridge step. Dynamically imported + gated on `agentPackage` so a run with no
  // llm requirement pays neither the mount I/O nor the LLM package load. Honors
  // `softPreflight` (dev-preview) exactly like the connector gate above.
  if (agentPackage?.name) {
    // Import the narrow module (NOT the `@cinatra-ai/agents` barrel) so this
    // lazy preflight loads only the lightweight mount reader — the barrel pulls
    // the whole agents module graph (defeating the lazy-load intent and, via its
    // side-effectful loads, breaking unrelated handler tests).
    const { readLlmRequirementFromMount } = await import(
      "@cinatra-ai/agents/read-llm-requirement-from-mount"
    );
    const requirement = await readLlmRequirementFromMount(
      agentPackage.name,
      agentPackage.version ?? null,
    );
    if (requirement) {
      const { assertLlmProviderAvailableForRun, LlmProviderNotConfiguredError } =
        await import("@/lib/agent-llm-preflight");
      try {
        await assertLlmProviderAvailableForRun(requirement);
      } catch (err) {
        if (softPreflight && err instanceof LlmProviderNotConfiguredError) {
          console.warn(
            `[agent-run-enqueue] soft-preflight: ${err.message} (settings: ${err.settingsHref})`,
          );
        } else {
          throw err;
        }
      }
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
