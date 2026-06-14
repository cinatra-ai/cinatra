/**
 * `preflightAgentCreation` hard pre-enqueue gate.
 *
 * Size/cap preflight happens before enqueue: exact offending skill and size are
 * reported; >30MB or unsynced is a configuration error, never a mid-run
 * failure after partial writes.
 *
 * This is the dispatch-boundary chokepoint. When pinned on Anthropic, this
 * preflight MUST fail closed (NEVER pass) before any LLM dispatch happens.
 * The wiring lives at the top of `handleAgentCreationReview` in
 * `agent-creation-review.ts` and runs AFTER JSON validation but BEFORE the
 * deterministic lint pass; a preflight failure aggregates into the same
 * blocker stream as a lint blocker.
 *
 * Standing invariants honoured:
 *   - NO-OP when `isAgentCreationPinActive()` is false; the dispatch site uses
 *     the operator-configured OpenAI default model (canonical "gpt-5.5"
 *     fallback — never base gpt-5).
 *   - When pinned on Anthropic, EVERY required skill must be: synced (row
 *     exists) + not stale + content-hash matches + governance permits +
 *     under the 30MB per-skill cap + the per-request set is ≤8.
 *   - ALL failures returned together (never first-only) so the operator sees
 *     the complete picture in a single configuration error.
 *
 * The preflight is provider-aware: when pin is openai (no Anthropic checks
 * fire) only the provider/model config check runs.
 */

import "server-only";

import {
  computeSkillContentHash,
  preflightAnthropicSkillSyncSizes,
  preflightSkillRequestSet,
  type SyncCandidateSkill,
} from "@cinatra-ai/llm";

// Anthropic hard per-request Custom Skills maximum, mirrored from
// `packages/llm/src/providers/anthropic-skill-tools.ts:23` —
// not re-exported from the package index, so duplicated here as a constant.
const ANTHROPIC_MAX_SKILLS_PER_REQUEST = 8;

// ---------------------------------------------------------------------------
// Failure-code union
// ---------------------------------------------------------------------------

export type AgentCreationPreflightFailure =
  | { code: "pin_not_configured"; message: string }
  | { code: "invalid_provider_config"; message: string }
  | { code: "environment_unavailable"; message: string }
  | { code: "catalog_unavailable"; message: string }
  | { code: "anthropic_opt_in_off"; message: string }
  | { code: "anthropic_no_skills_resolved"; message: string; emptyLanePackages: string[] }
  | { code: "skills_not_synced"; message: string; missingCatalogSkillIds: string[] }
  | { code: "skills_stale"; message: string; staleCatalogSkillIds: string[] }
  | { code: "skills_content_drift"; message: string; driftedCatalogSkillIds: string[] }
  | { code: "skills_governance_denied"; message: string; deniedCatalogSkillIds: string[] }
  | { code: "skill_size_cap_exceeded"; message: string; offendingCatalogSkillIds: string[]; byteSize?: number }
  | { code: "skill_request_cap_exceeded"; message: string; resolvedCount: number; maxPerRequest: number };

export type AgentCreationPreflightResult =
  | { ok: true; pinActive: false }
  | { ok: true; pinActive: true; provider: "openai" | "anthropic" | "gemini"; model: string }
  | { ok: false; pinActive: boolean; errors: AgentCreationPreflightFailure[] };

export type AgentCreationPreflightInput = {
  /** Flat de-duped catalog skill ids the dispatched lane(s) will reference. */
  requiredCatalogSkillIds: string[];
  /** Per-lane skill-set view (lane → skills) for the empty-lane check. */
  laneSkillSets: Array<{ agentPackageName: string; skillIds: string[] }>;
};

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Hard pre-enqueue gate. Fails as a CONFIGURATION ERROR before any authoring
 * writes. Returns all failures (not first-only).
 *
 * When `isAgentCreationPinActive()` returns false, no checks run and
 * `{ok:true, pinActive:false}` is returned — the dispatch site uses the
 * operator-configured OpenAI default model (canonical "gpt-5.5" fallback —
 * never base gpt-5).
 */
