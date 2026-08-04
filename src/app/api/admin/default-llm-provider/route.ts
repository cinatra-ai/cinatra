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
import {
  SetupProviderCommitConflictError,
  transitionDefaultProviderViaAdministration,
} from "@/lib/setup-provider-commit";
import { buildKnownDefaultCapableProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

// Standing invariant: the GLOBAL default LLM provider may only be a provider
// whose `cinatra.llmProvider` ABI v2 declaration sets `defaultCapable`.
// `writeDefaultLlmProviderToDatabase` is the authoritative fail-closed gate;
// this enum is defense-in-depth so a bad request is rejected with a clear 400
// before it ever reaches the sink.
//
// S6 (cinatra#2093) replaced the hardcoded `["openai","gemini"]` literal here —
// one of the four sites that architecturally barred Anthropic — with the
// DERIVED set, so the un-fencing lands in every gate at once rather than
// leaving this route rejecting a provider the sink would have accepted.
const providerSchema = z.object({
  provider: z.enum(buildKnownDefaultCapableProviders() as [string, ...string[]]),
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

    // S3 (cinatra#2388): the write routes through the provider-commit
    // machine's Administration transition (absent → create; pending setup
    // claim → classified 409; committed-same → idempotent no-op;
    // committed-different → fenced move), which itself performs every default
    // write through the shared audited chokepoint (platform-admin authority +
    // strict-before-mutation audit) backing the LLM-settings server actions —
    // every write path stays gated and audited identically.
    await transitionDefaultProviderViaAdministration({
      provider: parsed.data.provider as LlmProvider,
      actorId: actor.principalId ?? null,
      writeAuditedDefault: (provider) =>
        updateDefaultLlmProvider({
          actor,
          provider,
          requestId: request.headers.get("x-request-id") ?? undefined,
        }),
    });
    return NextResponse.json({ provider: parsed.data.provider });
  } catch (error) {
    if (error instanceof SetupProviderCommitConflictError) {
      // CLASSIFIED conflict — a pending setup claim (or a concurrent
      // transition) refuses the change as a 409, never an unclassified 500.
      return NextResponse.json(
        { error: error.message, conflict: error.conflict },
        { status: 409 },
      );
    }
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
