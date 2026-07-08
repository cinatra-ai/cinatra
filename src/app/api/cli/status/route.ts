// ---------------------------------------------------------------------------
// GET /api/cli/status — authenticated `cinatra status` over the API.
//
// cinatra#255 (G2). Returns the SAME JSON shape `cinatra status` prints today
// when it reads the DB directly, so the published `cinatra` bin can show a
// remote instance's status as an authenticated client (no DB credentials).
//
// AUTH: PLATFORM-ADMIN via `authorizeCliRequest` (cookie session, a remote
// `/api/cli`-audience Bearer with `cli:status`, or the dev-admin loopback
// bypass). The status payload is INSTANCE-GLOBAL (userCount, JWKS, MCP config)
// with no org predicate, so org-admins are excluded remotely (the CLI-audience decision record D6).
// READ-ONLY.
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
