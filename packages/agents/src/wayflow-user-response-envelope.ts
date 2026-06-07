import type { LlmAttachmentRef } from "@cinatra-ai/llm";

// ---------------------------------------------------------------------------
// Production HITL `userResponse` envelope serializer. Every HITL renderer
// emits `userResponse` as a text string OR a JSON-stringified
// structured payload, never wrapped in the WayFlow `user_envelope` shape
// — so artifact attachments captured by the HitlConversationPanel paperclip
// need a transport to the gate submission. This helper is the canonical
// wrapper.
//
// Contract (mirrors `src/app/api/llm-bridge/user-envelope.ts`'s parser
// at the receiving side):
//
//   userResponse =
//     attachments.length === 0
//       ? <payloadText>                                  // legacy: VERBATIM
//       : JSON.stringify({ text: <payloadText>, attachments });
//
// Critical invariants enforced by this helper: the legacy `payloadText` is
// preserved BYTE-IDENTICAL inside the envelope's `text` field — for renderers
// that already emit a structured JSON payload (auditor /
// campaign-recipients / email-drafts / trigger-agent), the existing JSON
// string ends up nested as a string inside `text`. Downstream WayFlow nodes
// that re-parse `text` get the SAME shape they got before; the envelope is
// opt-in opaque to them until they're updated.
// ---------------------------------------------------------------------------

/** Cap the attachment list to the SAME 20-ref ceiling the
 *  receiving-side parser enforces (`src/app/api/llm-bridge/user-envelope.ts`
 *  inner array .max(20)). Defensive: a renderer mis-stashing more would
 *  produce a payload the parser rejects with a 400; truncating here
 *  preserves graceful degrade (the user re-submits a smaller selection
 *  on the next gate). */
const MAX_ATTACHMENTS = 20;

export type WrappedUserResponse =
  // No attachments → byte-identical legacy `payloadText`.
  | { wrapped: false; userResponse: string }
  // With attachments → JSON-stringified `{text, attachments}` envelope.
  | { wrapped: true; userResponse: string };

/**
 * Wrap (or pass through) a HITL renderer's `userResponse` text with the
 * WayFlow `user_envelope` shape when there are pending paperclip
 * attachments.
 *
 *   payloadText: the EXACT string the renderer would have emitted in the
 *     legacy path — either free text ("[Approved by operator]") or a
 *     JSON-stringified structured payload
 *     ({campaignId,approved,approvedAt} etc.). MUST stay byte-identical
 *     inside the envelope's `text` field so existing downstream
 *     consumers see the same shape they got without the envelope.
 *   attachments: undefined/empty → byte-identical legacy. Non-empty →
 *     wrap. The order is preserved (the receiving parser is order-
 *     stable). Capped at 20 (parser's max).
 *
 * Returns a discriminated `{wrapped, userResponse}` so callers can log
 * which path they took.
 *
 * Never throws — a malformed `attachments` value (cast via `as any`) is
 * filtered defensively in `pickAttachmentFields` below; the result is
 * always valid JSON the parser will accept.
 */
export function wrapUserResponseWithAttachments(
  payloadText: string,
  attachments?: ReadonlyArray<LlmAttachmentRef> | null,
): WrappedUserResponse {
  if (!attachments || attachments.length === 0) {
    // Back-compat invariant: NO attachments ⇒ the exact `payloadText` is
    // returned VERBATIM. Tests pin this.
    return { wrapped: false, userResponse: payloadText };
  }
  // Validate-then-cap (NOT slice-then-pick). The
  // bridge parser at `src/app/api/llm-bridge/user-envelope.ts` enforces
  // non-empty strings + originKind enum + size as nonneg int via Zod
  // `.strict()`. Emitting a partial/null-bearing ref would produce a
  // wrapped payload the bridge 400s. Defensive: validate every ref,
  // drop the invalid ones, cap the VALID-survivor set to MAX_ATTACHMENTS.
  // If ZERO refs survive validation, fall back to legacy byte-identical
  // text (the user can re-attach valid files; the gate is not blocked
  // by bad metadata). Uses the CANONICALIZER variant
  // (`sanitizeAttachmentRefForEmit`) — defensive on the WRITE side:
  // drops invalid optional fields rather than failing the whole ref,
  // strips extras. The READ side (`tryParseWrappedUserResponse`) uses
  // the STRICT variant that mirrors bridge `.strict()` rejection.
  const valid: LlmAttachmentRef[] = [];
  for (const r of attachments) {
    const sanitized = sanitizeAttachmentRefForEmit(r);
    if (sanitized) {
      valid.push(sanitized);
      if (valid.length >= MAX_ATTACHMENTS) break;
    }
  }
  if (valid.length === 0) {
    return { wrapped: false, userResponse: payloadText };
  }
  return {
    wrapped: true,
    userResponse: JSON.stringify({ text: payloadText, attachments: valid }),
  };
}

