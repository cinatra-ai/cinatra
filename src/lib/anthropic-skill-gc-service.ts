import "server-only";

import {
  AnthropicSkillGcEngine,
  FetchAnthropicCustomSkillsGcClient,
  type AnthropicSkillGcStatePort,
  type GcResult,
} from "@cinatra-ai/llm";

import { readAnthropicConnectionFromDatabase } from "@/lib/database";
import { readAnthropicSkillSyncEnabledFromDatabase } from "@/lib/database";
import {
  listAllSyncRows,
  deleteSyncRowsForAnthropicSkill,
  withNamespaceSyncLock,
} from "@/lib/anthropic-skill-sync-dao";
import {
  countActiveLeasesForSkill,
  pruneExpiredLeases,
} from "@/lib/anthropic-skill-lease-dao";
import {
  deriveApiKeyFingerprint,
  deriveEnvironmentNamespace,
  ANTHROPIC_SKILL_LEASE_TTL_MS,
} from "@/lib/anthropic-skill-sync-service";

/**
 * App glue for the reference-counted / leased remote GC engine.
 *
 * This is an EXPLICIT maintenance operation, NOT on the hot agent-run path —
 * it is invoked from the admin governance-save action after pre-sync (sync
 * marks rows stale; GC then reclaims the ones that have aged past the grace
 * window with zero in-flight leases). Gated by the SAME global opt-in: OFF ⇒
 * fully inert (zero list, zero delete).
 *
 * Namespace = (apiKeyFingerprint, environment), matching sync. Serialized
 * against concurrent sync/GC for the namespace by the same advisory lock.
 * Fail-closed: an undeterminable namespace ⇒ no remote work.
 */

/**
 * GC stale-age GRACE window. The over-delete safety anchor: a row stale for
 * less than this is NEVER reclaimed even with zero leases. It MUST exceed
 * (lease TTL + the longest time a creation run can keep using a resolved skill
 * after resolution + clock skew).
 *
 * 30 min vs the 10-min lease TTL gives a ≥20-min post-lease margin. This is an
 * OPERATIONAL contract, not enforceable in-engine: a creation run that keeps
 * referencing a remote skill > ~20 min after the catalog removed it would
 * out-age the window. Creation runs are Opus-pinned and capped at ≤3 skills,
 * so they are far shorter than that; if run durations ever grow, raise GRACE
 * accordingly. The `GRACE > lease TTL` half of the contract IS asserted at
 * module load so the invariant fails loud instead of relying on prose.
 */
export const ANTHROPIC_SKILL_STALE_GRACE_MS = 30 * 60 * 1000;

if (ANTHROPIC_SKILL_STALE_GRACE_MS <= ANTHROPIC_SKILL_LEASE_TTL_MS) {
  throw new Error(
    "[anthropic-skill-gc] invariant violated: ANTHROPIC_SKILL_STALE_GRACE_MS " +
      `(${ANTHROPIC_SKILL_STALE_GRACE_MS}) must be strictly greater than ` +
      `ANTHROPIC_SKILL_LEASE_TTL_MS (${ANTHROPIC_SKILL_LEASE_TTL_MS}) — the ` +
      "grace window is the over-delete safety anchor and must outlive a lease.",
  );
}

/** App-layer GC result: the engine result plus app-layer failure detail. */
export type AppGcResult = GcResult & {
  /** Set (and `ok:false`) when the deployment namespace was undeterminable. */
  namespaceError?: string;
};

/** Live, fail-closed read of the default-OFF global opt-in. */
function readGlobalEnabled(): boolean {
  try {
    return readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    return false;
  }
}

/**
 * Explicit maintenance entrypoint — reclaim stale, aged-out, unleased remote
 * Anthropic skills. Idempotent. Inert when the global opt-in is OFF. NEVER
 * called inline on an agent run.
 */
export async function reclaimStaleAnthropicSkills(): Promise<AppGcResult> {
  // Global gate first — OFF ⇒ fully inert, zero work (no derive, no list).
  if (!readGlobalEnabled()) {
    return { ok: true, reclaimed: [], skipped: [], errors: [] };
  }

  const fp = deriveApiKeyFingerprint();
  if (!fp) {
    // No Anthropic key ⇒ nothing remote to reclaim.
    return { ok: true, reclaimed: [], skipped: [], errors: [] };
  }
  let env: string;
  try {
    env = deriveEnvironmentNamespace();
  } catch (err) {
    // Fail closed — never perform remote/state work on an ambiguous namespace.
    return {
      ok: false,
      reclaimed: [],
      skipped: [],
      errors: [],
      namespaceError: err instanceof Error ? err.message : String(err),
    };
  }

  // Re-read the key HERE because deriveApiKeyFingerprint read it separately;
  // it may have been blanked/removed between the two reads. An absent key ⇒
  // fail closed BEFORE constructing the client or entering the engine: no
  // remote DELETE attempts with an empty key.
  const conn = readAnthropicConnectionFromDatabase();
  const apiKey = typeof conn?.apiKey === "string" ? conn.apiKey.trim() : "";
  if (!apiKey) {
    return { ok: true, reclaimed: [], skipped: [], errors: [] };
  }
  const client = new FetchAnthropicCustomSkillsGcClient(apiKey);

  const statePort: AnthropicSkillGcStatePort = {
    listAllRows: () => listAllSyncRows(fp, env),
    countActiveLeasesForSkill: (anthropicSkillId) =>
      countActiveLeasesForSkill(fp, env, anthropicSkillId),
    deleteSyncRowsForSkill: (anthropicSkillId) =>
      deleteSyncRowsForAnthropicSkill(fp, env, anthropicSkillId),
  };

  const engine = new AnthropicSkillGcEngine(
    statePort,
    client,
    ANTHROPIC_SKILL_STALE_GRACE_MS,
  );

  // Serialize against concurrent sync/GC for this namespace using the same
  // advisory lock as pre-sync. Prune expired leases first so the active-lease
  // counts the engine reads are tight. The LIVE fail-closed reader is passed so
  // an admin toggling sync OFF while this runs stops further destructive calls
  // (engine re-reads before every remote DELETE).
  return withNamespaceSyncLock(fp, env, async () => {
    await pruneExpiredLeases(fp, env);
    return engine.collect(readGlobalEnabled);
  });
}
