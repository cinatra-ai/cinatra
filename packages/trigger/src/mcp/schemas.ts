import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for @cinatra-ai/trigger primitives.
// These mirror the field shape consumed by trigger-service.ts
// (setRunTriggerForActor / getRunTriggerForActor / deleteRunTriggerForActor).
// ---------------------------------------------------------------------------

export const runIdSchema = z.object({
  runId: z.string().min(1),
});

export const triggerConfigSetSchema = z.object({
  runId: z.string().min(1),
  triggerType: z.enum(["immediate", "scheduled", "recurring"]),
  scheduledAt: z.string().datetime().nullable().optional(),
  cronExpression: z.string().min(1).nullable().optional(),
  timezone: z.string().min(1).default("UTC"),
  enabled: z.boolean().default(true),
});

export type TriggerConfigSetInput = z.infer<typeof triggerConfigSetSchema>;
export type RunIdInput = z.infer<typeof runIdSchema>;
