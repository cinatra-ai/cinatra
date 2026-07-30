/**
 * cinatra#1943 A1 — adversarial extension of #1941 S2's own
 * job-system-authority-mint.test.ts (manifest row 8: "cross-job capability
 * misuse"). That suite proves the seam's mechanism against SYNTHETIC,
 * single-example fixtures (one mintableMaintenance() shape per case). This
 * file proves the SAME two independent checks — purpose ∈ allowedPurposes,
 * and a purpose's grants ⊆ the job's declared capabilities ceiling — hold
 * against the REAL production registry, exhaustively and under runtime
 * tamper, so a future registry entry that mis-declares its own ceiling (or an
 * attacker who can mutate a live entry post-hoc) is still caught:
 *
 *   1. Table-driven real-registry sweep: every REAL mintable job entry
 *      refuses every purpose NOT in its own declared allowedPurposes.
 *   2. Table-driven real-registry ceiling check: every REAL mintable job
 *      entry's OWN allowed purposes mint grants that are a subset of its own
 *      declared capabilities (the independent check #2199's synthetic tests
 *      exercise one example of; here it is a total sweep of what is ACTUALLY
 *      registered today).
 *   3. Runtime-tamper compound attack: a REAL job's authority object,
 *      Object.assign-injected with a purpose belonging to a DIFFERENT real
 *      job (satisfying allowedPurposes membership by tamper) still refuses
 *      because the capability-ceiling check is independent and re-derived
 *      from the (tampered) object's OWN capabilities field.
 *   4. Runtime-tamper org-binding attack: a REAL row-sweep job's authority
 *      object, Object.assign-mutated to claim a payload-bound org extractor,
 *      still refuses a mismatched orgId — the org-hopping defense holds even
 *      when exercised against a real (not synthetic) authority shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: logAuditEventMock,
}));

import { ORG_WRITE_CAPABILITIES } from "@cinatra-ai/org-write-kernel";
import type { OrgWriteCapability } from "@cinatra-ai/org-write-kernel";
import { runWithJobFrame } from "@/lib/background-jobs-system-frame";
import { mintSystemAuthorityForJob } from "../job-system-authority-mint";
import { OrgWriteAuthorityError } from "../authority";
import { BACKGROUND_JOB_REGISTRY } from "@/lib/background-jobs-registry";
import { BACKGROUND_JOB_NAMES } from "@/lib/background-jobs-names";
import type { JobAuthorityMetadata } from "@/lib/background-jobs-registry";

// The full universe of purposes the kernel-authority mint understands today
// (src/lib/org-write/authority.ts's SYSTEM_PURPOSE_CAPABILITIES — module-
// private by design, so this list is hand-mirrored, same convention #2199's
// own test file already uses for its individual purpose string literals). A
// future purpose added there without a matching update here would simply be
// excluded from this sweep, never silently miscounted.
const ALL_SYSTEM_PURPOSES = [
  "org-lifecycle-transition",
  "lease-expiry-finalizer",
  "agent-run-dispatch",
  "extension-dashboard-lifecycle",
  "dashboard-contribution-reconciler",
  "dashboard-twin-backfill",
] as const;

const ORG = "org-adv-1";

function runFrame<T>(jobName: string, authority: JobAuthorityMetadata, payload: unknown, fn: () => T): Promise<T> {
  return Promise.resolve(runWithJobFrame({ jobName, jobId: "job-adv-1", authority, payload }, fn));
}

beforeEach(() => {
  logAuditEventMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every REAL registry entry whose authorityKind can mint (system-maintenance
 *  mintable arm, or grandfathered-run) AND declares a non-empty
 *  allowedPurposes — the exact universe `mintSystemAuthorityForJob` can ever
 *  be legitimately called for in production today. */
const MINTABLE_REAL_ENTRIES: ReadonlyArray<[string, JobAuthorityMetadata]> = Object.entries(
  BACKGROUND_JOB_REGISTRY,
)
  .filter(([, handler]) => {
    const a = handler.authority;
    return (
      (a.authorityKind === "system-maintenance" || a.authorityKind === "grandfathered-run") &&
      Array.isArray(a.allowedPurposes) &&
      a.allowedPurposes.length > 0
    );
  })
  .map(([name, handler]) => [name, handler.authority] as [string, JobAuthorityMetadata]);

