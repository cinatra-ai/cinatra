import { NextResponse } from "next/server";
// The readiness check resolves through the `llm-provider-surface` capability
// the openai connector registers at activation (lazy/guarded host-access
// cutover). Connector absent → ready: false (degraded, never a 500).
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { readOpenAIConnection } from "@/lib/openai-connection-store";

export async function GET() {
  const connection = readOpenAIConnection();
  const surface = getLlmProviderSurface("openai");
  return NextResponse.json({
    ready: surface?.isConnectionReady?.(connection ?? undefined) === true,
  });
}
