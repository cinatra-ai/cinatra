import { describe, expect, it, vi } from "vitest";
import {
  parkPendingCall,
  consumePendingCall,
  denyPendingCall,
  recordOutcome,
  listPendingCallsForViewer,
  readPendingCall,
  readConfirmationPolicy,
  setConfirmationPolicy,
  canonicalizeArgs,
  computeArgsDigest,
  computeToolFingerprint,
  computeTargetFingerprint,
  redactArgsPreview,
  mintPendingCallId,
  ARGS_MAX_BYTES,
  PENDING_CALL_CAP,
  EXECUTING_HARD_DEADLINE_MS,
  PENDING_CALL_EXPIRY_MS,
  type ParkPendingCallInput,
  type PendingCallStoreDeps,
  type PendingCallStoreQuery,
} from "@/lib/connector-instance-pending-call-store";
import { connectorInstancePendingCallSchemaQueries } from "@/lib/connector-instance-pending-call-schema";
import { connectorInstanceConfirmationPolicySchemaQueries } from "@/lib/connector-instance-confirmation-policy-schema";

// cinatra#2020 S5 PR-1 — pending-call + confirmation-policy store. Injected query
// + audit → no real DB (mirrors connector-instance-server-store / -tool-policy).
// A semantically faithful in-memory Postgres double models the park transaction
// (advisory lock, flip-expired, exact-dup collapse, cap, ON CONFLICT arbiter,
// sweep), the exactly-once CAS surfaces, and the lazy reader flips against a
// SYNTHETIC clock so expiry / hard-deadline transitions are deterministic.

const MINUTE = 60_000;

