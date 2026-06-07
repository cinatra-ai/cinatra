// Provider × model × MIME × size capability registry. PURE decision table
// (no I/O, no server-only) — the single authority for "is this attachment
// natively ingestible by this model?" Non-ingestible attachments produce a
// structured reason for the not-readable manifest instead of being silently
// dropped.
//
// Native kinds map to the provider adapter's file mechanism:
//   openai_input_file   → OpenAI Responses `input_file` (file_id)
//   anthropic_document  → Anthropic `document` block (source file_id)
//   gemini_file_data    → Gemini `fileData { mimeType, fileUri }`

export type LlmProviderId = "openai" | "anthropic" | "gemini";

export type AttachmentNativeKind =
  | "openai_input_file"
  | "anthropic_document"
  | "gemini_file_data";

export type CapabilityRule = {
  provider: LlmProviderId;
  /** Matched against the resolved model id (substring/regex). */
  modelPattern: RegExp;
  /** Allowed MIME types (exact) and/or MIME prefixes ("image/"). */
  mimeAllow: string[];
  /** Hard ceiling for a single attachment, bytes. */
  maxBytes: number;
  nativeKind: AttachmentNativeKind;
  /** Provider-file-ref cache TTL hint, ms. */
  cacheTtlMs: number;
};

// PDF + images + plain text/markdown/csv are broadly supported. Office
// binaries / archives are deliberately absent, so callers receive a
// not-natively-ingestible decision instead of attempting extraction here.
const COMMON_DOC_MIME = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];
const IMAGE_PREFIX = ["image/"];
const MB = 1024 * 1024;

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  {
    provider: "openai",
    modelPattern: /^gpt-(5|4o)/i,
    mimeAllow: [...COMMON_DOC_MIME, ...IMAGE_PREFIX],
    maxBytes: 32 * MB,
    nativeKind: "openai_input_file",
    cacheTtlMs: 6 * 60 * 60 * 1000,
  },
  {
    // Keep Anthropic aligned with the shared native-ingestion policy:
    // PDF + images + plain text/markdown/csv are broadly ingestible, and
    // Anthropic Files API accepts text documents alongside PDF/images.
    provider: "anthropic",
    modelPattern: /^claude/i,
    mimeAllow: [...COMMON_DOC_MIME, ...IMAGE_PREFIX],
    maxBytes: 32 * MB,
    nativeKind: "anthropic_document",
    cacheTtlMs: 6 * 60 * 60 * 1000,
  },
  {
    provider: "gemini",
    modelPattern: /^gemini/i,
    mimeAllow: [...COMMON_DOC_MIME, ...IMAGE_PREFIX, "audio/", "video/"],
    maxBytes: 100 * MB,
    nativeKind: "gemini_file_data",
    cacheTtlMs: 47 * 60 * 60 * 1000, // Gemini Files API ~48h retention
  },
];

export type CapabilityDecision =
  | { ingestible: true; nativeKind: AttachmentNativeKind; maxBytes: number; cacheTtlMs: number }
  | { ingestible: false; reason: string };

function mimeMatches(allow: string[], mime: string): boolean {
  const m = mime.toLowerCase();
  return allow.some((a) =>
    a.endsWith("/") ? m.startsWith(a.toLowerCase()) : m === a.toLowerCase(),
  );
}

/**
 * The single capability decision. Deterministic + pure. `size` omitted ⇒
 * size check skipped (caller still enforces the blob cap upstream).
 */
export function resolveAttachmentCapability(input: {
  provider: LlmProviderId;
  model: string;
  mime: string;
  size?: number;
}): CapabilityDecision {
  const rule = CAPABILITY_RULES.find(
    (r) => r.provider === input.provider && r.modelPattern.test(input.model),
  );
  if (!rule) {
    return {
      ingestible: false,
      reason: `no capability rule for ${input.provider}/${input.model}`,
    };
  }
  if (!mimeMatches(rule.mimeAllow, input.mime)) {
    return {
      ingestible: false,
      reason: `mime ${input.mime} is not natively ingestible by ${input.provider}/${input.model}`,
    };
  }
  if (typeof input.size === "number" && input.size > rule.maxBytes) {
    return {
      ingestible: false,
      reason: `attachment ${input.size} bytes exceeds the ${rule.maxBytes}-byte limit for ${input.provider}`,
    };
  }
  return {
    ingestible: true,
    nativeKind: rule.nativeKind,
    maxBytes: rule.maxBytes,
    cacheTtlMs: rule.cacheTtlMs,
  };
}
