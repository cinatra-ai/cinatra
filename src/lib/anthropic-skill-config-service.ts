import "server-only";

import { syncCatalogSkillsToAnthropic } from "@/lib/anthropic-skill-sync-service";
import { reclaimStaleAnthropicSkills } from "@/lib/anthropic-skill-gc-service";
import { createNotification } from "@/lib/notifications";
import {
  readAnthropicSkillSyncEnabledFromDatabase,
  writeAnthropicSkillSyncEnabledToDatabase,
} from "@/lib/database";

/**
 * Eager, admin-save-time orchestration of the Anthropic Custom Skills sync + GC.
 *
 * Extracted from `setDefaultProvidersAction` (src/app/campaigns/actions.ts) so
 * the core LLM-settings save AND the connector-owned Skills-tab write share ONE
 * canonical path. The connector reaches this through the
 * `@cinatra-ai/host:anthropic-skill-config` host capability (registered in
 * `register-host-connector-services.ts`): the capability's `write` persists the
 * opt-in then calls this; core's own settings save calls it directly.
 *
 * Pre-syncs the catalog then reclaims stale remote skills, each notifying the
 * admin on failure and never rolling the already-persisted settings back. Both
 * underlying services short-circuit on a non-true global opt-in, so this is a
 * no-op when the Skills-upload opt-in is OFF.
 */
export async function orchestrateAnthropicSkillSync(): Promise<void> {
  // Pre-sync at admin-save time, not lazily on first agent run. The opt-in
  // write by the caller is already persisted; a sync failure must not roll the
  // save back, but it must be visible through an admin notification rather than
  // silent best-effort. Inert when the opt-in is OFF because the service returns
  // immediately on a non-true global flag.
  try {
    const result = await syncCatalogSkillsToAnthropic();
    if (!result.ok) {
      const detail =
        result.namespaceError ??
        result.preflightError?.message ??
        "Anthropic skill sync reported a configuration error.";
      await createNotification({
        title: "Anthropic skill sync configuration error",
        body: detail,
        kind: "error",
      });
    }
    // A REFUSED skill (cinatra#2089, S2): its stored bundle's router points at a
    // file the bundle does not ship, so the fail-closed one-hop lint kept it out
    // of the upload set. The run itself SUCCEEDS (`ok: true`) — every other skill
    // syncs — but the refused skill stops being published and its already
    // uploaded copy is marked stale for GC reclamation. Without this the refusal
    // would be invisible: the operator would see a green save and a skill that
    // quietly disappeared from the provider. Notify by NAME.
    const refused = result.captureDiagnostics?.refusedForDanglingReferences ?? [];
    if (refused.length > 0) {
      await createNotification({
        title: `Anthropic skill sync skipped ${refused.length} skill(s) with a broken reference`,
        body:
          "These skills were NOT uploaded because their SKILL.md points at files the " +
          "bundle does not ship (a router may only point one hop, at files it ships). " +
          "Any copy already uploaded is marked stale and will be reclaimed. Fix the " +
          "reference or ship the file, then save again: " +
          refused
            .map((r) => `${r.catalogSkillId} → ${r.missing.join(", ")}`)
            .join("; "),
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill sync failed",
      body:
        "Anthropic skill sync did not complete. The provider settings were " +
        "saved. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }

  // Leased/refcounted remote GC is an explicit maintenance step, not the hot
  // agent-run path. Runs after the pre-sync above: sync marks catalog-removed
  // or excluded rows stale; GC then reclaims remote skills that have aged past
  // the grace window with zero in-flight leases. The same governance opt-in
  // controls it, so it is inert when OFF. A GC failure must not roll the settings
  // save back, but it must be visible through an admin notification.
  try {
    const gc = await reclaimStaleAnthropicSkills();
    if (!gc.ok) {
      const detail =
        gc.namespaceError ??
        (gc.errors.length > 0
          ? gc.errors
              .map((e) => `${e.anthropicSkillId}: ${e.message}`)
              .join("; ")
          : "Anthropic skill GC reported an error.");
      await createNotification({
        title: "Anthropic skill GC error",
        body: detail,
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill GC failed",
      body:
        "Anthropic skill garbage collection did not complete. The provider " +
        "settings were saved and no skill was over-deleted. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }
}

/** The `{ read, write }` surface the anthropic-connector's Skills tab resolves
 * (structurally guarded on both being functions — anthropic-connector#44). */
export interface HostAnthropicSkillConfigCapability {
  /** The canonical, fail-closed (`=== true`) opt-in the core consumers read. */
  read(): boolean;
  /** Persist the opt-in then run the eager sync + GC orchestration. */
  write(enabled: boolean): Promise<void>;
}

/**
 * Build the `@cinatra-ai/host:anthropic-skill-config` host-capability impl the
 * anthropic-connector's Skills tab resolves + calls (registered in
 * `register-host-connector-services.ts`). The host owns the FULL write path so
 * the connector stays a thin caller: it just calls `write(enabled)`.
 *
 * `write` is the migrated equivalent of the core `setDefaultProvidersAction`
 * skill block: admin-gate (fail-closed) → persist a primitive boolean to the
 * canonical key → eager catalog-sync + stale-GC (admin-notify on failure, the
 * save never rolled back, inert when OFF). `read` mirrors the canonical reader
 * so the connector renders a read-backed toggle from the same value the ~7 core
 * consumers observe.
 */
/**
 * The capability's `write`: admin-gate (fail-closed) → persist the primitive
 * boolean to the canonical key → run the eager sync + GC orchestration. The
 * admin gate is imported LAZILY so the boot binder that registers this
 * capability can reach it through a dynamic import (keeping the binder's own
 * top-level module graph free of this file's sync/GC deps — auth + the sync/GC
 * services load only when an admin actually writes, not at every boot).
 */
export async function writeAnthropicSkillConfig(enabled: boolean): Promise<void> {
  // An untrusted connector call must never persist this non-ZDR data-egress
  // opt-in without an admin session (mirrors `setDefaultProvidersAction`).
  const { requireAdminSession } = await import("@/lib/auth-session");
  await requireAdminSession();
  writeAnthropicSkillSyncEnabledToDatabase(enabled);
  await orchestrateAnthropicSkillSync();
}

export function createAnthropicSkillConfigCapability(): HostAnthropicSkillConfigCapability {
  return {
    read: (): boolean => readAnthropicSkillSyncEnabledFromDatabase(),
    write: writeAnthropicSkillConfig,
  };
}
