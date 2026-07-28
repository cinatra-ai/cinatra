import "server-only";

// The S5 pending-call RESUME EXECUTOR (cinatra#2020 design §4.2, PR-4) — the
// ONLY component that ever executes a parked destructive call. The chat server
// action (`packages/chat/src/pending-call-actions.ts`) authenticates the live
// session + actor and hands the decision here; this module owns everything
// after that:
//
//   token verify → row read + requester-only ownership → the exactly-once
//   `pending → executing` CAS → the material-identity drift checks (tool +
//   execution-target fingerprints) → the full TOCTOU spine (the intact
//   `invokeConnectorInstanceTool`, hook omitted) → terminal outcome + audits.
//
// EXACTLY-ONCE: the consume CAS is the single edge to the wire; a duplicate
// confirm returns the recorded outcome (`alreadyDecided`) without invoking; a
// timed-out execution terminalizes as the INDETERMINATE
// `execution_interrupted`, and the still-pending wire promise upgrades it to
// the REAL outcome when it settles (the store's late-upgrade CAS — "the wire
// ran exactly once" survives the pessimistic flip).
//
// TOCTOU SPINE: the executor never trusts park-time state. It re-reads the
// CURRENT catalog through the governed list (same acquire path the invoke
// runs) and recomputes the tool fingerprint over `{name, serverId,
// inputSchema, rawAnnotations}` — a schema/annotation/implementation swap
// since park denies as `tool_changed` (a destructive→write relabel is INSIDE
// the hash, so it denies rather than resuming under weaker semantics). It
// pre-resolves the execution endpoint through the SAME resolver the invoke
// uses (the stored serverId passed verbatim) and denies a repoint as
// `target_changed`. The invoke itself then re-runs pin gating, the LIVE
// per-instance USE authority, endpoint resolution, catalog presence, and the
// live tool policy — with `destructiveHook` OMITTED (a confirmed call must
// not re-park; every OTHER gate stays armed).
//
// PLANE + AUDIT: connector-instance plane (the stage-1 store's posture);
// every transition writes one audit row per the taxonomy, policyVersion
// `connector-instance-confirmation`. Audit metadata carries ids/hashes/codes
// only — never args, previews, endpoints, or token material.

import type { ActorContext } from "@/lib/authz/actor-context";
import { logAuditEvent } from "@/lib/authz/audit";
import {
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
} from "@/lib/connector-instance-invoker";
import { buildConnectorInstanceInvokerDeps } from "@/lib/register-host-connector-services";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import {
  CONFIRMATION_POLICY_VERSION,
  computeTargetFingerprint,
  computeToolFingerprint,
  consumePendingCall,
  denyPendingCall,
  readPendingCall,
  recordOutcome,
  redactArgsPreview,
  type ConnectorInstancePendingCallRecord,
  type PendingCallStatus,
  type PendingCallStoreDeps,
} from "@/lib/connector-instance-pending-call-store";
import {
  verifyPendingCallDecisionToken,
  type PendingCallDecisionAction,
} from "@/lib/connector-instance-pending-call-decision-token";

/** Result-preview byte bound persisted into `result_summary` (§3: ≤ 2 KB). */
export const RESULT_PREVIEW_MAX_BYTES = 2048;
/** Executor-owned wire termination (§4.2): the invoke is raced against this
 * deadline; on expiry the row terminalizes INDETERMINATE
 * (`execution_interrupted`) and a late real outcome upgrades it exactly once. */
export const EXECUTE_TIMEOUT_MS = 120_000;

/** Page budget for the drift-check catalog re-list (§4.2 step 5b): a
 * misbehaving or malicious remote catalog that keeps returning a non-null (or
 * repeating) cursor must never spin the resume path forever with the row
 * already pinned in `executing` by the consume CAS above. The governed list
 * pages at up to 100 tools/page (`DEFAULT_PAGE_SIZE` in
 * connector-instance-invoker.ts), so this covers a catalog of up to 5,000
 * tools — far beyond any legitimate MCP server — before ejecting fail-closed. */
export const CATALOG_LOOKUP_MAX_PAGES = 50;

/** Invoker error codes whose resume-time throw IS the TOCTOU denial (the
 * re-run gate/presence/policy spine refused — execution provably never ran).
 * Everything else on the invoke path is an ordinary execution failure. */
const TOCTOU_DENIAL_CODES = new Set([
  "instance_pin_mismatch",
  "instance_id_required",
  "connector_key_underivable",
  "tool_policy_denied",
  "tool_not_found",
  "ambiguous_tool",
  "catalog_unavailable",
]);

