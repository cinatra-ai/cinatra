import "server-only";

// ---------------------------------------------------------------------------
// Test-delivery send PORT — host implementation (eng#548 #1625, DESIGN-V3
// "Module boundary resolution", part-2 stage 1).
//
// packages/agents owns the run scope, execute-tier authz, the durable
// agent_run_test_sends ledger (claim/settle/seq), and the typed discriminated
// return. This host impl performs ONLY the work that needs the app's
// email/auth/objects graph — the run-OWNER ActorContext, the campaign
// objects-authz, the actual outbound send, and crash reconciliation — injected
// through the boot-published LEAF port (register-test-delivery-send-port.ts).
//
// The run-owner ActorContext NEVER crosses the package boundary: only opaque
// selectedDraftIds + the typed result do. FAIL-CLOSED: a missing wiring or a
// send exception surfaces (the primitive returns an error / a typed failure),
// never a silent no-op send.
// ---------------------------------------------------------------------------

import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import { createSessionObjectsClient } from "@cinatra-ai/objects";
import {
  createTriggerEmailSendUseCases,
  planTestSendSelection,
} from "@/lib/trigger-email-send-use-cases";
import type {
  TestDeliverySendPort,
  TestDeliveryPortRun,
  TestDeliveryPrepareResult,
  TestDeliveryPerformResult,
  TestDeliverySendFailureReason,
} from "@cinatra-ai/agents/test-delivery-send-port";

const SENT_EMAIL_TYPE = "@cinatra-ai/email:sent-email";

const PORT_FAILURE_REASONS: ReadonlySet<TestDeliverySendFailureReason> = new Set([
  "no_drafts_selected",
  "invalid_recipient",
  "connector_unavailable",
  "dev_mode_recipient_required",
  "send_failed",
]);

/** Build a mailbox-selector PrimitiveActorContext from the run's OWNER identity.
 *  `run.runBy` is the mailbox selector (the Gmail connection used is the run
 *  owner's); the wrapper handler already fails closed on a null runBy. */
function ownerSendActor(run: TestDeliveryPortRun): PrimitiveActorContext {
  return {
    actorType: "human",
    userId: run.runBy ?? undefined,
    source: "a2a",
    orgId: run.orgId,
  };
}

export const testDeliverySendPortImpl: TestDeliverySendPort = {
  async prepareSend(params): Promise<TestDeliveryPrepareResult> {
    const { run, campaignId } = params;
    // Owner-context campaign objects-authz. The objects store is the org-bearing
    // authority; the enforced mapping is objectId == campaignId (DESIGN-V3 (5)).
    const ownerCtx = await buildActorContextFromRun(run);
    const client = createSessionObjectsClient(ownerCtx);
    let object: unknown = null;
    try {
      const res = (await client.get(campaignId)) as { object?: unknown } | null;
      object = res && typeof res === "object" ? (res as { object?: unknown }).object : null;
    } catch (err) {
      // BOTH a not-found ({object:null}) AND an objects-authz denial map to
      // campaign_access_denied; an unrelated infra error PROPAGATES (fail-closed,
      // run-failing — a bug, not a user-correctable state).
      if (err instanceof AuthzError) {
        return { ok: false, reason: "campaign_access_denied" };
      }
      throw err;
    }
    if (!object) {
      return { ok: false, reason: "campaign_access_denied" };
    }

    // Resolve the FINAL concrete draft-id set ONCE — random_initial is pinned
    // here and never rerandomized on retry. Reuses the shared selection logic.
    const plan = await planTestSendSelection({
      campaignId,
      recipientEmail: params.recipientEmail,
      selectionMode: params.selectionMode,
      specificInitialDraftIds: params.specificInitialDraftIds,
      specificFollowUpDraftIds: params.specificFollowUpDraftIds,
    });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason };
    }
    return { ok: true, recipientEmail: plan.recipientEmail, selectedDraftIds: plan.selectedDraftIds };
  },

  async performSend(params): Promise<TestDeliveryPerformResult> {
    const { run, campaignId, submissionId, recipientEmail, selectedDraftIds } = params;
    const actor = ownerSendActor(run);
    // Send EXACTLY the pinned ids (never rerandomized): specific_initial + the
    // resolved ids. submissionId threads into the sendEmail correlation for
    // per-draft crash reconciliation.
    const result = await createTriggerEmailSendUseCases().sendTestEmail(
      {
        campaignId,
        recipientEmail,
        selectionMode: "specific_initial",
        specificInitialDraftIds: selectedDraftIds,
        submissionId,
      },
      actor,
    );
    // The delivered-id set the use-case reports (all pinned ids on full success,
    // the partial prefix on a mid-batch failure). Fall back defensively: a full
    // success without an explicit list delivered every pinned id; a failure without
    // one delivered nothing observable.
    const deliveredDraftIds = Array.isArray(result.deliveredDraftIds)
      ? (result.deliveredDraftIds as unknown[]).filter((id): id is string => typeof id === "string")
      : result.ok === true
        ? selectedDraftIds
        : [];
    if (result.ok === true) {
      return {
        ok: true,
        sentTo: typeof result.sentTo === "string" ? result.sentTo : recipientEmail,
        sentCount: typeof result.sentCount === "number" ? result.sentCount : selectedDraftIds.length,
        deliveredDraftIds,
        message: typeof result.message === "string" ? result.message : `Test email sent to ${recipientEmail}.`,
      };
    }
    const reason = PORT_FAILURE_REASONS.has(result.reason as TestDeliverySendFailureReason)
      ? (result.reason as TestDeliverySendFailureReason)
      : "send_failed";
    return {
      ok: false,
      reason,
      deliveredDraftIds,
      message: typeof result.message === "string" ? result.message : "The test send failed.",
    };
  },

  async reconcile(params): Promise<"sent" | "unknown"> {
    const { run, campaignId, submissionId, expectedDraftIds } = params;
    // A vacuous expected set can never be proven delivered.
    if (expectedDraftIds.length === 0) return "unknown";
    const ownerCtx = await buildActorContextFromRun(run);
    const client = createSessionObjectsClient(ownerCtx);
    // Query the indexed campaign correlation, then narrow to THIS submission in
    // memory (submissionId + draftId are persisted on the sent-email object).
    const { items } = await client.list({
      type: SENT_EMAIL_TYPE,
      dataEquals: [{ key: "campaignId", value: campaignId }],
      limit: 500,
    });
    const coveredDraftIds = new Set<string>();
    for (const it of items as Array<{ data?: Record<string, unknown> }>) {
      const data = it.data ?? {};
      if (data.submissionId === submissionId && typeof data.draftId === "string") {
        coveredDraftIds.add(data.draftId);
      }
    }
    // "sent" ONLY when EVERY expected draft has a correlation row for THIS
    // submission — a partial multi-draft send stays "unknown".
    const allCovered = expectedDraftIds.every((id) => coveredDraftIds.has(id));
    return allCovered ? "sent" : "unknown";
  },
};
