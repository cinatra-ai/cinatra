export type TriggerEmailSendPrimitiveMetadata = {
  name: string;
  visibility: "public" | "internal";
  mutatesState: boolean;
  approvalPolicyForModeB: "never" | "always" | "per-tool";
  idempotencyKeySupported: boolean;
  asyncOperationKind?: string;
  capabilityGroup: "send" | "system";
  /**
   * The passthrough road (`/api/agents/passthrough`) may serve this primitive,
   * and only as the call of a declared publishing step: the calling step must be
   * a listed publishing step of the run's compiled flow and its newest publish
   * decision must read `released`. Absent, the road refuses the primitive unless
   * its own allowlist names it.
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
