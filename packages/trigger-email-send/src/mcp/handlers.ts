import type { PrimitiveActorContext, PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import * as schemas from "./schemas";

export type AsyncOperationState = {
  operationId: string;
  kind: string;
  status: string;
  phase?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  campaignId: string;
  resultSummary?: string;
};

export type TriggerEmailSendUseCases = {
  sendTestEmail(input: { campaignId: string; recipientEmail: string; selectionMode: "random_initial" | "specific_initial" | "all_initial"; specificInitialDraftIds?: string[]; specificFollowUpDraftIds?: string[] }, actor: PrimitiveActorContext): Promise<Record<string, unknown>>;
  startInitialSend(input: { serviceId: string; campaignId: string }, actor: PrimitiveActorContext): Promise<AsyncOperationState>;
  getInitialSendStatus(input: { campaignId: string }, actor: PrimitiveActorContext): Promise<AsyncOperationState>;
  cancelInitialSend(input: { campaignId: string }, actor: PrimitiveActorContext): Promise<AsyncOperationState>;
  runInitialSendWorker(input: { serviceId: string; campaignId: string; jobId: string }, actor: PrimitiveActorContext): Promise<{ ok: true; jobId: string }>;
  processDueFollowUps(input: { campaignId?: string }, actor: PrimitiveActorContext): Promise<{ ok: true }>;
};

export function createTriggerEmailSendHandlers(useCases: TriggerEmailSendUseCases) {
  return {
    "email_outreach_send_test_start": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.sendTestEmail(schemas.testSendSchema.parse(request.input), request.actor),
    "email_outreach_send_initial_start": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.startInitialSend(schemas.serviceAndCampaignIdSchema.parse(request.input), request.actor),
    "email_outreach_send_initial_status": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.getInitialSendStatus(schemas.campaignIdSchema.parse(request.input), request.actor),
    "email_outreach_send_initial_cancel": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.cancelInitialSend(schemas.campaignIdSchema.parse(request.input), request.actor),
    "email_outreach_system_jobs_initial_send_run": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.runInitialSendWorker(schemas.workerServiceAndCampaignIdSchema.parse(request.input), request.actor),
    "email_outreach_system_process_due_follow_ups": async (request: PrimitiveInvocationRequest<unknown>) =>
      useCases.processDueFollowUps(schemas.processDueFollowUpsSchema.parse(request.input), request.actor),
  } as const;
}
