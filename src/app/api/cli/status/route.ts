// ---------------------------------------------------------------------------
// GET /api/cli/status — authenticated `cinatra status` over the API.
//
// cinatra#255 (G2). Returns the SAME JSON shape `cinatra status` prints today
// when it reads the DB directly, so the published `cinatra` bin can show a
// remote instance's status as an authenticated client (no DB credentials).
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest` (cookie session, a
// verified remote Bearer carrying `cli:status`, or the dev-admin loopback
// bypass). Platform-admin because the payload is INSTANCE-GLOBAL (userCount,
// JWKS health, MCP public URL) with no org predicate — an org-admin must not
// see instance-wide posture (eng#231 D6). READ-ONLY.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { authorizeCliRequest } from "@/lib/cli-api/route-guard";
import { gatherCliStatus } from "@/lib/cli-api/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:status",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const status = await gatherCliStatus();
    return NextResponse.json(status, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[cli-api/status] failed to gather status", error);
    return NextResponse.json(
      { error: "Failed to gather instance status." },
      { status: 500 },
    );
  }
}
