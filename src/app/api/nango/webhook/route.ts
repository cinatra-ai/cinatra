import { NextResponse } from "next/server";
import { getNangoSystem } from "@/lib/nango-system";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Resolution miss => a DEFINED 503 with a marker -- NEVER a silent 200 (the
  // unauthenticated webhook must not pretend it processed an auth event).
  // Unreachable in prod: nango is a systemExtension whose REQUIRED activation
  // is boot-armed; this guards degraded/build contexts only (test-pinned).
  const nango = getNangoSystem();
  if (!nango) {
    return NextResponse.json(
      { error: "The connection service is not available.", code: "nango-system-unavailable" },
      { status: 503 },
    );
  }
  const result = await nango.handleNangoWebhookRequest(request);
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