export type PendingCallDecisionSession = {
  userId: string;
  orgId: string;
  /** The live better-auth session id — the token's `sid` binding. */
  sessionId: string;
};

/**
 * The card-facing decision result. Refusals are OPAQUE by design (no
 * existence/ownership oracle to the client; the audit trail carries the
 * reason); a decided result mirrors the row's terminal state.
 */
export type PendingCallDecisionResult =
  | { outcome: "refused" }
  | {
      outcome: "decided";
      id: string;
      status: PendingCallStatus;
      /** True when this request did NOT transition the row (duplicate decide):
       * the recorded outcome is returned and nothing executed again. */
      alreadyDecided: boolean;
      failureCode: string | null;
      resultSummary: unknown;
    };

export type PendingCallExecutorDeps = {
  /** Store surfaces (defaults = the real stage-1 store; `storeDeps` threads a
   * query/audit double into them for tests). */
  readPendingCall?: typeof readPendingCall;
  consumePendingCall?: typeof consumePendingCall;
  denyPendingCall?: typeof denyPendingCall;
  recordOutcome?: typeof recordOutcome;
  storeDeps?: PendingCallStoreDeps;
  /** Token verify (default = the stage-2 verifier). */
  verifyToken?: typeof verifyPendingCallDecisionToken;
  /** The governed invoke + list (defaults = the real invoker). */
  invoke?: typeof invokeConnectorInstanceTool;
  listTools?: typeof listConnectorInstanceTools;
  /** The SHARED runtime invoker-deps builder (default = the binder's exported
   * builder, so park-time and resume-time deps are the same object graph). */
  buildInvokerDeps?: typeof buildConnectorInstanceInvokerDeps;
  /** §7.3 audit sink (default `logAuditEvent`). */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
  /** Executor wire deadline override (tests). */
  executeTimeoutMs?: number;
};

function resolveExecutorDeps(deps: PendingCallExecutorDeps = {}) {
  return {
    readRow: deps.readPendingCall ?? readPendingCall,
    consume: deps.consumePendingCall ?? consumePendingCall,
    deny: deps.denyPendingCall ?? denyPendingCall,
    record: deps.recordOutcome ?? recordOutcome,
    storeDeps: deps.storeDeps,
    verifyToken: deps.verifyToken ?? verifyPendingCallDecisionToken,
    invoke: deps.invoke ?? invokeConnectorInstanceTool,
    listTools: deps.listTools ?? listConnectorInstanceTools,
    buildInvokerDeps: deps.buildInvokerDeps ?? buildConnectorInstanceInvokerDeps,
    audit: deps.audit ?? logAuditEvent,
    executeTimeoutMs: deps.executeTimeoutMs ?? EXECUTE_TIMEOUT_MS,
  };
}

type ResolvedExecutorDeps = ReturnType<typeof resolveExecutorDeps>;

type AuditInput = {
  operation: string;
  decision: "allowed" | "denied";
  resourceId: string;
  userId: string;
  orgId: string;
  metadata: Record<string, unknown>;
};

async function writeAudit(d: ResolvedExecutorDeps, input: AuditInput): Promise<void> {
  await d.audit({
    resourceType: "connector_instance",
    resourceId: input.resourceId,
    actorPrincipalType: "human",
    actorPrincipalId: input.userId,
    organizationId: input.orgId,
    authSource: "mcp",
    operation: input.operation,
    decision: input.decision,
    policyVersion: CONFIRMATION_POLICY_VERSION,
    metadata: input.metadata,
  });
}

/** ids/codes-only row metadata for audit rows (never args/preview/endpoint). */
function rowMetadata(row: ConnectorInstancePendingCallRecord): Record<string, unknown> {
  return {
    pendingCallId: row.id,
    connectorKey: row.connectorKey,
    instanceId: row.instanceId,
    serverId: row.serverId,
    toolName: row.toolName,
    surface: row.surface,
    ...(row.causation ? { causation: row.causation } : {}),
  };
}

/** Bounded, secret-redacted result preview for `result_summary` (§3/§6.2). */
export function buildResultSummary(result: unknown): { ok: true; resultPreview: string } {
  const record =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { value: result };
  return { ok: true, resultPreview: redactArgsPreview(record, RESULT_PREVIEW_MAX_BYTES) };
}

function decidedFromRow(
  row: ConnectorInstancePendingCallRecord,
  alreadyDecided: boolean,
): PendingCallDecisionResult {
  return {
    outcome: "decided",
    id: row.id,
    status: row.status,
    alreadyDecided,
    failureCode: row.failureCode,
    resultSummary: row.resultSummary,
  };
}

