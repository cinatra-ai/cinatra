/**
 * The PURE per-turn skill-delivery record builder (cinatra#2240).
 *
 * Turns the delivery seam's own outputs into the rows the durable record stores.
 * Deliberately dependency-free (types only) so every vehicle and the refusal
 * path are unit-testable without a database, a provider, or the runtime's
 * import graph.
 *
 * THE GAP THIS CLOSES (issue #2240, finding F8 of the #2094 S7 acceptance E2E):
 * a chat turn delivered skills to the provider and left NO durable trace, so
 * "which skills did this run actually get, via which vehicle?" was answerable
 * only at the wire. The agent-run path has had that record since cinatra#1368
 * (`agent_run_skills_used`); chat had none.
 *
 * TRUTHFULNESS RULES this builder enforces:
 *  - The VEHICLE is derived from the per-skill `deliveryMode` the adapter
 *    REPORTED, never guessed from the shape of the tool array. A single turn
 *    may legitimately mix modes (a personal inline delta alongside a native
 *    mount), and a turn-wide shape guess would mislabel both.
 *  - Anthropic's `provider_skill_id` + `skill_version` are read off the
 *    `container_skills` tool actually emitted — the exact reference that goes
 *    into `container.skills` on the wire.
 *  - Every resolved skill that was NOT delivered lands as an explicit
 *    `dropped` row with a reason. A drop is a first-class outcome (injection-
 *    contract cap, inline budget/body failure, Anthropic rank-and-truncate, or
 *    an unmountable OpenAI skill the adapter silently omitted from exposure) —
 *    it is NOT a refusal.
 *  - `refused` is ONLY the loud no-vehicle path (cinatra#2094 F11): skills were
 *    resolved and nothing could carry them, so the turn was refused. It is
 *    never used to describe an ordinary drop.
 */

import type { LlmProvider, LlmTool, SkillExposureEntry } from "@cinatra-ai/llm";

/** How the delivered skill actually travelled to the provider. */
export type SkillDeliveryVehicle = "container-skills" | "tool-mount" | "inline";

/** What happened to a resolved skill on this turn. */
export type SkillDeliveryOutcome = "delivered" | "dropped" | "refused";

/** One durable row: the fate of ONE resolved skill on ONE chat turn. */
export type TurnSkillDeliveryRow = {
  skillId: string;
  outcome: SkillDeliveryOutcome;
  provider: LlmProvider;
  /** Set iff `outcome === "delivered"`. */
  vehicle: SkillDeliveryVehicle | null;
  /** The adapter-reported `SkillDeliveryMode`. Set iff delivered. */
  deliveryMode: string | null;
  /** As reported by the adapter. Null on a non-delivered row. */
  invocationAttributable: boolean | null;
  /** Anthropic Custom Skill id named in `container.skills`; null elsewhere. */
  providerSkillId: string | null;
  /** Anthropic Custom Skill version named in `container.skills`; null elsewhere. */
  skillVersion: string | null;
  /** Set iff NOT delivered — why this resolved skill never reached the model. */
  nonDeliveryReason: string | null;
};

/**
 * `SkillDeliveryMode` → vehicle. The mode is the authoritative per-skill signal
 * the delivery ABI already carries; this is a pure relabelling of it into the
 * operator-facing vocabulary the issue asks for.
 */
export function vehicleForDeliveryMode(mode: string): SkillDeliveryVehicle | null {
  switch (mode) {
    case "anthropic_container":
      return "container-skills";
    case "openai_shell":
      return "tool-mount";
    case "gemini_inline":
    case "personal_inline":
      return "inline";
    default:
      // A mode this build does not know about is NOT silently coerced into a
      // vehicle — the caller records the row as undelivered-with-reason rather
      // than assert a transport it cannot name.
      return null;
  }
}

/**
 * Extract the Anthropic container references actually emitted, keyed by the
 * CATALOG skill id (the id the rest of the record is keyed on).
 */
function containerRefsByCatalogId(
  tools: readonly LlmTool[],
): Map<string, { providerSkillId: string; version: string }> {
  const refs = new Map<string, { providerSkillId: string; version: string }>();
  for (const tool of tools) {
    if ((tool as { type?: string }).type !== "container_skills") continue;
    const skills = (tool as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) continue;
    for (const entry of skills) {
      const e = entry as {
        skillId?: unknown;
        version?: unknown;
        catalogSkillId?: unknown;
      };
      if (typeof e.catalogSkillId !== "string" || typeof e.skillId !== "string") continue;
      refs.set(e.catalogSkillId, {
        providerSkillId: e.skillId,
        version: typeof e.version === "string" ? e.version : "",
      });
    }
  }
  return refs;
}

export type BuildTurnSkillDeliveryRowsInput = {
  provider: LlmProvider;
  /**
   * Every skill the injection contract RESOLVED for this turn — the
   * denominator. Anything here that is not in `exposure` is a drop.
   */
  requestedSkillIds: readonly string[];
  /** What the delivery adapter reported it actually delivered. */
  exposure: readonly SkillExposureEntry[];
  /** The tools the delivery emitted (mined for the Anthropic container refs). */
  tools?: readonly LlmTool[];
  /**
   * Drops the INJECTION CONTRACT recorded before delivery (the hard cap of 8),
   * plus the inline expansion's whole-skill drops. Both carry a machine reason.
   */
  contractDrops?: readonly { skillId: string; reason: string }[];
  /** Ids the Anthropic adapter rank-and-truncated off the request. */
  adapterDroppedSkillIds?: readonly string[];
  /** The adapter's human-readable truncation explanation, when it truncated. */
  adapterSelectionReason?: string;
  /**
   * Set ONLY on the loud no-vehicle refusal (cinatra#2094 F11). When present
   * EVERY resolved skill is recorded as `refused` with this reason — nothing
   * reached the model and the turn did not run.
   */
  refusalReason?: string | null;
};