describe("real-registry table-driven sweep (cinatra#1943 A1, row 8)", () => {
  it("sanity: at least one real mintable job entry exists to sweep (never a vacuously-empty table)", () => {
    expect(MINTABLE_REAL_ENTRIES.length).toBeGreaterThan(0);
  });

  it("every real mintable job refuses every purpose NOT in its own declared allowedPurposes", async () => {
    for (const [jobName, authority] of MINTABLE_REAL_ENTRIES) {
      const allowed = new Set(authority.allowedPurposes ?? []);
      const payload = jobName === BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE || authority.runExtractor
        ? { runId: "run-adv-1" }
        : {};
      for (const purpose of ALL_SYSTEM_PURPOSES) {
        if (allowed.has(purpose)) continue;
        await runFrame(jobName, authority, payload, () => {
          expect(() => mintSystemAuthorityForJob(purpose, ORG)).toThrow(OrgWriteAuthorityError);
        });
      }
    }
  });

  it("every real mintable job's OWN allowed purposes mint grants that are a subset of its own declared capabilities ceiling", async () => {
    for (const [jobName, authority] of MINTABLE_REAL_ENTRIES) {
      const payload = jobName === BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE || authority.runExtractor
        ? { runId: "run-adv-1" }
        : {};
      // Payload-bound jobs need their org field present and matching, or the
      // seam refuses on org-mismatch before the ceiling check ever runs —
      // orthogonal to what this test proves, so satisfy it generically.
      const orgExtractor = authority.orgExtractor;
      const fullPayload =
        orgExtractor?.source === "payload"
          ? { ...payload, [orgExtractor.field]: ORG }
          : payload;
      for (const purpose of authority.allowedPurposes ?? []) {
        await runFrame(jobName, authority, fullPayload, () => {
          const minted = mintSystemAuthorityForJob(purpose, ORG);
          for (const cap of ORG_WRITE_CAPABILITIES) {
            if (minted.can(cap)) {
              expect(authority.capabilities as readonly OrgWriteCapability[]).toContain(cap);
            }
          }
        });
      }
    }
  });
});

describe("runtime-tamper compound attack on a REAL entry (cinatra#1943 A1)", () => {
  it("injecting a DIFFERENT real job's purpose into a real entry's allowedPurposes is still refused by the independent capability-ceiling check", async () => {
    const real = BACKGROUND_JOB_REGISTRY[BACKGROUND_JOB_NAMES.ARTIFACT_REVIEW_RESUME_DELIVERY].authority;
    expect(real.capabilities).toEqual(["run.execute", "run.complete"]);
    expect(real.allowedPurposes).toEqual(["agent-run-dispatch"]);
    // Tamper: grant membership for "lease-expiry-finalizer" (a DIFFERENT real
    // job's exclusive purpose, granting run.lease-expire — not in this job's
    // real capabilities ceiling) without touching capabilities.
    const tampered = {
      ...real,
      allowedPurposes: [...(real.allowedPurposes ?? []), "lease-expiry-finalizer"],
    } as unknown as JobAuthorityMetadata;

    await runFrame(
      BACKGROUND_JOB_NAMES.ARTIFACT_REVIEW_RESUME_DELIVERY,
      tampered,
      { runId: "run-adv-2" },
      () => {
        expect(() => mintSystemAuthorityForJob("lease-expiry-finalizer", ORG)).toThrow(
          OrgWriteAuthorityError,
        );
      },
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({ purpose: "lease-expiry-finalizer" }),
      }),
    );
  });

  it("the SAME tampered frame still mints normally for its own real, untampered purpose (the attack is scoped, not a global break)", async () => {
    const real = BACKGROUND_JOB_REGISTRY[BACKGROUND_JOB_NAMES.ARTIFACT_REVIEW_RESUME_DELIVERY].authority;
    const tampered = {
      ...real,
      allowedPurposes: [...(real.allowedPurposes ?? []), "lease-expiry-finalizer"],
    } as unknown as JobAuthorityMetadata;

    await runFrame(
      BACKGROUND_JOB_NAMES.ARTIFACT_REVIEW_RESUME_DELIVERY,
      tampered,
      { runId: "run-adv-3" },
      () => {
        const minted = mintSystemAuthorityForJob("agent-run-dispatch", ORG);
        expect(minted.can("run.execute")).toBe(true);
        expect(minted.can("run.complete")).toBe(true);
        expect(minted.can("run.lease-expire")).toBe(false);
      },
    );
  });
});

describe("runtime-tamper org-binding attack on a REAL row-sweep entry (cinatra#1943 A1)", () => {
  it("a real row-sweep job's authority, mutated to claim a payload-bound org extractor, still refuses a mismatched orgId", async () => {
    const real = BACKGROUND_JOB_REGISTRY[BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE].authority;
    expect(real.orgExtractor?.source).toBe("row-sweep");
    const tampered = {
      ...real,
      orgExtractor: { source: "payload", field: "orgId" },
    } as unknown as JobAuthorityMetadata;

    await runFrame(
      BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE,
      tampered,
      { orgId: "org-different" },
      () => {
        expect(() => mintSystemAuthorityForJob("lease-expiry-finalizer", ORG)).toThrow(
          OrgWriteAuthorityError,
        );
      },
    );
  });

  it("the same tampered frame mints when the injected payload org field happens to match — proves the check isn't vacuously refusing everything", async () => {
    const real = BACKGROUND_JOB_REGISTRY[BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE].authority;
    const tampered = {
      ...real,
      orgExtractor: { source: "payload", field: "orgId" },
    } as unknown as JobAuthorityMetadata;

    await runFrame(
      BACKGROUND_JOB_NAMES.LEASE_EXPIRY_FINALIZE,
      tampered,
      { orgId: ORG },
      () => {
        const minted = mintSystemAuthorityForJob("lease-expiry-finalizer", ORG);
        expect(minted.can("run.lease-expire")).toBe(true);
      },
    );
  });
});
