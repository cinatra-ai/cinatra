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
   * with its arguments bound to the values the decision surfaced. Absent: the road does not serve it.
   */
  passthroughPublishingStep?: true;
};

export const triggerEmailSendPrimitiveMetadata = [
  { name: "email_outreach_send_test_start", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: true, asyncOperationKind: "test_send", capabilityGroup: "send" },
  { name: "email_outreach_send_initial_start", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: true, asyncOperationKind: "initial_send", capabilityGroup: "send", passthroughPublishingStep: true },
  { name: "email_outreach_send_initial_status", visibility: "public", mutatesState: false, approvalPolicyForModeB: "never", idempotencyKeySupported: false, asyncOperationKind: "initial_send", capabilityGroup: "send" },
  { name: "email_outreach_send_initial_cancel", visibility: "public", mutatesState: true, approvalPolicyForModeB: "always", idempotencyKeySupported: false, asyncOperationKind: "initial_send", capabilityGroup: "send" },
  { name: "email_outreach_system_jobs_initial_send_run", visibility: "internal", mutatesState: true, approvalPolicyForModeB: "never", idempotencyKeySupported: false, capabilityGroup: "system" },
  { name: "email_outreach_system_process_due_follow_ups", visibility: "internal", mutatesState: true, approvalPolicyForModeB: "never", idempotencyKeySupported: false, capabilityGroup: "system" },
] as const satisfies readonly TriggerEmailSendPrimitiveMetadata[];
