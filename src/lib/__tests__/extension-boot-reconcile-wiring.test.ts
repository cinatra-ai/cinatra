// The boot pass that actually runs stranded-install reconciliation.
//
// The pure reconciler is covered elsewhere. What these pin is the WIRING: that a
// real boot selects the right candidates, runs them, and reports; that a package
// the loaders already brought up is never touched; and that the five outcome
// classes the recovery policy distinguishes reach the right end state.
//
// The seam is the production entry point `reconcileStrandedInstallsAtBoot`,
// exercised with an injected dependency set so the store, the activator and the
// lifecycle primitive are observable. The candidate SELECTION, which is the part
// the wiring owns, runs for real against the injected store.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  BootReconcileDeps,
  ReconcilableRow,
} from "@/lib/extension-boot-reconcile";
import { classifyActivationFailure } from "@/lib/extension-activation-failure-class";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const OTHER = "@cinatra-ai/some-other-connector";

/** Rows the injected canonical store returns. */
let storeRows: ReconcilableRow[] = [];
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: async () => storeRows,
  readInstalledExtensionsByPackageName: async (p: string) =>
    storeRows.filter((r) => r.packageName === p),
}));

const row = (over: Partial<ReconcilableRow> & { id: string }): ReconcilableRow => ({
  packageName: PKG,
  organizationId: "org-1",
  ownerLevel: "organization",
  status: "active",
  isDefault: true,
  source: { type: "verdaccio" },
  ...over,
});
const bundledRow = (over: Partial<ReconcilableRow> = {}): ReconcilableRow =>
  row({ id: "plat", organizationId: null, ownerLevel: "platform", source: { type: "bundled" }, ...over });

function makeDeps(over: Partial<BootReconcileDeps> = {}) {
  const calls = {
    activated: [] as string[],
    archived: [] as string[],
    restored: [] as string[],
    recorded: [] as unknown[],
    audit: [] as { outcome: string; failureClass: string }[],
  };
  const deps: BootReconcileDeps = {
    readRows: async (p) => storeRows.filter((r) => r.packageName === p),
    isServing: () => false,
    activateOverride: async (r) => {
      calls.activated.push(r.id);
      return { ok: false, reason: "signature required" };
    },
    restoreBundled: async (p) => {
      calls.restored.push(p);
      return { ok: true };
    },
    archiveRow: async (id) => {
      calls.archived.push(id);
    },
    recordActivationFailure: async (i) => {
      calls.recorded.push(i);
    },
    emitAuditEvent: (i) => {
      calls.audit.push({ outcome: i.outcome, failureClass: i.failureClass });
    },
    withInstallLock: async (_p, fn) => fn(),
    classifyFailure: classifyActivationFailure,
    ...over,
  };
  return { deps, calls };
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  storeRows = [];
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  infoSpy.mockRestore();
  errSpy.mockRestore();
});

