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
  it("absent record → OPEN (allow) + warn-once signal (compatibility fallback ONLY)", () => {
    expect(evaluateInstanceToolPolicy(null, ref)).toEqual({ status: "allowed", warn: "absent_policy_fallback_open" });
    expect(evaluateInstanceToolPolicy(undefined, ref)).toEqual({ status: "allowed", warn: "absent_policy_fallback_open" });
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
