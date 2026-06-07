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
