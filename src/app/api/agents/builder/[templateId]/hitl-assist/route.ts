import { z } from "zod/v4";
import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-session";
import { buildActorContext } from "@/lib/authz/enforce";
import { readAgentTemplateById } from "@cinatra-ai/agents";
import { generate } from "@cinatra-ai/llm";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const hitlAssistBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  xRenderer: z.string().min(1),
  currentValue: z.unknown().optional(),
  // Editable field names derived from the interrupt schema on the client.
  // Takes priority over currentValue key inference so the first HITL step
  // (empty form) still gets the correct fields rather than falling back to
  // the ["subject","body"] dummy defaults.
  schemaProperties: z.array(z.string()).optional(),
  // Last assistant reply sent back so the LLM can resolve references like "insert it".
  lastAssistantMessage: z.string().max(4000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/agents/builder/[templateId]/hitl-assist
//
// Admin-only endpoint that uses the LLM to suggest field-level changes for a
// mid-run HITL screen. The renderer POSTs the user's natural-language prompt
// plus the current interrupt values; the LLM returns a JSON object with only
// the editable fields that should change.
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ templateId: string }> },
) {
  // 1. Admin guard — requireAdminSession redirects on failure; catch any non-redirect
  //    throws and return 401 to the client (API route, not a page).
  let session: Awaited<ReturnType<typeof requireAdminSession>>;
  try {
    session = await requireAdminSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Build actorContext so generate's requireActorFrame gate is satisfied.
  const actorContext = buildActorContext(session);

  // 2. Parse request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = hitlAssistBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
  }

  const { prompt, xRenderer, currentValue, schemaProperties, lastAssistantMessage } = parsed.data;

  // 3. Load template
  const { templateId } = await params;
  const template = await readAgentTemplateById(templateId);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // 4. Derive editable fields
  //    Primary: keys from currentValue (the actual domain data in the interrupt payload).
  //    Secondary: template hitlScreens validates the xRenderer is known (array of string IDs).
  //    NOTE: The interrupt approval schema only contains {approved: boolean} — never use
  //    it as a field source. Only the currentValue shape matters for suggestion generation.
  // TODO: upstream issue — currentValue keys are injected verbatim into the LLM prompt;
  // a crafted key could influence model output. Validate before injection.
  // Workaround: allow only identifier-safe keys (letter/underscore start, alphanumeric body).
  const SAFE_FIELD_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const currentValueKeys = Object.keys(
    (currentValue as Record<string, unknown> | null | undefined) ?? {},
  ).filter((k) => k !== "approved" && k !== "campaignId" && SAFE_FIELD_KEY.test(k));

  // Detect array-typed fields in currentValue so the LLM
  // can be instructed to return the full modified array under the same key.
  const currentValueObj = (currentValue as Record<string, unknown> | null | undefined) ?? {};
  const arrayFields = currentValueKeys.filter((k) => Array.isArray(currentValueObj[k]));

  // Confirm this xRenderer is one the template declares (informational only — not a gate)
  const hitlScreens = template.hitlScreens as string[] | null | undefined;
  const xRendererIsKnown = hitlScreens?.includes(xRenderer) ?? false;
  if (!xRendererIsKnown) {
    // Unknown xRenderer for this template — no schema available, fall through to currentValue keys
    console.warn(`[hitl-assist] unknown xRenderer '${xRenderer}' for template '${templateId}'; using currentValue keys only`);
  }

  // schemaProperties (from frontend interrupt schema) takes priority — it knows the
  // editable fields even when currentValue is empty (first HITL step, no data yet).
  const safeSchemaProps = (schemaProperties ?? []).filter(
    (k) => k !== "approved" && k !== "campaignId" && SAFE_FIELD_KEY.test(k),
  );
  const editableFields = safeSchemaProps.length > 0
    ? safeSchemaProps
    : currentValueKeys.length > 0
      ? currentValueKeys
      : ["subject", "body"]; // minimal fallback for drafts context

  // 5. Call LLM — ask for JSON inline (no outputSchema structured-output mode;
  //    that conflicts with tool injection and varies by provider path).

  // Trim before use so whitespace-only client values
  // (e.g. " \n\t ") don't create a meaningless assistant turn. After normalization,
  // empty strings collapse to null and are threaded as messages: undefined.
  const previousAssistant = lastAssistantMessage?.trim() || null;

  // When currentValue contains array fields (e.g. recipients),
  // tell the LLM to return the full modified array under the same key with all
  // existing item properties preserved — only the requested ones changed.
  const arrayFieldGuidance = arrayFields.length > 0
    ? ` For array fields like "${arrayFields.join('", "')}", return an array under the same key containing only the changed items. Each changed item must include its original "id" field plus only the fields that were modified — omit unchanged fields to keep the response compact.`
    : "";

  try {
    const response = await generate({
      system: `You are a HITL assist agent. The user will give you an instruction or request about how to fill or change form fields. Respond with ONLY a valid JSON object (no markdown, no explanation) with two keys: "suggestions" and "message". "suggestions" must contain only the fields that should change and their new values. "message" must be a single short sentence in plain English describing what you changed (e.g. "Changed Carol's title to CEO." or "Filled in subject and body with sample values."). The editable fields are: ${editableFields.join(", ")}. If the user's message is vague, open-ended, or uses phrases like "suggest", "give me something", "fill in", "add something", "insert something", or any similar request without specifying exact values, treat it as a request for sample values and generate plausible strings for ALL editable fields. If the user asks for sample, example, or placeholder values, generate plausible strings for all editable fields. Only set "suggestions" to {} if the message is clearly about something completely unrelated to this form (e.g. a factual question about the weather), and in that case set "message" to "Nothing to change.".${arrayFieldGuidance}`,
      // The prior assistant reply flows as a real assistant turn via `messages`.
      prompt: `User instruction: ${prompt}\n\nCurrent values: ${JSON.stringify(currentValue, null, 2)}`,
      // Thread the trimmed prior assistant reply as a
      // real assistant turn so follow-up references like "insert it" / "use those"
      // resolve naturally. `as const` narrows the role to the LlmMessage union literal.
      messages: previousAssistant
        ? [{ role: "assistant" as const, content: previousAssistant }]
        : undefined,
      maxTokens: 2048,
      logLabel: "hitl-assist",
      declaredToolboxIds: [],
      actorContext,
    });

    // Extract JSON from response text — handle optional markdown code fences.
    let suggestions: Record<string, unknown> = {};
    let message: string | null = null;
    if (response.text) {
      const text = response.text.trim();
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
      const jsonStr = (jsonMatch[1] ?? text).trim();
      try {
        const raw = JSON.parse(jsonStr) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const rawObj = raw as Record<string, unknown>;
          // Extract LLM-generated message before filtering suggestions.
          if (typeof rawObj.message === "string") message = rawObj.message;
          // Filter suggestions to only the known editable fields (guard against hallucinated keys).
          const editableSet = new Set(editableFields);
          const suggestionsSrc = (rawObj.suggestions && typeof rawObj.suggestions === "object" && !Array.isArray(rawObj.suggestions))
            ? rawObj.suggestions as Record<string, unknown>
            : {};
          for (const [k, v] of Object.entries(suggestionsSrc)) {
            if (editableSet.has(k) && v !== undefined && v !== null) suggestions[k] = v;
          }
        }
      } catch {
        console.warn("[hitl-assist] LLM response was not valid JSON:", text.slice(0, 200));
      }
    } else {
      console.warn("[hitl-assist] response.text is null/empty. Full response:", JSON.stringify({ status: response.status, rawBody: typeof response.rawBody === "string" ? response.rawBody.slice(0, 300) : response.rawBody }));
    }

    return NextResponse.json({ suggestions, message });
  } catch (err) {
    // Never expose raw errors to the client.
    console.warn("[hitl-assist] LLM call failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ suggestions: {} });
  }
}
