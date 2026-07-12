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

// A single filesystem/URL-safe path segment (rejects `.`/`..`, separators,
// query/fragment chars) — mirrors the registries `isSafePathSegment` shape but
// kept local so this run-start leaf never imports the registries barrel
// (cinatra#1196 route-graph pressure).
function isSafeConnectorSegment(s: string): boolean {
  return s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
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
    // Multi-vendor (cinatra#1196): derive BOTH the vendor and the name from the
    // connector packageId so an operator/third-party connector (`@vendor/<name>`)
    // deep-links to its OWN `/connectors/<vendor>/<name>/setup` route (the route
    // is `[vendor]/[slug]`) instead of the old literal `cinatra-ai` segment. A
    // first-party `@cinatra-ai/<name>` resolves identically to before; an
    // unscoped/malformed id falls back to the historical `cinatra-ai` vendor.
    //
    // Require EXACTLY one `/` and BOTH parts a single safe segment (the
    // canonical `@vendor/name` rule) — so a malformed multi-slash id like
    // `@v/a/b`, or query/fragment characters, can never leak EXTRA path
    // segments into the deep-link. Done INLINE rather than via the registries
    // `parsePackageId` on purpose: this is a leaf module eagerly imported by
    // many run-start suites with partial module mocks, and a top-level
    // `@cinatra-ai/registries` import would pull the registries barrel into
    // that graph (breaking those suites at load).
    const scoped = /^@([^/]+)\/([^/]+)$/.exec(packageId);
    let vendor = "cinatra-ai";
    let name: string;
    if (scoped && isSafeConnectorSegment(scoped[1]) && isSafeConnectorSegment(scoped[2])) {
      vendor = scoped[1];
      name = scoped[2];
    } else {
      // Unscoped or malformed: strip a leading `@scope/`, keep only the FIRST
      // path segment, and require it be a safe segment too — so a traversal
      // (`..`), separator, or query/fragment payload can never reach the href.
      // A still-unsafe fallback collapses to a stable safe placeholder (the
      // deep-link stays well-formed; this path is unreachable for a canonical
      // connector packageId). All under the historical `cinatra-ai` vendor.
      const first = packageId.replace(/^@[^/]+\//, "").split(/[/?#]/)[0];
      name = isSafeConnectorSegment(first) ? first : "unknown";
    }
    this.settingsHref = `/connectors/${vendor}/${name}/setup`;
  }
}

/** One connector dependency the run-start preflight declined to gate on. The
 * dependent step is SKIPPED (skip-step-audit) rather than the run failing —
 * the per-kind optional-missing behavior for connectors (cinatra#1058). */
export type SkippedOptionalConnector = { packageId: string; reason: string };

export type ConnectorPreflightResult = {
  /** Optional connector deps whose run-start authority was DENIED. Their
   * dependent step is skipped-and-audited; the run still proceeds. */
  skippedOptional: SkippedOptionalConnector[];
};

export async function runConnectorPreflight(
  connectorDependencies: ConnectorDependencyMap | undefined,
  actor: ActorContext | undefined,
  mode: ConnectorPolicyMode,
): Promise<ConnectorPreflightResult> {
  const skippedOptional: SkippedOptionalConnector[] = [];
  if (!connectorDependencies) return { skippedOptional };
  for (const [packageId, rawValue] of Object.entries(connectorDependencies)) {
    // cinatra#1056 threaded the projected edge's requirement through instead of
    // hardcoding "required"; a bare-string (legacy) value normalizes to
    // "required". cinatra#1058 wires the per-kind optional behavior on top:
    //   - REQUIRED dep denied  → fail closed at enqueue (ConnectorNotConfiguredError).
    //   - OPTIONAL dep denied  → skip-step-audit: do NOT throw; collect the dep so
    //     the caller records an audited, run-visible "skipped step" annotation and
    //     the run proceeds without that connector's dependent step.
    const requirement: "required" | "optional" =
      typeof rawValue === "string" ? "required" : rawValue.requirement;
    if (actor) {
      // Run-start connector authority. Route through the canonical helper so
      // every connector decision emits a structured audit event carrying the
      // real requirement; the helper marks an optional deny `skipped: true`.
      const { requireConnectorAuthority } = await import("@/lib/connector-authority");
      const decision = await requireConnectorAuthority(packageId, actor, { mode, requirement });
      if (!decision.allowed) {
        if (decision.skipped) {
          skippedOptional.push({ packageId, reason: decision.reason });
        } else {
          throw new ConnectorNotConfiguredError(packageId, decision.reason);
        }
      }
    } else {
      // No actor to attribute — un-audited synchronous gate. With a non-empty
      // map this branch fail-closes on `no_actor` for every dep, so
      // `enqueueAgentRun` derives a run actor BEFORE calling us whenever a map is
      // present (see the self-heal in enqueueAgentRun); this branch remains only
      // as a last-resort guard for a direct caller. The optional-skip routing
      // mirrors the audited branch so a direct actor-less caller degrades the
      // same way (optional → skip, required → fail closed).
      const decision = enforceConnectorPolicy(packageId, actor, mode);
      if (!decision.allowed) {
        if (requirement === "optional") {
          skippedOptional.push({ packageId, reason: decision.reason ?? "no_actor" });
        } else {
          throw new ConnectorNotConfiguredError(packageId, decision.reason);
        }
      }
    }
  }
  return { skippedOptional };
}

/**
 * Record the run-visible, audited "skipped step" annotation for each optional
 * connector dep the run-start preflight declined (cinatra#1058 skip-step-audit).
 * Emits one `audit_events` row per skipped dep, tagged with the runId and
 * `behavior: "skip-step-audit"`, so the skip surfaces on the run's audit trail
 * as an intentional optional-dependency decision. Best-effort: a write failure
 * is logged and swallowed — it must never fail an otherwise-enqueuable run.
 */
export async function recordOptionalConnectorSkips(
  runId: string,
  actor: ActorContext,
  skipped: readonly SkippedOptionalConnector[],
): Promise<void> {
  try {
    const { logAuditEvent } = await import("@/lib/authz/audit");
    for (const { packageId, reason } of skipped) {
      await logAuditEvent({
        organizationId: actor.organizationId,
        actorPrincipalId: actor.principalId,
        actorPrincipalType: "system",
        authSource: "worker",
        resourceType: "connector_instance",
        resourceId: packageId,
        operation: "use",
        // `allowed`: the RUN is allowed to proceed; the connector's dependent
        // step is what gets skipped. The `skipped`/`behavior` metadata is the
        // discriminant, not the decision.
        decision: "allowed",
        policyVersion: "connector-scope-use-policy",
        runId,
        metadata: {
          packageId,
          requirement: "optional",
          skipped: true,
          behavior: "skip-step-audit",
          reason,
        },
      });
    }
  } catch (err) {
    console.warn(
      `[agent-run-enqueue] failed to record optional-connector skip annotation for run ${runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
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
      const { skippedOptional } = await runConnectorPreflight(
        connectorDependencies,
        preflightActor,
        "use",
      );
      // cinatra#1058 skip-step-audit: an optional connector dep denied at
      // run-start does NOT fail the run — its dependent step is skipped. Record
      // one audited, run-visible annotation per skipped dep (audit_events row
      // carrying this runId + behavior:skip-step-audit) so the skip is an
      // intentional, attributable decision rather than a silent mid-run
      // degrade. Best-effort: an audit-write hiccup must never fail an
      // otherwise-enqueuable run.
      if (skippedOptional.length > 0) {
        await recordOptionalConnectorSkips(record.runId, preflightActor, skippedOptional);
      }
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
