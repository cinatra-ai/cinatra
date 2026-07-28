import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildResultSummary,
  CATALOG_LOOKUP_MAX_PAGES,
  decidePendingCall,
  EXECUTE_TIMEOUT_MS,
  type PendingCallExecutorDeps,
} from "@/lib/connector-instance-pending-call-executor";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import {
  computeTargetFingerprint,
  computeToolFingerprint,
  type ConnectorInstancePendingCallRecord,
} from "@/lib/connector-instance-pending-call-store";
import type { ConnectorInstanceInvokerDeps } from "@/lib/connector-instance-invoker";
import { issuePendingCallDecisionToken } from "@/lib/connector-instance-pending-call-decision-token";

// cinatra#2020 S5 PR-4 — the resume executor: token/ownership refusals, the
// exactly-once consume CAS (duplicate + concurrent confirms), the material
// drift checks (tool_changed / target_changed / presence), the TOCTOU spine
// classification, the executor-owned deadline + late upgrade, and the audit
// taxonomy. All deps injected — no DB, no real binder, no wire.

const SESSION = { userId: "u1", orgId: "org1", sessionId: "s1" };
const ACTOR = { principalType: "HumanUser", principalId: "u1" } as never;
const ENDPOINT = "https://site.example/index.php?rest_route=/mcp/vendor";
const TOOL = {
  name: "core/delete-post",
  serverId: "wps_1",
  inputSchema: { type: "object" },
  rawAnnotations: { destructiveHint: true },
};

function row(
  overrides: Partial<ConnectorInstancePendingCallRecord> = {},
): ConnectorInstancePendingCallRecord {
  return {
    id: "cipc_1",
    connectorKey: "wordpress",
    instanceId: "inst-1",
    serverId: TOOL.serverId,
    toolName: TOOL.name,
    args: { id: 7, force: true },
    argsHash: "hash",
    argsBytes: 24,
    argsPreview: "{…}",
    toolFingerprint: computeToolFingerprint(TOOL),
    targetFingerprint: computeTargetFingerprint(ENDPOINT),
    derivedClass: "destructive",
    surface: "chat",
    userId: SESSION.userId,
    orgId: SESSION.orgId,
    primitiveName: "wordpress_site_tool_call",
    intent: null,
    causation: "run-9",
    context: null,
    status: "pending",
    failureCode: null,
    resultSummary: null,
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    executingDeadline: null,
    executedAt: null,
    expiresAt: "2026-07-28T12:00:00.000Z",
    createdAt: "2026-07-28T11:45:00.000Z",
    updatedAt: "2026-07-28T11:45:00.000Z",
    ...overrides,
  };
}

type ReadFn = NonNullable<PendingCallExecutorDeps["readPendingCall"]>;
type ConsumeFn = NonNullable<PendingCallExecutorDeps["consumePendingCall"]>;
type DenyFn = NonNullable<PendingCallExecutorDeps["denyPendingCall"]>;
type RecordFn = NonNullable<PendingCallExecutorDeps["recordOutcome"]>;
type VerifyFn = NonNullable<PendingCallExecutorDeps["verifyToken"]>;
type InvokeFn = NonNullable<PendingCallExecutorDeps["invoke"]>;
type ListFn = NonNullable<PendingCallExecutorDeps["listTools"]>;
type AuditFn = NonNullable<PendingCallExecutorDeps["audit"]>;

