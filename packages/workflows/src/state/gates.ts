// Three orthogonal gates (timing / dependency / approval) in a per-task ledger,
// each evaluated independently with explainability
// (reason/details/blocker refs). A node dispatches only when ALL
// three gates pass (§9). Effective task readiness is DERIVED, never stored.

export const GATE_KINDS = ["timing", "dependency", "approval"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const GATE_STATES = ["pending", "passed", "blocked", "not_required"] as const;
export type GateState = (typeof GATE_STATES)[number];

export type GateEntry = {
  kind: GateKind;
  state: GateState;
  reason?: string;
  details?: Record<string, unknown>;
  blockerRefs?: unknown[];
};

// Derived (not stored) readiness summary for a task across its gate ledger.
export const EFFECTIVE_GATE_STATES = [
  "dispatchable", // all gates passed/not_required
  "scheduled", // approval granted/not-required but timing not yet due
  "pending_approval", // timing + deps satisfied, approval still pending
  "blocked", // a dependency or timing gate is blocked
] as const;
export type EffectiveGateState = (typeof EFFECTIVE_GATE_STATES)[number];

export type GateEvaluation = {
  state: EffectiveGateState;
  /** Human/assistant-readable reasons for any non-passed gate. */
  blockers: { kind: GateKind; reason: string; blockerRefs?: unknown[] }[];
};

function gate(ledger: readonly GateEntry[], kind: GateKind): GateEntry | undefined {
  return ledger.find((g) => g.kind === kind);
}

function passed(g: GateEntry | undefined): boolean {
  return !g || g.state === "passed" || g.state === "not_required";
}

/**
 * Derive a task's effective readiness from its gate ledger. A node is
 * `dispatchable` only when all present gates pass. The intermediate states
 * (`scheduled`, `pending_approval`, `blocked`) explain *why* a node is not yet
 * dispatchable, with blocker reasons for the UI/assistant "why is this blocked?".
 */
export function deriveEffectiveGateState(ledger: readonly GateEntry[]): GateEvaluation {
  const timing = gate(ledger, "timing");
  const dependency = gate(ledger, "dependency");
  const approval = gate(ledger, "approval");

  const blockers: GateEvaluation["blockers"] = [];
  for (const g of ledger) {
    if (g.state === "blocked" || g.state === "pending") {
      blockers.push({
        kind: g.kind,
        reason: g.reason ?? `${g.kind} gate is ${g.state}`,
        blockerRefs: g.blockerRefs,
      });
    }
  }

  // A genuinely blocked dependency or timing gate dominates.
  if (dependency?.state === "blocked" || timing?.state === "blocked") {
    return { state: "blocked", blockers };
  }

  const timingAndDepsOk = passed(timing) && passed(dependency);

  if (timingAndDepsOk && approval && approval.state === "pending") {
    return { state: "pending_approval", blockers };
  }

  // Approval granted/not-required but timing not yet due → scheduled.
  if (!timingAndDepsOk && passed(approval) && passed(dependency)) {
    return { state: "scheduled", blockers };
  }

  if (passed(timing) && passed(dependency) && passed(approval)) {
    return { state: "dispatchable", blockers: [] };
  }

  return { state: "blocked", blockers };
}

export function isDispatchable(ledger: readonly GateEntry[]): boolean {
  return deriveEffectiveGateState(ledger).state === "dispatchable";
}
