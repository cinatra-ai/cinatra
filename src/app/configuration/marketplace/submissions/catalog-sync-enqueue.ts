import "server-only";

import {
  enqueueBackgroundJob,
  BACKGROUND_JOB_NAMES,
} from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Shared fast-freshness catalog reconcile for an APPROVED extension submission.
//
// Extracted verbatim from the submissions-moderator server action so BOTH the
// drill-down page action (`submissions/actions.ts`) AND the unified-inbox
// non-redirecting decision helper enqueue the SAME single-package catalog-sync
// on approve — the two approve paths must not diverge (a submission approved
// from the inbox must reconcile the marketplace catalog exactly like one
// approved from the drill-down). Best-effort: a failed enqueue never rolls back
// the approval; the periodic full-sweep is the backstop.
// ---------------------------------------------------------------------------

/** The approve-output fields this reconcile depends on. */
export interface ApprovedSubmissionSyncInput {
  target_final_identity: string;
  status: string;
  promotion_state: string;
}

/**
 * Parse `@<scope>/<name>@<version>` into the marketplace-catalog-sync payload
 * shape. Returns null on malformed input — the enqueue is best-effort and a
 * malformed identity just means the periodic sweep handles the package on its
 * next tick.
 */
export function parseTargetFinalIdentity(
  identity: string,
): { packageName: string; version: string } | null {
  // Find the LAST "@" — the version separator. The first "@" belongs to
  // the scope (`@<scope>/...`).
  const at = identity.lastIndexOf("@");
  if (at <= 0) return null;
  const packageName = identity.slice(0, at);
  const version = identity.slice(at + 1);
  if (!packageName.startsWith("@") || !packageName.includes("/") || version === "") {
    return null;
  }
  return { packageName, version };
}

/**
 * Enqueue a single-package MARKETPLACE_CATALOG_SYNC for a just-approved
 * submission so the marketplace catalog table picks up the new package without
 * waiting for the next hourly full-sweep tick.
 *
 * Enqueue only on EXPLICIT on-track states. The terminal failure case
 * (`approved + failed`) is a row stuck mid-saga; the operator must hit "Retry
 * promotion" before there's anything in Verdaccio to sync — enqueuing on a
 * failed row would just thrash the retry budget for no benefit. Best-effort:
 * a failed enqueue is logged and left to the periodic sweep.
 */
export async function enqueueCatalogSyncForApprovedSubmission(
  approveResult: ApprovedSubmissionSyncInput,
): Promise<void> {
  const isOnTrack =
    approveResult.target_final_identity !== "" &&
    (approveResult.status === "promoted" ||
      approveResult.promotion_state === "complete" ||
      (approveResult.status === "approved" &&
        approveResult.promotion_state === "in_flight"));
  if (!isOnTrack) return;

  const parsed = parseTargetFinalIdentity(approveResult.target_final_identity);
  if (parsed === null) return;

  try {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC,
      { packageName: parsed.packageName, packageVersion: parsed.version },
      {
        // Per-package job id so it doesn't collide with the recurring loop.
        jobId: `marketplace-catalog-sync:${parsed.packageName}@${parsed.version}`,
        // 30s initial delay gives the marketplace's 9-step saga time to land
        // the package in Verdaccio before the sync worker tries to fetch it.
        // attempts=4 yields initial + ~30s + ~60s + ~120s ≈ 3.5min before the
        // periodic full-sweep takes over.
        delay: 30_000,
        attempts: 4,
        backoff: { type: "exponential", delay: 30_000 },
        overwriteIfStale: true,
      },
    );
  } catch (enqueueErr) {
    // Non-fatal — log and let the periodic sweep handle it.
    console.warn(
      "[marketplace-catalog-sync] post-approve single-package enqueue failed:",
      enqueueErr instanceof Error ? enqueueErr.message : enqueueErr,
    );
  }
}
