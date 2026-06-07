/**
 * Orchestrator dispatch worker.
 *
 * This module coordinates federated per-agent workspaces:
 *
 *  - Worker entry (`runOrchestratorJob`). Branches on
 *    `data.phase` at entry so the SAME BullMQ job name (AGENT_BUILDER_EXECUTION)
 *    can carry both the initial orchestrator dispatch (no `phase` field) and
 *    the rollup invocation fired by BullMQ's FlowProducer after all children
 *    complete (`phase: "rollup"`). The rollup branch is the contract point
 *    that keeps dispatch and rollup behavior shaped consistently.
 *
 *  - Dispatch implementation (static parallel fan-out): resolves every
 *    `agentDependencies[pkg]` to a concrete version,
 *    creates one child `agent_run` per dependency with `parentRunId` + pinned
 *    `packageVersion`, writes a coordination-only ledger to the orchestrator's
 *    `stepResults`, enqueues a FlowProducer tree via `enqueueChildFlow`, and
 *    returns. The parent parks in waiting-children state until the rollup
 *    branch fires.
 *
 * State-isolation invariant: the orchestrator row's `stepResults` contains
 * ONLY the strict `OrchestratorLedger` schema — no child domain data is ever
 * copied through the parent. Every attempt to write foreign keys is rejected
 * by the zod parse in read paths.
 *
 * Actor isolation: every `createAgentRun` call passes `runBy: run.runBy` —
 * the child inherits the parent's actor exactly once, at creation time, and
 * can never be retargeted. `runBy` follows the same tamper-resistant story as
 * `parentRunId` via the standard insert path.
 *
 * Retry-budget mitigation: every child flow job is enqueued with
 * `attempts: Number.MAX_SAFE_INTEGER` UPFRONT so `WaitingForHumanError`
 * throws do not exhaust the default retry count. This value is applied at
 * dispatch time and is not retroactively mutated.
 */
import { z } from "zod";
import semver from "semver";
import {
  readAgentRunById,
  readAgentTemplates,
  transitionRunStatus,
  RunTransitionError,
  TERMINAL_RUN_STATUSES,
  type AgentRunStatus,
} from "./store";
import { publishAgUiEvent } from "@cinatra-ai/agent-ui-protocol/server";

// ---------------------------------------------------------------------------
// TERMINAL_STATUSES — shared constant used by rollup + cancel paths.
// Kept here (the orchestrator module) rather than in execution.ts because
// only orchestrator paths need to reason about terminal-vs-non-terminal
// child runs when aggregating ledger state.
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
]);

// ---------------------------------------------------------------------------
// Ledger schema.
//
// Strict: extra keys are rejected. State-isolation invariant is a TYPE-level
// guarantee, enforced by zod at every persistence boundary.
// ---------------------------------------------------------------------------

export const OrchestratorLedgerEntrySchema = z
  .object({
    childRunId: z.string(),
    packageName: z.string(),
    packageVersion: z.string(),
    status: z.string(), // free-form AgentRunStatus — same union as agent_runs.status
    a2aTaskId: z.string().nullable(),
    artifactIds: z.array(z.string()).optional(),
  })
  .strict();

export const OrchestratorLedgerSchema = z.array(OrchestratorLedgerEntrySchema);

export type OrchestratorLedgerEntry = z.infer<typeof OrchestratorLedgerEntrySchema>;
export type OrchestratorLedger = z.infer<typeof OrchestratorLedgerSchema>;

// ---------------------------------------------------------------------------
// Pure helper — buildLedgerFromChildren.
//
// Maps createAgentRun results to ledger entries. NO child domain data is
// allowed through this mapping — only the coordination-level fields required
// for parent dashboards and rollup state rehydration.
// ---------------------------------------------------------------------------

export function buildLedgerFromChildren(
  children: Array<{
    runId: string;
    packageName: string;
    packageVersion: string;
    a2aTaskId: string | null;
    status: string;
  }>,
): OrchestratorLedger {
  return children.map((c) => ({
    childRunId: c.runId,
    packageName: c.packageName,
    packageVersion: c.packageVersion,
    status: c.status,
    a2aTaskId: c.a2aTaskId,
  }));
}

// ---------------------------------------------------------------------------
// Dependency resolver — reuses the installed-version lookup used by
// assertOrchestratorReady (execution.ts). A small copy rather than a shared
// util import to keep the orchestrator self-contained. If the installed
// version does not satisfy the declared semver range, we STILL pin to the
// installed version (matching assertOrchestratorReady's warn-don't-block
// precedent) — future tightening can harden this to a hard block.
// ---------------------------------------------------------------------------

