import { NextResponse } from "next/server";
import { handleNangoConnectSessionRequest } from "@cinatra-ai/nango-connector";
import { getAuthSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getAuthSession();
  const result = await handleNangoConnectSessionRequest(request, {
    userId: session?.user.id,
    userEmail: session?.user.email,
    userDisplayName: session?.user.name,
  });
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
