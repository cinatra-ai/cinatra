import type { GateEntry } from "../state/gates";
import type { DependencyOutcome } from "../spec/types";

// Runtime gate evaluation. Computes the three orthogonal gates
// (timing / dependency / approval) for a task from its current context, with
// reasons + blocker refs for "why is this blocked?". Pure — the reconciler
// persists the returned ledger.

export type DependencyEdge = { dependsOnTaskId: string; dependsOnKey?: string; outcome: DependencyOutcome };

export type TaskGateContext = {
  dueAtUtc: Date | null;
  now: Date;
  dependencies: DependencyEdge[];
  /** taskId → current status of the upstream task. */
  depStatusById: Map<string, string>;
  /** Whether this task has an approval gate. */
  hasApproval: boolean;
  /** The approval's status (pending/granted/rejected/needs_revision), if any. */
  approvalStatus?: string;
};

type DepResolution = "satisfied" | "blocked" | "pending";

/** Per-edge dependency-outcome semantics. */
export function resolveDependency(upstreamStatus: string, outcome: DependencyOutcome): DepResolution {
  switch (outcome) {
    case "success":
      if (upstreamStatus === "succeeded") return "satisfied";
      if (upstreamStatus === "failed" || upstreamStatus === "skipped" || upstreamStatus === "cancelled")
        return "blocked";
      return "pending";
    case "skipped":
      if (upstreamStatus === "succeeded" || upstreamStatus === "skipped") return "satisfied";
      if (upstreamStatus === "failed" || upstreamStatus === "cancelled") return "blocked";
      return "pending";
    case "failed":
      // Compensation edge — runs only if the upstream failed.
      if (upstreamStatus === "failed") return "satisfied";
      if (upstreamStatus === "succeeded" || upstreamStatus === "skipped" || upstreamStatus === "cancelled")
        return "blocked";
      return "pending";
    default:
      return "pending";
  }
}

export function evaluateTaskGates(ctx: TaskGateContext): GateEntry[] {
  const gates: GateEntry[] = [];

  // Timing gate.
  if (ctx.dueAtUtc) {
    const due = ctx.dueAtUtc.getTime() <= ctx.now.getTime();
    gates.push({
      kind: "timing",
      state: due ? "passed" : "pending",
      reason: due ? undefined : `Not due until ${ctx.dueAtUtc.toISOString()}`,
    });
  } else {
    gates.push({ kind: "timing", state: "passed" });
  }

  // Dependency gate.
  if (ctx.dependencies.length === 0) {
    gates.push({ kind: "dependency", state: "passed" });
  } else {
    const blockers: string[] = [];
    const pending: string[] = [];
    for (const dep of ctx.dependencies) {
      const status = ctx.depStatusById.get(dep.dependsOnTaskId) ?? "idle";
      const res = resolveDependency(status, dep.outcome);
      if (res === "blocked") blockers.push(dep.dependsOnKey ?? dep.dependsOnTaskId);
      else if (res === "pending") pending.push(dep.dependsOnKey ?? dep.dependsOnTaskId);
    }
    if (blockers.length > 0) {
      gates.push({
        kind: "dependency",
        state: "blocked",
        reason: `Blocked by upstream outcome: ${blockers.join(", ")}`,
        blockerRefs: blockers,
      });
    } else if (pending.length > 0) {
      gates.push({
        kind: "dependency",
        state: "pending",
        reason: `Waiting on: ${pending.join(", ")}`,
        blockerRefs: pending,
      });
    } else {
      gates.push({ kind: "dependency", state: "passed" });
    }
  }

  // Approval gate.
  if (ctx.hasApproval) {
    const granted = ctx.approvalStatus === "granted";
    gates.push({
      kind: "approval",
      state: granted ? "passed" : "pending",
      reason: granted ? undefined : `Awaiting approval (${ctx.approvalStatus ?? "pending"})`,
    });
  } else {
    gates.push({ kind: "approval", state: "not_required" });
  }

  return gates;
}
