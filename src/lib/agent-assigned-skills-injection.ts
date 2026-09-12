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
// definition S1, S2 and S3 all share. Its DECISION is inherited whole; only its
// catalog READ is injected — the PURE snapshot, never the syncing rebuild, because
// this tier runs per run dispatch (see `revalidateAgainstCatalogSnapshot`).
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
  EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP,
  resolveEffectiveAssignedSkills,
  type AssignedSkillScopeRow,
} from "@cinatra-ai/agents/effective-assigned-skills";
import {
  readCatalogSnapshotSource,
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
  /** True when the run's snapshot was absent, malformed or an unknown version
   *  and the SOLE legacy fallback (workspace plus the durable organization) was
   *  the chain that ran. The callers that audit scope decisions record it. */
  scopeUsedFallback: boolean;
  /** Distinct assigned ids the scope chain reached but the per-run cap of 5
   *  refused, in chain order. Never silent: an operator reads here why an
   *  assignment that exists in settings did not reach the run. */
  droppedOverEffectiveCap: string[];
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
  ) => Promise<ReadonlyArray<AssignedSkillScopeRow>>;
  /**
   * The shared S1 predicate. NEVER re-implemented. Default = the real one,
   * reading the catalog through the PURE snapshot source (see
   * {@link revalidateAgainstCatalogSnapshot} — the default must never inherit
   * the predicate's syncing catalog read on a per-dispatch path).
   */
  resolveAssignability?: (
    skillIds: readonly string[],
  ) => Promise<Map<string, SkillAssignability>>;
  /**
   * I/O agent resolution, used ONLY when the caller has no population to hand
   * (the degraded catalog-read path). Default = S1's canonical resolver, which
   * reads the installed-agent population through its own seam.
   */
  resolveAgentPackage?: (rawId: string) => Promise<AgentPackageResolution>;
  /**
   * THE RUN'S FROZEN SCOPES (cinatra#2815 S3, epic #2812) — not a seam but the
   * tier's scope INPUT, carried here so the two positional arguments stay what
   * they are.
   *
   * `snapshot` is the raw `assignment_scope_snapshot` payload of the run (or of
   * the assistant thread) this resolution is for. `durableOrgId` is the
   * instance's durable organization, which is the ONLY layer the sole legacy
   * fallback adds to the workspace when the payload is absent, malformed or an
   * unknown version.
   *
   * A caller that supplies NEITHER gets the narrowest possible answer — the
   * workspace layer alone — never the un-scoped package-wide set. A run's
   * delivered assignments must come from scopes somebody actually granted it.
   */
  runScope?: AssignedSkillDeliveryScope;
};

/** The scope input {@link AssignedSkillTierDeps.runScope} carries. */
export type AssignedSkillDeliveryScope = {
  /** The raw immutable snapshot payload of the run / assistant thread. */
  snapshot?: unknown;
  /** The instance's durable organization — the legacy fallback's org floor. */
  durableOrgId?: string | null;
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
  return {
    skillIds: [],
    agentPackageName,
    withheld: [],
    degraded: reason,
    scopeUsedFallback: false,
    droppedOverEffectiveCap: [],
  };
}

/**
 * The tier's DEFAULT revalidation: the SHARED S1 predicate, reading the catalog
 * through the PURE SNAPSHOT source.
 *
 * WHY THE READ IS INJECTED (coordinator-ordered pre-merge fix). The predicate's
 * `readCatalog` seam defaults to `readCatalogSource` →
 * `readSkillsCatalog()` → `syncInstalledSkillsToDatabase()`: a full catalog
 * rebuild — GitHub sync, disk scan, DB write, prefill enqueue. That default is
 * sized for the assignment WRITE path, which runs when an admin saves a pin.
 * This tier runs on EVERY run dispatch for every agent that has at least one
 * assignment, so inheriting it would make "an admin pinned a skill to this
 * agent" mean "every dispatch of this agent rebuilds the catalog" — the same
 * hazard class S3 documents for a per-keystroke picker search (cinatra#2352).
 * The zero-row short-circuit above already spares agents with no assignments;
 * this spares the agents the feature is actually for.
 *
 * `readSkillsCatalogSnapshot` reads the persisted rows and does nothing else,
 * and its freshness contract is exactly the one a read-only revalidation wants:
 * the catalog writers bump it transactionally and the lifecycle points call
 * `rebuildSkillsCatalog()` explicitly (cinatra#1364). A revalidation that
 * needed a rebuild to be correct would be asserting that the catalog is stale
 * at rest — which is the rebuild's problem, not this tier's.
 *
 * NOTHING ELSE MOVES: the other two leaf reads keep the predicate's defaults,
 * the conjuncts are untouched, and the predicate stays fail-closed end to end —
 * a snapshot read that THROWS still refuses every id rather than approving one.
 */