async function resolveInstalledVersion(
  packageName: string,
  requiredRange: string,
): Promise<string> {
  const found = await readAgentTemplates({
    packageName,
    status: "published",
    limit: 1,
  });
  const installed = found.items[0];
  if (!installed || !installed.packageVersion) {
    throw new Error(
      `Orchestrator dispatch: no installed published template for ${packageName} — run \`cinatra agents install ${packageName}\``,
    );
  }
  if (!semver.satisfies(installed.packageVersion, requiredRange)) {
    console.warn(
      `[agent-builder] Orchestrator sub-agent ${packageName}@${installed.packageVersion} does not satisfy required range ${requiredRange} (pinning to installed version)`,
    );
  }
  return installed.packageVersion;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Typed coercion for ledger -> stepResults patch argument.
function toStepResults(ledger: OrchestratorLedger): Record<string, unknown>[] {
  return ledger as unknown as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// cancelOrchestratorRun.
//
// Fan-out cancel: for every non-terminal child in the orchestrator's ledger
// with an a2aTaskId, issue an A2A cancelTask. Cancellation is bounded to the
// orchestrator's own ledger — it cannot reach another orchestrator's
// children. Children whose runBy differs from the orchestrator's runBy are
// skipped. Per-child failures are tolerated: the error is logged and fan-out
// continues.
//
// After fan-out completes, the orchestrator transitions to "stopped".
// ---------------------------------------------------------------------------

export type CancelOrchestratorActor = {
  actorType: string;
  source: string;
};

export async function cancelOrchestratorRun(
  orchRunId: string,
  _actor?: CancelOrchestratorActor,
): Promise<void> {
  const run = await readAgentRunById(orchRunId);
  if (!run) {
    throw new Error(`cancelOrchestratorRun: run ${orchRunId} not found`);
  }

  // Parse the ledger defensively. Non-orchestrator runs or runs without a
  // ledger get a best-effort no-op on fan-out (still transitions to stopped).
  const rawLedger = (run.stepResults ?? []) as unknown;
  const parsed = OrchestratorLedgerSchema.safeParse(rawLedger);
  const ledger: OrchestratorLedger = parsed.success ? parsed.data : [];

  // Lazy load the A2A client factory — keeps the cold start of non-cancel
  // paths free of the @a2a-js/sdk import weight.
  const { createInProcessA2AClient } = await import("@cinatra-ai/a2a");
  const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES, cancelBackgroundJob } =
    await import("@/lib/background-jobs");

  for (const entry of ledger) {
    if (TERMINAL_STATUSES.has(entry.status)) continue;

    // Never cancel a child whose runBy differs from the orchestrator.
    const child = await readAgentRunById(entry.childRunId);
    if (!child) {
      console.warn(
        `[agent-builder] cancelOrchestratorRun: child ${entry.childRunId} not found — skipping`,
      );
      continue;
    }
    // Treat null==null as "unknown owner" — not the same actor. Require
    // both sides to be a non-null string AND equal before allowing cancel.
    const runBy = (run as { runBy?: string | null }).runBy;
    const childRunBy = (child as { runBy?: string | null }).runBy;
    if (!runBy || !childRunBy || childRunBy !== runBy) {
      console.warn(
        `[agent-builder] cancelOrchestratorRun: child ${entry.childRunId} runBy mismatch — skipping`,
      );
      continue;
    }

    if (!entry.a2aTaskId) {
      // Fallback for children dispatched without an A2A task: cancel the BullMQ job
      // directly — jobId == childRunId per the dispatch loop above.
      try {
        await cancelBackgroundJob(entry.childRunId);
      } catch (err) {
        console.warn(
          `[agent-builder] cancelOrchestratorRun: cancelBackgroundJob failed for child ${entry.childRunId}: ${err instanceof Error ? err.message : String(err)} — continuing fan-out`,
        );
      }
      continue;
    }

    try {
      const client = await createInProcessA2AClient({
        packageName: entry.packageName,
        enqueueJob: async (jobName: string, data: unknown) => {
          await enqueueBackgroundJob(
            jobName as typeof BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
            data as Record<string, unknown>,
          );
        },
      });
      await client.cancelTask(entry.a2aTaskId);
    } catch (err) {
      console.warn(
        `[agent-builder] cancelOrchestratorRun: cancelTask failed for child ${entry.childRunId}: ${err instanceof Error ? err.message : String(err)} — continuing fan-out`,
      );
    }
  }

  // Shape C — Pitfall 3: read current status first, gate on terminal, transition
  // with source status. Source is heterogeneous: cancelOrchestratorRun fires from
  // UI regardless of whether the run is queued / running / pending_approval /
  // pending_input, so we look up the current status and dispatch through the
  // CAS-guarded transition. stale_from_status = benign race (someone else already
  // terminated the run between our read and CAS).
  const orch = await readAgentRunById(orchRunId);
  if (!orch) {
    // Defensive: the run record has vanished between the initial read at the top
    // of cancelOrchestratorRun and now. Log and exit cleanly.
    console.warn(
      `[cancelOrchestratorRun] run ${orchRunId} not found — skipping status transition`,
    );
    return;
  }
  if (TERMINAL_RUN_STATUSES.has(orch.status as AgentRunStatus)) {
    // Already terminal — no-op. The ledger fan-out above still ran; we just
    // don't re-transition an already-terminated run.
    return;
  }
  let transitioned = true;
  await transitionRunStatus(
    orchRunId,
    orch.status as AgentRunStatus,
    "stopped",
    { stepResults: toStepResults(ledger) },
  ).catch((err) => {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      // Race: someone else terminated the orchestrator run between our read and
      // CAS. Safe to ignore — the run is already terminal either way. The
      // winner publishes its own terminal frame; we skip the emit below.
      transitioned = false;
      return;
    }
    throw err;
  });

  if (!transitioned) return;

  // Publish RUN_FINISHED so SSE-bound UI (useAgUiRunStream) flips status to
  // "stopped". Without this the orchestrator-stepper-panel never sees the
  // terminal frame after a user-initiated Pause: handlePause sets isPaused
  // true, but the running-status useEffect immediately resets it because the
  // SSE stream still reports "running". Mirrors the completed-path emit.
  await Promise.resolve(
    publishAgUiEvent(orchRunId, {
      type: "RUN_FINISHED",
      threadId: orchRunId,
      runId: orchRunId,
      status: "stopped",
      timestamp: Date.now(),
    } as never),
  ).catch(() => undefined);
}