/**
 * Decide one pending call (§4.2). The caller (the chat server action) has
 * already established the LIVE cookie session and actor; everything here is
 * fail-closed: any verification miss is an opaque refusal + an audited
 * `pending_call_decision_rejected`, and no path reaches the wire except
 * through the single consume CAS.
 */
export async function decidePendingCall(
  input: {
    pendingCallId: string;
    action: PendingCallDecisionAction;
    token: string | null | undefined;
    session: PendingCallDecisionSession;
    actor: ActorContext;
  },
  deps: PendingCallExecutorDeps = {},
): Promise<PendingCallDecisionResult> {
  const d = resolveExecutorDeps(deps);
  const { session } = input;

  const rejected = async (reason: string, row?: ConnectorInstancePendingCallRecord) => {
    await writeAudit(d, {
      operation: "pending_call_decision_rejected",
      decision: "denied",
      resourceId: row?.instanceId ?? input.pendingCallId,
      userId: session.userId,
      orgId: session.orgId,
      metadata: {
        pendingCallId: input.pendingCallId,
        action: input.action,
        reason, // never token material
      },
    });
    return { outcome: "refused" } as const;
  };

  // ACTION GUARD (defense-in-depth beside the verifier's own fail-closed
  // unknown-action mapping): `action` arrives from a network-callable server
  // action, so the runtime value is validated HERE too, and execution below
  // is reachable ONLY through the explicit `confirm` branch — an unknown or
  // future action can never fall through to the consume CAS.
  if (input.action !== "confirm" && input.action !== "deny" && input.action !== "cancel") {
    return rejected("unknown_action");
  }

  // §4.2 step 2 — the served-card decision token: type/audience/TTL + the
  // row/user/org/session/action-family bindings, all fail-closed.
  const decision = d.verifyToken({
    token: input.token,
    expectedPendingCallId: input.pendingCallId,
    expectedUserId: session.userId,
    expectedOrgId: session.orgId,
    expectedSessionId: session.sessionId,
    expectedAction: input.action,
  });
  if (!decision) return rejected("token_invalid");

  // §4.2 step 3 — row read (lazy-flips stale state first) + REQUESTER-ONLY
  // ownership. All v1 decisions — confirm, deny, AND cancel — belong to the
  // user who parked the call; org-admin recourse is the org-disable switch.
  const row = await d.readRow(input.pendingCallId, d.storeDeps);
  if (!row) return rejected("not_found");
  if (row.userId !== session.userId || row.orgId !== session.orgId) {
    return rejected("ownership", row);
  }

  if (input.action === "deny" || input.action === "cancel") {
    const as = input.action === "deny" ? ("denied" as const) : ("cancelled" as const);
    const terminal = await d.deny(row.id, { decidedBy: session.userId, as }, d.storeDeps);
    if (!terminal) {
      // Already decided/expired — return the recorded state, transition nothing.
      const current = await d.readRow(row.id, d.storeDeps);
      return current ? decidedFromRow(current, true) : rejected("not_found");
    }
    await writeAudit(d, {
      operation: as === "denied" ? "pending_call_denied" : "pending_call_cancelled",
      decision: "denied",
      resourceId: row.instanceId,
      userId: session.userId,
      orgId: session.orgId,
      metadata: { ...rowMetadata(row), decidedBy: session.userId, role: "requester" },
    });
    return decidedFromRow(terminal, false);
  }

  // ── confirm — the ONLY branch that can reach execution ──────────────────
  if (input.action !== "confirm") {
    // Unreachable behind the action guard above; kept explicit so execution
    // is opt-in by construction, never a default fall-through.
    return rejected("unknown_action", row);
  }
  // §4.2 step 4 — THE exactly-once edge. 0 rows ⇒ someone already decided (or
  // expiry won): return the recorded outcome, never execute again.
  const executing = await d.consume(row.id, { decidedBy: session.userId }, d.storeDeps);
  if (!executing) {
    const current = await d.readRow(row.id, d.storeDeps);
    await writeAudit(d, {
      operation: "pending_call_confirm_replayed",
      decision: "denied",
      resourceId: row.instanceId,
      userId: session.userId,
      orgId: session.orgId,
      metadata: { ...rowMetadata(row), alreadyDecidedStatus: current?.status ?? "unknown" },
    });
    return current ? decidedFromRow(current, true) : rejected("not_found");
  }
  await writeAudit(d, {
    operation: "pending_call_confirmed",
    decision: "allowed",
    resourceId: row.instanceId,
    userId: session.userId,
    orgId: session.orgId,
    metadata: { ...rowMetadata(row), decidedBy: session.userId },
  });

  return executeConfirmedCall({ row: executing, session, actor: input.actor }, d);
}

