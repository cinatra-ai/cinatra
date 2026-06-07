// ---------------------------------------------------------------------------
// Classifier Signal Intake.
//
// Shape + helpers for the inputs consumed by the matcher runtime. We
// deliberately keep the helpers here in a LEAF subpath so
// `src/lib/artifacts/artifact-creation.ts` can import them without
// pulling the heavy `@cinatra-ai/objects` barrel (which would drag in
// server-only mcp/registries plumbing that the creation path explicitly
// avoids).
//
// Security model: NEVER accept a pre-built `classifierSignals` blob from
// callers. The service composes signals server-side from trusted HANDLES
// (`chatContextSource: { threadId }`) using authoritative auth-validated
// readers. A caller smuggling `classifierSignals: {...}` via `as any` is
// dropped because the typed input shape of `createSemanticArtifact` does
// not include it (TS strips at compile; the service destructures only
// the typed handles).
// ---------------------------------------------------------------------------

import { z } from "zod";

// SemanticArtifactRef carried inline (NOT imported from the objects
// barrel) to keep this module a true leaf. The shape mirrors
// `packages/objects/src/types.ts` so both stay byte-compatible.
type SemanticArtifactRefLeaf = { extension: string };

// `ArtifactOriginKind` ditto — duplicated as a string literal union so
// the leaf has zero cross-package import surface. Keep in sync with
// `packages/artifacts/src/artifact-version.ts`. Drift here is caught by
// the source-shape test for this module.
export type ArtifactOriginKindLeaf =
  | "upload"
  | "email_attachment"
  | "agent_generated"
  | "external_link"
  | "live_generator";

// ---------------------------------------------------------------------------
// Caps — every string field has its own cap; the final serialized
// payload is also byteLength-capped (computed via
// Buffer.byteLength(JSON.stringify(signals), "utf8")). The byte cap is
// the safety net; per-field caps minimize how often it has to fire.
// ---------------------------------------------------------------------------

export const CLASSIFIER_SIGNALS_CAPS = {
  /** Max chat messages persisted. The matcher needs only recent context. */
  maxChatMessages: 3,
  /** Max chars per chat message content (truncated, not rejected). */
  maxChatMessageContentChars: 1000,
  /** Max chars on threadId (uuid-shaped + slop). */
  maxThreadIdChars: 64,
  /** Max chars on filename / parentId / parentType. */
  maxIdentifierChars: 256,
  /** Max chars on each produces[].extension string. */
  maxProducesExtensionChars: 256,
  /** Max `produces[]` entries. */
  maxProducesEntries: 16,
  /** Hard ceiling on JSON.stringify(signals) byteLength. Drives the
   *  truncation cascade in `enforceClassifierSignalsByteCap`. */
  maxSerializedByteLength: 8 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Type + schema — STRICT (extra fields rejected to close the smuggling
// surface; any future field needs an explicit schema edit + test).
// ---------------------------------------------------------------------------

export type ChatMessageStripped = {
  role: "user" | "assistant";
  content: string;
};

export type ClassifierChatContext = {
  threadId: string;
  messages: ChatMessageStripped[];
};

export type ClassifierUploadSignals = {
  filename?: string;
  declaredMime?: string;
  originKind: ArtifactOriginKindLeaf;
  parentId?: string;
  parentType?: string;
  sizeBytes?: number;
};

export type ClassifierSignals = {
  chatContext?: ClassifierChatContext;
  produces?: SemanticArtifactRefLeaf[];
  upload: ClassifierUploadSignals;
};

// Caps are COERCING (truncate) not rejecting. A long
// filename/parentId/declaredMime/message content must NEVER suppress
// the whole signals blob; truncate to the per-field cap and continue.
// Smuggling (extra fields, wrong types) still strict-rejects.
const capString = (max: number) =>
  z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));

const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: capString(CLASSIFIER_SIGNALS_CAPS.maxChatMessageContentChars),
  })
  .strict();

const chatContextSchema = z
  .object({
    threadId: capString(CLASSIFIER_SIGNALS_CAPS.maxThreadIdChars).pipe(
      z.string().min(1),
    ),
    messages: z
      .array(chatMessageSchema)
      .max(CLASSIFIER_SIGNALS_CAPS.maxChatMessages),
  })
  .strict();

const producesEntrySchema = z
  .object({
    extension: capString(
      CLASSIFIER_SIGNALS_CAPS.maxProducesExtensionChars,
    ).pipe(z.string().min(1)),
  })
  .strict();

