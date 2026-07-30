import { describe, expect, it } from "vitest";
import {
  evaluateInstanceToolPolicy,
  isValidInstanceToolPolicyRecord,
  type InstanceToolPolicyRecord,
} from "../instance-tool-policy";

// cinatra#2017 S2 slice K4 — policy EVALUATION (§2.6 / D4 / §10-A3).

const base = { connectorKey: "wordpress", instanceId: "inst-1", updatedBy: "u", updatedAt: "2026-07-26T00:00:00Z" };
const ref = { serverId: "mcp-adapter-default", name: "ewpa/create-post" };

describe("evaluateInstanceToolPolicy — §10-A3 truth table", () => {
  // cinatra#2022 S7 PR-δ: absent → RESTRICTED+empty
  // (deny-all), not the pre-δ OPEN compatibility fallback.
  it("absent record → RESTRICTED+empty (deny) + warn-once signal (cinatra#2022 S7 PR-δ)", () => {
    expect(evaluateInstanceToolPolicy(null, ref)).toEqual({
      status: "denied",
      warn: "absent_policy_default_restricted",
    });
    expect(evaluateInstanceToolPolicy(undefined, ref)).toEqual({
      status: "denied",
      warn: "absent_policy_default_restricted",
    });
  });

  it("open mode → allow every tool EXCEPT entries in deny (deny applies in open mode)", () => {
    const open: InstanceToolPolicyRecord = { ...base, mode: "open" };
    expect(evaluateInstanceToolPolicy(open, ref).status).toBe("allowed");
    const openWithDeny: InstanceToolPolicyRecord = { ...base, mode: "open", deny: [ref] };
    expect(evaluateInstanceToolPolicy(openWithDeny, ref).status).toBe("denied");
  });

  it("restricted mode → allow ONLY tools in allow (empty allow ⇒ deny-all)", () => {
    const emptyAllow: InstanceToolPolicyRecord = { ...base, mode: "restricted" };
    expect(evaluateInstanceToolPolicy(emptyAllow, ref).status).toBe("denied");
    const allowed: InstanceToolPolicyRecord = { ...base, mode: "restricted", allow: [ref] };
    expect(evaluateInstanceToolPolicy(allowed, ref).status).toBe("allowed");
  });

  it("deny beats allow (deny precedence is absolute) in restricted mode", () => {
    const both: InstanceToolPolicyRecord = { ...base, mode: "restricted", allow: [ref], deny: [ref] };
    expect(evaluateInstanceToolPolicy(both, ref).status).toBe("denied");
  });

  it("invalid record (unknown mode) → deny-all + warn (fail-closed)", () => {
    const bad = { ...base, mode: "wide-open" } as unknown as InstanceToolPolicyRecord;
    expect(evaluateInstanceToolPolicy(bad, ref)).toEqual({ status: "denied", warn: "invalid_policy_deny_all" });
  });

  it("invalid record (malformed entry) → deny-all + warn", () => {
    const bad = { ...base, mode: "open", deny: [{ serverId: "x" }] } as unknown as InstanceToolPolicyRecord;
    expect(evaluateInstanceToolPolicy(bad, ref)).toEqual({ status: "denied", warn: "invalid_policy_deny_all" });
  });
});

describe("server-qualified matching (R2-M3) — never bare-name", () => {
  it("same tool NAME on two servers resolves each independently (one allow, one deny)", () => {
    const s1 = { serverId: "server-a", name: "core/get-site-info" };
    const s2 = { serverId: "server-b", name: "core/get-site-info" };
    const rec: InstanceToolPolicyRecord = { ...base, mode: "restricted", allow: [s1], deny: [s2] };
    expect(evaluateInstanceToolPolicy(rec, s1).status).toBe("allowed");
    expect(evaluateInstanceToolPolicy(rec, s2).status).toBe("denied");
  });

  it("stable-opaque serverId identity (R3-M3): distinct serverIds keep distinct policy even if names collide", () => {
    // Two servers whose *names* might normalize identically keep DISTINCT identity
    // because policy keys on the opaque serverId, never the normalized name.
    const a = { serverId: "id-aaa", name: "tool" };
    const b = { serverId: "id-bbb", name: "tool" };
    const rec: InstanceToolPolicyRecord = { ...base, mode: "open", deny: [a] };
    expect(evaluateInstanceToolPolicy(rec, a).status).toBe("denied");
    expect(evaluateInstanceToolPolicy(rec, b).status).toBe("allowed");
  });
});

