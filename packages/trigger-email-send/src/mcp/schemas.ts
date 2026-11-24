import { z } from "zod";

export const campaignIdSchema = z.object({
  campaignId: z.string().min(1),
});

export const serviceAndCampaignIdSchema = z.object({
  serviceId: z.string().min(1).default("campaign-email-outreach"),
  campaignId: z.string().min(1),
  // Explicit refs let the use case fetch the approved drafts + recipients
  // without scanning cinatra.objects by campaignId scoping rules.
  approvedDraftBundleRef: z.string().uuid().optional(),
  confirmedRecipientsRef: z.string().uuid().optional(),
  senderEmail: z.string().email().optional(),
  // The approved email bodies: each one an `email:body` artifact revision and
  // the contact of the draft it is the body of (the draft's `contactId`, else
  // its `recipientId`), which joins the body to its draft. When given, the send
  // mails, for each draft with an address, the text of ITS approved revision,
  // and refuses the whole send before any mail when a body is missing,
  // unreadable, not the artifact's current revision, named twice or the body of
  // no draft. At most 50: the cap of the publish card's artifacts row
  // (PUBLISH_LIST_ROW_ITEMS_MAX), so every body the card showed fits one send.
  approvedBodies: z
    .array(
      z
        .object({
          artifactId: z.string().min(1).max(200),
          representationRevisionId: z.string().min(1).max(200),
          contactId: z.string().trim().min(1).max(200),
        })
        .strict(),
    )
    .min(1)
    .max(50)
    .optional(),
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
