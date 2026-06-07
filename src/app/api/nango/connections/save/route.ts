import { NextResponse } from "next/server";
import { handleNangoConnectionSaveRequest } from "@cinatra-ai/nango-connector";
import { refreshUserGmailSendAsAddresses } from "@cinatra-ai/gmail-connector";
import { getAuthSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getAuthSession();
  const body = (await request.clone().json().catch(() => null)) as
    | { connectorKey?: string; scope?: string }
    | null;
  const result = await handleNangoConnectionSaveRequest(request, {
    userId: session?.user.id,
  });

  if (
    result.body.success === true &&
    body?.connectorKey === "gmail" &&
    body?.scope === "user" &&
    session?.user.id
  ) {
    try {
      await refreshUserGmailSendAsAddresses(session.user.id);
    } catch {
      // The connection itself succeeded; sender-address refresh can be retried from the tools UI.
    }
  }

  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