/** Terminalize + audit one execution outcome (normal AND late-upgrade path). */
async function recordAndAuditOutcome(
  d: ResolvedExecutorDeps,
  row: ConnectorInstancePendingCallRecord,
  session: PendingCallDecisionSession,
  input: {
    status: "executed" | "failed";
    failureCode?: string;
    resultSummary?: unknown;
    toctou?: boolean;
    durationMs?: number;
  },
): Promise<ConnectorInstancePendingCallRecord | null> {
  const recorded = await d.record(
    row.id,
    {
      status: input.status,
      failureCode: input.failureCode ?? null,
      ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
    },
    d.storeDeps,
  );
  if (!recorded) return null; // already terminal in another state — nothing to audit
  const operation = input.toctou
    ? "pending_call_toctou_denied"
    : input.status === "executed"
      ? "pending_call_executed"
      : "pending_call_execution_failed";
  await writeAudit(d, {
    operation,
    decision: input.status === "executed" ? "allowed" : "denied",
    resourceId: row.instanceId,
    userId: session.userId,
    orgId: session.orgId,
    metadata: {
      ...rowMetadata(row),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(recorded ? { lateUpgrade: recorded.lateUpgrade } : {}),
    },
  });
  return recorded.record;
}

async function executeConfirmedCall(
  ctx: {
    row: ConnectorInstancePendingCallRecord;
    session: PendingCallDecisionSession;
    actor: ActorContext;
  },
  d: ResolvedExecutorDeps,
): Promise<PendingCallDecisionResult> {
  const { row, session } = ctx;
  const startedAt = Date.now();

  const failTerminal = async (failureCode: string, toctou: boolean) => {
    const recorded = await recordAndAuditOutcome(d, row, session, {
      status: "failed",
      failureCode,
      toctou,
      durationMs: Date.now() - startedAt,
    });
    return recorded
      ? decidedFromRow(recorded, false)
      : ({
          outcome: "decided",
          id: row.id,
          status: "failed",
          alreadyDecided: false,
          failureCode,
          resultSummary: null,
        } as const);
  };

  // The consumed row must still carry its full args (DB CHECK couples
  // status='executing' ↔ args present). Defensive refusal, never a crash.
  if (!row.args) return failTerminal("args_missing", true);

  // The SHARED runtime deps — the binder's exported builder, so resume-time
  // deps are the exact object graph park-time used — with the destructive
  // hook OMITTED: the confirmed call must not re-park; every other gate
  // (pin, live USE authority, presence, policy, transport) stays armed.
  const { destructiveHook: _omitted, ...invokerDeps } = d.buildInvokerDeps(row.connectorKey);
  void _omitted;

  const trustedActor = {
    actor: ctx.actor,
    userId: session.userId,
    orgId: session.orgId,
    // Rebuilt from the PERSISTED row (host data, never client input) so the
    // invoker's step-0 pin gate holds on the resume path too.
    connectorInstancePin: { connectorKey: row.connectorKey, instanceId: row.instanceId },
  };
  const primitiveName = row.primitiveName ?? `${row.connectorKey}_site_tool_call`;

  try {
    // §4.2 step 5a — execution-TARGET consent binding: pre-resolve through the
    // SAME resolver the invoke uses, stored serverId passed verbatim; a
    // repoint since park (e.g. staging→production) denies — the consent bound
    // to the MATERIAL execution target. URL string only; never the auth header.
    const resolved = await invokerDeps.resolveInstanceEndpoint(
      row.connectorKey,
      row.instanceId,
      row.serverId,
    );
    if (!resolved) return failTerminal("network_error", true);
    if (computeTargetFingerprint(resolved.endpoint) !== row.targetFingerprint) {
      return failTerminal("target_changed", true);
    }

    // §4.2 step 5b — tool-shape consent binding: re-resolve the tool from the
    // CURRENT catalog via the governed list (the same acquire path the invoke
    // runs) and recompute the shared fingerprint. Vanished ⇒ tool_not_found;
    // schema/annotation drift ⇒ tool_changed. Both: wire never called.
    // Page-bounded (CATALOG_LOOKUP_MAX_PAGES): a repeating/non-null cursor
    // from the remote catalog must eject fail-closed rather than spin this
    // request forever with the row stuck in `executing`.
    let cursor: string | undefined;
    let entry: { name: string; serverId: string; inputSchema: unknown; rawAnnotations: Record<string, unknown> } | undefined;
    let pagesFetched = 0;
    let budgetExceeded = false;
    for (;;) {
      if (pagesFetched >= CATALOG_LOOKUP_MAX_PAGES) {
        budgetExceeded = true;
        break;
      }
      const page = await d.listTools(
        {
          connectorKey: row.connectorKey,
          instanceId: row.instanceId,
          serverId: row.serverId,
          actor: trustedActor,
          primitiveName,
          sourceType: row.surface,
          ...(row.causation ? { causation: row.causation } : {}),
          ...(cursor ? { cursor } : {}),
        },
        invokerDeps,
      );
      pagesFetched += 1;
      entry = page.tools.find((t) => t.serverId === row.serverId && t.name === row.toolName);
      if (entry || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (budgetExceeded) return failTerminal("catalog_lookup_budget_exceeded", true);
    if (!entry) return failTerminal("tool_not_found", true);
    const currentToolFingerprint = computeToolFingerprint({
      name: entry.name,
      serverId: row.serverId,
      inputSchema: entry.inputSchema,
      rawAnnotations: entry.rawAnnotations,
    });
    if (currentToolFingerprint !== row.toolFingerprint) {
      return failTerminal("tool_changed", true);
    }

    // §4.2 step 6 — the full TOCTOU spine by construction: the INTACT governed
    // invoke (pin → LIVE USE authority → endpoint → presence → LIVE policy →
    // wire), under the executor-owned deadline. On deadline the row
    // terminalizes INDETERMINATE and the still-pending wire promise upgrades
    // it to the real outcome when it settles (store late-upgrade CAS).
    const invokePromise = d.invoke(
      {
        connectorKey: row.connectorKey,
        instanceId: row.instanceId,
        serverId: row.serverId,
        toolName: row.toolName,
        args: row.args,
        actor: trustedActor,
        primitiveName,
        sourceType: row.surface,
        intent: `confirmed:${row.id}`,
        ...(row.causation ? { causation: row.causation } : {}),
      },
      invokerDeps,
    );
    const settled = invokePromise.then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("pending-call-execute-timeout");
    const raced = await Promise.race([
      settled,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), d.executeTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (raced === TIMED_OUT) {
      // INDETERMINATE: the wire may still be running. Terminalize honestly and
      // let the settled promise late-upgrade to the truth (audited by the
      // store as pending_call_outcome_late; we add the executor-side row).
      const interrupted = await failTerminal("execution_interrupted", false);
      void settled.then(async (outcome) => {
        try {
          if (outcome.ok) {
            await recordAndAuditOutcome(d, row, session, {
              status: "executed",
              resultSummary: buildResultSummary(outcome.result),
              durationMs: Date.now() - startedAt,
            });
          } else {
            const code =
              outcome.err instanceof InvokerError ? outcome.err.code : "error";
            await recordAndAuditOutcome(d, row, session, {
              status: "failed",
              failureCode: code,
              toctou: outcome.err instanceof InvokerError && TOCTOU_DENIAL_CODES.has(code),
              durationMs: Date.now() - startedAt,
            });
          }
        } catch (lateErr) {
          console.error("[pending-call-executor] late outcome record failed", lateErr);
        }
      });
      return interrupted;
    }

    if (raced.ok) {
      const recorded = await recordAndAuditOutcome(d, row, session, {
        status: "executed",
        resultSummary: buildResultSummary(raced.result),
        durationMs: Date.now() - startedAt,
      });
      return recorded
        ? decidedFromRow(recorded, false)
        : (await (async () => {
            const current = await d.readRow(row.id, d.storeDeps);
            return current
              ? decidedFromRow(current, true)
              : ({ outcome: "refused" } as const);
          })());
    }

    const err = raced.err;
    const code = err instanceof InvokerError ? err.code : "error";
    return failTerminal(code, err instanceof InvokerError && TOCTOU_DENIAL_CODES.has(code));
  } catch (err) {
    // Any unexpected infrastructure failure (fingerprint list read, store
    // write, resolver crash) terminalizes fail-closed — the wire was never
    // reached past the CAS except through the guarded race above.
    const code = err instanceof InvokerError ? err.code : "error";
    return failTerminal(code, err instanceof InvokerError && TOCTOU_DENIAL_CODES.has(code));
  }
}
