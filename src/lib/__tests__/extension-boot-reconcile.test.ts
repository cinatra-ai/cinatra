// Boot reconciliation + the activation-failure class: the recovery acceptance
// items.
//
// Reconciliation exists for rows stranded BEFORE the install pipeline learned to
// refuse them. Two properties matter more than anything else here:
//
//   1. success is REGISTRATION, not trust. Trust only admits an import, so a
//      package that passed the classifier and then registered nothing has not
//      been recovered and the bundled implementation must be serving.
//   2. a CONFIG-class failure is never durably archived. Trust can fail because
//      of mutable host settings, and destroying an operator's install over a
//      setting they are about to change is not an acceptable outcome.
import { describe, it, expect, vi } from "vitest";
import {
  classifyActivationFailure,
  mayDurablyArchiveOnBoot,
} from "@/lib/extension-activation-failure-class";
import {
  reconcileStrandedInstall,
  type BootReconcileDeps,
  type ReconcilableRow,
} from "@/lib/extension-boot-reconcile";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

const bundledRow: ReconcilableRow = {
  id: "plat",
  packageName: PKG,
  organizationId: null,
  status: "active",
  source: { type: "bundled" },
};
const overrideRow: ReconcilableRow = {
  id: "org",
  packageName: PKG,
  organizationId: "org-1",
  status: "active",
  source: { type: "verdaccio" },
};

function makeDeps(over: Partial<BootReconcileDeps> = {}) {
  const archived: string[] = [];
  const recorded: unknown[] = [];
  const audit: unknown[] = [];
  const restored: string[] = [];
  const deps: BootReconcileDeps = {
    readRows: async () => [bundledRow, overrideRow],
    isServing: () => false,
    activateOverride: async () => ({ ok: false, reason: "signature required" }),
    restoreBundled: async (p) => {
      restored.push(p);
      return { ok: true };
    },
    archiveRow: async (id) => {
      archived.push(id);
    },
    recordActivationFailure: async (i) => {
      recorded.push(i);
    },
    emitAuditEvent: (i) => {
      audit.push(i);
    },
    withInstallLock: async (_p, fn) => fn(),
    classifyFailure: classifyActivationFailure,
    ...over,
  };
  return { deps, archived, recorded, audit, restored };
}

describe("classifyActivationFailure", () => {
  it("mutable HOST CONFIGURATION is config class", () => {
    for (const reason of [
      "signature required (no verified signature, and marketplace-bootstrap trust is disabled)",
      "registry example.test is not a trusted activation host (none configured)",
      "no persisted host trust decision",
      "ExtensionSignatureBackfill: skipped (no-trusted-keys)",
    ]) {
      expect(classifyActivationFailure(reason)).toBe("config");
      expect(mayDurablyArchiveOnBoot(reason)).toBe(false);
    }
  });

  it("the BYTES being wrong is byte class", () => {
    for (const reason of [
      "tarball integrity not verified",
      "package signature did not verify",
      "declared digest does not match the store dir digest",
      "register() threw",
      "the module could not be imported",
      "sdk abi range not satisfied",
    ]) {
      expect(classifyActivationFailure(reason)).toBe("byte");
      expect(mayDurablyArchiveOnBoot(reason)).toBe(true);
    }
  });

  it("a PRESENT-but-invalid signature is byte class, an ABSENT one is config class", () => {
    // The distinction the owner ruling calls out: these are different verdicts
    // and only one of them means the bytes are wrong.
    expect(classifyActivationFailure("package signature did not verify")).toBe("byte");
    expect(classifyActivationFailure("signature required")).toBe("config");
  });

  it("a compound reason naming a real byte problem is NOT softened to config", () => {
    expect(
      classifyActivationFailure(
        "not a trusted activation host, and the tarball integrity did not verify",
      ),
    ).toBe("byte");
  });

  it("an unrecognized reason fails to the NON-destructive side", () => {
    expect(classifyActivationFailure("something nobody has seen before")).toBe("config");
    expect(mayDurablyArchiveOnBoot("")).toBe(false);
  });
});

