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
