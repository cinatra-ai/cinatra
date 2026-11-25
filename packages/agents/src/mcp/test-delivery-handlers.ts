// Run-scoped test-delivery send + parse primitives (#1625) — EXTRACTED from
// handlers.ts (file-size ratchet: keep the primitive hub under its ceiling).
// Intra-package import cycle with ./handlers is intentional and safe: the four
// shared helpers are hoisted function declarations referenced only at call time.

import { relative } from "node:path";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { AuthzError, can } from "@/lib/authz";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
  type AgentRunRecord,
  type AgentTemplateRecord,
} from "../store";
import { enforceRunAccess } from "../auth-policy";
import {
  getTestDeliverySendPort,
  TEST_DELIVERY_SEND_PORT_UNWIRED_ERROR,
  type TestDeliveryPinnedPlan,
  type TestDeliveryPortRun,
  type TestDeliverySelectionMode,
  testSendRecipient,
} from "../test-delivery-send-port";
import { readDecisionOfRun } from "../publish-decision-store";
import { publishDecisionCardRows, publishRowKind, type PublishRowDeclaration } from "../publish-decision-card";
import {
  claimTestSend,
  settleTestSend,
  recordPreClaimFailure,
  readTestSendBySubmission,
  readSentCountForRun,
  readUnacknowledgedDeliveredDraftIds,
  type TestSendRecord,
} from "../agent-run-test-sends";
import {
  authzErrorToResponse,
  emitReadDenialAudit,
  resolveRoleHintsFromSession,
  resolveRunScopedRunId,
  type PrimitiveRequest,
} from "./handlers";

// ---------------------------------------------------------------------------
// email_test_delivery_run_send / email_test_delivery_parse_action (#1625)
//
// The two run-scoped primitives that turn the test-delivery gate into a REAL
// run-performed send loop (DESIGN-V3 contracts (3)/(4)/(5)/(6)). Both derive the
// run, the declaring agent package, the campaign, and — for the send — the
// submission id from the run-bound invocation context, NEVER from caller input
// (the same #1794 trust model as the HITL primitives above).
//
//   email_test_delivery_run_send  — performs the send under the run OWNER's
//     authority, idempotent per (run, submission) via the agent_run_test_sends
//     ledger. execute-tier authz. The actual email/authz/objects work is done by
//     the host-injected send PORT; this handler owns run scope, authz, the
//     durable ledger claim/settle, seq, and the typed discriminated return.
//   email_test_delivery_parse_action — deterministic parse of the gate envelope
//     into a typed branch action; `halt` when the ledger performed-send count has
//     reached the template-trusted maxGateVisits cap. read-tier.
//
// CO-OWNER RESPONDER RULING (DESIGN-V3 (5)): a co-owner who passes the "execute"
// authorization gate but is NOT run.runBy still causes the send to use the run
// OWNER's mailbox/authority (the PORT builds the owner ActorContext from the run).
// A test email always comes FROM the run owner's configured sender regardless of
// which authorized co-owner clicked Send — and only after the "execute" boundary.
// ---------------------------------------------------------------------------

// REGISTRY-ROUTED gate-owner restriction (core-extension-instance-coupling-ban:
// core source names NO extension package). This send wrapper exists solely to
// drive the test-delivery HITL renderer gate; the manifest/registry — the
// generated field-renderer bindings + the runtime installed-package collector
// (getMergedFieldRendererBindings) — is the source of truth for the gate. Core
// matches the run's own package against the OWNER of the `test-delivery-input`
// binding, derived from the binding-ID prefix, so the restriction is
// manifest-derived, never hardcoded. `test-delivery-input` is a renderer-KIND
// contract id (not a package name/path), the #1854 A3 registry-routed precedent.
// (Adjudication: the coupling-ban gate WINS over DESIGN-V3 212-213's named-package
// restriction — the standing ratified principle is no pack names in core.)
//
// AXIS (#1958): send-authorization answers "whose GATE is this" — the AGENT that
// HOSTS the test-delivery gate, carried by the binding ID's package PREFIX
// (`@cinatra-ai/email-test-delivery-agent:input` → the `…-agent` package). It must
// NOT key on the binding's physical `declaredBy` (who SHIPS the renderer
// component), because a renderer can be RELOCATED to another pack without changing
// whose gate it is: #1958 moved this renderer's `declaredBy` from the agent to
// `@cinatra-ai/email-artifacts` while leaving the binding ID (the gate identity)
// untouched. The render axis keys on the unchanged binding ID and kept working;
// keying send-authz on `declaredBy` refused EVERY send after the move. Keying on
// the binding-ID owner prefix is invariant under such relocation — the render and
// send axes both track the one stable identity.
const TEST_DELIVERY_RENDERER_KIND = "test-delivery-input";

/** Extract the OWNER package from a field-renderer binding id. A binding id is
 *  `<ownerPackage>:<rendererLocalId>` (e.g.
 *  `@cinatra-ai/email-test-delivery-agent:input`); the npm package that hosts the
 *  gate is everything before the FIRST `:` — an npm package name cannot contain a
 *  colon, so the split is unambiguous. Returns null for a malformed id (no colon /
 *  empty prefix) so a bad registry row can never authorize an empty package. */
function bindingOwnerPackage(bindingId: string): string | null {
  const idx = bindingId.indexOf(":");
  if (idx <= 0) return null;
  return bindingId.slice(0, idx);
}

/** The set of AGENT packages that OWN the test-delivery renderer gate (per the
 *  manifest/registry). A run may invoke the send wrapper only if its own package
 *  HOSTS the gate — i.e. is the binding-ID owner of a `test-delivery-input`
 *  binding. Derived from the binding ID (the gate identity), NOT the physical
 *  `declaredBy` (the renderer shipper), so authorization is INVARIANT under a
 *  renderer relocation across packs (#1958). Resolved from the registry, never a
 *  hardcoded name. The field-renderer-bindings.server module is imported LAZILY
 *  (dynamic) so its filesystem-scanning graph is not pulled onto handlers.ts's
 *  eager import cycle (the extension-edge-bound-agent precedent). */
