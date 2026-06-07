// ---------------------------------------------------------------------------
// Trigger primitive metadata.
//
// Mirror of the TriggerEmailSendPrimitiveMetadata shape used by
// packages/trigger-email-send. Three primitives are exposed for the
// trigger-agent's tool list:
//   - trigger_config_get   (read)
//   - trigger_config_set   (write — per-tool approval, idempotent)
//   - trigger_config_delete (write — always approve)
// ---------------------------------------------------------------------------

export type TriggerPrimitiveMetadata = {
  name: string;
  visibility: "public" | "internal";
  mutatesState: boolean;
  approvalPolicyForModeB: "never" | "always" | "per-tool";
  idempotencyKeySupported: boolean;
  asyncOperationKind?: string;
  capabilityGroup: "trigger";
};

export const triggerPrimitiveMetadata = [
  {
    name: "trigger_config_get",
    visibility: "public",
    mutatesState: false,
    approvalPolicyForModeB: "never",
    idempotencyKeySupported: false,
    capabilityGroup: "trigger",
  },
  {
    name: "trigger_config_set",
    visibility: "public",
    mutatesState: true,
    approvalPolicyForModeB: "per-tool",
    idempotencyKeySupported: true,
    capabilityGroup: "trigger",
  },
  {
    name: "trigger_config_delete",
    visibility: "public",
    mutatesState: true,
    approvalPolicyForModeB: "always",
    idempotencyKeySupported: false,
    capabilityGroup: "trigger",
  },
] as const satisfies readonly TriggerPrimitiveMetadata[];
