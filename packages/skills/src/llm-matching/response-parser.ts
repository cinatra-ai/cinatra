/**
 * Parses the structured-output JSON returned by the matcher LLM and redacts
 * oversized raw responses for safe storage.
 *
 * Strict schema enforcement is required: rationale > 500 chars, out-of-range
 * score, missing required fields, or malformed JSON all produce `ok: false`
 * with errorCode "llm_schema_violation" and are never silently truncated into
 * a soft pass-through.
 *
 * redactRawResponse caps the returned string at <=1024 bytes total, including
 * the suffix. The slice-then-append approach below reserves marker bytes before
 * slicing so the redacted value stays within the bound.
 */

import { z } from "zod";
import { SKILL_MATCH_RAW_RESPONSE_REDACT_BYTES } from "./constants";
import type { ParseResult } from "./types";

const matchDecisionSchema = z
  .object({
    matched: z.boolean(),
    score: z.number().min(0).max(1),
    rationale: z.string().max(500),
  })
  .strict();

const REDACT_MARKER = "…[truncated to 1 KiB]";

export function redactRawResponse(raw: string): string {
  const rawBuffer = Buffer.from(raw, "utf-8");
  if (rawBuffer.byteLength <= SKILL_MATCH_RAW_RESPONSE_REDACT_BYTES) return raw;

  const markerBytes = Buffer.byteLength(REDACT_MARKER, "utf-8");
  let cut = Math.max(0, SKILL_MATCH_RAW_RESPONSE_REDACT_BYTES - markerBytes);

  // Walk back to a UTF-8 codepoint boundary so the toString() decode never
  // emits U+FFFD, which would expand 1 byte to 3 bytes and silently push the
  // cell over 1024. Continuation bytes have the high bits 0b10xxxxxx; keep
  // walking back while we're inside a multi-byte sequence.
  while (cut > 0 && (rawBuffer[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }

  return rawBuffer.subarray(0, cut).toString("utf-8") + REDACT_MARKER;
}

export function parseLlmResponse(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      errorCode: "llm_schema_violation",
      rawRedacted: redactRawResponse(raw),
    };
  }
  const result = matchDecisionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errorCode: "llm_schema_violation",
      rawRedacted: redactRawResponse(raw),
    };
  }
  return {
    ok: true,
    value: {
      matched: result.data.matched,
      score: result.data.score,
      rationale: result.data.rationale,
    },
  };
}
