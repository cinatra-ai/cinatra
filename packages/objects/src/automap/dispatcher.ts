// ---------------------------------------------------------------------------
// Agent-output dispatcher.
// ---------------------------------------------------------------------------
//
// The dispatcher consumes:
//   - the agent's raw output `data`,
//   - the target `typeId` (from the classifier or the producing skill),
//   - the type's `identityKey` (for dedup),
//   - the type's `crudPolicy` (CRUD semantics + HITL thresholds),
//   - the classifier's confidence,
//   - a "find existing object by identity" callback (DI for tests).
//
// It returns a deterministic + idempotent `DispatchDecision`. The caller
// then performs the corresponding `objects_save / objects_update` call via
// `createSessionObjectsClient` (or routes the `hitl` event to the HITL
// surface). Keeping the decision PURE means duplicate-detection, merge,
// partial-update + HITL-fallback are all unit-testable without a DB.

import {
  type AutomapCrudPolicy,
  DEFAULT_HITL_CONFIDENCE_THRESHOLD,
} from "./policy";

/** What the dispatcher decided to do. */
export type DispatchDecision =
  | { kind: "create"; typeId: string; data: Record<string, unknown> }
  | { kind: "update"; typeId: string; objectId: string; data: Record<string, unknown> }
  | { kind: "merge";  typeId: string; objectId: string; data: Record<string, unknown> }
  | { kind: "skip";   typeId: string; objectId: string; reason: string }
  | { kind: "hitl";   typeId: string; reason: string; output: Record<string, unknown> };

export type ExistingObject = { id: string; data: Record<string, unknown> };

export type DecideDispatchInput = {
  typeId: string;
  output: Record<string, unknown>;
  policy: AutomapCrudPolicy;
  identityKey: ((data: Record<string, unknown>) => string | null) | undefined;
  classifierConfidence?: number;
  /** The existing object whose identityKey matches the output, or null. */
  existing: ExistingObject | null;
};

/**
 * Pure dispatch decision. No DB I/O; no async. Callers do the lookup +
 * write; this fn only decides which write to make (or to escalate to HITL).
 */
export function decideDispatch(input: DecideDispatchInput): DispatchDecision {
  const { typeId, output, policy, identityKey, classifierConfidence, existing } = input;

  // 1. Classifier confidence gate.
  const threshold = policy.hitlConfidenceThreshold ?? DEFAULT_HITL_CONFIDENCE_THRESHOLD;
  if (classifierConfidence !== undefined && classifierConfidence < threshold) {
    return {
      kind: "hitl",
      typeId,
      reason: `classifier confidence ${classifierConfidence.toFixed(2)} < threshold ${threshold}`,
      output,
    };
  }

  // 2. Required-field gate.
  if (policy.requiredFields) {
    const missing = policy.requiredFields.filter((field) => {
      const v = output[field];
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });
    if (missing.length > 0) {
      return {
        kind: "hitl",
        typeId,
        reason: `required field(s) missing: ${missing.join(", ")}`,
        output,
      };
    }
  }

  // 3. Identity resolution.
  const identity = identityKey ? identityKey(output) : null;

  // 4. No identity AND policy says HITL on no-match → HITL.
  //    No identity AND policy says CREATE → create (the type is willing to mint
  //    bare records, e.g. transient notes).
  if (identity === null) {
    if (policy.onNoMatch === "hitl") {
      return {
        kind: "hitl",
        typeId,
        reason: "no resolvable identityKey for the output and onNoMatch=hitl",
        output,
      };
    }
    return { kind: "create", typeId, data: output };
  }

  // 5. Identity resolved + no existing → create or HITL by policy.
  if (existing === null) {
    if (policy.onNoMatch === "create") {
      return { kind: "create", typeId, data: output };
    }
    return {
      kind: "hitl",
      typeId,
      reason: `identityKey "${identity}" has no existing match and onNoMatch=hitl`,
      output,
    };
  }

  // 6. Identity resolved + existing match → apply onMatch.
  if (policy.onMatch === "skip") {
    return { kind: "skip", typeId, objectId: existing.id, reason: `identity "${identity}" already exists; policy.onMatch=skip` };
  }

  if (policy.onMatch === "merge") {
    const mergeable = new Set(policy.mergeableFields ?? []);
    const merged: Record<string, unknown> = { ...existing.data };
    for (const [key, value] of Object.entries(output)) {
      if (mergeable.has(key)) {
        merged[key] = mergeArrayOrPreferIncoming(existing.data[key], value);
      } else {
        merged[key] = value;
      }
    }
    // preserveOnUpdate fields stay on the existing record even under merge.
    for (const field of policy.preserveOnUpdate ?? []) {
      if (existing.data[field] !== undefined) merged[field] = existing.data[field];
    }
    return { kind: "merge", typeId, objectId: existing.id, data: merged };
  }

  // Default: onMatch === "update". Replace-with-incoming, but PRESERVE
  // any explicitly-preserved fields from the existing record.
  const updated: Record<string, unknown> = { ...output };
  for (const field of policy.preserveOnUpdate ?? []) {
    if (existing.data[field] !== undefined) updated[field] = existing.data[field];
  }
  return { kind: "update", typeId, objectId: existing.id, data: updated };
}

function mergeArrayOrPreferIncoming(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    // Order-preserving dedup by JSON-shape equality (handles strings + objects).
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of [...existing, ...incoming]) {
      const key = typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? String(item)
        : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  return incoming ?? existing;
}