function makeDeps(overrides: Partial<PendingCallExecutorDeps> = {}) {
  const pendingRow = row();
  const executingRow = row({ status: "executing", decidedBy: SESSION.userId });
  const verifyToken = vi.fn<VerifyFn>(() => ({
    pendingCallId: pendingRow.id,
    userId: SESSION.userId,
    orgId: SESSION.orgId,
    sessionId: SESSION.sessionId,
    act: "confirm",
    jti: "j1",
  }));
  const readPendingCall = vi.fn<ReadFn>(async () => pendingRow);
  const consumePendingCall = vi.fn<ConsumeFn>(async () => executingRow);
  const denyPendingCall = vi.fn<DenyFn>(async (_id, input) =>
    row({ status: input.as, decidedBy: SESSION.userId, args: null }),
  );
  const recordOutcome = vi.fn<RecordFn>(async (_id, input) => ({
    record: row({
      status: input.status,
      failureCode: input.failureCode ?? null,
      resultSummary: input.resultSummary ?? null,
      args: null,
    }),
    lateUpgrade: false,
  }));
  const resolveInstanceEndpoint = vi.fn(async () => ({
    endpoint: ENDPOINT,
    authHeader: "Basic zzz",
  }));
  const buildInvokerDeps = vi.fn(() => ({
    resolveInstanceEndpoint,
    destructiveHook: { enabled: () => true, fire: vi.fn() },
  }) as unknown as ConnectorInstanceInvokerDeps);
  const listTools = vi.fn<ListFn>(async () => ({
    tools: [
      {
        ...TOOL,
        derivedClass: "destructive",
        policyStatus: "allowed",
        cacheAgeMs: 0,
        catalogRevision: "rev-1",
      },
    ] as never,
    catalogRevision: "rev-1",
  }));
  const invoke = vi.fn<InvokeFn>(async () => ({ success: true, data: { ok: 1 } }));
  const audit = vi.fn<AuditFn>(async () => {});

  const deps: PendingCallExecutorDeps = {
    readPendingCall,
    consumePendingCall,
    denyPendingCall,
    recordOutcome,
    verifyToken,
    invoke,
    listTools,
    buildInvokerDeps: buildInvokerDeps as never,
    audit,
    ...overrides,
  };
  return {
    deps,
    pendingRow,
    executingRow,
    verifyToken,
    readPendingCall,
    consumePendingCall,
    denyPendingCall,
    recordOutcome,
    resolveInstanceEndpoint,
    buildInvokerDeps,
    listTools,
    invoke,
    audit,
  };
}

function auditOps(audit: ReturnType<typeof vi.fn>): string[] {
  return audit.mock.calls.map((c) => (c[0] as { operation: string }).operation);
}

const DECIDE = (deps: PendingCallExecutorDeps, action: "confirm" | "deny" | "cancel" = "confirm") =>
  decidePendingCall(
    { pendingCallId: "cipc_1", action, token: "tok", session: SESSION, actor: ACTOR },
    deps,
  );

describe("decidePendingCall — refusals (opaque; audited pending_call_decision_rejected)", () => {
  it("invalid token → refused BEFORE any row read", async () => {
    const h = makeDeps({ verifyToken: vi.fn<VerifyFn>(() => null) });
    const result = await decidePendingCall(
      {
        pendingCallId: "cipc_1",
        action: "confirm",
        token: "SECRET-TOKEN-MATERIAL-xyz",
        session: SESSION,
        actor: ACTOR,
      },
      h.deps,
    );
    expect(result).toEqual({ outcome: "refused" });
    expect(h.readPendingCall).not.toHaveBeenCalled();
    expect(h.consumePendingCall).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toEqual(["pending_call_decision_rejected"]);
    const meta = (h.audit.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta).toMatchObject({ reason: "token_invalid" });
    expect(JSON.stringify(meta)).not.toContain("SECRET-TOKEN-MATERIAL"); // never token material
  });

  it("unknown row → refused (not_found)", async () => {
    const h = makeDeps({ readPendingCall: vi.fn<ReadFn>(async () => null) });
    expect(await DECIDE(h.deps)).toEqual({ outcome: "refused" });
    expect(auditOps(h.audit)).toEqual(["pending_call_decision_rejected"]);
  });

  it("requester-only: another user's row → refused (ownership), nothing consumed", async () => {
    const h = makeDeps({
      readPendingCall: vi.fn<ReadFn>(async () => row({ userId: "someone-else" })),
    });
    expect(await DECIDE(h.deps)).toEqual({ outcome: "refused" });
    expect(h.consumePendingCall).not.toHaveBeenCalled();
    expect(h.denyPendingCall).not.toHaveBeenCalled();
  });
});

