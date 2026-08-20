#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WARN-FIRST ROLLOUT — how the chat-HITL evidence gates start enforcing
// (cinatra#2821).
//
// THE ROLLOUT RULE. A new gate must not turn an in-flight branch red in
// the middle of its review. So the gate enforces only for branches CREATED
// AFTER it lands; every branch that existed before is warned, not failed, and
// the epic's open branches are additionally listed by name so the decision is
// explicit rather than inferred from a timestamp.
//
// TWO GRANDFATHER AXES, because each covers what the other cannot:
//
//   1. BRANCH age. A branch whose first own commit predates `gateLandedAt` --
//      or that is named in `grandfatheredBranches` -- is warned. This is what
//      protects a review already in progress.
//   2. FINDING identity. Some findings are pre-existing debt ON MAIN (today:
//      two chat-cell captures nobody ever validated). A branch created after
//      the gate lands should not be red for debt it did not create, so those
//      exact findings are listed in `knownFindings` and stay warnings until the
//      slice that owns them clears the list. A finding NOT on the list fails
//      that branch immediately -- which is the entire point of landing the gate.
//
// FAIL-OPEN IS DELIBERATE HERE, and only here: when the branch or its age
// cannot be determined (a detached checkout, a shallow clone), the gate warns.
// A rollout mechanism that guesses "enforce" would red exactly the branches it
// was written to protect. The findings are still printed either way.
// ---------------------------------------------------------------------------

/** @typedef {{key: string, code: string, detail: string}} Finding */

/**
 * Decide whether this run enforces.
 *
 * @param {{branch?: string|null, branchCreatedAt?: string|null, policy: object, now?: Date}} input
 * @returns {{enforce: boolean, reason: string}}
 */
export function resolveEnforcement({ branch, branchCreatedAt, policy, now }) {
  const mode = policy?.enforcement ?? "warn-first";
  if (mode === "off") {
    return { enforce: false, reason: "the policy switches the gate off" };
  }
  if (mode === "enforce-all") {
    return { enforce: true, reason: "the policy enforces on every branch" };
  }
  if (mode !== "warn-first") {
    return {
      enforce: false,
      reason: `unknown enforcement mode "${mode}" -- warning rather than guessing`,
    };
  }
  const trunk = policy?.trunkBranch ?? "main";
  if (!branch) {
    return { enforce: false, reason: "the branch could not be determined" };
  }
  if (branch === trunk) {
    return {
      enforce: false,
      reason: `"${trunk}" carries the pre-existing findings; the gate reports them there without blocking`,
    };
  }
  const listed = policy?.grandfatheredBranches ?? [];
  if (listed.includes(branch)) {
    return {
      enforce: false,
      reason: `"${branch}" is explicitly grandfathered (in flight when the gate landed)`,
    };
  }
  const landed = Date.parse(policy?.gateLandedAt ?? "");
  if (!Number.isFinite(landed)) {
    return { enforce: false, reason: "the policy carries no valid `gateLandedAt`" };
  }
  const created = Date.parse(branchCreatedAt ?? "");
  if (!Number.isFinite(created)) {
    return {
      enforce: false,
      reason: "the branch's first-commit date could not be read (shallow clone?)",
    };
  }
  if (created < landed) {
    return {
      enforce: false,
      reason: `the branch's first commit (${new Date(created).toISOString()}) predates the gate landing (${new Date(landed).toISOString()})`,
    };
  }
  const nowMs = (now ?? new Date()).getTime();
  if (nowMs < landed) {
    return { enforce: false, reason: "the gate has not landed yet" };
  }
  return {
    enforce: true,
    reason: `the branch was created after the gate landed (${new Date(landed).toISOString()})`,
  };
}

/**
 * Split findings into the ones that can fail this run and the ones the policy
 * grandfathers by identity.
 *
 * @param {Finding[]} findings
 * @param {object} policy
 */
export function partitionFindings(findings, policy) {
  const known = new Set(policy?.knownFindings ?? []);
  const blocking = [];
  const grandfathered = [];
  for (const f of findings) {
    (known.has(f.key) ? grandfathered : blocking).push(f);
  }
  return { blocking, grandfathered };
}

/**
 * The whole rollout decision for one run: what fails, what only warns, and the
 * exit code that follows from it.
 */
export function decideOutcome({ findings, policy, branch, branchCreatedAt, now }) {
  const enforcement = resolveEnforcement({ branch, branchCreatedAt, policy, now });
  const { blocking, grandfathered } = partitionFindings(findings, policy);
  const failing = enforcement.enforce ? blocking : [];
  return {
    enforce: enforcement.enforce,
    reason: enforcement.reason,
    blocking,
    grandfathered,
    failing,
    exitCode: failing.length > 0 ? 1 : 0,
  };
}