describe("reconcileStrandedInstall", () => {
  it("a stranded row that activates AND registers is recovered", async () => {
    let serving = false;
    const { deps, archived } = makeDeps({
      isServing: () => serving,
      activateOverride: async () => {
        serving = true;
        return { ok: true };
      },
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toEqual({ kind: "activated", packageName: PKG });
    expect(archived).toEqual([]);
  });

  it("TRUST IS NOT SUCCESS: an activation that registers nothing is not recovered", async () => {
    // The package passed every gate and reported success, but the registry says
    // it is serving nothing. That is a failure, and the bundle must come back.
    const { deps, restored } = makeDeps({
      isServing: () => false,
      activateOverride: async () => ({ ok: true }),
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out.kind).not.toBe("activated");
    expect(restored).toEqual([PKG]);
  });

  it("CONFIG-class failure stays retryable and is NEVER durably archived", async () => {
    const { deps, archived, recorded, audit, restored } = makeDeps({
      activateOverride: async () => ({
        ok: false,
        reason: "signature required (no verified signature, and marketplace-bootstrap trust is disabled)",
      }),
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toMatchObject({ kind: "retryable", rowId: "org", failureClass: "config" });
    // The install survives: an operator configures the signing key and retries.
    expect(archived).toEqual([]);
    // The precise reason is recorded, not a generic summary.
    expect(recorded[0]).toMatchObject({
      rowId: "org",
      failureClass: "config",
      reason: expect.stringContaining("signature required"),
    });
    expect(audit).toHaveLength(1);
    // The bundled implementation is serving in the meantime.
    expect(restored).toEqual([PKG]);
  });

  it("BYTE-class failure archives canonically, and the store bytes are untouched", async () => {
    const { deps, archived, recorded, restored } = makeDeps({
      activateOverride: async () => ({ ok: false, reason: "tarball integrity not verified" }),
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toMatchObject({ kind: "archived", rowId: "org", failureClass: "byte" });
    expect(archived).toEqual(["org"]);
    expect(recorded[0]).toMatchObject({ failureClass: "byte" });
    expect(restored).toEqual([PKG]);
    // Nothing in the dep surface deletes bytes: archiving is the only durable
    // write, and it is the restorable lifecycle primitive.
    expect(Object.keys(deps)).not.toContain("deleteStoreDir");
  });

  it("a failed archive is reported as recovery-required, never swallowed", async () => {
    const { deps, audit } = makeDeps({
      activateOverride: async () => ({ ok: false, reason: "tarball integrity not verified" }),
      archiveRow: async () => {
        throw new Error("lifecycle refused");
      },
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toMatchObject({ kind: "recovery-required", rowId: "org" });
    expect(out.kind === "recovery-required" && out.reason).toContain("lifecycle refused");
    expect(audit[0]).toMatchObject({ outcome: "recovery-required" });
  });

  it("IDEMPOTENT: a package already serving is skipped and nothing is touched", async () => {
    const activate = vi.fn();
    const { deps, archived } = makeDeps({
      isServing: () => true,
      activateOverride: activate as never,
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out).toMatchObject({ kind: "skipped" });
    expect(activate).not.toHaveBeenCalled();
    expect(archived).toEqual([]);
  });

  it("REFUSES to choose between two live marketplace installs", async () => {
    const activate = vi.fn();
    const { deps } = makeDeps({
      readRows: async () => [
        bundledRow,
        overrideRow,
        { ...overrideRow, id: "org-b", organizationId: "org-2" },
      ],
      activateOverride: activate as never,
    });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out.kind).toBe("skipped");
    expect(out.kind === "skipped" && out.reason).toContain("more than one");
    expect(activate).not.toHaveBeenCalled();
  });

  it("does nothing for a package with no marketplace override", async () => {
    const { deps, archived } = makeDeps({ readRows: async () => [bundledRow] });
    const out = await reconcileStrandedInstall(PKG, deps);
    expect(out.kind).toBe("skipped");
    expect(archived).toEqual([]);
  });

  it("runs under the package install lock", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      withInstallLock: async (p, fn) => {
        order.push(`lock:${p}`);
        const r = await fn();
        order.push("unlock");
        return r;
      },
      activateOverride: async () => {
        order.push("activate");
        return { ok: false, reason: "signature required" };
      },
    });
    await reconcileStrandedInstall(PKG, deps);
    expect(order).toEqual([`lock:${PKG}`, "activate", "unlock"]);
  });
});
