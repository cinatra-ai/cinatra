import "server-only";

// ---------------------------------------------------------------------------
// THE ASSIGNED-SKILL INJECTION TIER (cinatra#2347 S2 — epic #2345).
//
// S1 gave the platform somewhere to remember "agent X uses skills A, B, C" that
// every kind of run can read. This module is the other half: the RESOLUTION-TIME
// loader that turns those rows into skill ids the delivery pipeline injects —
// and the place where an assignment that has since stopped being assignable
// stops being DELIVERED, not merely stops being pickable.
//
// It is deliberately a leaf with an injectable seam for each of its three reads,
// so the tier's fail-closed arms are provable without a database.
//
// WHY REVALIDATE AT ALL (issue scope item 3). Pick-time validation is not
// sufficient, and the two reasons are structural rather than hypothetical:
//
//   * a DERIVED extension skill carries a NULL `lifecycle_state`, and the
//     runtime-delivery gate in `agents-store` passes NULL through by design (the
//     extension install-state authority governs it elsewhere, so that gate never
//     becomes a second authority);
//   * archiving a skill-kind extension is a CATALOG NO-OP
//     (`packages/skills/src/extension-handler.ts`) — the catalog rows survive the
//     archive.
//
// So neither of the two gates a delivered id already passes would notice that
// the owning extension was archived, that the skill lost global visibility, or
// that its role changed. Only re-running the epic's shared assignability
// predicate does. `locked` is a LIVE state and stays deliverable — the predicate
// already treats active|locked as installed, which is exactly the contract this
// tier wants.
//
// The predicate is CONSUMED, never re-derived: `resolveSkillAssignability` from
// the public `@cinatra-ai/skills/agent-skill-assignability` subpath is the single
// definition S1, S2 and S3 all share.
//
// FAIL-CLOSED, NEVER FATAL (issue scope item 2). Every arm that cannot prove a
// skill is still assignable yields the EMPTY set and lets the run proceed: an
// assignment-store read failure, a revalidation throw, an unresolvable agent
// reference. A run losing its assigned skills is a degraded run; a run that
// ABORTS because an assignment table was briefly unreadable is an outage. The
// functions here therefore never reject.
// ---------------------------------------------------------------------------

import { readAssignedSkillsForAgentPackage } from "@/lib/agent-assigned-skills-store";
import {
  resolveSkillAssignability,
  type AssignabilityRefusal,
  type SkillAssignability,
} from "@cinatra-ai/skills/agent-skill-assignability";
import {
  resolveCanonicalAgentPackage,
  resolveCanonicalAgentPackageFrom,
  type AgentIdentityCandidate,
  type AgentPackageResolution,
} from "@cinatra-ai/skills/agent-package-resolver";

/** Why the tier produced nothing despite having been asked for a set. */
export type AssignedSkillTierDegradation =
  /** The agent reference resolved to no installed package (or to several). */
  | "agent-unresolved"
  /** The `agent_assigned_skills` read threw — fail closed, run proceeds. */
  | "assignment-read-failed"
  /** The shared assignability predicate threw — fail closed, run proceeds. */
  | "revalidation-failed";

/** A row that was read but withheld at resolution time, with the conjunct that
 *  refused it. `no-verdict` covers a predicate that returned no entry for an id
 *  it was asked about — treated as a refusal, never as an approval. */
export type WithheldAssignedSkill = {
  skillId: string;
  reason: AssignabilityRefusal | "no-verdict";
};

export type AssignedSkillTierOutcome = {
  /** Ordered (by stored `position`), deduped, REVALIDATED ids. */
  skillIds: string[];
  /** The canonical agent package the rows were read for; null when unresolved. */
  agentPackageName: string | null;
  /** Rows read but refused by revalidation. Empty on a degraded arm (nothing
   *  was evaluated), which is why `degraded` is reported separately. */
  withheld: WithheldAssignedSkill[];
  /** `null` when the tier ran to completion (including "there are no rows"). */
  degraded: AssignedSkillTierDegradation | null;
};

export type AssignedSkillTierDeps = {
  /** Ordered assignment rows for ONE canonical package. Default = the S1 store. */
  readAssignments?: (
    agentPackageName: string,
  ) => Promise<ReadonlyArray<{ skillId: string }>>;
  /** The shared S1 predicate. Default = the real one. NEVER re-implemented. */
  resolveAssignability?: (
    skillIds: readonly string[],
  ) => Promise<Map<string, SkillAssignability>>;
  /**
   * I/O agent resolution, used ONLY when the caller has no population to hand
   * (the degraded catalog-read path). Default = S1's canonical resolver, which
   * reads the installed-agent population through its own seam.
   */
  resolveAgentPackage?: (rawId: string) => Promise<AgentPackageResolution>;
};

/**
 * Render an identifier for a LOG LINE safely. A skill id and an agent reference
 * both originate off the wire; interpolating one into the message string would
 * make the log FORMAT caller-controlled (a `%s` or a newline could forge a
 * second record). Bounded, control-characters stripped, and always passed as a
 * console ARGUMENT. Mirrors S1's `forLog`.
 */
function forLog(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 200);
}

