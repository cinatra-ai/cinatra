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

// ---------------------------------------------------------------------------
// cinatra#1943 — REVERT-STYLE NEGATIVE CONTROL for manifest row 8
// ("Cross-job capability misuse").
//
// Lives HERE, beside its proof, rather than in the suite's shared no-DB
// control ledger (src/lib/__tests__/archive-acceptance-negative-controls.test.ts):
// naming `mintSystemAuthorityForJob` is restricted by the org-write kernel
// boundary gate's R5-job-system-mint rule to this directory. That is the
// correct home anyway — the control and the sweep it falsifies read together.
// See the ledger file's header for the red-then-green rule in full.
// ---------------------------------------------------------------------------


describe("row 8 negative control — the cross-job attack is stopped by the job's own two declarations, and lands once both are neutralized", () => {
  it("negative control (row 8): the SAME foreign job, purpose, org and payload MINTS real capabilities once its allowedPurposes AND capabilities declarations are both tampered — each check refuses on its own, neither is redundant", async () => {
    // PAIRS WITH: src/lib/org-write/__tests__/job-system-authority-mint-adversarial.test.ts
    //   "every real mintable job refuses every purpose NOT in its own declared allowedPurposes"
    //
    // The principal, the purpose, the org and the payload are held FIXED
    // across all three calls below — the only thing that changes is the job's
    // OWN authority declaration, which is precisely the guard. That is the
    // revert: the sweep's refusal is caused by those declarations, not by the
    // purpose being inert, retired, or unreachable for this job by some other
    // route. (Contrast a control that switched to the job which legitimately
    // owns the purpose: that changes the principal, so it shows the purpose is
    // alive but never shows the cross-job attack succeeding.)
    const ORG = "org-neg-ctrl-8";

    const PURPOSE = "lease-expiry-finalizer";
    // The capability that purpose actually grants — asserted at step 3 below,
    // and required ABSENT from the foreign job's ceiling so step 2 genuinely
    // refuses on the ceiling rather than passing through.
    const PURPOSE_GRANT = "run.lease-expire";

    // Select the foreign job by the EXACT properties this control needs, not
    // by registry order: a newly inserted first entry must not silently change
    // what is being tested (it would either mint at step 2 — because its
    // ceiling already covers the grant — or refuse for org-mismatch instead of
    // the ceiling, and the test would still be green while proving something
    // else). If no such job exists any more, this fails loudly and the pairing
    // gets re-derived deliberately.
    const foreign = MINTABLE_REAL_ENTRIES.find(
      ([, a]) =>
        !(a.allowedPurposes ?? []).includes(PURPOSE) &&
        !((a.capabilities ?? []) as readonly string[]).includes(PURPOSE_GRANT) &&
        a.orgExtractor?.source !== "payload",
    );
    expect(
      foreign,
      `expected a real mintable job that (a) does not declare "${PURPOSE}", (b) does not already ` +
        `hold "${PURPOSE_GRANT}" in its ceiling, and (c) is not payload-org-bound`,
    ).toBeDefined();
    const [foreignJobName, foreignAuthority] = foreign!;
    const payload = foreignAuthority.runExtractor ? { runId: "run-neg-ctrl-8" } : {};

    const mintUnder = (authority: JobAuthorityMetadata) =>
      Promise.resolve(
        runWithJobFrame(
          { jobName: foreignJobName, jobId: "neg-ctrl-8", authority, payload },
          () => {
            try {
              const minted = mintSystemAuthorityForJob(PURPOSE, ORG);
              return {
                minted: true as const,
                grants: ORG_WRITE_CAPABILITIES.filter((c) => minted.can(c)),
                orgId: minted.orgId,
              };
            } catch (err) {
              return { minted: false as const, error: err };
            }
          },
        ),
      );

    // 1. UNTAMPERED — the green sweep's own claim: refused by the
    //    allowedPurposes membership check.
    const untampered = await mintUnder(foreignAuthority);
    expect(untampered.minted).toBe(false);
    expect((untampered as { error: unknown }).error).toBeInstanceOf(OrgWriteAuthorityError);
    expect(String((untampered as { error: Error }).error.message)).toContain("allowedPurposes");

    // 2. MEMBERSHIP CHECK NEUTRALIZED (allowedPurposes tampered to include the
    //    foreign purpose) — STILL refused, now by the independent capability
    //    ceiling. Proves the two declarations are not one check spelled twice.
    const purposesTampered: JobAuthorityMetadata = Object.assign({}, foreignAuthority, {
      allowedPurposes: [...(foreignAuthority.allowedPurposes ?? []), PURPOSE],
    });
    const half = await mintUnder(purposesTampered);
    expect(half.minted).toBe(false);
    expect(String((half as { error: Error }).error.message)).toContain("ceiling");

    // 3. BOTH NEUTRALIZED — the attack LANDS. Same job, same purpose, same
    //    org, same payload: a cross-job mint that yields real, non-empty
    //    power. So the sweep in the green test is guarding something that
    //    genuinely works once the guard is gone.
    const bothTampered: JobAuthorityMetadata = Object.assign({}, purposesTampered, {
      capabilities: [...ORG_WRITE_CAPABILITIES],
    });
    const landed = await mintUnder(bothTampered);
    expect(landed.minted).toBe(true);
    expect((landed as { grants: string[] }).grants).toContain(PURPOSE_GRANT);
    expect((landed as { orgId: string }).orgId).toBe(ORG);
  });
});
