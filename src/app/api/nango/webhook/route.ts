import { NextResponse } from "next/server";
import { handleNangoWebhookRequest } from "@cinatra-ai/nango-connector";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const result = await handleNangoWebhookRequest(request);
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
