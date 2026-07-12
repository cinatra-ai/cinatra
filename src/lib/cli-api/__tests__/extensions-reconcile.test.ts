// HOST reconcile service (#1042 lever) — the plan/apply orchestration that
// drives the SAME auto-update cycle the daily loop drives, decoupling ONLY the
// scheduler (master flag + maintenance window). Fail-closed coverage per the
// CLI contract (cinatra-cli#127): a dry-run PLAN performs ZERO writes, an
// UNWIRED read model is an honest `unwired` reason (never a false "up to date"),
// a stale `--plan-digest` REFUSES apply before executing anything, per-candidate
// failures are isolated, a drift drop is an expected shrink (not a failure), and
// audit-write failures are non-fatal.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  planReconcile,
  applyReconcile,
  computePlanDigest,
  PlanDigestMismatchError,
  PLAN_DIGEST_MISMATCH_CODE,
  type ReconcilePlanCandidate,
} from "../extensions-reconcile";
import { EXTENSION_AUTO_UPDATE_ACTOR_ID } from "@/lib/extension-auto-update";
import type {
  AutoUpdateInstalledRow,
  ExtensionAutoUpdateDeps,
} from "@/lib/extension-auto-update";
import type { ExtensionUpdateEntry } from "@cinatra-ai/registries/src/update-read-model";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function makeRow(overrides: Partial<AutoUpdateInstalledRow> = {}): AutoUpdateInstalledRow {
  return {
    id: "row-1",
    packageName: "@acme/foo",
    kind: "connector",
    organizationId: null,
    status: "active",
    source: { type: "verdaccio", version: "1.0.0" },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ExtensionUpdateEntry> = {}): ExtensionUpdateEntry {
  return {
    packageName: "@acme/foo",
    latestVersion: "1.1.0",
    latestSdkAbiRange: "^2",
    refreshedAt: NOW.toISOString(), // fresh (within TTL)
    ...overrides,
  };
}

function makeStore(entries: ExtensionUpdateEntry[]) {
  const byName = new Map(entries.map((e) => [e.packageName, e]));
  return {
    read: async (names: string[]) => {
      const out = new Map<string, ExtensionUpdateEntry>();
      for (const n of names) {
        const e = byName.get(n);
        if (e) out.set(n, e);
      }
      return out;
    },
    upsert: async () => {},
  };
}

/**
 * A base deps set with a single updatable NULL-org verdaccio row. `isEnabled`
 * and `isWithinMaintenanceWindow` DEFAULT to false/false on purpose — reconcile
 * must override the scheduler gates, so the base saying "loop disabled / window
 * closed" proves the decoupling rather than hiding it.
 */
function makeBase(
  overrides: Partial<ExtensionAutoUpdateDeps> = {},
): ExtensionAutoUpdateDeps & {
  executeUpdate: ReturnType<typeof vi.fn>;
  writeAuditEvent: ReturnType<typeof vi.fn>;
} {
  const deps = {
    isEnabled: () => false, // scheduler flag OFF — reconcile overrides to ON
    isWithinMaintenanceWindow: () => false, // window CLOSED — reconcile overrides open
    isDenied: () => false,
    listInstalledRows: async () => [makeRow()],
    isRequiredInProd: () => false,
    resolveUpdateReadModelStore: async () => makeStore([makeEntry()]),
    evaluateAbiCompat: () => ({ compatible: true }),
    isSignatureReady: vi.fn(async () => true),
    executeUpdate: vi.fn(async () => {}),
    writeAuditEvent: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
  return deps as ReturnType<typeof makeBase>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planReconcile (dry run)", () => {
  it("selects candidates through the real gates and computes a stable candidate-only digest", async () => {
    const base = makeBase();
    const plan = await planReconcile(base);

    expect(plan.readModelStatus).toBe("wired");
    expect(plan.candidates).toEqual([
      { packageName: "@acme/foo", currentVersion: "1.0.0", targetVersion: "1.1.0" },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.fences).toEqual([]);
    expect(plan.generatedAt).toBe(NOW.toISOString());
    expect(plan.planDigest).toBe(computePlanDigest(plan.candidates));
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("performs ZERO writes — never executes and never writes a durable audit row", async () => {
    // The base executor/audit-writer would record if reached; the dry run must
    // substitute no-ops, so a candidate is still selected but NOTHING is written.
    const base = makeBase();
    const plan = await planReconcile(base);

    expect(plan.candidates).toHaveLength(1); // selection DID run
    expect(base.executeUpdate).not.toHaveBeenCalled();
    expect(base.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("read-model UNWIRED → honest `unwired` reason, never a false empty 'up to date' plan", async () => {
    const base = makeBase({ resolveUpdateReadModelStore: async () => null });
    const plan = await planReconcile(base);

    expect(plan.readModelStatus).toBe("unwired");
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([
      { packageName: "@acme/foo", reason: "read-model-unwired" },
    ]);
    // The empty-candidate digest is still well-formed (an unwired plan is NOT a
    // digest error — apply against it simply has nothing to do).
    expect(plan.planDigest).toBe(computePlanDigest([]));
  });

  it("is DECOUPLED from the scheduler — runs even with the master flag off AND the window closed", async () => {
    // makeBase already forces isEnabled=false + isWithinMaintenanceWindow=false.
    const base = makeBase();
    const plan = await planReconcile(base);
    expect(plan.candidates).toHaveLength(1);
  });

  it("fleet signature-readiness NOT-READY → an instance-wide fence + zero candidates", async () => {
    const base = makeBase({ isSignatureReady: vi.fn(async () => false) });
    const plan = await planReconcile(base);

    expect(plan.candidates).toEqual([]);
    expect(plan.fences).toEqual([
      { fence: "signature-readiness", detail: expect.any(String) },
    ]);
    expect(plan.skipped).toEqual([
      { packageName: "@acme/foo", reason: "signature-readiness" },
    ]);
  });

  it("surfaces per-package selection skips verbatim (deny list)", async () => {
    const base = makeBase({ isDenied: (name) => name === "@acme/foo" });
    const plan = await planReconcile(base);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([{ packageName: "@acme/foo", reason: "deny-listed" }]);
  });
});

describe("applyReconcile", () => {
  it("executes the candidate set and records the initiating operator + system executor", async () => {
    const base = makeBase();
    const result = await applyReconcile({ initiatingOperator: "admin-1" }, base);

    expect(result.applied).toEqual([
      { packageName: "@acme/foo", fromVersion: "1.0.0", toVersion: "1.1.0" },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.droppedByRecheck).toEqual([]);
    expect(result.initiatingOperator).toBe("admin-1");
    expect(result.systemExecutor).toBe(EXTENSION_AUTO_UPDATE_ACTOR_ID);
    expect(base.executeUpdate).toHaveBeenCalledTimes(1);
    expect(base.executeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@acme/foo",
        toVersion: "1.1.0",
        fromVersion: "1.0.0",
      }),
      expect.anything(),
    );
  });

  it("REFUSES on a stale --plan-digest and executes NOTHING (fail-closed CAS)", async () => {
    const base = makeBase();
    await expect(
      applyReconcile(
        { expectedDigest: "sha256:stale", initiatingOperator: "admin-1" },
        base,
      ),
    ).rejects.toBeInstanceOf(PlanDigestMismatchError);
    expect(base.executeUpdate).not.toHaveBeenCalled();
  });

  it("the refusal carries the stable `plan-digest-mismatch` code the CLI keys on", async () => {
    const base = makeBase();
    const err = await applyReconcile(
      { expectedDigest: "sha256:stale", initiatingOperator: "admin-1" },
      base,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanDigestMismatchError);
    expect((err as PlanDigestMismatchError).code).toBe(PLAN_DIGEST_MISMATCH_CODE);
  });

  it("a MATCHING --plan-digest proceeds to execution", async () => {
    const base = makeBase();
    const digest = (await planReconcile(base)).planDigest;
    const result = await applyReconcile(
      { expectedDigest: digest, initiatingOperator: "admin-1" },
      base,
    );
    expect(result.planDigest).toBe(digest);
    expect(result.applied).toHaveLength(1);
    expect(base.executeUpdate).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-candidate failure → `failed`, not a thrown apply", async () => {
    const base = makeBase({
      executeUpdate: vi.fn(async () => {
        throw new Error("registry exploded");
      }),
    });
    const result = await applyReconcile({ initiatingOperator: "admin-1" }, base);
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([
      { packageName: "@acme/foo", reason: "update-failed", detail: "registry exploded" },
    ]);
    expect(result.droppedByRecheck).toEqual([]);
  });

  it("a CAS-version-lost drop is `droppedByRecheck` (expected shrink), not a failure", async () => {
    const base = makeBase({
      executeUpdate: vi.fn(async () => {
        throw Object.assign(new Error("cas lost"), { code: "EXPECTED_VERSION_MISMATCH" });
      }),
    });
    const result = await applyReconcile({ initiatingOperator: "admin-1" }, base);
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.droppedByRecheck).toEqual([
      { packageName: "@acme/foo", reason: "cas-version-lost" },
    ]);
  });

  it("audit-write failures are NON-FATAL and counted (the update still applied)", async () => {
    const base = makeBase({
      writeAuditEvent: vi.fn(async () => {
        throw new Error("audit sink down");
      }),
    });
    const result = await applyReconcile({ initiatingOperator: "admin-1" }, base);
    expect(result.applied).toHaveLength(1); // outcome unaffected
    expect(result.auditWriteFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("computePlanDigest", () => {
  const a: ReconcilePlanCandidate = {
    packageName: "@a/one",
    currentVersion: "1.0.0",
    targetVersion: "2.0.0",
  };
  const b: ReconcilePlanCandidate = {
    packageName: "@b/two",
    currentVersion: "3.0.0",
    targetVersion: "3.1.0",
  };

  it("is order-independent (candidate set identity, not array order)", () => {
    expect(computePlanDigest([a, b])).toBe(computePlanDigest([b, a]));
  });

  it("changes when a target version changes (CAS pins the exact set)", () => {
    expect(computePlanDigest([a])).not.toBe(
      computePlanDigest([{ ...a, targetVersion: "2.1.0" }]),
    );
  });

  it("the empty set has a stable digest", () => {
    expect(computePlanDigest([])).toBe(computePlanDigest([]));
  });
});