const uploadSchema = z
  .object({
    filename: capString(CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars).optional(),
    declaredMime: capString(CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars).optional(),
    originKind: z.enum([
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ]),
    parentId: capString(CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars).optional(),
    parentType: capString(CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const classifierSignalsSchema: z.ZodType<ClassifierSignals> = z
  .object({
    chatContext: chatContextSchema.optional(),
    produces: z
      .array(producesEntrySchema)
      .max(CLASSIFIER_SIGNALS_CAPS.maxProducesEntries)
      .optional(),
    upload: uploadSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Stripper — accepts the full ChatMessage shape (with toolCalls,
// thinking, attachments, etc.) and returns ONLY {role, content},
// dropping everything else so a misbehaving chat upstream can never
// smuggle private fields (tool-call results, model thinking) into a
// matcher prompt.
// ---------------------------------------------------------------------------

type AnyChatMessage = {
  role?: unknown;
  content?: unknown;
  [k: string]: unknown;
};

export function stripChatMessagesForClassifier(
  raw: ReadonlyArray<AnyChatMessage>,
  opts?: { maxMessages?: number; maxContentChars?: number },
): ChatMessageStripped[] {
  const maxMsgs = opts?.maxMessages ?? CLASSIFIER_SIGNALS_CAPS.maxChatMessages;
  const maxChars =
    opts?.maxContentChars ?? CLASSIFIER_SIGNALS_CAPS.maxChatMessageContentChars;
  const out: ChatMessageStripped[] = [];
  // Walk newest-first → keep `maxMsgs` most-recent → reverse to
  // chronological order on output.
  for (let i = raw.length - 1; i >= 0 && out.length < maxMsgs; i--) {
    const m = raw[i];
    if (!m) continue;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length === 0) continue;
    out.push({
      role,
      content: content.length > maxChars ? content.slice(0, maxChars) : content,
    });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Dedupe `produces` by `extension` — preserves first occurrence to
// honor caller intent if the upstream order matters.
// ---------------------------------------------------------------------------

export function dedupeProduces(
  refs: ReadonlyArray<SemanticArtifactRefLeaf>,
): SemanticArtifactRefLeaf[] {
  const seen = new Set<string>();
  const out: SemanticArtifactRefLeaf[] = [];
  for (const r of refs) {
    if (!r || typeof r.extension !== "string") continue;
    if (seen.has(r.extension)) continue;
    seen.add(r.extension);
    out.push({ extension: r.extension });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Byte-cap enforcer — runs AFTER strict-schema parse. Truncates in the
// documented order:
//   (a) drop oldest chat messages until cap fits or zero messages;
//   (b) drop `produces` from the tail until cap fits or zero entries;
//   (c) blank optional identifier fields one-by-one.
// Returns a new signals object (never mutates).
// ---------------------------------------------------------------------------

function byteLen(value: unknown): number {
  // `JSON.stringify` is the canonical persisted form. The byteLength
  // calc uses Node's Buffer if available, falling back to a UTF-8
  // estimate so this leaf stays Node/browser-agnostic.
  const s = JSON.stringify(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(s, "utf8");
  }
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) bytes += 4;
    else if (code >= 0xdc00 && code < 0xe000) {
      /* low surrogate counted in the preceding high-surrogate branch */
    } else bytes += 3;
  }
  return bytes;
}

export function enforceClassifierSignalsByteCap(
  signals: ClassifierSignals,
): ClassifierSignals {
  const cap = CLASSIFIER_SIGNALS_CAPS.maxSerializedByteLength;
  let s: ClassifierSignals = signals;
  if (byteLen(s) <= cap) return s;

  // (a) drop oldest messages. When messages reaches zero, drop the
  //     whole chatContext (an empty-messages chatContext is useless to
  //     the matcher AND the existing tests expect it to be absent).
  if (s.chatContext && s.chatContext.messages.length > 0) {
    const threadId = s.chatContext.threadId;
    let msgs = s.chatContext.messages;
    while (msgs.length > 0) {
      msgs = msgs.slice(1);
      const candidate: ClassifierSignals = {
        ...s,
        chatContext:
          msgs.length === 0 ? undefined : { threadId, messages: msgs },
      };
      if (byteLen(candidate) <= cap) return candidate;
      s = candidate;
    }
  }

  // (b) drop produces from the tail
  if (s.produces && s.produces.length > 0) {
    let p = s.produces;
    while (p.length > 0) {
      p = p.slice(0, p.length - 1);
      const candidate: ClassifierSignals = {
        ...s,
        produces: p.length > 0 ? p : undefined,
      };
      if (byteLen(candidate) <= cap) return candidate;
      s = candidate;
    }
  }

  // (c) blank optional identifier fields. `originKind` and `sizeBytes`
  // stay — both are required-ish + tiny. Include `declaredMime` (which
  // can be user-controlled via the upload route's Content-Type header)
  // so a pathological mime can't bust the cap.
  for (const field of ["parentId", "parentType", "filename", "declaredMime"] as const) {
    if (s.upload[field] !== undefined) {
      s = { ...s, upload: { ...s.upload, [field]: undefined } };
      if (byteLen(s) <= cap) return s;
    }
  }
  // Final minimal-fallback assertion: after blanking every optional
  // field, the residual shape is `{upload:{originKind,sizeBytes?}}` —
  // always far under the 8 KiB cap. If we somehow STILL overshoot,
  // the input was malformed in a way our schema should already have
  // rejected. Return the floor regardless rather than persisting an
  // oversized payload.
  return {
    upload: { originKind: s.upload.originKind, sizeBytes: s.upload.sizeBytes },
  };
}

// ---------------------------------------------------------------------------
// `composeAndValidate` — single composer the service uses. Runs strict
// schema validation, dedupes produces, then enforces the byte cap.
// Throws if the input is malformed (schema failure). Returns the final
// `ClassifierSignals` ready to persist.
// ---------------------------------------------------------------------------

export function composeAndValidateClassifierSignals(
  input: ClassifierSignals,
): ClassifierSignals {
  // 1) strict schema parse FIRST — closes the smuggling surface so a
  //    caller using `as any` to inject extra top-level/nested fields
  //    THROWS loudly, NOT silently strips.
  const parsed = classifierSignalsSchema.parse(input);
  // 2) dedupe produces AFTER schema validation.
  const dedupedProduces = parsed.produces
    ? dedupeProduces(parsed.produces)
    : undefined;
  const candidate: ClassifierSignals = {
    chatContext: parsed.chatContext,
    produces:
      dedupedProduces && dedupedProduces.length > 0
        ? dedupedProduces
        : undefined,
    upload: parsed.upload,
  };
  // 3) byte cap
  return enforceClassifierSignalsByteCap(candidate);
}
