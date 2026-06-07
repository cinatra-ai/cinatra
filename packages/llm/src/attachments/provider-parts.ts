import type { AdapterAttachmentPart } from "../types";

// Pure provider-native part builders. Each takes the user prompt text +
// the resolved attachment parts and returns the provider's user-message
// content. CRITICAL: when there are no
// matching parts the return is the LEGACY plain form (a bare string for
// OpenAI/Anthropic, a single text part for Gemini) so the request body is
// BYTE-IDENTICAL for every existing caller. The separate
// `generateWithFileInput` path is untouched and unrelated.

function partsOf(
  resolved: AdapterAttachmentPart[] | undefined,
  nativeKind: string,
): AdapterAttachmentPart[] {
  return (resolved ?? []).filter((p) => p.nativeKind === nativeKind);
}

/**
 * Defines which resolved parts apply to each message, as an array aligned
 * to `messages`. Every user turn uses its OWN
 * resolvedAttachments; the request-level fallback applies to the LAST user
 * turn ONLY when that message carried none. An `undefined` entry ⇒ the caller emits the plain text form
 * (byte-identical). Single source of truth for all three stream builders.
 */
export function resolvedAttachmentsPerMessage(
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    resolvedAttachments?: AdapterAttachmentPart[];
  }>,
  requestLevel: AdapterAttachmentPart[] | undefined,
): Array<AdapterAttachmentPart[] | undefined> {
  const out: Array<AdapterAttachmentPart[] | undefined> = messages.map((m) =>
    m.role === "user" &&
    m.resolvedAttachments &&
    m.resolvedAttachments.length > 0
      ? m.resolvedAttachments
      : undefined,
  );
  if (requestLevel && requestLevel.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        if (out[i] === undefined) out[i] = requestLevel;
        break;
      }
    }
  }
  return out;
}

/** OpenAI Responses `input` user item content. */
export function openaiUserContent(
  promptText: string,
  resolved: AdapterAttachmentPart[] | undefined,
):
  | string
  | Array<
      | { type: "input_text"; text: string }
      | { type: "input_file"; file_id: string }
    > {
  const files = partsOf(resolved, "openai_input_file");
  if (files.length === 0) return promptText; // legacy: bare string
  return [
    { type: "input_text", text: promptText },
    ...files.map((f) => ({ type: "input_file" as const, file_id: f.providerFileId })),
  ];
}

/** Anthropic Messages user content. */
export function anthropicUserContent(
  promptText: string,
  resolved: AdapterAttachmentPart[] | undefined,
):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "document";
          source: { type: "file"; file_id: string };
        }
    > {
  const docs = partsOf(resolved, "anthropic_document");
  if (docs.length === 0) return promptText; // legacy: bare string
  return [
    { type: "text", text: promptText },
    ...docs.map((d) => ({
      type: "document" as const,
      source: { type: "file" as const, file_id: d.providerFileId },
    })),
  ];
}

/** True when any Anthropic document parts are present (→ Files API beta). */
export function hasAnthropicDocuments(
  resolved: AdapterAttachmentPart[] | undefined,
): boolean {
  return partsOf(resolved, "anthropic_document").length > 0;
}

/** Gemini `contents` user parts. */
export function geminiUserParts(
  promptText: string,
  resolved: AdapterAttachmentPart[] | undefined,
): Array<
  | { text: string }
  | { fileData: { mimeType: string; fileUri: string } }
> {
  const files = partsOf(resolved, "gemini_file_data");
  const parts: Array<
    { text: string } | { fileData: { mimeType: string; fileUri: string } }
  > = [{ text: promptText }];
  for (const f of files) {
    parts.push({ fileData: { mimeType: f.mime, fileUri: f.providerFileId } });
  }
  return parts; // length 1 (just text) when no parts — legacy-equivalent
}
