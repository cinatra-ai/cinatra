import { NextResponse } from "next/server";
import { getNangoSystem } from "@/lib/nango-system";
import { getAuthSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Resolution miss => a DEFINED 503 with a marker (never a silent success).
  // Unreachable in prod: nango is a systemExtension whose REQUIRED activation
  // is boot-armed; this guards degraded/build contexts only (test-pinned).
  const nango = getNangoSystem();
  if (!nango) {
    return NextResponse.json(
      { error: "The connection service is not available.", code: "nango-system-unavailable" },
      { status: 503 },
    );
  }
  const session = await getAuthSession();
  const result = await nango.handleNangoConnectSessionRequest(request, {
    userId: session?.user.id,
    userEmail: session?.user.email,
    userDisplayName: session?.user.name,
  });
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
