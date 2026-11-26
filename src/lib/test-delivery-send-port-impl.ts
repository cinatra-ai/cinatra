import "server-only";

// ---------------------------------------------------------------------------
// Test-delivery send PORT — host implementation (#1625, DESIGN-V3
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
  applyTokenReplacements,
  buildLazyDefaultDeps,
  createTriggerEmailSendUseCases,
  planTestSendSelection,
} from "@/lib/trigger-email-send-use-cases";
import type {
  TestDeliverySendPort,
  TestDeliveryPortRun,
  TestDeliveryPrepareResult,
  TestDeliveryPerformResult,
  TestDeliveryPinnedPerformResult,
  TestDeliverySendFailureReason,
} from "@cinatra-ai/agents/test-delivery-send-port";
import { testDraftRevision, testSendPreview, testSendRecipient } from "@cinatra-ai/agents/test-delivery-send-port";

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
    return {
      ok: true,
      recipientEmail: plan.recipientEmail,
      selectedDraftIds: plan.selectedDraftIds,
      // cinatra#4150: what a publish card shows of the plan: the From, and each draft (in send order) with the revision
      // the pinned send checks, its subject and a short preview of its body.
      sender: plan.sender,
      drafts: await Promise.all(
        plan.selectedDrafts.map(async (d) => ({
          id: d.id,
          revision: await testDraftRevision(d),
          subject: d.subject,
          preview: testSendPreview(applyTokenReplacements(d.body)),
        })),
      ),
    };
  },

  async performPinnedSend(params): Promise<TestDeliveryPinnedPerformResult> {
    // cinatra#4150: the pinned plan, sent exactly (same sender, recipient, drafts at their revisions) from the run
    // OWNER's mailbox; any difference answers plan_changed before any message goes out. The owner's access to the
    // campaign is read again first, as prepareSend reads it: access may have ended since the plan was made.
    const ownerCtx = await buildActorContextFromRun(params.run);
    let object: unknown = null;
    try {
      const res = (await createSessionObjectsClient(ownerCtx).get(params.plan.campaignId)) as { object?: unknown } | null;
      object = res && typeof res === "object" ? (res as { object?: unknown }).object : null;
    } catch (err) {
      if (!(err instanceof AuthzError)) throw err;
    }
    if (!object) {
      return { ok: false, reason: "campaign_access_denied", message: "You do not have access to this campaign.", deliveredDraftIds: [] };
    }
    // The campaign and the plan's drafts are read again: the sender must be the plan's, every draft must still belong
    // to the campaign and still be at the plan's revision; else nothing is sent. What is checked is what is sent (the
    // drafts are read once, checked, and sent from that read). A campaign that is not found is an invariant fault.
    const { plan, submissionId } = params;
    const deps = buildLazyDefaultDeps();
    const campaign = await deps.getCampaign(plan.campaignId);
    if (!campaign) throw new Error("Campaign not found.");
    const recipient = testSendRecipient(plan.recipientEmail);
    if (recipient === null || recipient !== plan.recipientEmail) {
      return {
        ok: false,
        reason: "invalid_recipient",
        message: "Enter a valid recipient email address for the test send.",
        deliveredDraftIds: [],
      };
    }
    const changed = {
      ok: false as const,
      reason: "plan_changed" as const,
      message: "The test send no longer matches what was approved (a draft or the sender changed). Nothing was sent.",
      deliveredDraftIds: [],
    };
    if ((campaign.senderEmail ?? "") !== plan.sender.email || (campaign.senderName ?? "") !== plan.sender.name) return changed;
    const campaignDraftIds = new Set(campaign.draftIds ?? []);
    const ids = plan.drafts.map((d) => d.id);
    if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((id) => campaignDraftIds.has(id))) return changed;
    const byId = new Map((await deps.getDraftsByIds(ids)).map((d) => [d.id, d] as const));
    const shown = params.shownDrafts;
    if (shown !== undefined && shown.length !== plan.drafts.length) return changed;
    const toSend: Array<{ id: string; subject: string; body: string }> = [];
    for (const [i, pinned] of plan.drafts.entries()) {
      const draft = byId.get(pinned.id);
      if (!draft || (await testDraftRevision(draft)) !== pinned.revision) return changed;
      // What the approved card showed of this draft is what is mailed: its subject, and its preview computed again
      // from the body read here by the one preview rule.
      const seen = shown?.[i];
      if (seen && (seen.subject !== draft.subject || seen.preview !== testSendPreview(applyTokenReplacements(draft.body)))) {
        return changed;
      }
      toSend.push(draft);
    }
    const actor = ownerSendActor(params.run);
    const deliveredDraftIds: string[] = [];
    try {
      for (const draft of toSend) {
        await deps.sendEmail(
          {
            to: [recipient],
            subject: `[Test] ${draft.subject}`,
            textBody: applyTokenReplacements(draft.body),
            fromName: campaign.senderName,
            fromEmail: campaign.senderEmail,
            replyTo: campaign.senderEmail,
          },
          {
            userId: actor.userId,
            orgId: actor.orgId ?? undefined,
            correlation: { campaignId: plan.campaignId, submissionId, draftId: draft.id },
          },
        );
        deliveredDraftIds.push(draft.id);
      }
      return { ok: true, sentTo: recipient, sentCount: deliveredDraftIds.length, deliveredDraftIds, message: `Test email sent to ${recipient}.` };
    } catch (err) {
      // A transport failure part way: the drafts that did go out are reported, so a later send never repeats them.
      return { ok: false, reason: "send_failed", deliveredDraftIds, message: err instanceof Error ? err.message : "The test send failed." };
    }
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
