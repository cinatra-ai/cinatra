// ---------------------------------------------------------------------------
// Test-delivery send PORT (eng#548 #1625, DESIGN-V3 part-2 stage A).
//
// The run-scoped test-delivery send primitive (email_test_delivery_run_send)
// lives in packages/agents/src/mcp/handlers.ts, but two capabilities it needs
// are APP-side and packages/agents cannot import app code (@/lib/*):
//   1. the sendTestEmail use-case (src/lib/trigger-email-send-use-cases.ts) —
//      pulls the email-system / connector graph;
//   2. buildActorContextFromRun (src/lib/authz/build-actor-context-from-run.ts) —
//      builds the run-OWNER coherent ActorContext used BOTH as the objects-store
//      campaign-authz principal AND as the send-execution authority.
//
// Per the CONVERGED boundary decision (codex MERGE-SAFE, DESIGN-V3 "Module
// boundary resolution"): the host injects the send implementation through this
// LEAF port seam — the SAME idiom as `setRunWaitNotifier` (run-wait-notifier.ts)
// and `setExtensionDataTeardownHook` (data-teardown-hook.ts) — rather than
// hoisting the email/auth/objects graph into a shared package.
//
// TRUE LEAF: this module imports NOTHING at runtime from the package graph (no
// imports at all), so the boot-reachable host wiring can inject the port without
// pulling any app/email/objects code onto a cold import graph. Exported through
// the NARROW subpath `@cinatra-ai/agents/test-delivery-send-port`, NOT the barrel,
// so the host wiring never closes an init-time cycle.
//
// FAIL-CLOSED — the one deviation from the best-effort teardown/notifier
// precedents. A send is a mutating, authority-bearing action: a missing wiring or
// an implementation exception MUST surface (the handler returns a clear error /
// the exception propagates), NEVER a silent no-op that reports success without
// sending. The holder is read at INVOCATION time (getTestDeliverySendPort), never
// captured while the handler map is constructed.
// ---------------------------------------------------------------------------

/** The enumerated EXPECTED send-failure space (contract (6)). Each maps to a
 *  resolved node value the workflow routes back into the gate as an honest
 *  banner — never a run-failing throw. */
export type TestDeliverySendFailureReason =
  | "no_drafts_selected"
  | "invalid_recipient"
  | "connector_unavailable"
  | "dev_mode_recipient_required"
  | "send_failed";

/** The port's phase-2 result. The package-side handler adds the ledger `seq`
 *  before returning to the workflow. Written as an EXPLICIT discriminated union
 *  (never `Omit<…,'seq'>`, which does not preserve per-branch fields). */
export type TestDeliveryPerformResult =
  | { ok: true; sentTo: string; sentCount: number; message: string }
  | { ok: false; reason: TestDeliverySendFailureReason; message: string };

/** The phase-1 (no side-effect) planning result. On success the pinned draft-id
 *  set the package persists into the ledger claim BEFORE any send; on failure a
 *  user-correctable reason routed straight to the gate. */
export type TestDeliveryPrepareResult =
  | { ok: true; recipientEmail: string; selectedDraftIds: string[] }
  | { ok: false; reason: "no_drafts_selected" | "invalid_recipient" | "campaign_access_denied" };

/** Run projection the port receives — ONLY package-read fields, never caller
 *  authority. `dependentInstallId` is included because the canonical owner-context
 *  builder (buildActorContextFromRun) consumes it. `inputParams` carries the
 *  dispatched `campaignId` the package pins (never a gate-supplied campaign). */
export type TestDeliveryPortRun = {
  id: string;
  runBy: string | null;
  orgId: string;
  dependentInstallId?: string | null;
  inputParams: Record<string, unknown>;
};

export type TestDeliverySelectionMode = "random_initial" | "specific_initial" | "all_initial";

export interface TestDeliverySendPort {
  /**
   * Phase 1 — NO side-effects. App impl: build the run-OWNER ActorContext via
   * buildActorContextFromRun(run); authorize the campaign as an OBJECT via
   * createSessionObjectsClient(ownerCtx).get(objectId=campaignId) scoped to
   * run.orgId — BOTH a not-found (`{object:null}`) AND an objects-authz denial map
   * to `reason:"campaign_access_denied"`; unrelated infra errors PROPAGATE. Resolve
   * the FINAL concrete draft-id set ONCE (random_initial is resolved to concrete
   * ids here and must never be rerandomized on a retry). Returns the pinned plan
   * the package persists into the ledger claim before any outbound send.
   */
  prepareSend(params: {
    run: TestDeliveryPortRun;
    campaignId: string;
    recipientEmail: string;
    selectionMode: TestDeliverySelectionMode;
    specificInitialDraftIds?: string[];
    specificFollowUpDraftIds?: string[];
  }): Promise<TestDeliveryPrepareResult>;

  /**
   * Phase 2 — the outbound send. Sends EXACTLY the pinned `selectedDraftIds`
   * (never rerandomized), threading `submissionId` (+ per-draft ids) into the
   * sendEmail correlation for crash reconciliation; `run.runBy` is the mailbox
   * selector and MUST be non-null (fail closed — no arbitrary-OAuth fallback).
   * Returns the typed discriminated result verbatim (expected failures are data,
   * not throws).
   */
  performSend(params: {
    run: TestDeliveryPortRun;
    campaignId: string;
    submissionId: string;
    recipientEmail: string;
    selectedDraftIds: string[];
  }): Promise<TestDeliveryPerformResult>;

  /**
   * Crash reconciliation for a ledger row stuck in `sending` past its lease.
   * Query the outbound correlation store for `submissionId`; return `"sent"` ONLY
   * when EVERY `expectedDraftIds` entry has a correlation row for THIS
   * submissionId, else `"unknown"`. `expectedDraftIds:[]` ⇒ `"unknown"` (never a
   * vacuous `"sent"`).
   */
  reconcile(params: {
    run: TestDeliveryPortRun;
    campaignId: string;
    submissionId: string;
    expectedDraftIds: string[];
  }): Promise<"sent" | "unknown">;
}

// Module singleton behind a global symbol slot (same idiom as
// setRunWaitNotifier) so a duplicated module instance across bundle boundaries
// still resolves to ONE holder.
const TEST_DELIVERY_SEND_PORT_SLOT = Symbol.for("cinatra.agents.testDeliverySendPort.v1");
type PortHolder = { port: TestDeliverySendPort | null };
function portHolder(): PortHolder {
  const g = globalThis as unknown as Record<symbol, PortHolder | undefined>;
  return (g[TEST_DELIVERY_SEND_PORT_SLOT] ??= { port: null });
}

/** Host wiring entry: inject the send implementation. Pass `null` to clear (tests). */
export function setTestDeliverySendPort(port: TestDeliverySendPort | null): void {
  portHolder().port = port;
}

/** Invocation-time getter — the wired port, or `null` when no host wired one.
 *  Callers MUST fail closed on `null` (never treat an unwired port as a
 *  successful no-op send). */
export function getTestDeliverySendPort(): TestDeliverySendPort | null {
  return portHolder().port;
}

/** The error a caller surfaces when no host has wired the send port. Kept as a
 *  distinct message so an operator sees a wiring gap, not a phantom send. */
export const TEST_DELIVERY_SEND_PORT_UNWIRED_ERROR =
  "email_test_delivery_run_send: the host test-delivery send port is not wired " +
  "(register-test-delivery-send-port must load on this path). Failing closed — no send performed.";
