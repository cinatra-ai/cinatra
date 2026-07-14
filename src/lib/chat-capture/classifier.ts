import "server-only";

// Chat-capture stage 2: the LLM CLASSIFIER (cinatra#1367).
//
// Runs ONLY on turns that passed the lexical pre-filter AND a successful
// per-user quota reservation. Input MUST already be redacted
// (redactChatCaptureText) — this module never sees raw chat text by contract
// (the pipeline is the enforcement point; the seeded-secret test pins it).
//
// Provider selection: the configured runtime via resolveConfiguredLlmRuntime
// — the same explicit-resolution contract the personal-skill distiller uses
// (#1367 design note: implicit runtime selection in @cinatra-ai/llm excludes
// Anthropic; explicit resolution does not).

import {
  resolveConfiguredLlmRuntime,
  runResolvedDeterministicLlmTask,
  parseStructuredJson,
} from "@cinatra-ai/llm";

export type ChatCaptureClassification = {
  durable: boolean;
  /** Imperative restatement of the durable instruction (redacted input ⇒
   * redacted output), present when durable. */
  instruction?: string;
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["durable", "instruction"],
  properties: {
    durable: { type: "boolean" },
    instruction: { type: ["string", "null"] },
  },
} as const;

const SYSTEM = [
  "You classify a single chat message from a user to an AI assistant.",
  "Decide whether it contains a DURABLE INSTRUCTION: a standing preference, rule, correction, or way-of-working the user wants the assistant to apply in FUTURE conversations — not just this one task.",
  "Durable: 'always answer in German', 'never use emojis', 'call me Sam', 'from now on cite sources', 'stop prefixing answers with summaries'.",
  "NOT durable: one-off task requests, questions, pasted documents/code/logs, feedback about a single answer without a standing rule, small talk.",
  "If durable, restate the instruction as one concise imperative sentence (second person, e.g. 'Always answer in German.'). Preserve [REDACTED] placeholders verbatim; never guess redacted content.",
  "Return only valid JSON matching the schema: {\"durable\": boolean, \"instruction\": string|null}.",
].join("\n");

function extractClassification(value: unknown): ChatCaptureClassification | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return extractClassification(parseStructuredJson<Record<string, unknown>>(value));
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.durable === "boolean") {
    const instruction =
      typeof record.instruction === "string" && record.instruction.trim().length > 0
        ? record.instruction.trim()
        : undefined;
    return { durable: record.durable, instruction };
  }
  // Tolerate provider envelope nesting (same defensive shape the
  // personal-skill extractor uses).
  for (const key of ["output_parsed", "json", "response", "result", "data"]) {
    const nested = extractClassification(record[key]);
    if (nested) return nested;
  }
  const output = record.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const nested = extractClassification(item);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Classify a REDACTED user message. Returns null when no runtime is
 * configured or the response is unusable — callers treat null as
 * "not durable" (fail-closed: no capture on classifier failure).
 */
export async function classifyChatCaptureMessage(
  redactedMessage: string,
): Promise<ChatCaptureClassification | null> {
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) return null;

  const response = await runResolvedDeterministicLlmTask({
    runtime,
    system: SYSTEM,
    user: ["User message:", redactedMessage].join("\n"),
    outputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 400,
    reasoningEffort: "low",
    logLabel: "chat-capture-classify",
  });

  return (
    extractClassification(response?.text) ?? extractClassification(response?.rawBody) ?? null
  );
}
