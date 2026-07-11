import "server-only";

// The platform DYNAMIC DISPATCH primitive (cinatra#1032 deliverable 2).
//
// Dispatches a project worker agent BY PACKAGE REF at tick time — the seam
// that separates a Project Manager Agent (skills decide, dynamically) from
// static OAS orchestration (composition hardcoded as inlined subflows). Every
// dispatch is:
//
//   1. POLICY-VALIDATED deterministically BEFORE any run is created — the
//      proposed pick must pass the shared ready-item validator and the
//      proposed worker must be the template task's binding, drawn from the
//      template's versioned worker ALLOWLIST (`templateWorkerAllowlist`,
//      merged as #1032 slice a). A pick or target failing these checks NEVER
//      reaches `createAgentRun` (Acceptance 3).
//   2. LEASE-FENCED — the write-ahead ledger claim only lands while the caller
//      is the LIVE project-lease holder at its fencing version, evaluated in
//      the same SQL statement (no TOCTOU window for a stale tick).
//   3. LEDGERED — routed through `project_dispatch_attempts`, written AHEAD of
//      `createAgentRun` with a deterministically derived idempotency key
//      passed VERBATIM, so a tick killed mid-dispatch re-converges onto the
//      SAME child run on the next pass: neither a duplicated child run nor a
//      lost item (Acceptance 2).
//   4. GATED by the exact host safety chain of the workflow agent_task
//      executor (src/lib/workflow-agent-executor.ts, reused verbatim):
//      package-ref resolution, the AGENT_CROSS_ORG fail-closed tenancy check,
//      the #659 runtime-lifecycle gate (fail-closed on archive, fail-open on a
//      status-store outage), latest published version pinning,
//      `createAgentRun(idempotencyKey)`, and the enqueue-repair rule.
//   5. OBO-CEILING-SAFE — the child run's ceiling is SERVER-DERIVED at
//      creation inside `createAgentRun` over the child's own anchored scope;
//      the parent tick run's chain is passed as the compose operand
//      (`parentOboCeiling`), NEVER copied onto the child (the clone-copy
//      trap). A provably-disjoint composition fails closed before any insert.
//   6. SEAT- AND INSTANCE-GATED (deliverable 3, the install/kind-gate wiring):
//      dispatch requires an INSTANTIATED project (a `project_instances` row —
//      see src/lib/project-instantiation.ts) and runs ON BEHALF OF the
//      project's persisted PM SEAT: the caller supplies only the parent tick
//      run's ID (`parentRunId`); the run row, its org, its agent package, its
//      cinatra project, and its persisted OBO ceiling chain are all read
//      SERVER-SIDE (never trusted from input). The parent run's agent must BE
//      the instance's pm_agent_package and must STILL declare the
//      pm-work-store capability binding (fail-closed against a reinstall that
//      dropped it). The template is resolved from the instance's pinned
//      template package's FINALIZED store payload — never caller-supplied
//      bytes — and its stable id must equal the instance's pinned template_id.
//
// Never throws: every failure resolves to a structured outcome, mirroring the
// workflow executor's contract.

import { randomUUID } from "node:crypto";
import {
  createAgentRun,
  readAgentRunById,
  readAgentTemplateById,
  readAgentTemplateByPackageName,
  readAgentVersionsByTemplate,
  TERMINAL_RUN_STATUSES,
  type AgentRunStatus,
} from "@cinatra-ai/agents";
import { readProjectInstance } from "@cinatra-ai/agents/project-instance-store";
import { isAgentRuntimeRunnable } from "@cinatra-ai/agents/runtime-install-gate";
import {
  beginDispatchAttempt,
  settleDispatchAttempt,
  type DispatchAttemptRecord,
} from "@cinatra-ai/agents/project-dispatch-ledger-store";
import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions/canonical-store";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";

/** Stable code carried by OboCeilingCompositionError — branch on the CODE, not
 *  instanceof, to avoid cross-bundle class-identity coupling (the documented
 *  site-level pattern; see packages/a2a/src/agent-executor.ts). */
