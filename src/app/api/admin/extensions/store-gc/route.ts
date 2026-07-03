/**
 * Operator trigger for the explicit extension-store GC reaper (cinatra#796).
 *
 * POST /api/admin/extensions/store-gc
 *   body: { dryRun?: boolean }   (default false)
 *   -> the reap report: { dryRun, dataRoot, scannedDigests, activeDigests,
 *      unsafeSlugs, deleted, retained, protectedEntries, skippedForRacedLease,
 *      skippedForRacedActive, failedDeletes }
 *
 * Runs the SAME retention-aware reaper the daily maintenance loop runs
 * (`reapExtensionStore`): keep the DB-anchored ACTIVE digest + the 2 newest
 * prior digests per {kind, slug}; delete the rest — never anything active,
 * leased, undatable, too young, or belonging to a fail-closed slug. With
 * `dryRun: true` the report's `deleted` is the PLANNED delete set and nothing
 * is touched — the operator preview.
 *
 * ISOLATION + SAFETY:
 *  - Admin-gated (`requireAdminSession()` — Better-Auth `admin` role).
 *    Platform-admin only.
 *  - The report carries names/kinds/digests/counts only — no payloads, no
 *    secrets, no manifest contents.
 *  - The reaper never writes the DB and is never a trust input; the DB anchor
 *    + finalized journal own selection (this endpoint cannot change them).
 *  - `force-dynamic` + `no-store`: a live maintenance action; never cache.
 */

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-session";
import { reapExtensionStore } from "@/lib/extension-store-reaper";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await requireAdminSession();
  let dryRun = false;
  try {
    const body = (await request.json()) as { dryRun?: unknown };
    dryRun = body?.dryRun === true;
  } catch {
    // empty/malformed body → a real (non-dry) run with defaults
  }
  const report = await reapExtensionStore({ dryRun });
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  });
}