/**
 * Build the durable rows for one chat turn. Pure: same input ⇒ same output,
 * ordered by `requestedSkillIds` first (delivery/injection rank order) so a
 * record read back is stable and diffable.
 */
export function buildTurnSkillDeliveryRows(
  input: BuildTurnSkillDeliveryRowsInput,
): TurnSkillDeliveryRow[] {
  const provider = input.provider;

  // The refusal is total by construction: the seam produced NO vehicle, so no
  // resolved skill reached the model. Record every one of them as refused —
  // that is precisely the set an operator needs to see.
  if (input.refusalReason) {
    const reason = input.refusalReason;
    return dedupeBySkillId(
      input.requestedSkillIds.map((skillId) => ({
        skillId,
        outcome: "refused" as const,
        provider,
        vehicle: null,
        deliveryMode: null,
        invocationAttributable: null,
        providerSkillId: null,
        skillVersion: null,
        nonDeliveryReason: reason,
      })),
    );
  }

  const containerRefs = containerRefsByCatalogId(input.tools ?? []);
  const rows: TurnSkillDeliveryRow[] = [];
  const delivered = new Set<string>();

  for (const entry of input.exposure) {
    const vehicle = vehicleForDeliveryMode(entry.deliveryMode);
    if (vehicle === null) {
      // Unknown mode: record the truth (it did not reach the model under any
      // vehicle this build can name) instead of inventing a transport.
      rows.push({
        skillId: entry.skillId,
        outcome: "dropped",
        provider,
        vehicle: null,
        deliveryMode: null,
        invocationAttributable: null,
        providerSkillId: null,
        skillVersion: null,
        nonDeliveryReason: `unrecognized delivery mode "${entry.deliveryMode}"`,
      });
      delivered.add(entry.skillId);
      continue;
    }
    const ref = containerRefs.get(entry.skillId);
    rows.push({
      skillId: entry.skillId,
      outcome: "delivered",
      provider,
      vehicle,
      deliveryMode: entry.deliveryMode,
      invocationAttributable: entry.invocationAttributable,
      providerSkillId: ref?.providerSkillId ?? null,
      skillVersion: ref?.version ? ref.version : null,
      nonDeliveryReason: null,
    });
    delivered.add(entry.skillId);
  }

  // Reasons for the drops we were TOLD about, keyed by skill id.
  const dropReasons = new Map<string, string>();
  for (const drop of input.contractDrops ?? []) {
    if (!dropReasons.has(drop.skillId)) dropReasons.set(drop.skillId, drop.reason);
  }
  const adapterReason =
    input.adapterSelectionReason ??
    `over the provider's per-request skill cap; rank-and-truncated off this ${provider} request`;
  for (const skillId of input.adapterDroppedSkillIds ?? []) {
    if (!dropReasons.has(skillId)) dropReasons.set(skillId, adapterReason);
  }

  // Every resolved-but-undelivered skill, INCLUDING ones no drop channel
  // reported (an OpenAI skill without an on-disk source path is simply absent
  // from `exposure` — the silent case finding F8 could not see).
  const undelivered = new Set<string>();
  for (const skillId of input.requestedSkillIds) {
    if (!delivered.has(skillId)) undelivered.add(skillId);
  }
  for (const skillId of dropReasons.keys()) {
    if (!delivered.has(skillId)) undelivered.add(skillId);
  }
  for (const skillId of undelivered) {
    rows.push({
      skillId,
      outcome: "dropped",
      provider,
      vehicle: null,
      deliveryMode: null,
      invocationAttributable: null,
      providerSkillId: null,
      skillVersion: null,
      nonDeliveryReason:
        dropReasons.get(skillId) ??
        `resolved for this turn but not delivered by the ${provider} vehicle`,
    });
  }

  return dedupeBySkillId(sortByRequestOrder(rows, input.requestedSkillIds));
}

function sortByRequestOrder(
  rows: TurnSkillDeliveryRow[],
  requestedSkillIds: readonly string[],
): TurnSkillDeliveryRow[] {
  const rank = new Map<string, number>();
  requestedSkillIds.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  return [...rows].sort((a, b) => {
    const ai = rank.get(a.skillId) ?? Number.MAX_SAFE_INTEGER;
    const bi = rank.get(b.skillId) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });
}

/** `(turn_id, skill_id)` is the PK — first row for a skill wins (a delivered
 *  row is always emitted before the drop sweep, so delivery always wins). */
function dedupeBySkillId(rows: TurnSkillDeliveryRow[]): TurnSkillDeliveryRow[] {
  const seen = new Set<string>();
  const out: TurnSkillDeliveryRow[] = [];
  for (const row of rows) {
    if (seen.has(row.skillId)) continue;
    seen.add(row.skillId);
    out.push(row);
  }
  return out;
}