const OBO_CEILING_DISJOINT_CODE = "AGENT_OBO_CEILING_DISJOINT";
import {
  checkTemplateWorkerRefsAgainstDependencies,
  itemNotReadyReason,
  indexItemStatusByKey,
  templateWorkerAllowlist,
  PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR,
  type NotReadyReason,
  type ReadyItemView,
  type WorkerAgentRef,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { enqueueAgentRun, enqueueDepsForTemplate } from "@/lib/agent-run-enqueue";
import {
  agentManifestDeclaresPmSeat,
  resolveInstalledAgentManifest,
  resolveInstalledProjectTemplate,
} from "@/lib/project-template-resolve";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Storage bound for action_version (PostgreSQL `integer`). */
const MAX_ACTION_VERSION = 2_147_483_647;

/** Canonical, unambiguous fingerprint of a worker binding's version
 *  constraint — part of the immutable attempt identity persisted on the
 *  ledger row (structural, mirrors `versionConstraintsEqual`'s kind+value
 *  discrimination). */
function versionConstraintFingerprint(vc: WorkerAgentRef["versionConstraint"]): string {
  switch (vc.kind) {
    case "semver-range":
      return `semver-range:${vc.range}`;
    case "exact":
      return `exact:${vc.version}`;
    case "git-ref":
      return `git-ref:${vc.ref}`;
  }
}

/** Deterministic pre-dispatch rejections — no ledger row was consumed and no
 *  run was created (or could ever have been). */
export type ProjectDispatchRejectionCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_INSTANTIATED"
  | "NOT_PM_SEAT"
  | "PROJECT_TEMPLATE_MISMATCH"
  | "TEMPLATE_WORKER_REFS_INVALID"
  | "WORKER_NOT_ALLOWLISTED"
  | "PICK_UNKNOWN"
  | "ITEM_NOT_READY"
  | "LEASE_NOT_HELD"
  | "DISPATCH_ATTEMPT_CONFLICT";

/** Dispatch-chain failures — the attempt is ledgered 'failed' (or, for
 *  DISPATCH_RUN_MISSING, preserved as-is); no NEW child run exists.
 *  DISPATCH_ATTEMPT_CONFLICT appears here too for the post-dispatch settle
 *  conflict (the child run exists; the ledger row was concurrently settled to
 *  a different result — surfaced, never overwritten). TEMPLATE_UNRESOLVED is
 *  pre-ledger (no attempt row was consumed): the instance's pinned template
 *  package stopped resolving to a finalized install carrying a valid
 *  template — an environment/lifecycle fault, not a caller policy error. */
export type ProjectDispatchFailureCode =
  | "TEMPLATE_UNRESOLVED"
  | "AGENT_UNRESOLVED"
  | "AGENT_CROSS_ORG"
  | "AGENT_NOT_INSTALLED"
  | "OBO_CEILING_DISJOINT"
  | "DISPATCH_RUN_MISSING"
  | "DISPATCH_ATTEMPT_CONFLICT"
  | "PROJECT_DISPATCH_FAILED";

export type ProjectDispatchOutcome =
  | {
      status: "dispatched";
      runId: string;
      attemptId: string;
      idempotencyKey: string;
    }
  | {
      /** A prior attempt for this (item, actionVersion) already dispatched the
       *  child run; the ledger short-circuited (enqueue repaired if the run
       *  was still queued). */
      status: "already_dispatched";
      runId: string;
      attemptId: string;
    }
  | {
      status: "rejected";
      code: ProjectDispatchRejectionCode;
      /** Populated for ITEM_NOT_READY. */
      notReadyReason?: NotReadyReason;
      message: string;
    }
  | { status: "failed"; code: ProjectDispatchFailureCode; message: string };

export type ProjectWorkerDispatchInput = {
  /** Auth-derived tenant org — NEVER a body id (tenancy operand). */
  orgId: string;
  /** The PM project scope — the natural-key prefix of every item in `items`.
   *  Must be an INSTANTIATED project (see src/lib/project-instantiation.ts);
   *  the persisted instance pins the template package/id, the PM seat, and
   *  the cinatra project refinement the child run inherits. */
  projectRef: string;
  /** Every cinatra-managed item in the project scope (dependency resolution
   *  context for the ready validator). */
  items: readonly ReadyItemView[];
  /** The proposed pick — the natural key of the item to dispatch. */
  pick: string;
  /** The tick day, YYYY-MM-DD (ready-validator operand). */
  asOf: string;
  /** Deliberate-retry counter: the ledger key is (item, actionVersion). A
   *  recovery pass reuses the SAME value; a deliberate re-dispatch bumps it. */
  actionVersion: number;
  /** The proposed worker ROLE (validated against the template task's binding
   *  and the template allowlist — role, never a parsed package string). */
  role: string;
  /** Input params for the child run. */
  runInput: Record<string, unknown>;
  /** The user on whose behalf the project runs (delegated attribution). */
  runBy?: string | null;
  /** The caller's LIVE project lease (from acquireProjectLease) — its fencing
   *  version guards the ledger claim. */
  lease: { holderId: string; version: number };
  /** The dispatching tick run's ID (the PM agent's own run) — REQUIRED. The
   *  run row is read SERVER-SIDE: its org must match `orgId`, it must be
   *  NON-TERMINAL, its agent must BE the instance's persisted PM seat, the
   *  project lease must be held AS this run (lease.holderId === parentRunId),
   *  and its PERSISTED OBO ceiling chain is the compose operand (never
   *  accepted from input — the clone-copy / caller-crafted-ceiling trap).
   *  BOUNDARY NOTE: this primitive is server-only and its callers are host
   *  code; proving the AUTHENTICATED caller IS this run (run-token ≡
   *  parentRunId) happens at the tool boundary that exposes dispatch to an
   *  agent run — the run-token spine's enforcement seam, wired with the
   *  project-manager pilot. */
  parentRunId: string;
};

/**
 * Runtime-lifecycle gate (cinatra#659) — verbatim from
 * src/lib/workflow-agent-executor.ts: fail-CLOSED on a runtime archive,
 * CG-1 bundled floor (null package allowed), fail-OPEN on a canonical-store
 * outage (the tenancy gate is the real authz boundary).
 */
async function agentTemplateRuntimeRunnable(packageName: string | null | undefined): Promise<boolean> {
  if (packageName == null) return true; // CG-1: untracked legacy/bundled template
  let status: "active" | "archived" | undefined;
  try {
    status = (await readEffectiveStatusByPackageNames([packageName])).get(packageName);
  } catch (err) {
    console.warn(
      `[project-dispatch] effective-status read failed for "${packageName}" — treating as runnable (fail-open):`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
  return isAgentRuntimeRunnable({ packageName, effectiveStatus: status });
}

/** Best-effort 'failed' settle inside the never-throw boundary: a settle
 *  conflict/error must not mask the primary failure being returned. */
async function settleFailedBestEffort(attempt: DispatchAttemptRecord, error: string): Promise<void> {
  try {
    await settleDispatchAttempt({
      id: attempt.id,
      expectedVersion: attempt.version,
      status: "failed",
      runId: attempt.runId,
      error,
    });
  } catch (err) {
    console.warn(
      `[project-dispatch] failed-settle for attempt ${attempt.id} did not land:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Dispatch a project worker agent for a picked work item. See the module
 * header for the invariants. Never throws.
 */
export async function dispatchProjectWorker(
  input: ProjectWorkerDispatchInput,
): Promise<ProjectDispatchOutcome> {
  try {
    // ---- 0. Deterministic input validation ------------------------------
    if (
      !Number.isSafeInteger(input.actionVersion) ||
      input.actionVersion < 0 ||
      input.actionVersion > MAX_ACTION_VERSION
    ) {
      return {
        status: "rejected",
        code: "INVALID_INPUT",
        message: `actionVersion must be an integer in [0, ${MAX_ACTION_VERSION}], got ${input.actionVersion}`,
      };
    }
    if (!YMD.test(input.asOf)) {
      return {
        status: "rejected",
        code: "INVALID_INPUT",
        message: `asOf must be YYYY-MM-DD, got "${input.asOf}"`,
      };
    }
    if (typeof input.parentRunId !== "string" || input.parentRunId.trim().length === 0) {
      return {
        status: "rejected",
        code: "INVALID_INPUT",
        message: "parentRunId (the PM seat's tick run) is required",
      };
    }

    // ---- 0b. Instance gate: the project must be INSTANTIATED --------------
    // (deliverable 3). The instance pins the template package/id, the PM
    // seat, and the cinatra project refinement — dispatch never proceeds on
    // an un-instantiated project scope.
    const instance = await readProjectInstance(input.orgId, input.projectRef);
    if (!instance) {
      return {
        status: "rejected",
        code: "PROJECT_NOT_INSTANTIATED",
        message: `project "${input.projectRef}" has no instance in org ${input.orgId} — instantiate it before dispatching`,
      };
    }

    // ---- 0c. PM-SEAT gate: server-derived parent-run authority ------------
    // The caller supplies only the run ID; org, agent package, project, and
    // the OBO ceiling compose operand are read from the persisted run row.
    const parentRun = await readAgentRunById(input.parentRunId);
    if (!parentRun || parentRun.orgId !== input.orgId) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `parent run "${input.parentRunId}" does not exist in org ${input.orgId}`,
      };
    }
    // A TERMINAL run cannot be the dispatching tick: nominating an old
    // completed/failed PM run (e.g. one with a broader historical ceiling)
    // is refused — only a live seat run dispatches.
    if (TERMINAL_RUN_STATUSES.has(parentRun.status as AgentRunStatus)) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `parent run "${input.parentRunId}" is terminal (${parentRun.status}) — only a live PM tick run can dispatch`,
      };
    }
    // Lease-identity binding: the project lease must be held AS the seat tick
    // run (holderId === the parent run id), so a caller cannot pair one run's
    // seat authority with a lease acquired under a different identity.
    if (input.lease.holderId !== parentRun.id) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `lease holder "${input.lease.holderId}" is not the parent tick run "${parentRun.id}" — the project lease must be held by the dispatching seat run`,
      };
    }
    if (instance.projectId !== null && parentRun.projectId !== instance.projectId) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `parent run "${input.parentRunId}" does not belong to the instance's cinatra project "${instance.projectId}"`,
      };
    }
    const seatTemplate = await readAgentTemplateById(parentRun.templateId);
    if (!seatTemplate || seatTemplate.packageName !== instance.pmAgentPackage) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `parent run "${input.parentRunId}" is not a run of the project's PM seat "${instance.pmAgentPackage}"`,
      };
    }
    // The seat must STILL carry the pm-work-store binding (fail-closed against
    // a reinstall/downgrade that dropped it after instantiation).
    const seatManifest = await resolveInstalledAgentManifest(instance.pmAgentPackage, input.orgId);
    if (!seatManifest || !agentManifestDeclaresPmSeat(seatManifest.manifest)) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `"${instance.pmAgentPackage}" no longer resolves to an installed agent declaring the required pm-work-store binding — dispatch fails closed`,
      };
    }

    // ---- 0d. Template authority: the instance's pinned installed template --
    // Resolved from the FINALIZED store payload (never caller bytes); the
    // stable template id must equal the instance's pinned template_id.
    const templateResolution = await resolveInstalledProjectTemplate(
      instance.templatePackage,
      input.orgId,
    );
    if (!templateResolution.ok) {
      return {
        status: "failed",
        code: "TEMPLATE_UNRESOLVED",
        message: `the instance's template package "${instance.templatePackage}" does not resolve to a finalized install with a valid template (${templateResolution.reason}${templateResolution.detail ? `: ${templateResolution.detail}` : ""})`,
      };
    }
    const projectTemplate = templateResolution.template;
    if (projectTemplate.id !== instance.templateId) {
      return {
        status: "rejected",
        code: "PROJECT_TEMPLATE_MISMATCH",
        message: `installed template id "${projectTemplate.id}" does not match the instance's pinned template id "${instance.templateId}" — refusing a template swap under the same project ref`,
      };
    }
    // Worker-ref EXACT-MATCH re-assertion against the SAME finalized
    // manifest's dependency edges — the install gate's "one truth source"
    // rule, re-run HERE because the shared install pipeline finalizes the
    // store payload BEFORE the native agent handler's gate runs: a dispatch
    // racing that window (or reading a payload whose gate rejection is still
    // being compensated) must never allowlist a worker the manifest does not
    // declare. Fail-closed on unreadable edges.
    try {
      const edges = parseManifestDependencyEdges(templateResolution.manifest, {
        packageName: instance.templatePackage,
      }).edges;
      const workerRefViolations = checkTemplateWorkerRefsAgainstDependencies(
        projectTemplate,
        edges,
      );
      if (workerRefViolations.length > 0) {
        return {
          status: "rejected",
          code: "TEMPLATE_WORKER_REFS_INVALID",
          message:
            `installed template of "${instance.templatePackage}" violates the one-truth-source ` +
            `worker-ref rule: ` +
            workerRefViolations.map((v) => `[${v.code}] ${v.path}`).join("; "),
        };
      }
    } catch (err) {
      return {
        status: "rejected",
        code: "TEMPLATE_WORKER_REFS_INVALID",
        message: `installed manifest of "${instance.templatePackage}" has unreadable dependency edges — dispatch fails closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ---- 1. Worker policy: template-task binding + allowlist -------------
    // The pick's task id is the natural-key suffix (task ids are separator-free
    // by contract). The template task's own worker binding is the one truth
    // source; the allowlist membership check is defense-in-depth (the binding
    // is in the allowlist by construction for a validated template).
    const prefix = `${input.projectRef}${PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR}`;
    if (!input.pick.startsWith(prefix)) {
      return {
        status: "rejected",
        code: "PICK_UNKNOWN",
        message: `pick "${input.pick}" is outside project scope "${input.projectRef}"`,
      };
    }
    const taskId = input.pick.slice(prefix.length);
    const task = projectTemplate.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        status: "rejected",
        code: "PICK_UNKNOWN",
        message: `pick "${input.pick}" does not correspond to a template task`,
      };
    }
    if (!task.worker) {
      return {
        status: "rejected",
        code: "WORKER_NOT_ALLOWLISTED",
        message: `task "${taskId}" is a human/manual task — it has no worker binding to dispatch`,
      };
    }
    if (task.worker.role !== input.role) {
      return {
        status: "rejected",
        code: "WORKER_NOT_ALLOWLISTED",
        message: `role "${input.role}" is not task "${taskId}"'s worker binding ("${task.worker.role}")`,
      };
    }
    const allowlisted = templateWorkerAllowlist(projectTemplate).find(
      (w) => w.role === input.role && w.packageName === task.worker?.packageName,
    );
    if (!allowlisted) {
      return {
        status: "rejected",
        code: "WORKER_NOT_ALLOWLISTED",
        message: `role "${input.role}" is not in the template worker allowlist`,
      };
    }

    // ---- 2. Deterministic ready validation (Acceptance 3) ----------------
    const item = input.items.find((it) => it.naturalKey === input.pick);
    if (!item) {
      return {
        status: "rejected",
        code: "PICK_UNKNOWN",
        message: `pick "${input.pick}" is not among the project's work items`,
      };
    }
    const notReady = itemNotReadyReason(item, {
      asOf: input.asOf,
      statusByKey: indexItemStatusByKey(input.items),
    });
    if (notReady !== null) {
      return {
        status: "rejected",
        code: "ITEM_NOT_READY",
        notReadyReason: notReady,
        message: `item "${input.pick}" is not ready: ${notReady}`,
      };
    }

    // ---- 3. Lease-fenced write-ahead ledger claim -------------------------
    const begin = await beginDispatchAttempt({
      orgId: input.orgId,
      projectRef: input.projectRef,
      itemNaturalKey: input.pick,
      actionVersion: input.actionVersion,
      workerRole: allowlisted.role,
      workerPackage: allowlisted.packageName,
      workerVersionConstraint: versionConstraintFingerprint(allowlisted.versionConstraint),
      lease: input.lease,
    });
    if (begin.kind === "lease_not_held") {
      return {
        status: "rejected",
        code: "LEASE_NOT_HELD",
        message: `caller does not hold the live lease for project "${input.projectRef}" (holder "${input.lease.holderId}" v${input.lease.version})`,
      };
    }
    const attempt = begin.attempt;

    // Immutable-binding drift check: the same deliberate-attempt identity must
    // never execute a DIFFERENT worker binding — role, package, OR version
    // constraint (a template change requires a new actionVersion).
    if (
      begin.kind === "existing" &&
      (attempt.projectRef !== input.projectRef ||
        attempt.workerRole !== allowlisted.role ||
        attempt.workerPackage !== allowlisted.packageName ||
        attempt.workerVersionConstraint !==
          versionConstraintFingerprint(allowlisted.versionConstraint))
    ) {
      return {
        status: "rejected",
        code: "DISPATCH_ATTEMPT_CONFLICT",
        message:
          `attempt (${input.pick}, v${input.actionVersion}) is bound to ` +
          `${attempt.workerRole}=${attempt.workerPackage}@${attempt.workerVersionConstraint} ` +
          `in project "${attempt.projectRef}" — refusing to execute a different binding under the same action version`,
      };
    }

    // A dispatched attempt is already SETTLED — gate failures below must not
    // try to re-settle it.
    const alreadySettled = attempt.status === "dispatched";
    const settleFailed = async (error: string) => {
      if (!alreadySettled) await settleFailedBestEffort(attempt, error);
    };

    // ---- 4. Host safety gate chain (workflow-agent-executor, verbatim) ----
    // Runs BEFORE the already-dispatched short-circuit so even the
    // enqueue-REPAIR of a previously dispatched run stays behind the tenancy
    // and runtime-lifecycle gates (reviving an archived agent's queued run is
    // a dispatch too).
    const template = await readAgentTemplateByPackageName(allowlisted.packageName);
    if (!template) {
      await settleFailed(`AGENT_UNRESOLVED: ${allowlisted.packageName}`);
      return {
        status: "failed",
        code: "AGENT_UNRESOLVED",
        message: `could not resolve worker agent package "${allowlisted.packageName}"`,
      };
    }

    // Tenancy fail-closed: the resolved template MUST belong to the project's
    // auth-derived org, or be a public/null-origin template. A foreign-org
    // template would let a project in org A execute org B's agent under A's
    // tenancy and cost attribution.
    if (template.orgId !== null && template.orgId !== input.orgId) {
      await settleFailed(`AGENT_CROSS_ORG: ${template.id}`);
      return {
        status: "failed",
        code: "AGENT_CROSS_ORG",
        message: `agent ${template.id} is not available in org ${input.orgId}`,
      };
    }

    // Runtime-lifecycle gate (cinatra#659), fail-CLOSED on runtime archive.
    if (!(await agentTemplateRuntimeRunnable(template.packageName))) {
      await settleFailed(`AGENT_NOT_INSTALLED: ${template.id}`);
      return {
        status: "failed",
        code: "AGENT_NOT_INSTALLED",
        message: `agent ${template.id} is disabled or uninstalled (no active install)`,
      };
    }

    // ---- 5. Idempotent short-circuit for an already-dispatched attempt ----
    if (begin.kind === "existing" && attempt.status === "dispatched") {
      if (!attempt.runId) {
        return {
          status: "failed",
          code: "DISPATCH_RUN_MISSING",
          message: `attempt ${attempt.id} is dispatched but carries no run id`,
        };
      }
      const existingRun = await readAgentRunById(attempt.runId);
      if (!existingRun) {
        return {
          status: "failed",
          code: "DISPATCH_RUN_MISSING",
          message: `attempt ${attempt.id} dispatched run ${attempt.runId}, which no longer exists — never re-dispatching under the same action version`,
        };
      }
      // Repair the enqueue if the prior tick crashed between createAgentRun
      // and enqueueAgentRun (gate-checked above, like any dispatch).
      if (existingRun.status === "queued") {
        await enqueueAgentRun(
          { runId: existingRun.id },
          { ...enqueueDepsForTemplate(template), softPreflight: true },
        );
      }
      return { status: "already_dispatched", runId: attempt.runId, attemptId: attempt.id };
    }
    // 'pending' or 'failed' → recovery: fall through to the dispatch chain
    // with the SAME ledgered idempotency key.

    // Pin the run to the latest published version snapshot (mirrors the
    // agent_run MCP handler and the workflow agent_task executor).
    const versions = await readAgentVersionsByTemplate(template.id);
    const latestVersionId = versions[0]?.id;

    const runId = `run_${randomUUID()}`;
    let run;
    try {
      run = await createAgentRun({
        id: runId,
        templateId: template.id,
        versionId: latestVersionId,
        inputParams: input.runInput,
        runBy: input.runBy ?? undefined,
        // Tenant is the project's auth-derived org, never a body id.
        orgId: input.orgId,
        // The cinatra project refinement is the INSTANCE's persisted binding
        // (one truth) — never a per-dispatch input.
        projectId: instance.projectId,
        // Idempotent dispatch provenance — the ledgered key, VERBATIM.
        idempotencyKey: attempt.idempotencyKey,
        // Child linkage + OBO ceiling composition (W5): the child's ceiling is
        // server-derived over its OWN anchored scope inside createAgentRun;
        // the parent chain is the seat run's PERSISTED chain (read server-side
        // in step 0c) as the compose operand only — never copied, never
        // accepted from input.
        parentRunId: parentRun.id,
        parentOboCeiling: parentRun.oboCeiling ?? null,
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === OBO_CEILING_DISJOINT_CODE) {
        const message = err instanceof Error ? err.message : String(err);
        await settleFailedBestEffort(attempt, `OBO_CEILING_DISJOINT: ${message}`);
        return {
          status: "failed",
          code: "OBO_CEILING_DISJOINT",
          message: `child ceiling composition is provably disjoint — dispatch fails closed: ${message}`,
        };
      }
      throw err;
    }

    // Enqueue when THIS dispatch inserted the run, OR when an idempotent hit
    // (run.id !== runId) is still `queued` — the prior tick may have crashed
    // between createAgentRun and enqueueAgentRun, and this re-dispatch must
    // repair that gap. The worker's queued→running CAS guards any
    // double-enqueue. softPreflight: the tick has no live session actor — a
    // missing connector/LLM provider surfaces as a run failure at execution,
    // not a hard enqueue block (workflow-executor rule, verbatim).
    if (run.id === runId || run.status === "queued") {
      await enqueueAgentRun(
        { runId: run.id },
        { ...enqueueDepsForTemplate(template), softPreflight: true },
      );
    }

    // ---- 6. Settle the ledger --------------------------------------------
    const settled = await settleDispatchAttempt({
      id: attempt.id,
      expectedVersion: attempt.version,
      status: "dispatched",
      runId: run.id,
    });
    if (settled.kind === "conflict") {
      // The child run exists and is enqueued; the ledger row was concurrently
      // settled to a DIFFERENT result. Surface — never overwrite.
      return {
        status: "failed",
        code: "DISPATCH_ATTEMPT_CONFLICT",
        message:
          `run ${run.id} was dispatched but attempt ${attempt.id} was concurrently settled to ` +
          `${settled.attempt ? `${settled.attempt.status}/${settled.attempt.runId ?? "no run"}` : "a deleted row"}`,
      };
    }
    return {
      status: "dispatched",
      runId: run.id,
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotencyKey,
    };
  } catch (err) {
    return {
      status: "failed",
      code: "PROJECT_DISPATCH_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