function revalidateAgainstCatalogSnapshot(
  skillIds: readonly string[],
): Promise<Map<string, SkillAssignability>> {
  return resolveSkillAssignability(skillIds, { readCatalog: readCatalogSnapshotSource });
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
  //
  // Guarded on BOTH arms, including the pure one. `resolveCanonicalAgentPackageFrom`
  // reads fields off every candidate, so a malformed population entry would throw
  // — and this function's caller is a resolver that USED to be total on that
  // input. "Never rejects" has to hold literally, not just for well-formed data,
  // or the whole fail-closed posture depends on the caller's data hygiene.
  let resolution: AgentPackageResolution;
  try {
    resolution = population
      ? resolveCanonicalAgentPackageFrom(rawId, population)
      : await (deps.resolveAgentPackage ?? resolveCanonicalAgentPackage)(rawId);
  } catch (err) {
    console.warn(
      "[agent-assigned-skills] agent resolution threw — no assigned skills delivered (fail-closed). agent / cause:",
      forLog(rawId),
      err instanceof Error ? err.message : err,
    );
    return degraded("agent-unresolved", null);
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

  // ---- (2b) THE EFFECTIVE-5 CHAIN (cinatra#2815 S3, epic #2812) --------
  //
  // The store's cap is per EXACT SCOPE, so the rows just read can legally carry
  // five project assignments, five organization ones and five workspace ones at
  // once. A run receives at most FIVE DISTINCT ids, taken along
  // project -> user -> team(s) -> organization -> workspace from the scopes its
  // creation FROZE — never a live column, never the actor's current teams.
  //
  // The chain, its first-seen dedupe (which replaces the flat dedupe this tier
  // used to do over the stored order) and the SOLE legacy fallback all live in
  // ONE pure module, consumed here and by the assistant delivery seam, because
  // two copies of one authority rule decide differently the first time one of
  // them is fixed.
  const effective = resolveEffectiveAssignedSkills(rows ?? [], {
    snapshot: deps.runScope?.snapshot,
    durableOrgId: deps.runScope?.durableOrgId ?? null,
    cap: EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP,
  });
  const orderedIds = effective.skillIds;
  if (effective.droppedOverCap.length > 0) {
    console.warn(
      "[agent-assigned-skills] the per-run effective cap of " +
        `${EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP} refused assignment(s) — they ` +
        "survive in settings but are NOT delivered to this run. agent / refused:",
      forLog(agentPackageName),
      effective.droppedOverCap.map(forLog),
    );
  }
  if (effective.fallbackDegraded) {
    console.warn(
      "[agent-assigned-skills] no usable assignment-scope snapshot AND no " +
        "durable organization — the chain narrowed to the WORKSPACE layer alone " +
        "(fail-closed, never wider). agent / reason:",
      forLog(agentPackageName),
      effective.fallbackDegraded,
    );
  }
  if (effective.unplaceableScopeKinds.length > 0) {
    console.warn(
      "[agent-assigned-skills] assignment row(s) carry a scope kind this build " +
        "cannot place — dropped, never widened. agent / kinds:",
      forLog(agentPackageName),
      effective.unplaceableScopeKinds.map(forLog),
    );
  }
  const scopeReport = {
    scopeUsedFallback: effective.usedFallback,
    droppedOverEffectiveCap: effective.droppedOverCap,
  };
  if (orderedIds.length === 0) {
    return {
      skillIds: [],
      agentPackageName,
      withheld: [],
      degraded: null,
      ...scopeReport,
    };
  }

  // ---- (3) resolution-time REVALIDATION --------------------------------
  let verdicts: Map<string, SkillAssignability>;
  try {
    verdicts = await (deps.resolveAssignability ?? revalidateAgainstCatalogSnapshot)(orderedIds);
  } catch (err) {
    // The predicate is itself fail-closed, so a throw here means the seam broke
    // rather than a conjunct refusing. Either way: withhold everything, proceed.
    console.warn(
      "[agent-assigned-skills] assignability revalidation threw — no assigned skills delivered (fail-closed); the run proceeds. agent / cause:",
      forLog(agentPackageName),
      err instanceof Error ? err.message : err,
    );
    return { ...degraded("revalidation-failed", agentPackageName), ...scopeReport };
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
  return { skillIds, agentPackageName, withheld, degraded: null, ...scopeReport };
}

/** Ids-only convenience over {@link resolveAssignedSkillTier}. Never rejects. */
export async function resolveAssignedSkillTierIds(
  agentId: string,
  population: readonly AgentIdentityCandidate[] | null,
  deps: AssignedSkillTierDeps = {},
): Promise<string[]> {
  return (await resolveAssignedSkillTier(agentId, population, deps)).skillIds;
}
