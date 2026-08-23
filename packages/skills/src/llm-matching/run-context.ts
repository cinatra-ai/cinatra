/**
 * Frozen run-context minting for the skill matcher (setup-flow S6).
 *
 * A `SkillMatchRunContext` — `{provider, model, evaluatorVersion}` — is minted
 * EXACTLY ONCE at run creation (batch submit, first inline fan-out invocation,
 * drift-sample run, maintenance tick, admin per-pair re-evaluation) from the
 * committed default provider AT THAT INSTANT, then threaded through every
 * stage of that run. No stage re-resolves the live default mid-run: an admin
 * default change mid-run must not alter any in-flight stage.
 *
 * `resolveConfiguredLlmRuntime()` is the resolved-model exposure seam — the
 * `model` it reports is read straight off the resolved adapter's
 * `defaultModel`, i.e. the model a subsequent call with no explicit `model`
 * really lands on.
 *
 * A `null` mint means "no LLM runtime this matcher can run on" — nothing
 * resolved, or what resolved is the scripted deterministic TEST runtime, which
 * is not a provider and which the matcher has no path for. Callers treat this
 * as a CLEAN SKIP: last-good rows are retained, a job-level skipped-pair count
 * is logged, and nothing throws (failure taxonomy: absence of a runtime is a
 * state, not an error).
 */

import {
  resolveConfiguredLlmRuntime,
  isScriptedLlmRuntime,
  probeBatchCapability,
  type LlmProvider,
} from "@cinatra-ai/llm";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { LLM_MATCHER_VERSION } from "./constants";
import type { SkillMatchRunContext } from "./types";

/**
 * Injectable seam so job handlers / tests can control minting without mocking
 * the whole `@cinatra-ai/llm` barrel.
 */
export type MintRunContext = () => Promise<SkillMatchRunContext | null>;

export async function mintSkillMatchRunContext(): Promise<SkillMatchRunContext | null> {
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) return null;
  // cinatra#2910 — the scripted DETERMINISTIC TEST runtime is not a provider.
  // A context minted from it would carry `provider: "scripted"` into code that
  // treats the field as an `LlmProvider`: `submitSkillMatchBatch` probes the
  // batch capability for it and submits a provider batch under that id
  // (jobs.ts), i.e. a cast would turn a test runtime into a real-provider call.
  // The matcher has no scripted path, so this is the CLEAN SKIP the null mint
  // already means (last-good rows retained, skipped pairs counted, nothing
  // throws) — stated here with its reason instead of leaking downstream.
  if (isScriptedLlmRuntime(runtime)) {
    console.info(
      "[skill-matcher] the scripted test LLM runtime resolved (no real provider is " +
        "configured) — skipping the matcher run; last-good rows stand",
    );
    return null;
  }
  return {
    provider: runtime.provider,
    model: runtime.model,
    evaluatorVersion: LLM_MATCHER_VERSION,
  };
}

/**
 * Which transport a run on `provider` would take (capability routing): a
 * declared batch surface (v2 or the OpenAI-canonical v1) means the provider
 * batch path; no surface means the chunked synchronous fan-out. Used by the
 * admin dry-run so the confirmation modal describes the run truthfully.
 */
export async function probeSkillMatchBatchMode(
  provider: string,
): Promise<"batch" | "synchronous"> {
  const support = await probeBatchCapability(provider as LlmProvider);
  return support.batchVersion !== null ? "batch" : "synchronous";
}

/**
 * Explicit actor source for the skill-match background paths (setup-flow S6).
 *
 * Production deterministic LLM calls fail closed without an actor frame, and
 * the SKILL_MATCH_* background handlers historically minted none — every
 * matcher evaluation dispatched from a worker failed in production mode. The
 * dispatch site builds this System identity and threads it (via the handler
 * deps) into `evaluatePair`'s `generate()` calls. `skill_matches` is
 * instance-level (no org axis), so no organizationId is carried. Mirrors
 * `buildArtifactMatcherActorContext` (src/lib/artifacts/matcher-runtime.ts).
 */
export function buildSkillMatchWorkerActorContext(jobLabel: string): ActorContext {
  return {
    principalType: "System",
    principalId: `skill-matcher:${jobLabel}`,
    teamIds: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Runtime shape-guard for run contexts rehydrated from BullMQ payloads or the
 * batch-run record. Returns the context when structurally valid, else null
 * (callers then mint fresh or skip — never proceed on a forged/partial shape).
 */
export function coerceRunContext(value: unknown): SkillMatchRunContext | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // cinatra#2910 — a rehydrated context never re-enters the run on the scripted
  // runtime either: minting refuses it above, so a payload carrying it is stale
  // or forged, and the provider-keyed reads downstream would cast it to a real
  // provider. Rejecting here keeps the two doors shut with the same rule.
  if (candidate.provider === "scripted") return null;
  if (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    typeof candidate.evaluatorVersion === "string" &&
    candidate.evaluatorVersion.length > 0
  ) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      evaluatorVersion: candidate.evaluatorVersion,
    };
  }
  return null;
}
