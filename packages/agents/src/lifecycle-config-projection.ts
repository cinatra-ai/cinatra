import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-config-projection (cinatra#2047 defect D-1, epic #2037 S0/S2)
//
// Re-projects the CORE-owned lifecycle declarations
// (`lifecycle-repair-producer-registry`) onto the matching installed templates'
// `agent_templates.lifecycle_config` column — the exact same column the manifest
// compile path writes at install time, read by `resolveRepairCapable` (the
// `changes_requested` route) and `parseCompiledManifest` (the policy lattice).
//
// Why a projection and not only an install-time write: a core-owned declaration
// changes when CORE ships, not when the extension re-publishes, and the blog
// template on every existing environment was installed long before D-1. This is
// exactly the shape of the already-shipped agent runtime-dependency projection
// backfill (`agent-runtime-dep-projection-backfill`): idempotent, MERGE-not-clear,
// soft-failing per row, kill-switchable, run from a `retryable` boot phase.
//
// MERGE-not-clear: a template's manifest-declared keys are preserved; only the
// core-declared keys are overwritten (`mergeLifecycle`). A package that is not
// core-declared is never touched by this pass.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";

import { db } from "./db";
import { agentTemplates } from "./schema";
import { CORE_LIFECYCLE_PRODUCERS } from "./lifecycle-repair-producer-registry";

import {
  mergeLifecycle,
  parseLifecycleConfigText,
  serializeLifecycleConfig,
} from "@/lib/lifecycle/lifecycle-policy";

export const LIFECYCLE_CONFIG_PROJECTION_ENV = "CINATRA_LIFECYCLE_CONFIG_PROJECTION";

export interface LifecycleConfigProjectionSummary {
  /** Templates matched by a core-declared package name. */
  scanned: number;
  /** Rows whose `lifecycle_config` text was rewritten. */
  updated: number;
  /** Rows that already carried the merged value (idempotent no-op). */
  unchanged: number;
  /** Rows whose write threw (soft-failed; the next boot retries). */
  failed: number;
  /** Set when the pass declined to run at all. */
  skippedReason?: string;
}

/**
 * Project every core-owned lifecycle declaration onto its installed template row.
 * Idempotent and safe to run on every boot. Never throws: a per-row failure is
 * counted and the pass continues.
 */
export async function projectCoreLifecycleConfig(opts?: {
  log?: (message: string) => void;
}): Promise<LifecycleConfigProjectionSummary> {
  const summary: LifecycleConfigProjectionSummary = {
    scanned: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };

  if ((process.env[LIFECYCLE_CONFIG_PROJECTION_ENV] ?? "").trim().toLowerCase() === "off") {
    summary.skippedReason = `disabled via ${LIFECYCLE_CONFIG_PROJECTION_ENV}=off`;
    return summary;
  }

  for (const producer of CORE_LIFECYCLE_PRODUCERS) {
    let rows: Array<{ id: string; lifecycleConfig: string | null }>;
    try {
      rows = await db
        .select({ id: agentTemplates.id, lifecycleConfig: agentTemplates.lifecycleConfig })
        .from(agentTemplates)
        .where(eq(agentTemplates.packageName, producer.packageName));
    } catch (err) {
      summary.failed += 1;
      opts?.log?.(
        `[lifecycle-config-projection] read failed for ${producer.packageName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    for (const row of rows) {
      summary.scanned += 1;
      const merged = serializeLifecycleConfig(
        mergeLifecycle(parseLifecycleConfigText(row.lifecycleConfig), producer.lifecycle),
      );
      if (merged === (row.lifecycleConfig ?? null)) {
        summary.unchanged += 1;
        continue;
      }
      try {
        await db
          .update(agentTemplates)
          .set({ lifecycleConfig: merged })
          .where(eq(agentTemplates.id, row.id));
        summary.updated += 1;
        opts?.log?.(
          `[lifecycle-config-projection] projected core lifecycle onto ${producer.packageName} (template ${row.id})`,
        );
      } catch (err) {
        summary.failed += 1;
        opts?.log?.(
          `[lifecycle-config-projection] write failed for template ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return summary;
}