// cinatra#2024 S9 program-acceptance evidence, batch 3 — design §2 row 1(e) /
// D3 ("mode: restricted actually restricts and lists denials"). The truth-
// table tests above already prove restricted-mode denial in the abstract,
// against a single synthetic `ref` — this describes the LISTING behavior the
// criterion actually names: `tools_list`'s per-row mapping
// (`src/lib/connector-instance-invoker.ts` ~L1016/L1033) calls this exact
// function once per catalog entry and reports every row's `policyStatus`,
// never dropping a denied row from the response (§2.6/§3.5/N9 "never
// shortens"). Proven here against a REAL S1 community-stack fixture write
// ability (`ewpa/update-post`) and its one genuinely destructive ability
// (`ewpa/create-code-snippet`, named in cinatra#2013's own epic body) mixed
// alongside an allowed read — not an empty/abstract denial. Does NOT
// re-prove: absent-record default, deny-beats-allow, invalid-record
// fail-closed, or server-qualified matching (all covered above); does NOT
// re-prove the full invoker-level block (already covered end-to-end by
// `src/lib/__tests__/connector-instance-invoker.test.ts`'s
// "policy deny (restricted empty allow) → tool_policy_denied" and its
// neighbors, deliberately not duplicated here).
describe("restricted mode lists denials against a concrete fixture ability (cinatra#2024 §2 row 1(e) / D3)", () => {
  const server = "mcp-adapter-default";
  const readAllowed = { serverId: server, name: "ewpa/get-post" };
  const writeDenied = { serverId: server, name: "ewpa/update-post" };
  const destructiveDenied = { serverId: server, name: "ewpa/create-code-snippet" };
  const mixedCatalog = [readAllowed, writeDenied, destructiveDenied];

  it("a narrow restricted allow-list LISTS every catalog row's status — the two ewpa/* mutation abilities show up DENIED, never dropped", () => {
    const record: InstanceToolPolicyRecord = { ...base, mode: "restricted", allow: [readAllowed] };

    // Mirrors tools_list's own per-row mapping: evaluate every catalog entry,
    // never filter/shorten the list (the "lists denials" half of the
    // criterion — a denied tool is a reported row, not an omission).
    const listed = mixedCatalog.map((toolRef) => ({
      toolRef,
      decision: evaluateInstanceToolPolicy(record, toolRef),
    }));

    expect(listed).toHaveLength(mixedCatalog.length);
    expect(listed.find((row) => row.toolRef.name === "ewpa/get-post")!.decision.status).toBe("allowed");
    expect(listed.find((row) => row.toolRef.name === "ewpa/update-post")!.decision.status).toBe("denied");
    expect(listed.find((row) => row.toolRef.name === "ewpa/create-code-snippet")!.decision.status).toBe(
      "denied",
    );
  });

  it("restricted mode blocks the destructive fixture ability's invocation path at the policy layer (the same decision the invoker's step-2 floor throws on)", () => {
    // `connector-instance-invoker.ts`'s step 2 (~L689/L697) calls this exact
    // function and throws `tool_policy_denied` before any wire call on
    // `decision.status === "denied"` — proven end-to-end at that layer
    // already (not re-proven here). This asserts the same decision object,
    // at the policy layer this package owns, for the real destructive
    // ability the S1 community-stack fixture exposes.
    const record: InstanceToolPolicyRecord = { ...base, mode: "restricted", allow: [readAllowed] };
    expect(evaluateInstanceToolPolicy(record, destructiveDenied)).toEqual({ status: "denied" });
  });
});

describe("isValidInstanceToolPolicyRecord", () => {
  it("accepts well-formed open/restricted records", () => {
    expect(isValidInstanceToolPolicyRecord({ ...base, mode: "open" })).toBe(true);
    expect(isValidInstanceToolPolicyRecord({ ...base, mode: "restricted", allow: [ref] })).toBe(true);
  });
  it("rejects unknown mode / malformed entries / null", () => {
    expect(isValidInstanceToolPolicyRecord(null)).toBe(false);
    expect(isValidInstanceToolPolicyRecord({ ...base, mode: "nope" } as unknown as InstanceToolPolicyRecord)).toBe(false);
    expect(
      isValidInstanceToolPolicyRecord({ ...base, mode: "open", allow: [{ name: "x" }] } as unknown as InstanceToolPolicyRecord),
    ).toBe(false);
  });
});