type Internal = {
  id: string;
  connector_key: string;
  instance_id: string;
  server_id: string;
  tool_name: string;
  args: Record<string, unknown> | null;
  args_hash: string;
  args_bytes: number;
  args_preview: string;
  tool_fingerprint: string;
  target_fingerprint: string;
  derived_class: string;
  surface: string;
  user_id: string;
  org_id: string;
  primitive_name: string | null;
  intent: string | null;
  causation: string | null;
  context: Record<string, unknown> | null;
  status: string;
  failure_code: string | null;
  result_summary: unknown;
  decided_by: string | null;
  decided_at_ms: number | null;
  consumed_at_ms: number | null;
  executing_deadline_ms: number | null;
  executed_at_ms: number | null;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type PolicyInternal = {
  connector_key: string;
  instance_id: string;
  mode: string;
  updated_by: string;
  updated_at_ms: number;
};

function makeStore() {
  const rows = new Map<string, Internal>();
  const policies = new Map<string, PolicyInternal>();
  let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

  const project = (r: Internal) => ({
    id: r.id,
    connector_key: r.connector_key,
    instance_id: r.instance_id,
    server_id: r.server_id,
    tool_name: r.tool_name,
    args: r.args,
    args_hash: r.args_hash,
    args_bytes: r.args_bytes,
    args_preview: r.args_preview,
    tool_fingerprint: r.tool_fingerprint,
    target_fingerprint: r.target_fingerprint,
    derived_class: r.derived_class,
    surface: r.surface,
    user_id: r.user_id,
    org_id: r.org_id,
    primitive_name: r.primitive_name,
    intent: r.intent,
    causation: r.causation,
    context: r.context,
    status: r.status,
    failure_code: r.failure_code,
    result_summary: r.result_summary,
    decided_by: r.decided_by,
    decided_at: isoOrNull(r.decided_at_ms),
    consumed_at: isoOrNull(r.consumed_at_ms),
    executing_deadline: isoOrNull(r.executing_deadline_ms),
    executed_at: isoOrNull(r.executed_at_ms),
    expires_at: iso(r.expires_at_ms),
    created_at: iso(r.created_at_ms),
    updated_at: iso(r.updated_at_ms),
  });

  const dedupMatch = (r: Internal, v: unknown[]) =>
    r.org_id === v[0] &&
    r.connector_key === v[1] &&
    r.instance_id === v[2] &&
    r.server_id === v[3] &&
    r.user_id === v[4] &&
    r.surface === v[5] &&
    r.tool_name === v[6] &&
    r.args_hash === v[7];

  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const v = (values ?? []) as unknown[];
    const trimmed = text.trimStart();

    if (text.includes("pg_advisory_xact_lock")) return [];

    // ---- confirmation policy -------------------------------------------------
    if (text.includes("connector_instance_confirmation_policy")) {
      if (trimmed.startsWith("SELECT")) {
        const [ck, iid] = v as [string, string];
        const p = policies.get(`${ck}::${iid}`);
        return p ? [{ ...p, updated_at: iso(p.updated_at_ms) }] : [];
      }
      // upsert
      const [ck, iid, mode, updatedBy] = v as [string, string, string, string];
      policies.set(`${ck}::${iid}`, {
        connector_key: ck,
        instance_id: iid,
        mode,
        updated_by: updatedBy,
        updated_at_ms: nowMs,
      });
      return [];
    }

    // ---- on-write sweep ------------------------------------------------------
    if (trimmed.startsWith("DELETE")) {
      const retentionSecs = Number(v[0]);
      const cutoff = nowMs - retentionSecs * 1000;
      const terminal = new Set(["executed", "failed", "denied", "cancelled", "expired"]);
      for (const [id, r] of [...rows]) {
        if (terminal.has(r.status) && r.updated_at_ms < cutoff) rows.delete(id);
      }
      return [];
    }

    // ---- park INSERT (ON CONFLICT arbiter) -----------------------------------
    if (trimmed.startsWith("INSERT")) {
      const [
        id, ck, iid, sid, tool, argsJson, argsHash, argsBytes, preview, toolFp, targetFp,
        derived, surface, userId, orgId, primitive, intent, causation, contextJson, expirySecs,
      ] = v as [
        string, string, string, string, string, string, string, number, string, string, string,
        string, string, string, string, string | null, string | null, string | null, string | null, number,
      ];
      // partial-unique arbiter: a live pending row with the same dedup key wins.
      for (const r of rows.values()) {
        if (r.status === "pending" && dedupMatch(r, [orgId, ck, iid, sid, userId, surface, tool, argsHash])) {
          return []; // DO NOTHING
        }
      }
      const row: Internal = {
        id, connector_key: ck, instance_id: iid, server_id: sid, tool_name: tool,
        args: JSON.parse(argsJson), args_hash: argsHash, args_bytes: argsBytes, args_preview: preview,
        tool_fingerprint: toolFp, target_fingerprint: targetFp, derived_class: derived, surface,
        user_id: userId, org_id: orgId, primitive_name: primitive ?? null, intent: intent ?? null,
        causation: causation ?? null, context: contextJson ? JSON.parse(contextJson) : null,
        status: "pending", failure_code: null, result_summary: null, decided_by: null,
        decided_at_ms: null, consumed_at_ms: null, executing_deadline_ms: null, executed_at_ms: null,
        expires_at_ms: nowMs + expirySecs * 1000, created_at_ms: nowMs, updated_at_ms: nowMs,
      };
      rows.set(id, row);
      return [{ id, expires_at: iso(row.expires_at_ms) }];
    }

    // ---- UPDATEs -------------------------------------------------------------
    if (trimmed.startsWith("UPDATE")) {
      // lazy reader flip (viewer- or id-scoped)
      if (text.includes("status = CASE WHEN status = 'pending'")) {
        const byId = text.includes("WHERE id = $1");
        const out: Array<Record<string, unknown>> = [];
        for (const r of rows.values()) {
          const inScope = byId ? r.id === v[0] : r.org_id === v[0] && r.user_id === v[1];
          if (!inScope) continue;
          if (r.status === "pending" && r.expires_at_ms <= nowMs) {
            r.status = "expired";
            r.args = null;
            r.updated_at_ms = nowMs;
            out.push({ id: r.id, connector_key: r.connector_key, instance_id: r.instance_id, status: "expired", failure_code: r.failure_code });
          } else if (r.status === "executing" && r.executing_deadline_ms !== null && r.executing_deadline_ms <= nowMs) {
            r.status = "failed";
            r.failure_code = "execution_interrupted";
            r.args = null;
            r.updated_at_ms = nowMs;
            out.push({ id: r.id, connector_key: r.connector_key, instance_id: r.instance_id, status: "failed", failure_code: "execution_interrupted" });
          }
        }
        return out;
      }
      // park flip-expired (this dedup key's expired pendings)
      if (text.includes("SET status = 'expired'")) {
        const out: Array<Record<string, unknown>> = [];
        for (const r of rows.values()) {
          if (r.status === "pending" && r.expires_at_ms <= nowMs && dedupMatch(r, v)) {
            r.status = "expired";
            r.args = null;
            r.updated_at_ms = nowMs;
            out.push({ id: r.id, connector_key: r.connector_key, instance_id: r.instance_id, status: "expired", failure_code: r.failure_code });
          }
        }
        return out;
      }
      // consume CAS (pending → executing)
      if (text.includes("SET status = 'executing'")) {
        const [id, decidedBy, deadlineSecs] = v as [string, string, number];
        const r = rows.get(id);
        if (r && r.status === "pending" && r.expires_at_ms > nowMs) {
          r.status = "executing";
          r.decided_by = decidedBy;
          r.decided_at_ms = nowMs;
          r.consumed_at_ms = nowMs;
          r.executing_deadline_ms = nowMs + deadlineSecs * 1000;
          r.updated_at_ms = nowMs;
          return [project(r)];
        }
        return [];
      }
      // deny CAS (pending → denied|cancelled)
      if (text.includes("SET status = $3")) {
        const [id, decidedBy, as] = v as [string, string, string];
        const r = rows.get(id);
        if (r && r.status === "pending" && r.expires_at_ms > nowMs) {
          r.status = as;
          r.decided_by = decidedBy;
          r.decided_at_ms = nowMs;
          r.args = null;
          r.updated_at_ms = nowMs;
          return [project(r)];
        }
        return [];
      }
      // recordOutcome late-upgrade (failed/execution_interrupted → real outcome)
      if (text.includes("status = 'failed' AND failure_code = 'execution_interrupted'")) {
        const [id, status, failureCode, summaryJson] = v as [string, string, string | null, string | null];
        const r = rows.get(id);
        if (r && r.status === "failed" && r.failure_code === "execution_interrupted") {
          r.status = status;
          r.failure_code = failureCode;
          r.result_summary = summaryJson ? JSON.parse(summaryJson) : null;
          if (status === "executed") r.executed_at_ms = nowMs;
          r.args = null;
          r.updated_at_ms = nowMs;
          return [project(r)];
        }
        return [];
      }
      // recordOutcome primary (executing → executed|failed)
      if (text.includes("status = 'executing'")) {
        const [id, status, failureCode, summaryJson] = v as [string, string, string | null, string | null];
        const r = rows.get(id);
        if (r && r.status === "executing") {
          r.status = status;
          r.failure_code = failureCode;
          r.result_summary = summaryJson ? JSON.parse(summaryJson) : null;
          if (status === "executed") r.executed_at_ms = nowMs;
          r.args = null;
          r.updated_at_ms = nowMs;
          return [project(r)];
        }
        return [];
      }
      return [];
    }

    // ---- SELECTs -------------------------------------------------------------
    if (trimmed.startsWith("SELECT")) {
      if (text.includes("count(*)")) {
        const [orgId, userId, ck, iid, tool] = v as [string, string, string, string, string];
        const n = [...rows.values()].filter(
          (r) => r.org_id === orgId && r.user_id === userId && r.connector_key === ck &&
            r.instance_id === iid && r.tool_name === tool && r.status === "pending" &&
            r.expires_at_ms > nowMs,
        ).length;
        return [{ n }];
      }
      if (text.includes("SELECT id, expires_at FROM")) {
        const hit = [...rows.values()].find((r) => r.status === "pending" && dedupMatch(r, v));
        return hit ? [{ id: hit.id, expires_at: iso(hit.expires_at_ms) }] : [];
      }
      if (text.includes("WHERE id = $1 LIMIT 1")) {
        const r = rows.get(v[0] as string);
        return r ? [project(r)] : [];
      }
      // viewer list
      const [orgId, userId] = v as [string, string];
      return [...rows.values()]
        .filter((r) => r.org_id === orgId && r.user_id === userId)
        .sort((a, b) => b.created_at_ms - a.created_at_ms || a.id.localeCompare(b.id))
        .map(project);
    }

    throw new Error(`unhandled SQL in test double: ${trimmed.slice(0, 60)}`);
  });

  const audit = vi.fn(async () => {});
  const deps: PendingCallStoreDeps = { query: query as unknown as PendingCallStoreQuery, audit };
  return {
    deps,
    audit,
    rows,
    policies,
    query,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function parkInput(over: Partial<ParkPendingCallInput> = {}): ParkPendingCallInput {
  return {
    connectorKey: "wordpress",
    instanceId: "i1",
    serverId: "wps-server-a",
    toolName: "core/delete-post",
    args: { id: 42 },
    endpointUrl: "https://example.com/wp-json/mcp/x",
    inputSchema: { type: "object" },
    rawAnnotations: { destructive: true },
    derivedClass: "destructive",
    surface: "chat",
    userId: "u1",
    orgId: "org1",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("canonicalizeArgs is stable regardless of key order", () => {
    expect(canonicalizeArgs({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalizeArgs({ a: { c: 3, d: 4 }, b: 1 }));
  });

  it("computeArgsDigest hashes canonically and counts bytes", () => {
    const a = computeArgsDigest({ x: 1, y: 2 });
    const b = computeArgsDigest({ y: 2, x: 1 });
    expect(a.hash).toBe(b.hash);
    expect(a.bytes).toBe(Buffer.byteLength(canonicalizeArgs({ x: 1, y: 2 }), "utf8"));
    expect(computeArgsDigest({ x: 1 }).hash).not.toBe(a.hash);
  });

  it("computeToolFingerprint changes with name, serverId, inputSchema and annotations", () => {
    const base = computeToolFingerprint({ name: "t", serverId: "s", inputSchema: { a: 1 }, rawAnnotations: { destructive: true } });
    expect(computeToolFingerprint({ name: "t", serverId: "s", inputSchema: { a: 1 }, rawAnnotations: { destructive: true } })).toBe(base);
    expect(computeToolFingerprint({ name: "t2", serverId: "s", inputSchema: { a: 1 }, rawAnnotations: { destructive: true } })).not.toBe(base);
    expect(computeToolFingerprint({ name: "t", serverId: "s2", inputSchema: { a: 1 }, rawAnnotations: { destructive: true } })).not.toBe(base);
    expect(computeToolFingerprint({ name: "t", serverId: "s", inputSchema: { a: 2 }, rawAnnotations: { destructive: true } })).not.toBe(base);
    // annotations are INSIDE the hash → a destructive→write relabel changes it.
    expect(computeToolFingerprint({ name: "t", serverId: "s", inputSchema: { a: 1 }, rawAnnotations: {} })).not.toBe(base);
  });

  it("computeTargetFingerprint changes with the endpoint URL string", () => {
    expect(computeTargetFingerprint("https://a.example/x")).toBe(computeTargetFingerprint("https://a.example/x"));
    expect(computeTargetFingerprint("https://a.example/x")).not.toBe(computeTargetFingerprint("https://b.example/x"));
  });

  it("redactArgsPreview redacts secret-ish keys recursively and truncates oversize", () => {
    const preview = redactArgsPreview({ title: "ok", password: "hunter2", nested: { apiKey: "k", authToken: "t" } });
    expect(preview).toContain('"title": "ok"');
    expect(preview).toContain('"password": "[redacted]"');
    expect(preview).toContain('"apiKey": "[redacted]"');
    expect(preview).not.toContain("hunter2");
    const big = redactArgsPreview({ blob: "x".repeat(20000) }, 1024);
    expect(Buffer.byteLength(big, "utf8")).toBeLessThan(1024 + 64);
    expect(big).toContain("truncated for display");
    // a multibyte payload cut at an odd byte boundary must not leak a U+FFFD
    // replacement glyph, and the pre-marker slice must stay within the budget.
    const multibyte = redactArgsPreview({ emoji: "😀".repeat(2000) }, 1023);
    expect(multibyte).not.toContain("�");
    const slice = multibyte.split("\n…truncated")[0]!;
    expect(Buffer.byteLength(slice, "utf8")).toBeLessThanOrEqual(1023);
  });

  it("mintPendingCallId is a unique cipc_ + 32 hex id", () => {
    const a = mintPendingCallId();
    expect(a).toMatch(/^cipc_[0-9a-f]{32}$/);
    expect(a).not.toBe(mintPendingCallId());
  });
});

// ---------------------------------------------------------------------------
// parkPendingCall
// ---------------------------------------------------------------------------

describe("parkPendingCall — insert / dedup arbiter / cap", () => {
  it("parks a new call (reused: false) and persists the derived columns", async () => {
    const { deps, rows } = makeStore();
    const res = await parkPendingCall(parkInput(), deps);
    expect(res.outcome).toBe("parked");
    if (res.outcome !== "parked") return;
    expect(res.reused).toBe(false);
    expect(res.id).toMatch(/^cipc_[0-9a-f]{32}$/);
    const row = rows.get(res.id)!;
    expect(row.status).toBe("pending");
    expect(row.args_hash).toBe(computeArgsDigest({ id: 42 }).hash);
    expect(row.tool_fingerprint).toBe(
      computeToolFingerprint({ name: "core/delete-post", serverId: "wps-server-a", inputSchema: { type: "object" }, rawAnnotations: { destructive: true } }),
    );
    expect(row.target_fingerprint).toBe(computeTargetFingerprint("https://example.com/wp-json/mcp/x"));
  });

  it("collapses an exact duplicate to the existing id (reused: true), one row total", async () => {
    const { deps, rows } = makeStore();
    const first = await parkPendingCall(parkInput(), deps);
    const second = await parkPendingCall(parkInput(), deps);
    expect(first.outcome).toBe("parked");
    expect(second.outcome).toBe("parked");
    if (first.outcome !== "parked" || second.outcome !== "parked") return;
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(rows.size).toBe(1);
  });

  it("keeps DIFFERENT server_id / surface as separate rows (dedup scope)", async () => {
    const { deps, rows } = makeStore();
    await parkPendingCall(parkInput({ serverId: "wps-server-a" }), deps);
    await parkPendingCall(parkInput({ serverId: "wps-server-b" }), deps);
    await parkPendingCall(parkInput({ serverId: "wps-server-a", surface: "session" }), deps);
    expect(rows.size).toBe(3);
  });

  it("flips this dedup key's expired pending BEFORE the arbiter, then inserts fresh", async () => {
    const { deps, rows, audit, advance } = makeStore();
    const first = await parkPendingCall(parkInput(), deps);
    if (first.outcome !== "parked") throw new Error("expected park");
    advance(PENDING_CALL_EXPIRY_MS + MINUTE); // the pending row is now stale
    const second = await parkPendingCall(parkInput(), deps);
    if (second.outcome !== "parked") throw new Error("expected park");
    expect(second.reused).toBe(false); // stale row flipped → a fresh row is inserted
    expect(second.id).not.toBe(first.id);
    expect(rows.get(first.id)!.status).toBe("expired");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ operation: "pending_call_expired" }));
  });

  it("refuses args over the 256 KB cap BEFORE the transaction", async () => {
    const { deps, rows } = makeStore();
    const res = await parkPendingCall(parkInput({ args: { blob: "x".repeat(ARGS_MAX_BYTES + 100) } }), deps);
    expect(res.outcome).toBe("args_too_large");
    if (res.outcome !== "args_too_large") return;
    expect(res.argsBytes).toBeGreaterThan(ARGS_MAX_BYTES);
    expect(rows.size).toBe(0);
  });

  it("refuses a distinct-args park at the cap, but an exact dup at cap still collapses", async () => {
    const { deps } = makeStore();
    for (let i = 0; i < PENDING_CALL_CAP; i += 1) {
      const r = await parkPendingCall(parkInput({ args: { id: i } }), deps);
      expect(r.outcome).toBe("parked");
    }
    const over = await parkPendingCall(parkInput({ args: { id: 999 } }), deps);
    expect(over.outcome).toBe("cap_exceeded");
    if (over.outcome === "cap_exceeded") expect(over.pendingCount).toBe(PENDING_CALL_CAP);
    // a duplicate of an EXISTING pending collapses (bypasses the cap) — never refuses.
    const dup = await parkPendingCall(parkInput({ args: { id: 0 } }), deps);
    expect(dup.outcome).toBe("parked");
    if (dup.outcome === "parked") expect(dup.reused).toBe(true);
  });

  it("counts only LIVE pendings for the cap — expired distinct-args rows never force cap_exceeded", async () => {
    const { deps, advance } = makeStore();
    for (let i = 0; i < PENDING_CALL_CAP; i += 1) {
      const r = await parkPendingCall(parkInput({ args: { id: i } }), deps);
      expect(r.outcome).toBe("parked");
    }
    advance(PENDING_CALL_EXPIRY_MS + MINUTE); // the 3 pendings are now expired (not yet flipped)
    const fresh = await parkPendingCall(parkInput({ args: { id: 999 } }), deps);
    expect(fresh.outcome).toBe("parked"); // stale rows do not count toward the cap
  });

  it("does not audit a normal park (the hook owns pending_call_parked in PR-3)", async () => {
    const { deps, audit } = makeStore();
    await parkPendingCall(parkInput(), deps);
    expect(audit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// exactly-once CAS: consume / deny / recordOutcome
// ---------------------------------------------------------------------------

describe("consumePendingCall — pending → executing CAS", () => {
  it("consumes once, stamps the executing deadline, retains args; a second consume is stale", async () => {
    const { deps } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    const first = await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    expect(first?.status).toBe("executing");
    expect(first?.decidedBy).toBe("u1");
    expect(first?.consumedAt).not.toBeNull();
    expect(first?.executingDeadline).not.toBeNull();
    expect(first?.args).toEqual({ id: 42 }); // executing keeps args
    const second = await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    expect(second).toBeNull();
  });

  it("refuses to consume an expired pending (expires_at > now())", async () => {
    const { deps, advance } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    advance(PENDING_CALL_EXPIRY_MS + MINUTE);
    expect(await consumePendingCall(parked.id, { decidedBy: "u1" }, deps)).toBeNull();
  });
});

describe("denyPendingCall — terminal negative CAS", () => {
  it.each(["denied", "cancelled"] as const)("moves pending → %s, nulls args, second is stale", async (as) => {
    const { deps } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    const first = await denyPendingCall(parked.id, { decidedBy: "u1", as }, deps);
    expect(first?.status).toBe(as);
    expect(first?.args).toBeNull();
    expect(await denyPendingCall(parked.id, { decidedBy: "u1", as }, deps)).toBeNull();
  });
});

describe("recordOutcome — executing → terminal + late upgrade", () => {
  it("records executed on an executing row, nulls args, no lateUpgrade", async () => {
    const { deps } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    const out = await recordOutcome(parked.id, { status: "executed", resultSummary: { ok: true } }, deps);
    expect(out?.lateUpgrade).toBe(false);
    expect(out?.record.status).toBe("executed");
    expect(out?.record.args).toBeNull();
    expect(out?.record.resultSummary).toEqual({ ok: true });
    expect(out?.record.executedAt).not.toBeNull();
  });

  it("records failed with a failure code", async () => {
    const { deps } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    const out = await recordOutcome(parked.id, { status: "failed", failureCode: "tool_policy_denied" }, deps);
    expect(out?.record.status).toBe("failed");
    expect(out?.record.failureCode).toBe("tool_policy_denied");
  });

  it("late-upgrades a reader-flipped execution_interrupted row and audits pending_call_outcome_late", async () => {
    const { deps, audit, advance } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    advance(EXECUTING_HARD_DEADLINE_MS + MINUTE);
    const flipped = await readPendingCall(parked.id, deps); // reader pessimistically flips
    expect(flipped?.status).toBe("failed");
    expect(flipped?.failureCode).toBe("execution_interrupted");
    audit.mockClear();
    const out = await recordOutcome(parked.id, { status: "executed", resultSummary: { ok: true } }, deps);
    expect(out?.lateUpgrade).toBe(true);
    expect(out?.record.status).toBe("executed");
    expect(out?.record.args).toBeNull(); // late-upgrade nulls args for CHECK parity
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ operation: "pending_call_outcome_late" }));
  });

  it("returns null when neither an executing nor an interrupted row matches", async () => {
    const { deps } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    // still 'pending' (never consumed) → nothing to record
    expect(await recordOutcome(parked.id, { status: "executed" }, deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lazy reader flips + on-write sweep
// ---------------------------------------------------------------------------

describe("reader lazy flips (executing-deadline truthfulness)", () => {
  it("flips an expired pending to expired on read and audits pending_call_expired", async () => {
    const { deps, audit, advance } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    advance(PENDING_CALL_EXPIRY_MS + MINUTE);
    const read = await readPendingCall(parked.id, deps);
    expect(read?.status).toBe("expired");
    expect(read?.args).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ operation: "pending_call_expired" }));
  });

  it("REFUSES to flip a live executing row before the 15-min hard deadline", async () => {
    const { deps, audit, advance } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    audit.mockClear();
    advance(EXECUTING_HARD_DEADLINE_MS - MINUTE); // still inside the deadline
    const read = await readPendingCall(parked.id, deps);
    expect(read?.status).toBe("executing");
    expect(audit).not.toHaveBeenCalled();
  });

  it("flips a crashed executing row to execution_interrupted only past the deadline", async () => {
    const { deps, audit, advance } = makeStore();
    const parked = await parkPendingCall(parkInput(), deps);
    if (parked.outcome !== "parked") throw new Error("expected park");
    await consumePendingCall(parked.id, { decidedBy: "u1" }, deps);
    advance(EXECUTING_HARD_DEADLINE_MS + MINUTE);
    const read = await readPendingCall(parked.id, deps);
    expect(read?.status).toBe("failed");
    expect(read?.failureCode).toBe("execution_interrupted");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ operation: "pending_call_execution_interrupted" }));
  });
});

describe("on-write sweep", () => {
  it("deletes terminal rows past the retention window when a new park lands", async () => {
    const { deps, rows, advance } = makeStore();
    const stale = await parkPendingCall(parkInput({ toolName: "core/delete-user", args: { id: 1 } }), deps);
    if (stale.outcome !== "parked") throw new Error("expected park");
    await denyPendingCall(stale.id, { decidedBy: "u1", as: "denied" }, deps); // terminal
    rows.get(stale.id)!.updated_at_ms -= 31 * 24 * 60 * MINUTE; // age it past 30 days
    advance(MINUTE);
    await parkPendingCall(parkInput({ args: { id: 2 } }), deps); // triggers the sweep
    expect(rows.has(stale.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

describe("listPendingCallsForViewer", () => {
  it("is scoped to (org, user) and lazy-expires stale rows", async () => {
    const { deps, advance } = makeStore();
    await parkPendingCall(parkInput({ args: { id: 1 } }), deps);
    await parkPendingCall(parkInput({ args: { id: 2 } }), deps);
    await parkPendingCall(parkInput({ userId: "u2", args: { id: 3 } }), deps);
    const mine = await listPendingCallsForViewer({ orgId: "org1", userId: "u1" }, deps);
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.userId === "u1")).toBe(true);
    // ordering is newest-first
    expect(mine[0]!.createdAt >= mine[1]!.createdAt).toBe(true);
    advance(PENDING_CALL_EXPIRY_MS + MINUTE);
    const after = await listPendingCallsForViewer({ orgId: "org1", userId: "u1" }, deps);
    expect(after.every((r) => r.status === "expired")).toBe(true);
  });
});

describe("readPendingCall", () => {
  it("returns null for an unknown id", async () => {
    const { deps } = makeStore();
    expect(await readPendingCall("cipc_deadbeef", deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// confirmation policy
// ---------------------------------------------------------------------------

describe("confirmation policy store", () => {
  it("reads null (defaults) when no row exists", async () => {
    const { deps } = makeStore();
    expect(await readConfirmationPolicy("wordpress", "i1", deps)).toBeNull();
  });

  it("upserts the mode, audits confirmation_policy_changed with from→to, and reads back", async () => {
    const { deps, audit } = makeStore();
    await setConfirmationPolicy({ connectorKey: "wordpress", instanceId: "i1", mode: "disabled", updatedBy: "admin" }, deps);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "confirmation_policy_changed",
        metadata: expect.objectContaining({ from: "default", to: "disabled", updatedBy: "admin" }),
      }),
    );
    const read = await readConfirmationPolicy("wordpress", "i1", deps);
    expect(read).toMatchObject({ mode: "disabled", updatedBy: "admin" });

    audit.mockClear();
    await setConfirmationPolicy({ connectorKey: "wordpress", instanceId: "i1", mode: "default", updatedBy: "admin2" }, deps);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ from: "disabled", to: "default" }) }),
    );
    expect((await readConfirmationPolicy("wordpress", "i1", deps))?.mode).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// bootstrap DDL invariants (design §3)
// ---------------------------------------------------------------------------

describe("bootstrap DDL invariants", () => {
  const ddl = connectorInstancePendingCallSchemaQueries("cinatra").map((q) => q.text);
  const table = ddl[0]!;

  it("enforces the 256 KB args cap and the status enum as DB CHECKs", () => {
    expect(table).toContain("args_bytes integer NOT NULL CHECK (args_bytes <= 262144)");
    expect(table).toContain(
      "status text NOT NULL CHECK (status IN ('pending','executing','executed','failed','denied','cancelled','expired'))",
    );
  });

  it("enforces the status↔args coupling structurally (args nulled at terminalization)", () => {
    expect(table).toContain("CHECK ((status IN ('pending','executing')) = (args IS NOT NULL))");
  });

  it("declares the partial-UNIQUE dedup arbiter over the full key with the pending predicate", () => {
    const dedup = ddl.find((q) => q.includes("connector_instance_pending_call_dedup_idx"))!;
    expect(dedup).toContain("UNIQUE INDEX");
    expect(dedup).toContain("(org_id, connector_key, instance_id, server_id, user_id, surface, tool_name, args_hash)");
    expect(dedup).toContain("WHERE status = 'pending'");
  });

  it("declares the viewer read index and the expiry sweep index", () => {
    expect(ddl.some((q) => q.includes("connector_instance_pending_call_viewer_idx") && q.includes("(org_id, user_id, status, created_at DESC)"))).toBe(true);
    expect(ddl.some((q) => q.includes("connector_instance_pending_call_expires_idx") && q.includes("(expires_at)"))).toBe(true);
  });

  it("confirmation policy table is keyed per (connector_key, instance_id)", () => {
    const policy = connectorInstanceConfirmationPolicySchemaQueries("cinatra")[0]!.text;
    expect(policy).toContain("connector_instance_confirmation_policy");
    expect(policy).toContain("PRIMARY KEY (connector_key, instance_id)");
  });
});
