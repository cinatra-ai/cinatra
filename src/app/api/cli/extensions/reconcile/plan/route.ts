// ---------------------------------------------------------------------------
// GET /api/cli/extensions/reconcile/plan — authenticated `cinatra extensions
// reconcile --plan` (dry run) over the API. Part of #1042 (the reconcile lever).
//
// Runs the merged extension update planner (the boot-seeded auto-update cycle,
// #1042 slices 1-3) in DRY RUN for this instance's NON-REQUIRED extensions and
// returns the plan + a plan-digest CAS token. STRUCTURALLY READ-ONLY: the
// planner runs with a no-op executor + no-op audit writer, so this path can make
// no server write (see `@/lib/cli-api/extensions-reconcile`).
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest` — the exact mirror of the
// sibling `/api/cli/*` routes (`status`, `agents/export|import`): cookie
// session, a verified remote Bearer carrying `cli:extensions:read`, or the
// dev-admin loopback bypass. Platform-admin because the plan is INSTANCE-GLOBAL
// (platform-scoped NULL-org extension rows) with no org predicate, so an
// org-admin must not see instance-wide update posture.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { authorizeCliRequest } from "@/lib/cli-api/route-guard";
import { planReconcile } from "@/lib/cli-api/extensions-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:extensions:read",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const plan = await planReconcile();
    return NextResponse.json(plan, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[cli-api/extensions/reconcile/plan] failed", error);
    return NextResponse.json(
      { error: "Failed to compute the reconcile plan." },
      { status: 500 },
    );
  }
}