async function resolveTestDeliveryGateOwnerPackages(): Promise<Set<string>> {
  const { getMergedFieldRendererBindings } = await import("../field-renderer-bindings.server");
  const owners = new Set<string>();
  for (const b of getMergedFieldRendererBindings()) {
    if (b.kind !== TEST_DELIVERY_RENDERER_KIND) continue;
    const owner = bindingOwnerPackage(b.id);
    if (owner) owners.add(owner);
  }
  return owners;
}

// The claim lease. A row still `sending` past this window is treated as a
// crashed claim and reconciled against the outbound correlation store (never a
// blind resend). Generous relative to a single Gmail round-trip.
const TEST_SEND_LEASE_SECONDS = 120;

// The default renderer-gate visit cap until the stage-B oas-compiler stamp lands
// (DESIGN-V3 (1)/(3)). maxGateVisits counts PERFORMED sends; the terminal
// continue/halt does not consume one. Read SERVER-SIDE from the trusted template.
const DEFAULT_MAX_GATE_VISITS = 25;
const MAX_GATE_VISITS_CEILING = 100;

// Resolves the trusted per-gate-resume submission id for the run-scoped send
// primitive. Stamped ONLY by a verified server-side run-bound seam
// (`/api/agents/passthrough`, from the context-id-bound run row's a2aTaskId),
// never from caller input. Fail closed absent — the ledger dedupe identity
// cannot be forged into being.
function resolveRunScopedSubmissionId(
  tool = "email_test_delivery_run_send",
): { submissionId: string } | { error: string } {
  const ctx = mcpRequestContextStorage.getStore();
  const submissionId = ctx?.verifiedSubmissionId;
  if (!submissionId || typeof submissionId !== "string" || submissionId.length === 0) {
    return {
      error:
        `${tool}: no verified submission id on the invocation frame ` +
        "(the run-bound pre-interrupt seam stamps it from the gate's resume task id). " +
        "Failing closed — the idempotency identity cannot be caller-supplied.",
    };
  }
  return { submissionId };
}

// Best-effort read of the template-trusted maxGateVisits (DESIGN-V3 (1)). The
// oas-compiler stamp that persists it into the compiled approvalPolicy step is a
// deferred forward-guard, so this reads defensively and defaults to 25, clamped
// to [1, 100]. NEVER an OAS-carried or caller value.
function resolveMaxGateVisits(template: AgentTemplateRecord | null): number {
  const raw = template?.approvalPolicy as unknown as {
    maxGateVisits?: unknown;
    steps?: Array<{ maxGateVisits?: unknown; metadata?: { cinatra?: { maxGateVisits?: unknown } } }>;
  } | null;
  const candidates: unknown[] = [];
  if (raw && typeof raw === "object") {
    candidates.push(raw.maxGateVisits);
    for (const step of raw.steps ?? []) {
      candidates.push(step?.maxGateVisits);
      candidates.push(step?.metadata?.cinatra?.maxGateVisits);
    }
  }
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c >= 1) {
      return Math.min(c, MAX_GATE_VISITS_CEILING);
    }
  }
  return DEFAULT_MAX_GATE_VISITS;
}

