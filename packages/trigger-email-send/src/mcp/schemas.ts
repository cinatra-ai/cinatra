import { z } from "zod";

export const campaignIdSchema = z.object({
  campaignId: z.string().min(1),
});

const approvedBodiesListSchema = z
  .array(
    z
      .object({
        artifactId: z.string().min(1).max(200),
        representationRevisionId: z.string().min(1).max(200),
        contactId: z.string().trim().min(1).max(200),
        // What the publish card showed for this message: the address the send
        // resolves for its draft must equal it (trimmed, any letter case), and
        // the subject the send mails must equal it exactly. Required, so every
        // message the approved form mails is bound to both.
        recipientEmail: z.string().min(1).max(320),
        subject: z.string().max(2000),
      })
      .strict(),
  )
  .min(1)
  .max(50);

function kindOfJson(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

// A flow step reaches the send through the passthrough road, which delivers a
// template value as a string: `{{ emailBodies | tojson }}` arrives as JSON text
// (cinatra#3089; the same text-for-structure rule as the passthrough's
// objects_update seam). The list is therefore read in both forms: an array as it
// is, a string as the JSON it must parse to. Text that does not parse, or parses
// to anything but a list, is refused here; the parsed list then meets the SAME
// entry schema and 1..50 bounds as the array form, so there is one validation.
const approvedBodiesInputSchema = z.preprocess((value, ctx) => {
  if (typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "approvedBodies text is not valid JSON" });
    return z.NEVER;
  }
  if (!Array.isArray(parsed)) {
    ctx.addIssue({
      code: "custom",
      message: `approvedBodies text must encode a JSON list of approved bodies (got ${kindOfJson(parsed)})`,
    });
    return z.NEVER;
  }
  return parsed;
}, approvedBodiesListSchema);

export const serviceAndCampaignIdSchema = z.object({
  serviceId: z.string().min(1).default("campaign-email-outreach"),
  campaignId: z.string().min(1),
  // Explicit refs let the use case fetch the approved drafts + recipients
  // without scanning cinatra.objects by campaignId scoping rules.
  approvedDraftBundleRef: z.string().uuid().optional(),
  confirmedRecipientsRef: z.string().uuid().optional(),
  senderEmail: z.string().email().optional(),
  // The approved email bodies: each one an `email:body` artifact revision, the
  // contact of the draft it is the body of (the draft's `contactId`, else its
  // `recipientId`), which joins the body to its draft, and the recipient
  // address and subject the publish card showed for that message. When given, the send
  // mails, for each draft with an address, the text of ITS approved revision,
  // and refuses the whole send before any mail when a body is missing,
  // unreadable, not the artifact's current revision, named twice, the body of
  // no draft, or when the message's address or subject is not the one shown. At most 50: the cap of the publish card's artifacts row
  // (PUBLISH_LIST_ROW_ITEMS_MAX), so every body the card showed fits one send.
  approvedBodies: approvedBodiesInputSchema.optional(),
});

export const workerServiceAndCampaignIdSchema = serviceAndCampaignIdSchema.extend({
  jobId: z.string().min(1),
});

export const testSendSchema = z.object({
  campaignId: z.string().min(1),
  recipientEmail: z.string().email(),
  selectionMode: z.enum(["random_initial", "specific_initial", "all_initial"]),
  specificInitialDraftIds: z.array(z.string()).optional(),
  specificFollowUpDraftIds: z.array(z.string()).optional(),
});

export const processDueFollowUpsSchema = z.object({
  campaignId: z.string().min(1).optional(),
});
