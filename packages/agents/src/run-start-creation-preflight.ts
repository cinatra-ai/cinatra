import type { AgentCreationPreflightResult } from "./preflight-agent-creation";
import { preflightAgentCreation } from "./preflight-agent-creation";
import { resolveRequiredCreationSkillIds } from "./resolve-required-creation-skill-ids";

void (null as unknown as AgentCreationPreflightResult);

// ---------------------------------------------------------------------------
// AGENT-CREATION PRE-ENQUEUE GATE FOR A RUN START (cinatra#2935, lifecycle-b
// W5d — lifted verbatim from the removed chat pre-router, which owned it).
//
// Mirrors the creation-review and source-write pre-enqueue gates: a run start
// MUST refuse to enqueue a creation flow when the Anthropic pin is active but
// the required catalog skills are not synced, governance opt-in is off, the sync
// namespace cannot be derived, or skill caps are exceeded.
//
// Pin INACTIVE (`isAgentCreationPinActive()` returns false until Anthropic
// governance + sync land): the entire gate is BYPASSED, so every existing
// dispatch stays byte-for-byte identical.
//
// Pin ACTIVE + provider !== "anthropic": a FIRST-PASS probe with empty
// `laneSkillSets` confirms provider/model config; catalog resolution and the
// skill checks are skipped because they apply only to Anthropic.
//
// Pin ACTIVE + provider === "anthropic": required catalog skills are resolved
// for THIS package via the strict resolver (which throws on catalog errors →
// surfaced as `catalog_unavailable`) and a SECOND-PASS preflight runs with the
// populated lane sets.
//
// NOT A CREATION-FLOW PACKAGE: nothing runs. The set is DERIVED from the agents
// package's own lane definitions (`getAgentCreationFlowPackages`), never a
// hand-kept literal.
// ---------------------------------------------------------------------------
/**
 * The refusal a run start owes when the creation preflight fails, or null when
 * it passes (which includes every package the gate does not cover). Composed
 * HERE so the handler barrel carries the call and not the sentence.
 */
export async function refuseIfCreationPreflightFails(
  packageName: string | null | undefined,
  identifierForError: string,
): Promise<{ error: string; code: string } | null> {
  const result = await runCreationPreflightForRunStart(packageName);
  if (result.ok) return null;
  return {
    error: `Cannot run ${identifierForError}: agent-creation preflight failed (${result.errorLabel}).`,
    code: "preflight_failed",
  };
}

export async function runCreationPreflightForRunStart(
  packageName: string | null | undefined,
): Promise<{ ok: true } | { ok: false; errorLabel: string }> {
  if (!packageName) return { ok: true };
  const { getAgentCreationFlowPackages } = await import("./creation-flow-packages");
  if (!getAgentCreationFlowPackages().has(packageName)) return { ok: true };

  const { isAgentCreationPinActive } = await import("@/lib/database");
  if (!isAgentCreationPinActive()) return { ok: true };

  const probe = await preflightAgentCreation({
    requiredCatalogSkillIds: [],
    laneSkillSets: [],
  });
  if (!probe.ok) {
    return {
      ok: false,
      errorLabel: probe.errors.map((e) => `${e.code}: ${e.message}`).join(" / "),
    };
  }
  if (!probe.pinActive || probe.provider !== "anthropic") return { ok: true };

  let laneSkillSets: Awaited<ReturnType<typeof resolveRequiredCreationSkillIds>>;
  try {
    laneSkillSets = await resolveRequiredCreationSkillIds([packageName]);
  } catch (err) {
    return {
      ok: false,
      errorLabel: `catalog_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const requiredCatalogSkillIds = Array.from(
    new Set(laneSkillSets.flatMap((l) => l.skillIds)),
  );
  const full = await preflightAgentCreation({ requiredCatalogSkillIds, laneSkillSets });
  if (!full.ok) {
    return {
      ok: false,
      errorLabel: full.errors.map((e) => `${e.code}: ${e.message}`).join(" / "),
    };
  }
  return { ok: true };
}