const ORIGIN_KINDS = new Set<LlmAttachmentRef["originKind"]>([
  "upload",
  "email_attachment",
  "agent_generated",
  "external_link",
  "live_generator",
]);

/** Validate + strip a single ref to the parser-accepted strict shape.
 *  Returns the sanitized ref OR `null` when any required field is
 *  invalid (mirrors the bridge `refSchema` in
 *  `src/app/api/llm-bridge/user-envelope.ts:refSchema`). Never throws:
 *  a null/undefined/non-object input safely returns null too — the
 *  "never throws" contract holds against `as any` smuggling. */
/** EMIT-SIDE canonicalizer (lenient on the write boundary). Drops
 *  invalid optional fields, strips unknown extras. The bridge would
 *  still accept the projection — extras and invalid optionals are
 *  filtered out client-side BEFORE emission so a renderer using
 *  `as any` cannot produce a wrap that the bridge would 400 on. */
function sanitizeAttachmentRefForEmit(ref: unknown): LlmAttachmentRef | null {
  // ENTIRE body wrapped in try/catch so a Proxy with throwing getters,
  // a Symbol.toPrimitive that explodes, or any other adversarial
  // shape safely returns null — honoring the "never throws" contract
  // against `as any` smuggling.
  try {
    if (!ref || typeof ref !== "object") return null;
    const r = ref as Partial<LlmAttachmentRef>;
    const artifactId = typeof r.artifactId === "string" ? r.artifactId : "";
    const representationRevisionId =
      typeof r.representationRevisionId === "string"
        ? r.representationRevisionId
        : "";
    const digest = typeof r.digest === "string" ? r.digest : "";
    const mime = typeof r.mime === "string" ? r.mime : "";
    if (
      artifactId.length === 0 ||
      representationRevisionId.length === 0 ||
      digest.length === 0 ||
      mime.length === 0
    ) {
      return null;
    }
    if (
      typeof r.originKind !== "string" ||
      !ORIGIN_KINDS.has(r.originKind as LlmAttachmentRef["originKind"])
    ) {
      return null;
    }
    const out: LlmAttachmentRef = {
      artifactId,
      representationRevisionId,
      digest,
      mime,
      originKind: r.originKind as LlmAttachmentRef["originKind"],
    };
    if (typeof r.title === "string") out.title = r.title;
    if (typeof r.filename === "string") out.filename = r.filename;
    if (
      typeof r.size === "number" &&
      Number.isInteger(r.size) &&
      r.size >= 0
    ) {
      out.size = r.size;
    }
    return out;
  } catch {
    return null;
  }
}

/** Convenience: parse the wrapped envelope back into `{text, attachments}`
 *  (mirroring the bridge's parser). Returns `null` if the input is NOT a
 *  valid envelope (e.g. a legacy plain `payloadText`). Useful for tests
 *  + future per-caller assertions that the wrap round-trips byte-perfect. */
