/**
 * Admin-gated polling endpoint for the skill-match status panel.
 *
 * GET /api/admin/skills/match-status -> { latest: SkillMatchBatchRun | null }
 *
 * The matches-tab status panel polls this every 30s while the latest batch
 * is in_flight (validating | in_progress | finalizing). Admin gate is
 * mandatory — this is the only route handler that exposes batch metadata
 * outside the MCP boundary.
 */

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-session";
import { readLatestBatchRun } from "@cinatra-ai/skills";

export async function GET() {
  await requireAdminSession();
  const latest = await readLatestBatchRun();
  return NextResponse.json({
    latest: latest
      ? {
          batchId: latest.batchId,
          status: latest.status,
          pairCount: latest.pairCount,
          submittedAt: latest.submittedAt.toISOString(),
          completedAt: latest.completedAt ? latest.completedAt.toISOString() : null,
          lastPolledAt: latest.lastPolledAt ? latest.lastPolledAt.toISOString() : null,
          errorMessage: latest.errorMessage,
          evaluatorVersion: latest.evaluatorVersion,
        }
      : null,
  });
}
