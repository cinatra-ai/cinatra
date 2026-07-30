// Instance tool policy EVALUATION (cinatra#2017 S2 slice K4, design §2.6 / D4 /
// §10-A3). Pure — the invoker's step-2 floor and the `tools_list` per-row
// `policyStatus` both call `evaluateInstanceToolPolicy`. Persistence lives in the
// core store (`src/lib/connector-instance-tool-policy-store.ts`); this module
// owns ONLY the decision logic, so it is unit-testable without a DB.
//
// Matching is ALWAYS on the full server-qualified `{serverId, name}` pair
// (R2-M3 / R3-M3) — NEVER a bare name. Deny precedence is ABSOLUTE (§10-A3).

/** Server-qualified tool identity. `serverId` is the STABLE, OPAQUE host-owned
 *  id (§10-A1); `name` is the (slash-bearing on triad servers) ability/tool
 *  name. Structurally identical to the SDK contract's `SiteToolRef`. */
export type ToolRef = {
  serverId: string;
  name: string;
};

export type InstanceToolPolicyMode = "open" | "restricted";

/** A persisted per-`(connectorKey, instanceId)` policy record (§2.6). */
export type InstanceToolPolicyRecord = {
  connectorKey: string;
  instanceId: string;
  mode: InstanceToolPolicyMode;
  allow?: ToolRef[];
  deny?: ToolRef[];
  updatedBy: string;
  updatedAt: string;
};

export type InstanceToolPolicyStatus = "allowed" | "denied";

/** The reason a fallback / fail-closed verdict was reached — the caller uses it
 *  to warn-once / emit an audit event (§10-A3). Undefined on a normal verdict.
 *  `absent_policy_default_restricted` (cinatra#2022 S7 PR-δ): renamed from the
 *  pre-δ `absent_policy_fallback_open` — the compatibility OPEN window is
 *  deliberately ended, not extended; keeping the old name would misdescribe
 *  the current deny-by-default verdict. */
export type InstanceToolPolicyWarning =
  | "absent_policy_default_restricted"
  | "invalid_policy_deny_all";

export type InstanceToolPolicyDecision = {
  status: InstanceToolPolicyStatus;
  warn?: InstanceToolPolicyWarning;
};

function refEquals(a: ToolRef, b: ToolRef): boolean {
  return a.serverId === b.serverId && a.name === b.name;
}

function isValidToolRef(value: unknown): value is ToolRef {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.serverId === "string" &&
    r.serverId.length > 0 &&
    typeof r.name === "string" &&
    r.name.length > 0
  );
}

function isValidRefArray(value: unknown): value is ToolRef[] {
  if (value === undefined) return true; // optional — an absent list is valid
  if (!Array.isArray(value)) return false;
  return value.every(isValidToolRef);
}

/**
 * A record is VALID when its `mode` is a known literal and every present
 * allow/deny entry is a well-formed `{serverId, name}` ref. An unknown mode or a
 * malformed entry makes the WHOLE record invalid → fail-closed deny-all (§10-A3).
 */
export function isValidInstanceToolPolicyRecord(
  record: InstanceToolPolicyRecord | null | undefined,
): record is InstanceToolPolicyRecord {
  if (!record || typeof record !== "object") return false;
  if (record.mode !== "open" && record.mode !== "restricted") return false;
  if (!isValidRefArray(record.allow)) return false;
  if (!isValidRefArray(record.deny)) return false;
  return true;
}

/**
 * Evaluate the §10-A3 truth table for a resolved `{serverId, name}` tool ref.
 * Deny precedence is absolute; matching is always on the full pair.
 *
 * | Record state                            | Result                                        |
 * |------------------------------------------|-----------------------------------------------|
 * | absent (cinatra#2022 S7 PR-δ default)     | RESTRICTED+empty — deny-all; warn-once/instance|
 * | `open`                                    | allow every tool EXCEPT entries in `deny`      |
 * | `restricted`                              | allow ONLY `allow` minus `deny`; empty ⇒ deny  |
 * | invalid (unknown mode / malformed)        | deny-all (evaluate as restricted+empty) + warn |
 *
 * cinatra#2022 S7 PR-δ: the absent-record default FLIPS from OPEN to
 * RESTRICTED+empty here — this ends the pre-δ compatibility window outright,
 * with no data migration. A site owner must add an explicit allow entry (via
 * connector settings) before ANY ability is reachable for an instance with no
 * persisted policy row, on every surface (chat/in-admin/blog-publish/
 * freshness) alike, since this evaluator is surface-independent.
 */
export function evaluateInstanceToolPolicy(
  record: InstanceToolPolicyRecord | null | undefined,
  ref: ToolRef,
): InstanceToolPolicyDecision {
  // Absent → RESTRICTED+empty (deny-all). Pre-δ this was a compatibility
  // fallback to OPEN; δ ends that window. The caller
  // warns-once per instance (§2.6/§10-A3).
  if (record === null || record === undefined) {
    return { status: "denied", warn: "absent_policy_default_restricted" };
  }

  // Invalid (unknown mode, malformed entries) → fail-closed deny-all, evaluated
  // as `restricted` + empty `allow`; the caller emits an audit warn (§10-A3).
  if (!isValidInstanceToolPolicyRecord(record)) {
    return { status: "denied", warn: "invalid_policy_deny_all" };
  }

  // Deny is absolute in BOTH modes.
  const denied = (record.deny ?? []).some((r) => refEquals(r, ref));
  if (denied) return { status: "denied" };

  if (record.mode === "open") {
    return { status: "allowed" };
  }

  // restricted: allow ONLY entries in `allow` (minus deny, already handled).
  // Empty/absent `allow` ⇒ deny-all.
  const allowed = (record.allow ?? []).some((r) => refEquals(r, ref));
  return { status: allowed ? "allowed" : "denied" };
}
