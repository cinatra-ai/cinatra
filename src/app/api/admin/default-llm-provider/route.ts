import { NextResponse } from "next/server";
import { z } from "zod";
import { readDefaultLlmProviderFromDatabase, writeDefaultLlmProviderToDatabase } from "@/lib/database";

// Standing invariant: the GLOBAL default LLM provider may only be OpenAI or
// Gemini — Anthropic is selectable per-purpose only and is never the global
// default. `writeDefaultLlmProviderToDatabase` is the authoritative fail-closed
// gate; this enum is defense-in-depth so a bad request is rejected with a clear
// 400 before it ever reaches the sink.
const providerSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
});

export async function GET() {
  try {
    const provider = readDefaultLlmProviderFromDatabase();
    return NextResponse.json({ provider });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to read default LLM provider." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const parsed = providerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid provider value." },
        { status: 400 },
      );
    }
    writeDefaultLlmProviderToDatabase(parsed.data.provider);
    return NextResponse.json({ provider: parsed.data.provider });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update default LLM provider." },
      { status: 500 },
    );
  }
}
