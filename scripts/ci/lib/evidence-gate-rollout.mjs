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
 * THE ONE READING of a rollout policy. Every field the rollout reads, with the
 * rollout's own defaults (`??`: an absent field and an explicit `null` are the
 * same) and no further checking. `resolveEnforcement` and `partitionFindings`
 * read the policy only through this function, and the base comparison in
 * `chat-hitl-evidence-gate.mjs` reads it through `effectiveRolloutPolicy`
 * below, so the two cannot drift (cinatra#3832).
 *
 * @param {object} policy
 */
export function readRolloutPolicy(policy) {
  return {
    mode: policy?.enforcement ?? "warn-first",
    trunk: policy?.trunkBranch ?? "main",
    listed: policy?.grandfatheredBranches ?? [],
    landed: Date.parse(policy?.gateLandedAt ?? ""),
    known: policy?.knownFindings ?? [],
  };
}

/**
 * What a mode value means to the rollout: `off`, `enforce-all`, `warn-first`,
 * or `disabled` for any other value (the rollout warns rather than guessing,
 * so an unknown mode enforces nothing).
 */
export function effectiveMode(mode) {
  return mode === "off" || mode === "enforce-all" || mode === "warn-first" ? mode : "disabled";
}

/**
 * Decide whether this run enforces.
 *
 * @param {{branch?: string|null, branchCreatedAt?: string|null, policy: object, now?: Date}} input
 * @returns {{enforce: boolean, reason: string}}
 */
export function resolveEnforcement({ branch, branchCreatedAt, policy, now }) {
  const { mode, trunk, listed, landed } = readRolloutPolicy(policy);
  const kind = effectiveMode(mode);
  if (kind === "off") {
    return { enforce: false, reason: "the policy switches the gate off" };
  }
  if (kind === "enforce-all") {
    return { enforce: true, reason: "the policy enforces on every branch" };
  }
  if (kind !== "warn-first") {
    return {
      enforce: false,
      reason: `unknown enforcement mode "${mode}" -- warning rather than guessing`,
    };
  }
  if (!branch) {
    return { enforce: false, reason: "the branch could not be determined" };
  }
  if (branch === trunk) {
    return {
      enforce: false,
      reason: `"${trunk}" carries the pre-existing findings; the gate reports them there without blocking`,
    };
  }
  if (listed.includes(branch)) {
    return {
      enforce: false,
      reason: `"${branch}" is explicitly grandfathered (in flight when the gate landed)`,
    };
  }
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

/** A value read as a list of names the way the rollout reads one; null when it is no list. */
function nameList(value) {
  return Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === "string"))].sort() : null;
}

/**
 * A policy reduced to what the rollout would DO with it: the effective mode
 * and, only for a mode that reads them, the fields in the shape the rollout
 * reads them. A field the rollout ignores in this mode is absent.
 *
 *   off, disabled  no field: nothing can fail.
 *   enforce-all    `knownFindings` (it still moves a finding from failing to
 *                  grandfathered).
 *   warn-first     `knownFindings`, `trunk` (a string, else null: no branch
 *                  equals it), `grandfatheredBranches` and `startMs` (the
 *                  landing date, null when there is no valid one: the rollout
 *                  then enforces nothing).
 *
 * A list field that is not an array (a string, a number, an object) is `null`:
 * the rollout reads it by accident (a string by substring, the rest throw), so
 * a caller that must be safe treats null as unreadable. Entries that are not
 * strings can equal no branch and no finding and are dropped.
 *
 * @param {object} policy
 */
export function effectiveRolloutPolicy(policy) {
  const { mode, trunk, listed, landed, known } = readRolloutPolicy(policy);
  const kind = effectiveMode(mode);
  const out = { mode: kind };
  if (kind === "off" || kind === "disabled") return out;
  out.knownFindings = nameList(known);
  if (kind === "enforce-all") return out;
  out.trunk = typeof trunk === "string" ? trunk : null;
  out.grandfatheredBranches = nameList(listed);
  out.startMs = Number.isFinite(landed) ? landed : null;
  return out;
}

/**
 * Split findings into the ones that can fail this run and the ones the policy
 * grandfathers by identity.
 *
 * @param {Finding[]} findings
 * @param {object} policy
 */
export function partitionFindings(findings, policy) {
  const known = new Set(readRolloutPolicy(policy).known);
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
