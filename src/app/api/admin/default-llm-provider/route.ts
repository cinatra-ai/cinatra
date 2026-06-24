import { NextResponse } from "next/server";
import { z } from "zod";
import { readDefaultLlmProviderFromDatabase } from "@/lib/database";
import { getActorContext } from "@/lib/auth-session";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import {
  updateDefaultLlmProvider,
  DefaultLlmProviderAuthzError,
  DefaultLlmProviderAuditError,
} from "@/lib/admin/default-llm-provider-mutation";

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
  // Same-origin enforcement (CSRF defense-in-depth for this cookie-backed,
  // global-settings-mutating route).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // Authenticate the caller.
  const actor = await getActorContext();
  if (!actor) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = providerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid provider value." },
        { status: 400 },
      );
    }

    // Shared chokepoint: platform-admin authority + strict-before-mutation
    // audit + write. The same helper backs the LLM-settings server actions so
    // every write path is gated and audited identically.
    await updateDefaultLlmProvider({
      actor,
      provider: parsed.data.provider,
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    return NextResponse.json({ provider: parsed.data.provider });
  } catch (error) {
    if (error instanceof DefaultLlmProviderAuthzError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof DefaultLlmProviderAuditError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update default LLM provider." },
      { status: 500 },
    );
  }
}
