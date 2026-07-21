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

// Per-ingestible-MIME extension table: `[mime, canonicalExtension, ...aliases]`.
// OpenAI's Responses `input_file` (context-stuffing) path derives the file
// FORMAT from the filename extension — an extensionless name is rejected with a
// 400 even when the bytes ARE a supported format, AND an extension that does not
// match the bytes' MIME makes the provider parse the file under the WRONG format
// (e.g. a `.pdf` name on text/markdown bytes → PDF parsing of markdown). So the
// extension must MATCH the authoritative mime, not merely be some recognized
// extension. This is the single authority mapping an ingestible mime to its
// provider-recognized extension(s). Held as an ARRAY of tuples (a lookup TABLE,
// `Map`-built below), the same shape the rest of packages/llm uses for its
// representation-mime vocabulary — a capability list, distinct from the
// presentation-identity keying the core UI boundary gate governs (a mime-keyed
// object literal would read as that keying). Doc entries mirror `COMMON_DOC_MIME`
// (the ingestible set the capability rules gate on) + the concrete image forms
// the `image/*` prefix admits — a bare `image/*` cannot map to one extension.
const INGESTIBLE_MIME_EXTENSIONS: ReadonlyArray<
  readonly [mime: string, canonical: string, ...aliases: string[]]
> = [
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md", ".markdown"],
  ["text/csv", ".csv"],
  ["application/json", ".json"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg", ".jpeg"],
  ["image/webp", ".webp"],
];
// mime → canonical extension (used to SYNTHESIZE a filename for a mime).
const MIME_CANONICAL_EXTENSION = new Map<string, string>(
  INGESTIBLE_MIME_EXTENSIONS.map(([mime, canonical]) => [mime, canonical]),
);
// mime → every extension that mime accepts (canonical + aliases), for MATCHING
// an existing filename against its authoritative mime.
const MIME_ACCEPTED_EXTENSIONS = new Map<string, ReadonlySet<string>>(
  INGESTIBLE_MIME_EXTENSIONS.map(([mime, ...exts]) => [mime, new Set(exts)]),
);

/** Normalize a MIME for capability/extension lookup: lowercase + strip any
 *  `;`-params + trim. `text/markdown; charset=utf-8` ⇒ `text/markdown`. */
function normalizeCapabilityMime(mime: string): string {
  const semi = mime.indexOf(";");
  return (semi >= 0 ? mime.slice(0, semi) : mime).trim().toLowerCase();
}

/** The trailing `.<ext>` of a filename, lowercased, or null when there is no
 *  non-empty extension (`"a3f9…-uuid"`, `"trailing."`, `".hidden"`, `""`). */
function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot).toLowerCase();
}

/**
 * Canonical, provider-recognized file extension (with leading dot, e.g.
 * `".md"`) for an explicitly-ingestible MIME, or `null` when the mime is not
 * one the registry ingests. A `null` return means the caller MUST leave the
 * filename unchanged — we never invent an extension for an unknown type. Pure;
 * co-located with the capability registry so the ingestible set and its
 * extensions stay in one authority.
 */
export function extensionForIngestibleMime(mime: string): string | null {
  const m = normalizeCapabilityMime(mime);
  const explicit = MIME_CANONICAL_EXTENSION.get(m);
  if (explicit) return explicit;
  // The capability rules admit the image/* family by PREFIX (not an enumerated
  // set), so an ingestible image subtype the explicit table does not list
  // (image/gif, image/svg+xml, …) must still get an extension — otherwise a
  // synthesized filename is extensionless and OpenAI's input_file path 400s
  // (peer-review r3). Derive it from the subtype (strip a `+suffix`; normalize
  // jpeg→jpg). This is OpenAI-specific: Gemini/Anthropic pass the mime
  // explicitly and need no extension, and OpenAI's ingestible image set IS the
  // image/* family. (Split on `/` and compare the bare type — a literal
  // `"image/"` prefix in a `.startsWith(...)` keying arg is what the artifact-UI
  // boundary gate governs.)
  const [type, subtypeFull] = m.split("/", 2);
  if (type === "image" && subtypeFull) {
    const sub = subtypeFull.split("+", 1)[0]; // "svg+xml" → "svg"
    // ONLY simple single-token subtypes (the real raster formats: gif, bmp,
    // tiff, png, webp, heic, avif, apng, svg…). A dotted/vendor/`x-` subtype
    // (`vnd.microsoft.icon`, `x-icon`) would derive a multi-dot "extension"
    // `extensionOf` (last dot) cannot round-trip → a false mime-match → the guard
    // re-appending it. Those exotic types are not in OpenAI's ingestible image
    // set anyway; return null (degrade to the honest structural/not-readable
    // path) rather than guess a malformed extension (peer-review r4).
    if (/^[a-z0-9]+$/.test(sub)) {
      return sub === "jpeg" ? ".jpg" : `.${sub}`;
    }
  }
  return null;
}

/**
 * True when `filename`'s extension is one the given AUTHORITATIVE ingestible
 * MIME accepts (its canonical extension or an alias — e.g. text/markdown accepts
 * `.md`/`.markdown`, image/jpeg accepts `.jpg`/`.jpeg`). Case-insensitive.
 * Returns false for a non-ingestible mime, an extensionless name, OR an
 * extension that belongs to a DIFFERENT mime (`report.pdf` on text/markdown →
 * false, so the caller re-derives the correct extension instead of shipping
 * markdown bytes under PDF format detection). This is the mime-aware replacement
 * for a global "is this any recognized extension" check.
 */
export function filenameExtensionMatchesMime(
  filename: string,
  mime: string,
): boolean {
  const ext = extensionOf(filename);
  if (ext === null) return false;
  const m = normalizeCapabilityMime(mime);
  const accepted = MIME_ACCEPTED_EXTENSIONS.get(m);
  if (accepted) return accepted.has(ext);
  // image/* subtypes not in the explicit table match their derived extension
  // (image/gif ↔ .gif) — see extensionForIngestibleMime.
  const derived = extensionForIngestibleMime(m);
  return derived !== null && ext === derived;
}

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