describe("reconcileStrandedInstallsAtBoot: candidate selection", () => {
  it("considers a live product install the loaders did NOT bring up", async () => {
    storeRows = [bundledRow(), row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.considered).toBe(1);
    expect(calls.activated).toEqual(["org"]);
  });

  it("NEVER touches a package the loaders already activated", async () => {
    storeRows = [row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set([PKG]), deps);
    expect(sweep.considered).toBe(0);
    expect(calls.activated).toEqual([]);
  });

  it("ignores a bundled-only package: there is no override to recover", async () => {
    storeRows = [bundledRow()];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    expect((await reconcileStrandedInstallsAtBoot(new Set(), deps)).considered).toBe(0);
    expect(calls.activated).toEqual([]);
  });

  it("ignores an archived row and a non-default sibling", async () => {
    storeRows = [
      row({ id: "arch", status: "archived" }),
      row({ id: "sibling", isDefault: false }),
    ];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps } = makeDeps();
    expect((await reconcileStrandedInstallsAtBoot(new Set(), deps)).considered).toBe(0);
  });

  it("sweeps several packages in one pass", async () => {
    storeRows = [row({ id: "a" }), row({ id: "b", packageName: OTHER })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.considered).toBe(2);
    expect(calls.activated.sort()).toEqual(["a", "b"]);
  });

  it("a reconciliation that THROWS never aborts the sweep", async () => {
    storeRows = [row({ id: "a" }), row({ id: "b", packageName: OTHER })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps } = makeDeps({
      activateOverride: async (r) => {
        if (r.id === "a") throw new Error("activator exploded");
        return { ok: false, reason: "signature required" };
      },
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    // Both were considered; the survivor still produced an outcome.
    expect(sweep.considered).toBe(2);
    expect(sweep.outcomes.map((o) => o.packageName)).toEqual([OTHER]);
  });
});

describe("reconcileStrandedInstallsAtBoot: the five outcome classes", () => {
  it("CONFIG class: retryable, never archived, reason recorded", async () => {
    storeRows = [bundledRow(), row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps({
      activateOverride: async () => ({ ok: false, reason: "signature required" }),
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.outcomes[0]).toMatchObject({ kind: "retryable", failureClass: "config" });
    expect(calls.archived, "a host setting must never destroy an install").toEqual([]);
    expect(calls.restored).toEqual([PKG]);
    expect(calls.recorded[0]).toMatchObject({ failureClass: "config" });
  });

  it("BYTE class: archived canonically, bundled restored", async () => {
    storeRows = [bundledRow(), row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps({
      activateOverride: async () => ({ ok: false, reason: "tarball integrity not verified" }),
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.outcomes[0]).toMatchObject({ kind: "archived", failureClass: "byte" });
    expect(calls.archived).toEqual(["org"]);
    expect(calls.restored).toEqual([PKG]);
  });

  it("UNKNOWN reason falls to the non-destructive side", async () => {
    storeRows = [row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps({
      activateOverride: async () => ({ ok: false, reason: "something nobody has seen" }),
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.outcomes[0]).toMatchObject({ kind: "retryable", failureClass: "config" });
    expect(calls.archived).toEqual([]);
  });

  it("LOCKED org row beside a workspace row: the workspace row is reconciled", async () => {
    // Supersession leaves the locked org row live. The sweep must act on the row
    // in force, not read the pair as two competing installs and skip.
    storeRows = [
      row({ id: "org-locked", status: "locked" }),
      row({ id: "ws", organizationId: null, ownerLevel: "workspace" }),
    ];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps({
      activateOverride: async (r) => {
        calls.activated.push(r.id);
        return { ok: true };
      },
      isServing: () => false,
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(calls.activated).toEqual(["ws"]);
    // isServing stays false, so the attempt is not credited as recovery.
    expect(sweep.outcomes[0]?.kind).not.toBe("skipped");
  });

  it("TWO competing org overrides: refuses to choose, touches nothing", async () => {
    storeRows = [
      row({ id: "org-a" }),
      row({ id: "org-b", organizationId: "org-2" }),
    ];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.outcomes[0]?.kind).toBe("skipped");
    expect(calls.activated).toEqual([]);
    expect(calls.archived).toEqual([]);
  });

  it("a recovered package is reported as activated", async () => {
    storeRows = [row({ id: "org" })];
    let serving = false;
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps } = makeDeps({
      isServing: () => serving,
      activateOverride: async () => {
        serving = true;
        return { ok: true };
      },
    });
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.outcomes[0]).toEqual({ kind: "activated", packageName: PKG });
  });
});

// ---------------------------------------------------------------------------
// METADATA-ONLY KINDS ARE NOT STRANDED (cinatra#2762 round-2 item 1).
//
// `activatedThisBoot` is built from the loaders' ActivationResults. A skill,
// agent or artifact NEVER enters it: it ships no server module, so
// `sdk-extensions/activate.ts` returns `skipped/no-server-entry` on a perfectly
// HEALTHY install, and the artifact bridge rescan that does project artifacts
// runs in a LATER boot phase than this one. Absence from the set therefore says
// nothing about these kinds — and reading it as evidence reconciled every
// healthy metadata-only install on EVERY boot: an activation attempt, an audit
// INSERT and an `[operational-event]` error per package per restart.
// ---------------------------------------------------------------------------
describe("reconcileStrandedInstallsAtBoot: metadata-only kinds are excluded BY KIND", () => {
  for (const kind of ["skill", "agent", "artifact"] as const) {
    it(`a healthy ${kind} install is never a candidate`, async () => {
      storeRows = [row({ id: "org", kind })];
      const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
      const { deps, calls } = makeDeps();
      const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
      expect(sweep).toEqual({ considered: 0, outcomes: [] });
      // No attempt, no archive, no audit row, no operational-event error.
      expect(calls.activated).toEqual([]);
      expect(calls.archived).toEqual([]);
      expect(calls.recorded).toEqual([]);
      expect(calls.audit).toEqual([]);
    });
  }

  it("a connector IS still a candidate — the exclusion is by kind, not a blanket mute", async () => {
    storeRows = [row({ id: "org", kind: "connector" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.considered).toBe(1);
    expect(calls.activated).toEqual(["org"]);
  });

  it("a row with NO kind recorded keeps the previous behaviour", async () => {
    storeRows = [row({ id: "org" })];
    const { reconcileStrandedInstallsAtBoot } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const sweep = await reconcileStrandedInstallsAtBoot(new Set(), deps);
    expect(sweep.considered).toBe(1);
    expect(calls.activated).toEqual(["org"]);
  });

  it("the reconciler ITSELF also refuses a metadata-only row it is handed directly", async () => {
    // Defense in depth: the sweep filters the rows `listInstalledExtensions`
    // returned; this is the row a fresh read under the lock produced.
    storeRows = [row({ id: "org", kind: "skill" })];
    const { reconcileStrandedInstall } = await import("@/lib/extension-boot-reconcile");
    const { deps, calls } = makeDeps();
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toMatchObject({ kind: "skipped" });
    expect(calls.activated).toEqual([]);
  });

  it("the failure-class regex is NOT the fix: 'no server entry' still classifies as byte", async () => {
    // Widening `/no server entry/i` to match the loader's `no-server-entry` skip
    // would have silenced the same log line by declaring healthy installs
    // BYTE-class — which archives them. The regex must stay exactly as it was.
    expect(classifyActivationFailure("registered:no server entry")).toBe("byte");
    expect(classifyActivationFailure("skipped:no-server-entry")).not.toBe("byte");
  });
});

// ---------------------------------------------------------------------------
// THE SWEEP'S RESULTS REACH THE REQUIRED-ACTIVATION ASSERT (round-2 item 2).
//
// The phase runs this pass before `assertRequiredExtensionActivations` precisely
// so a package it recovers "counts as present" — but it pushed NOTHING into the
// array that assert reads, so a REQUIRED package reconciliation had just
// activated was still reported `missing` and a production boot aborted on its
// own successful recovery.
// ---------------------------------------------------------------------------
describe("activationResultsFromReconcileSweep", () => {
  const sweepOf = (...outcomes: unknown[]) =>
    ({ considered: outcomes.length, outcomes } as never);

  it("an ACTIVATED package becomes a registered result", async () => {
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    expect(
      activationResultsFromReconcileSweep(sweepOf({ kind: "activated", packageName: PKG })),
    ).toEqual([{ packageName: PKG, status: "registered" }]);
  });

  it("a recovered REQUIRED package no longer fails the real assert", async () => {
    // The end-to-end point of the fix, through the real cross-check.
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    const { findRequiredActivationFailures } = await import(
      "@/lib/required-extension-activation"
    );
    const results = activationResultsFromReconcileSweep(
      sweepOf({ kind: "activated", packageName: PKG }),
    );
    expect(findRequiredActivationFailures(results, [PKG], new Set([PKG]))).toEqual([]);
    // Without the results the SAME required package is reported missing.
    expect(findRequiredActivationFailures([], [PKG], new Set([PKG]))).toEqual([
      { packageName: PKG, status: "missing" },
    ]);
  });

  it("a failed override whose BUNDLE was restored counts as present: it IS serving", async () => {
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    const { findRequiredActivationFailures } = await import(
      "@/lib/required-extension-activation"
    );
    for (const kind of ["retryable", "archived"] as const) {
      const results = activationResultsFromReconcileSweep(
        sweepOf({
          kind,
          packageName: PKG,
          rowId: "org",
          reason: "signature required",
          failureClass: kind === "retryable" ? "config" : "byte",
          bundledRestored: true,
        }),
      );
      expect(results[0].status).toBe("registered");
      // The reason is still carried, so nobody reads this as a clean activation.
      expect(String(results[0].error)).toContain("bundled in the image is serving");
      expect(findRequiredActivationFailures(results, [PKG], new Set([PKG]))).toEqual([]);
    }
  });

  it("NOTHING serving still FAILS the assert — now with this pass's diagnosis", async () => {
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    const { findRequiredActivationFailures } = await import(
      "@/lib/required-extension-activation"
    );
    const results = activationResultsFromReconcileSweep(
      sweepOf({
        kind: "archived",
        packageName: PKG,
        rowId: "org",
        reason: "integrity mismatch",
        failureClass: "byte",
        bundledRestored: false,
      }),
      );
    expect(results[0].status).toBe("failed");
    expect(String(results[0].error)).toContain("integrity mismatch");
    expect(findRequiredActivationFailures(results, [PKG], new Set([PKG]))).toHaveLength(1);
  });

  it("recovery-required fails the assert too", async () => {
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    const results = activationResultsFromReconcileSweep(
      sweepOf({ kind: "recovery-required", packageName: PKG, rowId: "org", reason: "archive failed" }),
    );
    expect(results[0].status).toBe("failed");
  });

  it("a SKIPPED package contributes nothing: this pass did not act", async () => {
    const { activationResultsFromReconcileSweep } = await import(
      "@/lib/extension-boot-reconcile"
    );
    expect(
      activationResultsFromReconcileSweep(
        sweepOf({ kind: "skipped", packageName: PKG, reason: "already serving" }),
      ),
    ).toEqual([]);
  });
});