export async function preflightAgentCreation(
  input: AgentCreationPreflightInput,
): Promise<AgentCreationPreflightResult> {
  const errors: AgentCreationPreflightFailure[] = [];

  // (1) Pin-active gate — no-op when inactive.
  const { isAgentCreationPinActive, readAgentCreationLlmProviderFromDatabase,
          readAgentCreationModelFromDatabase, readAnthropicSkillSyncEnabledFromDatabase } =
    await import("@/lib/database");

  if (!isAgentCreationPinActive()) {
    return { ok: true, pinActive: false };
  }

  // (2) Provider/model configured.
  const providerRaw = readAgentCreationLlmProviderFromDatabase();
  const model = readAgentCreationModelFromDatabase();
  if (!providerRaw || !model) {
    errors.push({
      code: "pin_not_configured",
      message: `Agent-creation pin active but configuration is incomplete (provider=${JSON.stringify(providerRaw)}, model=${JSON.stringify(model)}). Configure agent_creation_llm_provider and agent_creation_model in the admin LLM UI.`,
    });
    return { ok: false, pinActive: true, errors };
  }
  if (providerRaw !== "openai" && providerRaw !== "anthropic" && providerRaw !== "gemini") {
    errors.push({
      code: "invalid_provider_config",
      message: `Invalid agent_creation_llm_provider value: "${providerRaw}". Must be one of openai, anthropic, gemini.`,
    });
    return { ok: false, pinActive: true, errors };
  }
  const provider = providerRaw as "openai" | "anthropic" | "gemini";

  // OpenAI/Gemini pinned → only need provider/model configured. Skip
  // Anthropic-specific checks.
  if (provider !== "anthropic") {
    return { ok: true, pinActive: true, provider, model };
  }

  // ---------------------------------------------------------------------
  // Anthropic-only checks
  // ---------------------------------------------------------------------

  // (3a) Any lane with zero resolved skills?
  const emptyLanePackages = input.laneSkillSets
    .filter((l) => l.skillIds.length === 0)
    .map((l) => l.agentPackageName);
  if (emptyLanePackages.length > 0) {
    errors.push({
      code: "anthropic_no_skills_resolved",
      message: `Agent-creation pin active on Anthropic but the following lane(s) resolved 0 catalog skills: [${emptyLanePackages.join(", ")}]. Anthropic dispatch requires container.skills to be non-empty (function-tool fallback risk).`,
      emptyLanePackages,
    });
  }

  // (3b) Anthropic skill upload opt-in.
  if (readAnthropicSkillSyncEnabledFromDatabase() !== true) {
    errors.push({
      code: "anthropic_opt_in_off",
      message: "Anthropic skill upload opt-in is OFF (anthropic_skill_sync_enabled). Enable in the admin Anthropic governance UI before pinning Anthropic for agent creation.",
    });
  }

  // (3c) Derive namespace (apiKeyFingerprint + environment).
  let fingerprint: string | null = null;
  let environment: string | null = null;
  try {
    const svc = await import("@/lib/anthropic-skill-sync-service");
    fingerprint = svc.deriveApiKeyFingerprint();
    environment = svc.deriveEnvironmentNamespace();
  } catch (err) {
    errors.push({
      code: "environment_unavailable",
      message: `Could not derive Anthropic sync namespace: ${err instanceof Error ? err.message : String(err)}.`,
    });
    // No point continuing the per-skill checks without a namespace.
    return { ok: false, pinActive: true, errors };
  }

  if (!fingerprint) {
    // No Anthropic API key configured → every required skill counts as
    // unsynced. Surface the underlying cause as missing rows.
    errors.push({
      code: "skills_not_synced",
      message: "No Anthropic API key configured — no sync rows can exist.",
      missingCatalogSkillIds: [...input.requiredCatalogSkillIds],
    });
    return { ok: false, pinActive: true, errors };
  }

  // (3d) Per-skill sync-row check + content-hash + governance + size cap.
  let dao: typeof import("@/lib/anthropic-skill-sync-dao");
  let svc: typeof import("@/lib/anthropic-skill-sync-service");
  let governanceMod: typeof import("@/lib/anthropic-skill-upload-governance");
  try {
    dao = await import("@/lib/anthropic-skill-sync-dao");
    svc = await import("@/lib/anthropic-skill-sync-service");
    governanceMod = await import("@/lib/anthropic-skill-upload-governance");
  } catch (err) {
    errors.push({
      code: "catalog_unavailable",
      message: `Could not load Anthropic skill sync helpers: ${err instanceof Error ? err.message : String(err)}.`,
    });
    return { ok: false, pinActive: true, errors };
  }

  // Read each sync row.
  const missingCatalogSkillIds: string[] = [];
  const staleCatalogSkillIds: string[] = [];
  const rowsByCatalogSkillId = new Map<string, { contentHash: string }>();
  for (const catalogSkillId of input.requiredCatalogSkillIds) {
    const row = await dao.readSyncRow(fingerprint, environment, catalogSkillId);
    if (!row) {
      missingCatalogSkillIds.push(catalogSkillId);
      continue;
    }
    if (row.stale === true) {
      staleCatalogSkillIds.push(catalogSkillId);
      continue;
    }
    rowsByCatalogSkillId.set(catalogSkillId, { contentHash: row.contentHash });
  }
  if (missingCatalogSkillIds.length > 0) {
    errors.push({
      code: "skills_not_synced",
      message: `Anthropic Custom Skills not synced for catalog ids: [${missingCatalogSkillIds.join(", ")}]. Run admin save to trigger sync.`,
      missingCatalogSkillIds,
    });
  }
  if (staleCatalogSkillIds.length > 0) {
    errors.push({
      code: "skills_stale",
      message: `Anthropic Custom Skills marked stale for catalog ids: [${staleCatalogSkillIds.join(", ")}]. These are no longer referenced.`,
      staleCatalogSkillIds,
    });
  }

  // Load candidates off-disk (filtered to requiredCatalogSkillIds) for hash
  // + governance + size checks.
  let allCandidates: SyncCandidateSkill[];
  try {
    allCandidates = await svc.buildSyncCandidates();
  } catch (err) {
    errors.push({
      code: "catalog_unavailable",
      message: `Could not read catalog skills off disk: ${err instanceof Error ? err.message : String(err)}.`,
    });
    return { ok: false, pinActive: true, errors };
  }
  const requiredSet = new Set(input.requiredCatalogSkillIds);
  const requiredCandidates = allCandidates.filter((c) => requiredSet.has(c.catalogSkillId));

  // Content-hash drift.
  const driftedCatalogSkillIds: string[] = [];
  for (const candidate of requiredCandidates) {
    const row = rowsByCatalogSkillId.get(candidate.catalogSkillId);
    if (!row) continue; // missing or stale already accounted for.
    const currentHash = computeSkillContentHash(candidate.skillMd, candidate.bundledFiles);
    if (currentHash !== row.contentHash) {
      driftedCatalogSkillIds.push(candidate.catalogSkillId);
    }
  }
  if (driftedCatalogSkillIds.length > 0) {
    errors.push({
      code: "skills_content_drift",
      message: `Anthropic Custom Skill content has drifted (catalog ids: [${driftedCatalogSkillIds.join(", ")}]). Re-sync to upload a new immutable version.`,
      driftedCatalogSkillIds,
    });
  }

  // Per-skill governance flag.
  const deniedCatalogSkillIds: string[] = [];
  for (const candidate of requiredCandidates) {
    if (!governanceMod.isAnthropicSkillUploadAllowedFromConfig(candidate)) {
      deniedCatalogSkillIds.push(candidate.catalogSkillId);
    }
  }
  if (deniedCatalogSkillIds.length > 0) {
    errors.push({
      code: "skills_governance_denied",
      message: `Per-skill Anthropic upload denied for catalog ids: [${deniedCatalogSkillIds.join(", ")}]. Lift the allowAnthropicUpload exclusion flag.`,
      deniedCatalogSkillIds,
    });
  }

  // 30MB per-skill cap.
  const sizeError = preflightAnthropicSkillSyncSizes(requiredCandidates);
  if (sizeError) {
    errors.push({
      code: "skill_size_cap_exceeded",
      message: sizeError.message,
      offendingCatalogSkillIds: sizeError.offendingSkillIds,
      byteSize: sizeError.byteSize,
    });
  }

  // ≤8 per request cap.
  // The cap is per-REQUEST, but dispatch sends one request per lane. Checking
  // the UNION would falsely block 3 lanes × 3 unique skills as 9-over-8 even
  // though no single request exceeds 3. Apply preflightSkillRequestSet to EACH
  // lane's skill set individually.
  for (const lane of input.laneSkillSets) {
    const requestCapError = preflightSkillRequestSet(lane.skillIds, ANTHROPIC_MAX_SKILLS_PER_REQUEST);
    if (requestCapError) {
      errors.push({
        code: "skill_request_cap_exceeded",
        message: `lane ${lane.agentPackageName}: ${requestCapError.message}`,
        resolvedCount: lane.skillIds.length,
        maxPerRequest: ANTHROPIC_MAX_SKILLS_PER_REQUEST,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, pinActive: true, errors };
  }
  return { ok: true, pinActive: true, provider, model };
}