export function tryParseWrappedUserResponse(
  userResponse: string,
):
  | { text: string; attachments: LlmAttachmentRef[] }
  | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(userResponse);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // STRICT bridge-rejection mirror. The bridge
  // (`src/app/api/llm-bridge/user-envelope.ts`) uses zod `.strict()`
  // on the envelope object: top-level extra fields are REJECTED, the
  // refs array is `.max(20)`, every ref must pass refSchema. Return
  // null on ANY violation so this helper cannot bless a wire payload
  // the bridge would 400 on.
  const allowedKeys = new Set(["text", "attachments"]);
  for (const k of Object.keys(parsed as object)) {
    if (!allowedKeys.has(k)) return null;
  }
  const obj = parsed as { text?: unknown; attachments?: unknown };
  if (typeof obj.text !== "string") return null;
  // The bridge `envelopeSchema` makes `attachments` OPTIONAL
  // (`.array(refSchema).max(20).optional()`). A wire envelope with
  // only `{text}` (or `{text, attachments: undefined}`) is
  // bridge-accepted and round-trips to `{text, attachments: []}`. The
  // helper must accept it too — asymmetric rejection breaks true
  // bridge equivalence.
  let rawAttachments: unknown[] = [];
  if (obj.attachments !== undefined) {
    if (!Array.isArray(obj.attachments)) return null;
    if (obj.attachments.length > 20) return null;
    rawAttachments = obj.attachments;
  }
  // STRICT bridge mirror, not the lenient emit
  // sanitizer. The bridge's `refSchema.strict()` rejects unknown
  // keys, AND rejects present-but-invalid optional fields (size=-1,
  // title=42, etc.). The emit canonicalizer DROPS those — fine for
  // write-boundary defense but wrong for "would this round-trip
  // through the bridge?". Use the strict variant here.
  const refs: LlmAttachmentRef[] = [];
  for (const r of rawAttachments) {
    const strict = validateAttachmentRefStrict(r);
    if (!strict) return null;
    refs.push(strict);
  }
  return { text: obj.text, attachments: refs };
}

const REF_KEYS_ALLOWED = new Set([
  "artifactId",
  "representationRevisionId",
  "digest",
  "mime",
  "originKind",
  "title",
  "filename",
  "size",
]);

/** STRICT bridge-mirror validator (read boundary). Byte-equivalent to
 *  `src/app/api/llm-bridge/user-envelope.ts:refSchema` (.strict() +
 *  optional fields' present-value validation). Returns null on ANY
 *  bridge-rejectable input — no silent recovery. Used ONLY by
 *  `tryParseWrappedUserResponse` to ensure a parse-success here implies
 *  the bridge would accept the payload. */
function validateAttachmentRefStrict(
  ref: unknown,
): LlmAttachmentRef | null {
  try {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
    // Unknown-key rejection: refSchema.strict() rejects any property
    // not in the schema.
    for (const k of Object.keys(ref)) {
      if (!REF_KEYS_ALLOWED.has(k)) return null;
    }
    const r = ref as Partial<LlmAttachmentRef>;
    if (
      typeof r.artifactId !== "string" || r.artifactId.length === 0 ||
      typeof r.representationRevisionId !== "string" ||
      r.representationRevisionId.length === 0 ||
      typeof r.digest !== "string" || r.digest.length === 0 ||
      typeof r.mime !== "string" || r.mime.length === 0
    ) {
      return null;
    }
    if (
      typeof r.originKind !== "string" ||
      !ORIGIN_KINDS.has(r.originKind as LlmAttachmentRef["originKind"])
    ) {
      return null;
    }
    // Optional fields — when PRESENT they MUST validate (not be
    // silently dropped). Bridge's `.optional()` only permits
    // `undefined` / omitted, not invalid values.
    if (r.title !== undefined && typeof r.title !== "string") return null;
    if (r.filename !== undefined && typeof r.filename !== "string") return null;
    if (r.size !== undefined) {
      if (
        typeof r.size !== "number" ||
        !Number.isInteger(r.size) ||
        r.size < 0
      ) {
        return null;
      }
    }
    const out: LlmAttachmentRef = {
      artifactId: r.artifactId,
      representationRevisionId: r.representationRevisionId,
      digest: r.digest,
      mime: r.mime,
      originKind: r.originKind as LlmAttachmentRef["originKind"],
    };
    if (r.title !== undefined) out.title = r.title;
    if (r.filename !== undefined) out.filename = r.filename;
    if (r.size !== undefined) out.size = r.size;
    return out;
  } catch {
    return null;
  }
}