// Reads run.inputParams.campaignId as a non-empty string. The campaign is PINNED
// from the run's dispatch params (DESIGN-V3 (5)) — a caller / gate campaignId is
// structurally impossible to send to.
function resolvePinnedCampaignId(run: AgentRunRecord): string | null {
  const raw = run.inputParams?.campaignId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function toPortRun(run: AgentRunRecord): TestDeliveryPortRun {
  return {
    id: run.id,
    runBy: run.runBy,
    orgId: run.orgId,
    dependentInstallId: run.dependentInstallId,
    inputParams: run.inputParams,
  };
}

// A ledger row's stored result_json is the typed discriminated result the port
// returned; re-return it verbatim with the row's seq stamped. On a row that
// somehow lacks result_json (crash before settle already handled by the caller),
// synthesize an in-progress shape.
function ledgerRowToResult(row: TestSendRecord): Record<string, unknown> {
  if (row.resultJson && typeof row.resultJson === "object") {
    return { ...row.resultJson, seq: row.seq };
  }
  return {
    ok: false,
    seq: row.seq,
    reason: "send_in_progress",
    message: "A test send for this submission is still in progress.",
  };
}

/** The idempotency read of a send (one per (run, submission)), shared by both call shapes: a terminal row of this
 *  submission is returned verbatim, a live claim answers send_in_progress, and a claim whose lease expired is reconciled
 *  against the outbound correlation store (never a blind resend). Null when the submission has no row yet. */
async function replayExistingSubmission(args: {
  runId: string;
  submissionId: string;
  campaignId: string;
  recipientEmail: string;
  port: NonNullable<ReturnType<typeof getTestDeliverySendPort>>;
  portRun: TestDeliveryPortRun;
}): Promise<Record<string, unknown> | null> {
  const { runId, submissionId, campaignId, recipientEmail, port, portRun } = args;
  const existing = await readTestSendBySubmission(runId, submissionId);
  if (!existing) return null;
  if (existing.status === "sent" || existing.status === "failed") {
    // Terminal — a transport retry of the same resume. Return the prior
    // result verbatim; NEVER a second send.
    return ledgerRowToResult(existing);
  }
  // status === "sending": either genuinely in-flight (lease live) or a
  // crashed claim (lease expired → ambiguous, reconcile).
  if (existing.leaseExpiresAt.getTime() > Date.now()) {
    return {
      ok: false,
      seq: existing.seq,
      reason: "send_in_progress",
      message: "Your previous test send is still in progress. Please wait.",
    };
  }
  // Expired lease → reconcile against the outbound correlation store for THIS
  // submission (never a blind resend).
  const outcome = await port.reconcile({
    run: portRun,
    campaignId,
    submissionId,
    expectedDraftIds: existing.selectedDraftIds,
  });
  if (outcome === "sent") {
    const settled = await settleTestSend({
      id: existing.id,
      status: "sent",
      result: {
        ok: true,
        sentTo: existing.recipientEmail ?? recipientEmail,
        sentCount: existing.selectedDraftIds.length,
        // reconcile confirmed EVERY expected draft was delivered.
        deliveredDraftIds: existing.selectedDraftIds,
        message: `Test email sent to ${existing.recipientEmail ?? recipientEmail}.`,
      },
    });
    if (settled) return ledgerRowToResult(settled);
    // CAS lost (#1947): the original slow claimer's performSend returned and
    // settled this row between our reconcile and here. Its result is a real
    // send outcome — return the AUTHORITATIVE persisted terminal verbatim,
    // never our reconcile-synthesized shape over a row that already settled.
    const authoritative = await readTestSendBySubmission(runId, submissionId);
    return ledgerRowToResult(authoritative ?? existing);
  }
  // Ambiguous — the earlier send's outcome is unknowable. Do NOT auto-resend.
  return {
    ok: false,
    seq: existing.seq,
    reason: "previous_send_unknown",
    message:
      "Your last test send's status is unknown — check the inbox before resending.",
  };
}

export async function handleEmailTestDeliveryRunSend(
  request: PrimitiveRequest<{
    recipientEmail?: unknown;
    selectionMode?: unknown;
    specificInitialDraftIds?: unknown;
    specificFollowUpDraftIds?: unknown;
    pinnedPlanJson?: unknown;
  }>,
): Promise<unknown> {
  const runCtx = resolveRunScopedRunId();
  if ("error" in runCtx) return { error: runCtx.error };
  const subCtx = resolveRunScopedSubmissionId();
  if ("error" in subCtx) return { error: subCtx.error };
  const { runId } = runCtx;
  const { submissionId } = subCtx;

  // The ONLY caller-supplied fields (run, campaign, submission are all context-
  // derived). The passthrough seam invokes WITHOUT the tool's Zod schema, so these
  // are validated + bounded defensively — but the validation runs AFTER the run is
  // loaded + authorized (below), so EVERY user-correctable failure resolves to a
  // gateCycle-advancing ledger row (never a bare `{error}` that strands the HITL
  // screen — #1625 F3). Captured raw here; validated post-authz.
  // cinatra#4150: TWO call shapes, told apart by the presence of `pinnedPlanJson`. With it, the call is a PINNED send:
  // it sends exactly the plan that `campaign_test_send_plan` answered (the plan a publish card showed), and every
  // selection field is ignored. Without it, the call is the selection send exactly as before.
  const pinned = request.input !== null && typeof request.input === "object" && "pinnedPlanJson" in request.input;
  const pinnedPlanJson = typeof request.input?.pinnedPlanJson === "string" ? request.input.pinnedPlanJson : "";
  const pinnedPlan = pinned ? parsePinnedPlan(pinnedPlanJson) : null;
  const recipientEmail = pinned
    ? (pinnedPlan?.recipientEmail ?? "")
    : typeof request.input?.recipientEmail === "string" ? request.input.recipientEmail.trim() : "";
  const selectionModeRaw = request.input?.selectionMode;
  const SELECTION_MODES: TestDeliverySelectionMode[] = [
    "random_initial",
    "specific_initial",
    "all_initial",
  ];
  const validateIds = (value: unknown, field: string): string[] | { error: string } => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return { error: `\`${field}\` must be an array of draft id strings.` };
    if (value.length > 500) return { error: `\`${field}\` is bounded at 500 ids.` };
    if (value.some((id) => typeof id !== "string" || id.length === 0)) {
      return { error: `\`${field}\` must contain only non-empty draft id strings.` };
    }
    return value as string[];
  };

  const actor = request.actor as PrimitiveActorContext;
  const roles = await resolveRoleHintsFromSession();
  try {
    // #1625 (F3): record a pre-claim failure as a terminal `failed` ledger
    // row that ALLOCATES the next per-run seq so `seq`→`gateCycle` ADVANCES and the
    // renderer clears its pending state (never strands). ON CONFLICT reads back the
    // winning row, so a same-submission transport retry returns the authoritative
    // prior result verbatim — never a second attempt. Used for EVERY user-visible
    // pre-claim failure below (invalid input, unauthorized package, missing
    // campaign/owner mailbox, unwired port, campaign-access denial, empty plan).
    const preClaimFail = async (
      result: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const rec = await recordPreClaimFailure({
        runId,
        submissionId,
        recipientEmail: recipientEmail || null,
        result,
      });
      return ledgerRowToResult(rec.row);
    };

    // read-enforced load (readAgentRunById applies enforceRunAccess("read")).
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    const template = await readAgentTemplateById(run.templateId);

    // EXECUTE-tier authz FIRST — before ANY ledger write. A pre-claim failure
    // record ALLOCATES a seq (advances gateCycle), which is an execute-tier side
    // effect on the run's HITL state; gating it behind `execute` ensures a merely
    // read-authorized actor can never advance the gate cycle (codex convergence).
    // OWNER-CONTEXT defense-in-depth, NOT responder authz (#1625 F2): the
    // passthrough seam reconstructs the actor from run.runBy for this server-side
    // back-edge node, so this check is evaluated against the owner and is
    // effectively tautological here. The RESPONDER-side execute gate lives at the
    // resume seam (review-task-actions.ts enforceResumeAccess / agent_run_resume),
    // which enforces `execute` + `approveHitl` against the actual responder BEFORE
    // the WayFlow resume ever reaches this node. Thread co-owners + effective
    // policy exactly like agent_run_resume so the shape matches.
    const coOwnerRows = await readRunCoOwners(run.id);
    const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
    const effectivePolicy = run.authPolicy ?? template?.agentAuthPolicy ?? null;
    await enforceRunAccess({ ...run, effectivePolicy, coOwnerUserIds }, actor, "execute", roles);

    // Gate-owner restriction — REGISTRY-ROUTED (see
    // resolveTestDeliveryGateOwnerPackages / TEST_DELIVERY_RENDERER_KIND: core
    // names NO extension package; the manifest/registry says which agent OWNS the
    // test-delivery gate, via the binding-ID prefix — NOT the renderer's physical
    // `declaredBy`, so a renderer relocation across packs never revokes the send
    // (#1958)). Enforced AFTER execute-authz above, so recording a pre-claim
    // failure here cannot be driven by a read-only actor.
    const agentPackageName =
      template?.packageName && template.packageName.length > 0 ? template.packageName : null;
    const gateOwnerPackages = await resolveTestDeliveryGateOwnerPackages();
    if (!agentPackageName || !gateOwnerPackages.has(agentPackageName)) {
      // Fail-as-data (no send), F3-recorded so the gate never strands. This run's
      // agent does not declare the test-delivery renderer this primitive drives.
      return preClaimFail({
        ok: false,
        reason: "not_authorized",
        message: "This run is not authorized to perform a test-delivery send.",
      });
    }

    // Campaign PINNED from the run's dispatch params — a caller campaignId is
    // never read. F3: a missing campaign is recorded (advances gateCycle) not
    // stranded.
    const campaignId = resolvePinnedCampaignId(run);
    if (!campaignId) {
      return preClaimFail({
        ok: false,
        reason: "connector_unavailable",
        message: "This run has no dispatched campaign to send from.",
      });
    }
    // Fail closed on a null runBy — the run owner is the mailbox selector; there
    // is no arbitrary-OAuth fallback (parity with the deleted route's guard). F3:
    // recorded so gateCycle advances (never strands).
    if (!run.runBy) {
      return preClaimFail({
        ok: false,
        reason: "connector_unavailable",
        message: "This run has no owner mailbox to send the test email from.",
      });
    }

    if (pinned) {
      return await performPinnedTestSend({
        run, campaignId, submissionId, plan: pinnedPlan, planJson: pinnedPlanJson, preClaimFail,
      });
    }

    // Input validation — post-authz so a malformed envelope resolves to a
    // gateCycle-advancing failed row, never a stranded screen (F3).
    if (recipientEmail.length === 0) {
      return preClaimFail({
        ok: false,
        reason: "invalid_recipient",
        message: "Enter a valid recipient email address for the test send.",
      });
    }
    if (!SELECTION_MODES.includes(selectionModeRaw as TestDeliverySelectionMode)) {
      return preClaimFail({
        ok: false,
        reason: "no_drafts_selected",
        message: "Choose a valid selection mode for the test send.",
      });
    }
    const selectionMode = selectionModeRaw as TestDeliverySelectionMode;
    const initialIds = validateIds(request.input?.specificInitialDraftIds, "specificInitialDraftIds");
    if (!Array.isArray(initialIds)) {
      return preClaimFail({ ok: false, reason: "no_drafts_selected", message: initialIds.error });
    }
    const followUpIds = validateIds(request.input?.specificFollowUpDraftIds, "specificFollowUpDraftIds");
    if (!Array.isArray(followUpIds)) {
      return preClaimFail({ ok: false, reason: "no_drafts_selected", message: followUpIds.error });
    }

    const port = getTestDeliverySendPort();
    if (!port) {
      // Fail CLOSED — never a phantom success. A missing wiring is an operator
      // error; F3-recorded (advances gateCycle) so the gate never strands while
      // still surfacing the wiring gap as the failure reason/message.
      return preClaimFail({
        ok: false,
        reason: "connector_unavailable",
        message: TEST_DELIVERY_SEND_PORT_UNWIRED_ERROR,
      });
    }
    const portRun = toPortRun(run);

    // ---- Idempotency: is there already a claim for this (run, submission)? ----
    const replayed = await replayExistingSubmission({ runId, submissionId, campaignId, recipientEmail, port, portRun });
    if (replayed) return replayed;

    // ---- Phase 1 (no side-effects): plan + pin the batch under owner authz. ----
    const prepared = await port.prepareSend({
      run: portRun,
      campaignId,
      recipientEmail,
      selectionMode,
      specificInitialDraftIds: initialIds,
      specificFollowUpDraftIds: followUpIds,
    });
    if (!prepared.ok) {
      // A pre-claim expected failure — report it as data, F3-recorded so
      // `seq`→`gateCycle` advances (a fresh submission id per visit ⇒ a distinct
      // row/seq even for a repeated identical reason). ON CONFLICT returns the
      // winning row so a same-submission transport retry replays verbatim.
      return preClaimFail({
        ok: false,
        reason: prepared.reason,
        message:
          prepared.reason === "campaign_access_denied"
            ? "You do not have access to this campaign."
            : prepared.reason === "invalid_recipient"
              ? "Enter a valid recipient email address for the test send."
              : "No test emails were selected to send.",
      });
    }

    // ---- Partial-batch-retry guard (#1625 regression). ----
    // A PRIOR gate visit may have PARTIALLY delivered drafts TO THIS RECIPIENT (a
    // mid-batch send failure settled `failed` but the prefix went out). The user
    // saw "failed" and retries on a fresh submission — re-sending those already-
    // delivered drafts would double-deliver. Subtract them (same-recipient, since
    // the last success) from the pinned plan before the claim. Keyed on the SAME
    // recipient the row is claimed/stored under (prepared.recipientEmail).
    //
    // SCOPE BOUNDARY (#1947): this suppression TRUSTS the transport-reported
    // `deliveredDraftIds` on each prior row. The #1947 hardening makes the
    // SAME-submission replay path airtight (the priority-CAS settle makes a
    // reconcile-confirmed `sent` win over a delivered-but-reported-`failed`, so a
    // crashed claim reconciles to its true delivered set — see settleTestSend).
    // The residual it does NOT close is a DIFFERENT-submission interleave: a
    // pathological delivered-but-reported-`failed` row whose `deliveredDraftIds`
    // is empty, read here by a FRESH submission before any same-submission replay
    // has reconciled it to `sent`. That window is bounded by WayFlow gate
    // serialization (one HITL resume in flight per run — a fresh gate visit is not
    // admitted until the prior resume, and its transport-retry reconcile, returns),
    // and closing it unconditionally would require a fresh-send-time objects-store
    // reconcile of every stale row here (a #1625 partial-retry-guard change with
    // its own hot-path/cost trade-offs), deliberately OUT of #1947's
    // same-submission scope.
    const alreadyDelivered = new Set(
      await readUnacknowledgedDeliveredDraftIds(runId, prepared.recipientEmail),
    );
    const selectedDraftIds = prepared.selectedDraftIds.filter((id) => !alreadyDelivered.has(id));
    if (selectedDraftIds.length === 0) {
      // Every planned draft was already delivered by a prior partial send — there
      // is nothing new to send; resending would double-deliver. Record (advances
      // gateCycle) with an honest banner instead of a phantom re-send.
      return preClaimFail({
        ok: false,
        reason: "no_drafts_selected",
        message:
          "The selected drafts were already delivered by a previous test send; nothing new to send.",
      });
    }

    // ---- Claim: the atomic exactly-once fence on (run, submission). Pins EXACTLY
    // the not-yet-delivered ids as the durable expected batch. ----
    const claim = await claimTestSend({
      runId,
      submissionId,
      selectedDraftIds,
      recipientEmail: prepared.recipientEmail,
      leaseSeconds: TEST_SEND_LEASE_SECONDS,
    });
    if (claim.kind === "existing") {
      // A concurrent claim raced us between the read above and here. Return based
      // on that row's state — never a second send.
      const row = claim.row;
      if (row.status === "sent" || row.status === "failed") return ledgerRowToResult(row);
      return {
        ok: false,
        seq: row.seq,
        reason: "send_in_progress",
        message: "Your previous test send is still in progress. Please wait.",
      };
    }

    // ---- Phase 2 (the outbound send) of exactly the pinned not-yet-delivered
    // ids. `result.deliveredDraftIds` is persisted in the settle so a later retry
    // excludes them + the cap counts a partial delivery. ----
    const result = await port.performSend({
      run: portRun,
      campaignId,
      submissionId,
      recipientEmail: prepared.recipientEmail,
      selectedDraftIds,
    });
    const settled = await settleTestSend({
      id: claim.row.id,
      status: result.ok ? "sent" : "failed",
      result: { ...result },
    });
    if (settled) return { ...result, seq: claim.row.seq };
    // CAS lost (#1947): a concurrent lease-expiry reconcile already settled this
    // row (it read the outbound correlation store and confirmed delivery) between
    // our performSend and this settle — the classic slow-send-past-lease window.
    // The reconcile-confirmed terminal is authoritative (ground truth from the
    // persisted sent-email objects); return it verbatim rather than clobbering it
    // with this (possibly delivered-but-reported-failed) transport self-report.
    const authoritative = await readTestSendBySubmission(runId, submissionId);
    return authoritative ? ledgerRowToResult(authoritative) : { ...result, seq: claim.row.seq };
  } catch (err) {
    if (err instanceof AuthzError) {
      emitReadDenialAudit(actor, runId);
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    // An UNEXPECTED fault (context/authz invariant, unknown exception) fails the
    // node visibly — it is a bug, not a user-correctable gate state.
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Test delivery send failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// The pinned test send and its plan (cinatra#4150)
//
// A run must not mail anything before a person approved it on the host's
// publish card, and the card must show what is mailed. The plan primitive
// (`campaign_test_send_plan`) answers, for one gate submission, the sender as
// the messages carry it, the recipient as typed and validated, and the PINNED
// drafts (ids and revisions, subjects, a short preview), with the random pick
// made there, once. Its answer feeds the card's rows directly: `sender` (a text
// row "From"), `recipient` (a text row "To"), `drafts` (a list row of records
// with `subject` and `preview`, at most 50, so the card shows every draft that
// will be mailed), and `planJson`, the pinned plan the send takes. The send in
// its pinned shape mails exactly that plan and refuses anything else.
// ---------------------------------------------------------------------------

/** The most drafts one pinned plan holds: the most records a publish card's list row draws, so every draft that will
 *  be mailed is on the card. */
export const TEST_SEND_PLAN_DRAFTS_MAX = 50;
const PLAN_JSON_MAX = 20_000;
const REVISION_RE = /^[0-9a-f]{64}$/;

/** The pinned plan as `planJson` carries it. Version 1; exactly these keys. */
type PinnedPlanWire = TestDeliveryPinnedPlan & { v: 1 };

const ownKeysAre = (value: object, keys: string): boolean => Object.keys(value).sort().join(",") === keys;
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Parse a `planJson` the plan primitive answered, or null for anything else (a wrong key, type, size or version). */
export function parsePinnedPlan(json: string): TestDeliveryPinnedPlan | null {
  if (typeof json !== "string" || json.length === 0 || json.length > PLAN_JSON_MAX) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainRecord(raw) || !ownKeysAre(raw, "campaignId,drafts,recipientEmail,sender,v") || raw.v !== 1) return null;
  const { campaignId, sender, recipientEmail, drafts } = raw;
  if (typeof campaignId !== "string" || campaignId.length === 0) return null;
  if (!isPlainRecord(sender) || !ownKeysAre(sender, "email,name")) return null;
  if (typeof sender.email !== "string" || typeof sender.name !== "string") return null;
  if (typeof recipientEmail !== "string" || testSendRecipient(recipientEmail) !== recipientEmail) return null;
  if (!Array.isArray(drafts) || drafts.length === 0 || drafts.length > TEST_SEND_PLAN_DRAFTS_MAX) return null;
  const pinned: Array<{ id: string; revision: string }> = [];
  for (const d of drafts) {
    if (!isPlainRecord(d) || !ownKeysAre(d, "id,revision")) return null;
    if (typeof d.id !== "string" || d.id.length === 0 || d.id.length > 200) return null;
    if (typeof d.revision !== "string" || !REVISION_RE.test(d.revision)) return null;
    pinned.push({ id: d.id, revision: d.revision });
  }
  if (new Set(pinned.map((d) => d.id)).size !== pinned.length) return null;
  return { campaignId, sender: { email: sender.email, name: sender.name }, recipientEmail, drafts: pinned };
}

/** The sender as a person reads it on the card: the From of the test messages. */
export function testSendSenderText(sender: { email: string; name: string }): string {
  if (sender.email && sender.name) return `${sender.name} <${sender.email}>`;
  if (sender.email) return sender.email;
  return sender.name ? `${sender.name} (the run owner's mailbox)` : "The run owner's mailbox";
}

/** The values a publish card draws for a test-send plan, by the plan's own fields: the From as a person reads it, the
 *  recipient, and each draft's subject and preview with its id and revision. THE one derivation: the plan primitive
 *  answers exactly these values, and the pinned send checks the approved card against them. */
export function testSendCardValues(
  plan: { sender: { email: string; name: string }; recipientEmail: string },
  drafts: ReadonlyArray<{ id: string; revision: string; subject: string; preview: string }>,
): { sender: string; recipient: string; drafts: Array<{ subject: string; preview: string; draftId: string; revision: string }> } {
  return {
    sender: testSendSenderText(plan.sender),
    recipient: plan.recipientEmail,
    drafts: drafts.map((d) => ({ subject: d.subject, preview: d.preview, draftId: d.id, revision: d.revision })),
  };
}

/** The card a test-send decision must declare: a text row of `sender`, a text row of `recipient` and a list row of
 *  `drafts` whose columns are exactly `subject` and `preview`, and no other row. Labels and order are the pack's. */
function declaresTestSendCard(rows: readonly PublishRowDeclaration[]): boolean {
  if (rows.length !== 3) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const kind = publishRowKind(row);
    if (kind === "text" && (row.input === "sender" || row.input === "recipient")) seen.add(row.input);
    else if (kind === "list" && row.input === "drafts" && "columns" in row) {
      const fields = row.columns.map((c) => c.field).sort().join(",");
      if (fields !== "preview,subject") return false;
      seen.add("drafts");
    } else return false;
  }
  return seen.size === 3;
}

type ApprovedCard = { ok: true; shownDrafts?: Array<{ subject: string; preview: string }> } | { ok: false };

/**
 * The approval of this pinned send. The decision is never resolved here by a reading of its own: it is the decision
 * the passthrough road resolved for the verified step (itself, or the publishing node it lies inside) and claimed for
 * this call (`publishCallClaim` in the request frame). With no claim, the road proved that no publishing step governs
 * the call (publishCallAllowed lets a governed step through only with a claim), and nothing is compared.
 * With a claim, the claimed decision must be this run's, released, and its card must be the plan: the declared rows
 * are the test-send card (declaresTestSendCard), the surfaced `planJson` is this call's plan byte for byte, the
 * surfaced drafts name the plan's drafts at their revisions in order, and the rows the card DREW from the surfaced
 * values (publishDecisionCardRows, the card's own drawing) equal the rows it draws from testSendCardValues of the plan
 * with the drafts' shown subjects and previews. Those shown subjects and previews go to the port, which compares them
 * with the drafts it reads. Anything else refuses.
 */
async function approvedCardOfCall(runId: string, plan: TestDeliveryPinnedPlan, planJson: string): Promise<ApprovedCard> {
  const claim = mcpRequestContextStorage.getStore()?.publishCallClaim;
  if (claim === undefined) return { ok: true };
  if (claim.runId !== runId || typeof claim.decisionId !== "string" || claim.decisionId.length === 0) return { ok: false };
  const decision = await readDecisionOfRun(runId, claim.decisionId);
  if (!decision || decision.runId !== runId || decision.status !== "released") return { ok: false };
  const declared = decision.declaredRows;
  if (!declared || !declaresTestSendCard(declared)) return { ok: false };
  const surfaced = decision.surfacedValues;
  if (surfaced.planJson !== planJson) return { ok: false };
  const rows = surfaced.drafts;
  if (!Array.isArray(rows) || rows.length !== plan.drafts.length) return { ok: false };
  const shown: Array<{ id: string; revision: string; subject: string; preview: string }> = [];
  for (const [i, r] of rows.entries()) {
    const pinned = plan.drafts[i]!;
    if (!isPlainRecord(r) || r.draftId !== pinned.id || r.revision !== pinned.revision) return { ok: false };
    if (typeof r.subject !== "string" || typeof r.preview !== "string") return { ok: false };
    shown.push({ id: pinned.id, revision: pinned.revision, subject: r.subject, preview: r.preview });
  }
  const drawn = publishDecisionCardRows(declared, surfaced);
  const expected = publishDecisionCardRows(declared, testSendCardValues(plan, shown));
  if (drawn.length !== 3 || JSON.stringify(drawn) !== JSON.stringify(expected)) return { ok: false };
  return { ok: true, shownDrafts: shown.map(({ subject, preview }) => ({ subject, preview })) };
}

type PreClaimFail = (result: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The pinned send, after the run, its authz, its gate owner, its campaign and its owner were proven by the caller. */
async function performPinnedTestSend(args: {
  run: AgentRunRecord;
  campaignId: string;
  submissionId: string;
  plan: TestDeliveryPinnedPlan | null;
  planJson: string;
  preClaimFail: PreClaimFail;
}): Promise<Record<string, unknown>> {
  const { run, campaignId, submissionId, plan, planJson, preClaimFail } = args;
  const runId = run.id;
  if (!plan || plan.campaignId !== campaignId) {
    return preClaimFail({ ok: false, reason: "plan_invalid", message: "This test send carries no valid plan. Nothing was sent." });
  }
  const port = getTestDeliverySendPort();
  if (!port || typeof port.performPinnedSend !== "function") {
    return preClaimFail({ ok: false, reason: "connector_unavailable", message: TEST_DELIVERY_SEND_PORT_UNWIRED_ERROR });
  }
  const portRun = toPortRun(run);
  const replayed = await replayExistingSubmission({
    runId, submissionId, campaignId, recipientEmail: plan.recipientEmail, port, portRun,
  });
  if (replayed) return replayed;
  const approved = await approvedCardOfCall(runId, plan, planJson);
  if (!approved.ok) {
    return preClaimFail({
      ok: false,
      reason: "plan_not_approved",
      message: "This test send is not the one that was approved. Nothing was sent.",
    });
  }
  // A draft of the plan that a previous partial send already delivered to this recipient is not sent again, and the
  // plan is not cut down either: what the card showed is what is mailed, so the send is refused and nothing goes out.
  const alreadyDelivered = new Set(await readUnacknowledgedDeliveredDraftIds(runId, plan.recipientEmail));
  if (plan.drafts.some((d) => alreadyDelivered.has(d.id))) {
    return preClaimFail({
      ok: false,
      reason: "plan_changed",
      message: "A draft of this test send was already delivered by a previous test send. Nothing was sent.",
    });
  }
  const selectedDraftIds = plan.drafts.map((d) => d.id);
  const claim = await claimTestSend({
    runId,
    submissionId,
    selectedDraftIds,
    recipientEmail: plan.recipientEmail,
    leaseSeconds: TEST_SEND_LEASE_SECONDS,
  });
  if (claim.kind === "existing") {
    const row = claim.row;
    if (row.status === "sent" || row.status === "failed") return ledgerRowToResult(row);
    return { ok: false, seq: row.seq, reason: "send_in_progress", message: "Your previous test send is still in progress. Please wait." };
  }
  const result = await port.performPinnedSend({
    run: portRun,
    submissionId,
    plan,
    ...(approved.shownDrafts ? { shownDrafts: approved.shownDrafts } : {}),
  });
  const settled = await settleTestSend({ id: claim.row.id, status: result.ok ? "sent" : "failed", result: { ...result } });
  if (settled) return { ...result, seq: claim.row.seq };
  const authoritative = await readTestSendBySubmission(runId, submissionId);
  return authoritative ? ledgerRowToResult(authoritative) : { ...result, seq: claim.row.seq };
}

/** The plan's answer on a refusal: the recorded failure row (its seq advances the form's cycle), in the shape the form
 *  reads back (`lastSendResult`, `gateCycle`), with every success field present and empty. */
function planRefusal(recorded: Record<string, unknown>): Record<string, unknown> {
  const message = typeof recorded.message === "string" ? recorded.message : "The test send could not be planned.";
  return {
    ...recorded,
    ok: false,
    sender: "",
    recipient: "",
    drafts: [],
    draftCount: 0,
    planJson: "",
    lastSendResult: { ok: false, message },
    gateCycle: typeof recorded.seq === "number" ? recorded.seq : 0,
  };
}

/**
 * campaign_test_send_plan (cinatra#4150): the plan of a test send for this run's gate submission. It sends nothing and
 * changes no draft. It runs under the same run checks as the send (execute-tier run authz, the gate-owner restriction,
 * the campaign pinned from the run, the run owner's mailbox); a user-correctable refusal (no recipient, no drafts, too
 * many drafts, no campaign access) is recorded as the send records it, a terminal failed row of the test-send ledger
 * that advances the form's cycle, and is answered in the form's shape. On success it answers the card's values and
 * the pinned plan (see the section comment above). The recipient and the subjects are the run's own data; they are
 * answered to the run and never logged.
 */
export async function handleCampaignTestSendPlan(
  request: PrimitiveRequest<{
    recipientEmail?: unknown;
    selectionMode?: unknown;
    specificInitialDraftIds?: unknown;
    specificFollowUpDraftIds?: unknown;
  }>,
): Promise<unknown> {
  const runCtx = resolveRunScopedRunId();
  if ("error" in runCtx) return { error: runCtx.error };
  const subCtx = resolveRunScopedSubmissionId("campaign_test_send_plan");
  if ("error" in subCtx) return { error: subCtx.error };
  const { runId } = runCtx;
  const { submissionId } = subCtx;
  const typedRecipient = typeof request.input?.recipientEmail === "string" ? request.input.recipientEmail.trim() : "";
  // The one recipient rule of every test send: a plan is never built for an address the send would refuse.
  const recipientEmail = testSendRecipient(typedRecipient) ?? "";
  const actor = request.actor as PrimitiveActorContext;
  const roles = await resolveRoleHintsFromSession();
  try {
    const refuse = async (result: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const rec = await recordPreClaimFailure({
        runId, submissionId, recipientEmail: recipientEmail || (typedRecipient.length > 0 && typedRecipient.length <= 320 ? typedRecipient : null), result,
      });
      return planRefusal(ledgerRowToResult(rec.row));
    };
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };
    const template = await readAgentTemplateById(run.templateId);
    const coOwnerRows = await readRunCoOwners(run.id);
    const effectivePolicy = run.authPolicy ?? template?.agentAuthPolicy ?? null;
    await enforceRunAccess({ ...run, effectivePolicy, coOwnerUserIds: coOwnerRows.map((r) => r.userId) }, actor, "execute", roles);
    const agentPackageName = template?.packageName && template.packageName.length > 0 ? template.packageName : null;
    if (!agentPackageName || !(await resolveTestDeliveryGateOwnerPackages()).has(agentPackageName)) {
      return refuse({ ok: false, reason: "not_authorized", message: "This run is not authorized to perform a test-delivery send." });
    }
    const campaignId = resolvePinnedCampaignId(run);
    if (!campaignId) {
      return refuse({ ok: false, reason: "connector_unavailable", message: "This run has no dispatched campaign to send from." });
    }
    if (!run.runBy) {
      return refuse({ ok: false, reason: "connector_unavailable", message: "This run has no owner mailbox to send the test email from." });
    }
    if (recipientEmail.length === 0) {
      return refuse({ ok: false, reason: "invalid_recipient", message: "Enter a valid recipient email address for the test send." });
    }
    const selectionMode = request.input?.selectionMode;
    if (selectionMode !== "random_initial" && selectionMode !== "specific_initial" && selectionMode !== "all_initial") {
      return refuse({ ok: false, reason: "no_drafts_selected", message: "Choose a valid selection mode for the test send." });
    }
    const ids = (value: unknown): string[] | null =>
      value === undefined ? [] :
        Array.isArray(value) && value.length <= 500 && value.every((id) => typeof id === "string" && id.length > 0)
          ? (value as string[]) : null;
    const initialIds = ids(request.input?.specificInitialDraftIds);
    const followUpIds = ids(request.input?.specificFollowUpDraftIds);
    if (!initialIds || !followUpIds) {
      return refuse({ ok: false, reason: "no_drafts_selected", message: "The selected draft ids are not valid." });
    }
    const port = getTestDeliverySendPort();
    if (!port) return refuse({ ok: false, reason: "connector_unavailable", message: TEST_DELIVERY_SEND_PORT_UNWIRED_ERROR });
    const prepared = await port.prepareSend({
      run: toPortRun(run),
      campaignId,
      recipientEmail,
      selectionMode,
      specificInitialDraftIds: initialIds,
      specificFollowUpDraftIds: followUpIds,
    });
    if (!prepared.ok) {
      return refuse({
        ok: false,
        reason: prepared.reason,
        message:
          prepared.reason === "campaign_access_denied"
            ? "You do not have access to this campaign."
            : prepared.reason === "invalid_recipient"
              ? "Enter a valid recipient email address for the test send."
              : "No test emails were selected to send.",
      });
    }
    // A host whose port answers no plan detail cannot show a card: fail closed, never a plan the card cannot show.
    if (!prepared.sender || !Array.isArray(prepared.drafts)) {
      return { error: "campaign_test_send_plan: the host test-delivery port answered no plan detail. Nothing was planned." };
    }
    // Drafts a previous partial send already delivered to this recipient are left out here, so the card shows only
    // what this send will mail.
    const alreadyDelivered = new Set(await readUnacknowledgedDeliveredDraftIds(runId, prepared.recipientEmail));
    const drafts = prepared.drafts.filter((d) => !alreadyDelivered.has(d.id));
    if (drafts.length === 0) {
      return refuse({
        ok: false,
        reason: "no_drafts_selected",
        message: "The selected drafts were already delivered by a previous test send; nothing new to send.",
      });
    }
    if (drafts.length > TEST_SEND_PLAN_DRAFTS_MAX) {
      return refuse({
        ok: false,
        reason: "too_many_drafts",
        message: `Select at most ${TEST_SEND_PLAN_DRAFTS_MAX} drafts for one test send.`,
      });
    }
    const wire: PinnedPlanWire = {
      v: 1,
      campaignId,
      sender: { email: prepared.sender.email, name: prepared.sender.name },
      recipientEmail: prepared.recipientEmail,
      drafts: drafts.map((d) => ({ id: d.id, revision: d.revision })),
    };
    const planJson = JSON.stringify(wire);
    const card = testSendCardValues(wire, drafts);
    // A plan the send would refuse for a reason known now is refused now: the send reads the plan with this same
    // parser, and the publish gate records at most PUBLISH_SURFACED_VALUES_MAX_BYTES of the values it surfaces (the
    // card's values and planJson), so a plan over either bound is never shown for approval.
    const { PUBLISH_SURFACED_VALUES_MAX_BYTES } = await import("../publish-decision-actions");
    const surfacedBytes = new TextEncoder().encode(JSON.stringify({ ...card, planJson })).length;
    if (parsePinnedPlan(planJson) === null || surfacedBytes > PUBLISH_SURFACED_VALUES_MAX_BYTES) {
      return refuse({
        ok: false,
        reason: "plan_too_large",
        message: "This test send is too large to show for approval. Select fewer drafts or shorten the sender.",
      });
    }
    return {
      ok: true,
      ...card,
      draftCount: drafts.length,
      planJson,
      lastSendResult: null,
      gateCycle: 0,
    };
  } catch (err) {
    if (err instanceof AuthzError) {
      emitReadDenialAudit(actor, runId);
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Test delivery plan failed: ${message}` };
  }
}

type ParsedGateEnvelope = {
  action: "send" | "continue" | "halt";
  recipientEmail?: string;
  selectionMode?: TestDeliverySelectionMode;
  specificInitialDraftIds?: string[];
  specificFollowUpDraftIds?: string[];
};

// Parse the gate's userResponse envelope into a typed, branch-readable action.
// Malformed / absent → `continue` (fail to the safe terminal path, never crash).
function parseGateEnvelope(userResponse: unknown): ParsedGateEnvelope {
  if (typeof userResponse !== "string" || userResponse.trim().length === 0) {
    return { action: "continue" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(userResponse);
  } catch {
    return { action: "continue" };
  }
  if (!parsed || typeof parsed !== "object") return { action: "continue" };
  const env = parsed as Record<string, unknown>;
  const action = env.action;
  if (action === "continue" || action === "halt") return { action };
  if (action !== "send") return { action: "continue" };
  const out: ParsedGateEnvelope = { action: "send" };
  if (typeof env.recipientEmail === "string") out.recipientEmail = env.recipientEmail;
  const mode = env.selectionMode;
  if (mode === "random_initial" || mode === "specific_initial" || mode === "all_initial") {
    out.selectionMode = mode;
  }
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).slice(0, 500) : undefined;
  const inits = stringArray(env.specificInitialDraftIds);
  if (inits) out.specificInitialDraftIds = inits;
  const follows = stringArray(env.specificFollowUpDraftIds);
  if (follows) out.specificFollowUpDraftIds = follows;
  return out;
}

export async function handleEmailTestDeliveryParseAction(
  request: PrimitiveRequest<{ userResponse?: unknown }>,
): Promise<unknown> {
  const runCtx = resolveRunScopedRunId();
  if ("error" in runCtx) return { error: runCtx.error };
  const { runId } = runCtx;
  const actor = request.actor as PrimitiveActorContext;
  const roles = await resolveRoleHintsFromSession();
  try {
    // read-enforced load — this is a read-tier deterministic parse.
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    const envelope = parseGateEnvelope(request.input?.userResponse);

    // Halt guard: when the ledger's PERFORMED-send count has reached the
    // template-trusted cap, force the terminal path even if the user asked to
    // send again. Read the bound SERVER-SIDE from the run's compiled template.
    if (envelope.action === "send") {
      const [template, sentCount] = await Promise.all([
        readAgentTemplateById(run.templateId),
        readSentCountForRun(runId),
      ]);
      const maxGateVisits = resolveMaxGateVisits(template);
      if (sentCount >= maxGateVisits) {
        return { action: "halt", maxGateVisits, sentCount };
      }
    }
    return { ...envelope };
  } catch (err) {
    if (err instanceof AuthzError) {
      emitReadDenialAudit(actor, runId);
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Parse action failed: ${message}` };
  }
}
