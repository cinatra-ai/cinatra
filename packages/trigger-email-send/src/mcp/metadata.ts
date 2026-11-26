export type TriggerEmailSendPrimitiveMetadata = {
  name: string;
  visibility: "public" | "internal";
  mutatesState: boolean;
  approvalPolicyForModeB: "never" | "always" | "per-tool";
  idempotencyKeySupported: boolean;
  asyncOperationKind?: string;
  capabilityGroup: "send" | "system";
  /**
   * cinatra#3745: the deterministic passthrough road (`/api/agents/passthrough`) may serve this primitive, and only as
   * the call of a flow's publishing step whose publish decision a person released; the call uses that decision once,
   * with its arguments bound to the decision. `shown` names the arguments that say what is mailed: the released card
   * must have displayed each on a declared row. `routing` names opaque ids no person can judge (the card shows no row
   * for them): each is bound only by equality to the value frozen with the decision. Any other argument is refused.
   * Absent: the road does not serve it.
   */
  passthroughPublishingStep?: { readonly shown: readonly string[]; readonly routing: readonly string[] };
};

export const triggerEmailSendPrimitiveMetadata = [
  { name: "email_outreach_send_test_start", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: true, asyncOperationKind: "test_send", capabilityGroup: "send" },
  { name: "email_outreach_send_initial_start", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: true, asyncOperationKind: "initial_send", capabilityGroup: "send",
    // The sender is what the card shows; the campaign and the two bundle references only route the send (the send
    // checks the bundles' content against the released list, cinatra#4832).
    passthroughPublishingStep: { shown: ["senderEmail"], routing: ["serviceId", "campaignId", "approvedDraftBundleRef", "confirmedRecipientsRef"] } },
  { name: "email_outreach_send_initial_status", visibility: "public", mutatesState: false, approvalPolicyForModeB: "never", idempotencyKeySupported: false, asyncOperationKind: "initial_send", capabilityGroup: "send" },
  { name: "email_outreach_send_initial_cancel", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: false, asyncOperationKind: "initial_send", capabilityGroup: "send" },
  { name: "email_outreach_system_jobs_initial_send_run", visibility: "internal", mutatesState: true, approvalPolicyForModeB: "never", idempotencyKeySupported: false, capabilityGroup: "system" },
  { name: "email_outreach_system_process_due_follow_ups", visibility: "internal", mutatesState: true, approvalPolicyForModeB: "never", idempotencyKeySupported: false, capabilityGroup: "system" },
] as const satisfies readonly TriggerEmailSendPrimitiveMetadata[];
