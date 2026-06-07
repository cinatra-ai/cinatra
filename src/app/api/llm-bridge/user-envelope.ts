import { z } from "zod";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

// WayFlow text-only `user` envelope, OPT-IN ONLY. A2A messages are
// text-only by design; a caller that needs to round-trip artifact refs
// through a text-only channel sets `body.user_envelope: true` and sends
// `body.user` as a JSON string shaped
// `{text: string, attachments?: LlmAttachmentRef[]}`.
//
// Hard byte-identical invariant for callers that do not opt in: when
// `enabled === false` (or undefined) the raw user text is returned VERBATIM
// even if it happens to be JSON-shaped like an envelope. A user literally
// typing `{"text":"hi"}` must reach the model as `{"text":"hi"}`.
//
// When `enabled === true`, strict-schema parse failures THROW so the route
// can respond with a 400 — never silently fall back to plain text.

const refSchema = z
  .object({
    artifactId: z.string().min(1),
    representationRevisionId: z.string().min(1),
    digest: z.string().min(1),
    mime: z.string().min(1),
    originKind: z.enum([
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ]),
    title: z.string().optional(),
    filename: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

const envelopeSchema = z
  .object({
    text: z.string(),
    attachments: z.array(refSchema).max(20).optional(),
  })
  .strict();

export class UserEnvelopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserEnvelopeParseError";
  }
}

export function parseUserEnvelope(
  rawUser: string,
  enabled: boolean,
  topLevelAttachments?: LlmAttachmentRef[],
): { text: string; attachments?: LlmAttachmentRef[] } {
  let envText: string = rawUser;
  let envAttachments: LlmAttachmentRef[] | undefined;
  if (enabled) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawUser);
    } catch {
      throw new UserEnvelopeParseError(
        "user_envelope=true but body.user is not valid JSON",
      );
    }
    const parsed = envelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new UserEnvelopeParseError(
        `user_envelope=true but body.user does not match {text, attachments?}: ${parsed.error.message}`,
      );
    }
    envText = parsed.data.text;
    envAttachments = parsed.data.attachments;
  }
  const merged: LlmAttachmentRef[] = [];
  if (envAttachments && envAttachments.length > 0) merged.push(...envAttachments);
  if (topLevelAttachments && topLevelAttachments.length > 0)
    merged.push(...topLevelAttachments);
  // Each source is independently capped at 20 by its own zod schema
  // (envelope inner / RequestSchema top-level), but the MERGED total must
  // also stay at 20 — otherwise user_envelope=true can sneak 20 + 20 = 40
  // refs into orchestration.
  if (merged.length > 20) {
    throw new UserEnvelopeParseError(
      `merged attachments exceed the 20-ref total (envelope ${envAttachments?.length ?? 0} + body ${topLevelAttachments?.length ?? 0} = ${merged.length})`,
    );
  }
  return {
    text: envText,
    attachments: merged.length > 0 ? merged : undefined,
  };
}