describe("decidePendingCall — deny / cancel (requester-only terminal CAS, no invoke)", () => {
  it.each([
    ["deny", "denied", "pending_call_denied"],
    ["cancel", "cancelled", "pending_call_cancelled"],
  ] as const)("%s → %s + %s audit, wire never called", async (action, as, op) => {
    const h = makeDeps();
    const result = await DECIDE(h.deps, action);
    expect(result).toMatchObject({ outcome: "decided", status: as, alreadyDecided: false });
    expect(h.denyPendingCall).toHaveBeenCalledWith(
      "cipc_1",
      { decidedBy: SESSION.userId, as },
      undefined,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toEqual([op]);
  });

  it("deny replay (already decided) returns the recorded state without a new transition", async () => {
    const h = makeDeps({
      denyPendingCall: vi.fn<DenyFn>(async () => null),
      readPendingCall: vi
        .fn<ReadFn>()
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ status: "expired", args: null })),
    });
    const result = await DECIDE(h.deps, "deny");
    expect(result).toMatchObject({ outcome: "decided", status: "expired", alreadyDecided: true });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("decidePendingCall — confirm: exactly-once + replay", () => {
  it("happy path: consume → drift checks → intact invoke (hook OMITTED) → executed", async () => {
    const h = makeDeps();
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "executed", alreadyDecided: false });

    // Exactly one wire execution, from the persisted row, on the resume spine.
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const [invokeInput, invokeDeps] = h.invoke.mock.calls[0];
    expect(invokeInput).toMatchObject({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: TOOL.serverId,
      toolName: TOOL.name,
      args: { id: 7, force: true },
      primitiveName: "wordpress_site_tool_call",
      sourceType: "chat",
      intent: "confirmed:cipc_1",
      causation: "run-9",
    });
    // The pin is rebuilt from HOST data (the persisted row).
    expect(
      (invokeInput as { actor: { connectorInstancePin: unknown } }).actor.connectorInstancePin,
    ).toEqual({ connectorKey: "wordpress", instanceId: "inst-1" });
    // The confirmed call must not re-park: destructiveHook is OMITTED; every
    // other shared-runtime dep passes through.
    expect(invokeDeps).not.toHaveProperty("destructiveHook");
    expect((invokeDeps as { resolveInstanceEndpoint: unknown }).resolveInstanceEndpoint).toBe(
      h.resolveInstanceEndpoint,
    );
    // Stored serverId through the S3-widened resolver at the COMPARE call site.
    expect(h.resolveInstanceEndpoint).toHaveBeenCalledWith("wordpress", "inst-1", TOOL.serverId);

    expect(h.recordOutcome).toHaveBeenCalledTimes(1);
    const [, outcomeInput] = h.recordOutcome.mock.calls[0];
    expect(outcomeInput).toMatchObject({ status: "executed" });
    expect(auditOps(h.audit)).toEqual(["pending_call_confirmed", "pending_call_executed"]);
  });

  it("duplicate confirm (CAS lost) → recorded outcome, alreadyDecided, replay audit, NO second execution", async () => {
    const h = makeDeps({
      consumePendingCall: vi.fn<ConsumeFn>(async () => null),
      readPendingCall: vi
        .fn<ReadFn>()
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(
          row({ status: "executed", args: null, resultSummary: { ok: true } }),
        ),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "executed", alreadyDecided: true });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toEqual(["pending_call_confirm_replayed"]);
    expect(
      (h.audit.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata,
    ).toMatchObject({ alreadyDecidedStatus: "executed" });
  });

  it("two CONCURRENT confirms: single CAS winner, one wire call, loser gets the recorded outcome", async () => {
    const h = makeDeps();
    h.consumePendingCall
      .mockResolvedValueOnce(h.executingRow)
      .mockResolvedValueOnce(null);
    h.readPendingCall.mockImplementation(async () =>
      h.invoke.mock.calls.length > 0
        ? row({ status: "executed", args: null })
        : row(),
    );
    const [first, second] = await Promise.all([DECIDE(h.deps), DECIDE(h.deps)]);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const outcomes = [first, second].map((r) =>
      r.outcome === "decided" ? r.alreadyDecided : "refused",
    );
    expect(outcomes.filter((o) => o === false)).toHaveLength(1);
    expect(outcomes.filter((o) => o === true)).toHaveLength(1);
  });
});

describe("decidePendingCall — material-identity drift (consent binding)", () => {
  it("execution-target repoint since park → failed('target_changed'), toctou audit, wire never called", async () => {
    const h = makeDeps();
    h.resolveInstanceEndpoint.mockResolvedValueOnce({
      endpoint: "https://DIFFERENT.example/mcp",
      authHeader: "Basic zzz",
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "target_changed" });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toEqual(["pending_call_confirmed", "pending_call_toctou_denied"]);
  });

  it("unresolvable endpoint at compare → failed('network_error') toctou, wire never called", async () => {
    const h = makeDeps();
    h.resolveInstanceEndpoint.mockResolvedValueOnce(null as never);
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "network_error" });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("tool vanished from the CURRENT catalog → failed('tool_not_found'), wire never called", async () => {
    const h = makeDeps({
      listTools: vi.fn<ListFn>(async () => ({ tools: [] as never, catalogRevision: "rev-2" })),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "tool_not_found" });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toContain("pending_call_toctou_denied");
  });

  it("tool SHAPE drift (inputSchema changed) → failed('tool_changed'), wire never called", async () => {
    const h = makeDeps({
      listTools: vi.fn<ListFn>(async () => ({
        tools: [
          {
            ...TOOL,
            inputSchema: { type: "object", properties: { force: { type: "boolean" } } },
            derivedClass: "destructive",
            policyStatus: "allowed",
            cacheAgeMs: 0,
            catalogRevision: "rev-2",
          },
        ] as never,
        catalogRevision: "rev-2",
      })),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "tool_changed" });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("annotation relabel (destructive→write) is INSIDE the fingerprint → denies as tool_changed", async () => {
    const h = makeDeps({
      listTools: vi.fn<ListFn>(async () => ({
        tools: [
          {
            ...TOOL,
            rawAnnotations: {},
            derivedClass: "write",
            policyStatus: "allowed",
            cacheAgeMs: 0,
            catalogRevision: "rev-2",
          },
        ] as never,
        catalogRevision: "rev-2",
      })),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "tool_changed" });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("unchanged tool found on a LATER list page (cursor loop) → proceeds to execute", async () => {
    const h = makeDeps();
    h.listTools
      .mockResolvedValueOnce({
        tools: [] as never,
        catalogRevision: "rev-1",
        nextCursor: "c2",
      })
      .mockResolvedValueOnce({
        tools: [
          {
            ...TOOL,
            derivedClass: "destructive",
            policyStatus: "allowed",
            cacheAgeMs: 0,
            catalogRevision: "rev-1",
          },
        ] as never,
        catalogRevision: "rev-1",
      });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "executed" });
    expect(h.listTools).toHaveBeenCalledTimes(2);
    expect(h.listTools.mock.calls[1][0]).toMatchObject({ cursor: "c2", serverId: TOOL.serverId });
  });

  it("a catalog that keeps returning a non-null cursor forever is capped at CATALOG_LOOKUP_MAX_PAGES → failed('catalog_lookup_budget_exceeded'), row never stays pinned in executing", async () => {
    const h = makeDeps();
    h.listTools.mockImplementation(async () => ({
      tools: [] as never,
      catalogRevision: "rev-1",
      nextCursor: "same-cursor-forever",
    }));
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({
      outcome: "decided",
      status: "failed",
      failureCode: "catalog_lookup_budget_exceeded",
    });
    expect(h.listTools).toHaveBeenCalledTimes(CATALOG_LOOKUP_MAX_PAGES);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(auditOps(h.audit)).toEqual(["pending_call_confirmed", "pending_call_toctou_denied"]);
    // The recorded terminal status came from d.recordOutcome — the row left
    // `executing` rather than staying pinned there while this call hung.
    expect(h.recordOutcome).toHaveBeenCalledWith(
      h.executingRow.id,
      expect.objectContaining({ status: "failed", failureCode: "catalog_lookup_budget_exceeded" }),
      undefined,
    );
  });
});

describe("decidePendingCall — TOCTOU spine at invoke + execution failures", () => {
  it("revoked authority / live policy deny at invoke → toctou audit, failed(<code>)", async () => {
    const h = makeDeps({
      invoke: vi.fn<InvokeFn>(async () => {
        throw new InvokerError("tool_policy_denied", "denied since park");
      }),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "tool_policy_denied" });
    expect(auditOps(h.audit)).toEqual(["pending_call_confirmed", "pending_call_toctou_denied"]);
  });

  it("ordinary wire failure → pending_call_execution_failed (not toctou)", async () => {
    const h = makeDeps({
      invoke: vi.fn<InvokeFn>(async () => {
        throw new InvokerError("tool_error", "site 500");
      }),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "tool_error" });
    expect(auditOps(h.audit)).toEqual(["pending_call_confirmed", "pending_call_execution_failed"]);
  });

  it("consumed row missing args (defensive) → failed('args_missing'), wire never called", async () => {
    const h = makeDeps({
      consumePendingCall: vi.fn<ConsumeFn>(async () =>
        row({ status: "executing", args: null }),
      ),
    });
    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({ outcome: "decided", status: "failed", failureCode: "args_missing" });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("decidePendingCall — executor deadline + late upgrade (exactly-once truth)", () => {
  it("deadline expiry → INDETERMINATE execution_interrupted; the settled wire upgrades to the real outcome exactly once", async () => {
    let resolveInvoke: (v: unknown) => void = () => {};
    const invoke = vi.fn<InvokeFn>(
      () => new Promise((resolve) => (resolveInvoke = resolve)),
    );
    const h = makeDeps({ invoke, executeTimeoutMs: 5 });
    const lateRecord = row({ status: "executed", args: null });
    h.recordOutcome
      .mockResolvedValueOnce({
        record: row({ status: "failed", failureCode: "execution_interrupted", args: null }),
        lateUpgrade: false,
      })
      .mockResolvedValueOnce({ record: lateRecord, lateUpgrade: true });

    const result = await DECIDE(h.deps);
    expect(result).toMatchObject({
      outcome: "decided",
      status: "failed",
      failureCode: "execution_interrupted",
    });

    // The wire settles late → the real outcome upgrades the interrupted row.
    resolveInvoke({ success: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.recordOutcome).toHaveBeenCalledTimes(2);
    expect(h.recordOutcome.mock.calls[1][1]).toMatchObject({ status: "executed" });
    const ops = auditOps(h.audit);
    expect(ops).toEqual([
      "pending_call_confirmed",
      "pending_call_execution_failed",
      "pending_call_executed",
    ]);
    const lateMeta = (h.audit.mock.calls[2][0] as { metadata: Record<string, unknown> }).metadata;
    expect(lateMeta).toMatchObject({ lateUpgrade: true });
  });

  it("exports the production 120s deadline", () => {
    expect(EXECUTE_TIMEOUT_MS).toBe(120_000);
  });
});

describe("act-family mapping against the REAL verifier (no injected verify double)", () => {
  // These pin the LANDED stage-2 mapping end-to-end through the executor: a
  // reject-family token decides deny AND cancel but never confirm; a confirm
  // token never denies; an unknown/hostile action refuses fail-closed before
  // anything is consumed. Real HMAC tokens — the secret is test-scoped.
  const PRIOR_SECRET = process.env.BETTER_AUTH_SECRET;
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-pr4-executor";
  });
  afterAll(() => {
    if (PRIOR_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = PRIOR_SECRET;
  });

  function realTokenDeps(act: "confirm" | "reject") {
    const h = makeDeps();
    const { verifyToken: _drop, ...rest } = h.deps;
    void _drop;
    const token = issuePendingCallDecisionToken({
      pendingCallId: "cipc_1",
      userId: SESSION.userId,
      orgId: SESSION.orgId,
      sessionId: SESSION.sessionId,
      act,
    });
    return { ...h, deps: rest, token };
  }

  it("a reject-family token authorizes deny AND cancel through the real mapping", async () => {
    for (const action of ["deny", "cancel"] as const) {
      const h = realTokenDeps("reject");
      const result = await decidePendingCall(
        { pendingCallId: "cipc_1", action, token: h.token, session: SESSION, actor: ACTOR },
        h.deps,
      );
      expect(result).toMatchObject({
        outcome: "decided",
        status: action === "deny" ? "denied" : "cancelled",
      });
      expect(h.invoke).not.toHaveBeenCalled();
    }
  });

  it("a reject-family token can NEVER confirm (real verifier refuses; nothing consumed)", async () => {
    const h = realTokenDeps("reject");
    const result = await decidePendingCall(
      { pendingCallId: "cipc_1", action: "confirm", token: h.token, session: SESSION, actor: ACTOR },
      h.deps,
    );
    expect(result).toEqual({ outcome: "refused" });
    expect(h.consumePendingCall).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("a confirm token can NEVER deny", async () => {
    const h = realTokenDeps("confirm");
    const result = await decidePendingCall(
      { pendingCallId: "cipc_1", action: "deny", token: h.token, session: SESSION, actor: ACTOR },
      h.deps,
    );
    expect(result).toEqual({ outcome: "refused" });
    expect(h.denyPendingCall).not.toHaveBeenCalled();
  });

  it("a HOSTILE raw action 'reject' refuses fail-closed — never consumed, never executed", async () => {
    const h = realTokenDeps("reject");
    const result = await decidePendingCall(
      {
        pendingCallId: "cipc_1",
        action: "reject" as never,
        token: h.token,
        session: SESSION,
        actor: ACTOR,
      },
      h.deps,
    );
    expect(result).toEqual({ outcome: "refused" });
    expect(h.consumePendingCall).not.toHaveBeenCalled();
    expect(h.denyPendingCall).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    // The refusal is audited as an unknown action, before any row read.
    expect(auditOps(h.audit)).toEqual(["pending_call_decision_rejected"]);
    expect(
      (h.audit.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata,
    ).toMatchObject({ reason: "unknown_action" });
  });
});

describe("result summaries (§3/§6.2) — bounded + secret-redacted, never raw in audits", () => {
  it("redacts secret-ish keys in the persisted preview", () => {
    const summary = buildResultSummary({ ok: 1, password: "hunter2", nested: { api_key: "k" } });
    expect(summary.ok).toBe(true);
    expect(summary.resultPreview).toContain("[redacted]");
    expect(summary.resultPreview).not.toContain("hunter2");
  });

  it("wraps non-object results", () => {
    expect(buildResultSummary("plain").resultPreview).toContain("plain");
  });

  it("audit metadata never carries args, previews, or endpoints", async () => {
    const h = makeDeps();
    await DECIDE(h.deps);
    const serialized = JSON.stringify(h.audit.mock.calls.map((c) => c[0]));
    expect(serialized).not.toContain('"force"'); // args key
    expect(serialized).not.toContain(ENDPOINT);
    expect(serialized).not.toContain("Basic zzz");
  });
});