function degraded(
  reason: AssignedSkillTierDegradation,
  agentPackageName: string | null,
): AssignedSkillTierOutcome {
  return { skillIds: [], agentPackageName, withheld: [], degraded: reason };
}

/**
 * Resolve the assigned-skill tier for one agent reference.
 *
 * `population` is the caller's already-loaded installed-agent list. Passing it
 * keeps the hot path at ONE population read per resolution (the caller already
 * paid for it). Passing `null` — the degraded catalog-read path, which never got
 * a population — makes the tier resolve the agent itself through S1's canonical
 * resolver, so a catalog outage that left the agents reader healthy still
 * delivers assignments.
 *
 * NEVER REJECTS. Every failure is an empty set plus a `degraded` reason.
 */
export async function resolveAssignedSkillTier(
  agentId: string,
  population: readonly AgentIdentityCandidate[] | null,
  deps: AssignedSkillTierDeps = {},
): Promise<AssignedSkillTierOutcome> {
  const rawId = typeof agentId === "string" ? agentId.trim() : "";
  if (rawId === "") return degraded("agent-unresolved", null);

  // ---- (1) canonical agent package -------------------------------------
  let resolution: AgentPackageResolution;
  if (population) {
    resolution = resolveCanonicalAgentPackageFrom(rawId, population);
  } else {
    try {
      resolution = await (deps.resolveAgentPackage ?? resolveCanonicalAgentPackage)(rawId);
    } catch (err) {
      console.warn(
        "[agent-assigned-skills] agent resolution threw — no assigned skills delivered (fail-closed). agent / cause:",
        forLog(rawId),
        err instanceof Error ? err.message : err,
      );
      return degraded("agent-unresolved", null);
    }
  }
  if (!resolution.ok) {
    // An UNKNOWN reference is the overwhelmingly common case (an agent with no
    // assignments never had a row either), so it is not worth a warning; an
    // AMBIGUOUS one is a real configuration hazard and is surfaced.
    if (resolution.reason === "ambiguous") {
      console.warn(
        "[agent-assigned-skills] agent reference is AMBIGUOUS — refusing to guess, no assigned skills delivered. agent / matches:",
        forLog(rawId),
        (resolution.matches ?? []).map(forLog),
      );
    }
    return degraded("agent-unresolved", null);
  }
  const agentPackageName = resolution.packageName;

  // ---- (2) the stored assignment rows ----------------------------------
  let rows: ReadonlyArray<{ skillId: string }>;
  try {
    rows = await (deps.readAssignments ?? readAssignedSkillsForAgentPackage)(agentPackageName);
  } catch (err) {
    // Scope item 2: a read error fails CLOSED to empty and the run PROCEEDS.
    console.warn(
      "[agent-assigned-skills] assignment read failed — no assigned skills delivered (fail-closed); the run proceeds. agent / cause:",
      forLog(agentPackageName),
      err instanceof Error ? err.message : err,
    );
    return degraded("assignment-read-failed", agentPackageName);
  }

  // First-seen dedup over the stored order (`position` ASC). The store's PK
  // already makes a duplicate pair impossible; this keeps the tier a pure
  // function of its input even against a hand-edited row set.
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const row of rows ?? []) {
    const id = typeof row?.skillId === "string" ? row.skillId.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }
  if (orderedIds.length === 0) {
    return { skillIds: [], agentPackageName, withheld: [], degraded: null };
  }

  // ---- (3) resolution-time REVALIDATION --------------------------------
  let verdicts: Map<string, SkillAssignability>;
  try {
    verdicts = await (deps.resolveAssignability ?? resolveSkillAssignability)(orderedIds);
  } catch (err) {
    // The predicate is itself fail-closed, so a throw here means the seam broke
    // rather than a conjunct refusing. Either way: withhold everything, proceed.
    console.warn(
      "[agent-assigned-skills] assignability revalidation threw — no assigned skills delivered (fail-closed); the run proceeds. agent / cause:",
      forLog(agentPackageName),
      err instanceof Error ? err.message : err,
    );
    return degraded("revalidation-failed", agentPackageName);
  }

  const skillIds: string[] = [];
  const withheld: WithheldAssignedSkill[] = [];
  for (const id of orderedIds) {
    const verdict = verdicts?.get?.(id);
    if (verdict?.assignable === true) {
      skillIds.push(id);
      continue;
    }
    withheld.push({ skillId: id, reason: verdict?.reason ?? "no-verdict" });
  }
  if (withheld.length > 0) {
    console.warn(
      "[agent-assigned-skills] withheld assignment(s) at resolution time — the assignment survives in settings but is NOT delivered. agent / withheld:",
      forLog(agentPackageName),
      withheld.map((w) => `${forLog(w.skillId)}:${w.reason}`),
    );
  }
  return { skillIds, agentPackageName, withheld, degraded: null };
}

/** Ids-only convenience over {@link resolveAssignedSkillTier}. Never rejects. */
export async function resolveAssignedSkillTierIds(
  agentId: string,
  population: readonly AgentIdentityCandidate[] | null,
  deps: AssignedSkillTierDeps = {},
): Promise<string[]> {
  return (await resolveAssignedSkillTier(agentId, population, deps)).skillIds;
}
