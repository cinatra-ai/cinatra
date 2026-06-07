import { NextResponse } from "next/server";
import { isOpenAIConnectionReady } from "@cinatra-ai/openai-connector";
import { readOpenAIConnection } from "@/lib/openai-connection-store";

export async function GET() {
  const connection = readOpenAIConnection();
  return NextResponse.json({
    ready: isOpenAIConnectionReady(connection ?? undefined),
  });
}
