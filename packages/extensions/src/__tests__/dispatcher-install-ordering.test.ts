import { describe, it, expect, vi, beforeEach } from "vitest";

// The host installer OWNS the install/update sequence (NOT a per-handler
// post-hook). These DI-unit tests pin the corrected ordering + rollback:
//   - the canonical row is ensured BEFORE the native handler (so the workflow
//     saga's recordProvenance + the pipeline both resolve it);
//   - a non-finalizing pipeline ROLLS BACK the placeholder row + reports a
//     truthful failure, and a later install RE-RUNS the pipeline;
//   - update() runs the SAME host installer with UPDATE semantics — it re-runs
//     the pipeline against the existing finalized row + hot-activates.
//
// The canonical store + lifecycle-primitive + activate-hook are mocked so the
// test isolates the dispatch ordering with no DB / registry.

// --- mutable in-memory canonical-store state --------------------------------
type Row = {
  id: string;
  packageName: string;
  status: string;
  organizationId: string | null;
  source: { type: string; integrity?: string } | null;
};
let rows: Row[] = [];
const callOrder: string[] = [];

const installExtensionManifest = vi.fn(async (row: Row) => {
  callOrder.push(`createRow:${row.id}`);
  rows.push({ ...row });
  return row;
});
const transitionExtensionLifecycle = vi.fn(async () => null);
const _internalDeleteInstalledExtension = vi.fn(async (id: string) => {
  callOrder.push(`deleteRow:${id}`);
  rows = rows.filter((r) => r.id !== id);
});
const readInstalledExtensionById = vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null);
const readInstalledExtensionsByPackageName = vi.fn(async (pkg: string) =>
  rows.filter((r) => r.packageName === pkg),
);
// Promoted to a module-level spy (default: empty) so individual tests can
// override the full-manifest snapshot the restore/archive closure gates read
// (assertCanonicalRestoreClosure → listInstalledExtensions).
const listInstalledExtensions = vi.fn(async (): Promise<unknown[]> => []);

// Placeholder integrity values = a row the install pipeline never finalized.
// Kept in sync with DISPATCHER_PLACEHOLDER_INTEGRITY in ../non-finalized-row.
const PLACEHOLDER_INTEGRITY = new Set(["", "dispatcher-install", "pending-resolution", "latest", "HEAD"]);

// Stub the per-package install lock the dispatcher now wraps runHostInstall in.
// It records each acquisition (in callOrder, with the package key) so a test can
// prove the lock is taken per-package BEFORE the native handler runs, then runs
// `fn` inline. The lock's actual mutual-exclusion/serialization semantics are
// owned + tested in @cinatra-ai/agents (materialize-agent-package).
const withInstallLockAcquisitions: string[] = [];
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (packageName: string, fn: () => Promise<unknown>) => {
    withInstallLockAcquisitions.push(packageName);
    callOrder.push(`withInstallLock:${packageName}`);
    return fn();
  },
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [string])),
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...(a as [string])),
  _internalDeleteInstalledExtension: (...a: unknown[]) =>
    _internalDeleteInstalledExtension(...(a as [string])),
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...(a as [])),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));
vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...(a as [Row])),
  transitionExtensionLifecycle: (...a: unknown[]) => transitionExtensionLifecycle(...(a as [])),
  // Mirror the REAL primitive's self-guard rather than delegating straight to the
  // writer: refuse a healthy/finalized row loudly (so a dispatcher misuse that
  // deletes a healthy row fails the test instead of being masked). A non-finalized
  // placeholder (active|locked + placeholder integrity — no journal reader is wired
  // here, so the real primitive's journal-aware check also reduces to this) is
  // deleted via the canonical-store spy, keeping the rollback assertions meaningful.
  deleteNonFinalizedCanonicalRow: async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return; // missing → idempotent no-op
    const integrity = typeof row.source?.integrity === "string" ? row.source.integrity : null;
    const nonFinalized =
      (row.status === "active" || row.status === "locked") &&
      integrity !== null &&
      PLACEHOLDER_INTEGRITY.has(integrity);
    if (!nonFinalized) {
      throw new Error(
        `deleteNonFinalizedCanonicalRow refused — '${id}' is not a non-finalized placeholder (mock guard mirrors the real primitive)`,
      );
    }
    await _internalDeleteInstalledExtension(id);
  },
}));
// The REQUIRED-PIN GATE verdict is controllable per-test (default: pass).
const { checkRequiredExtensionVersionPin } = vi.hoisted(() => ({
  checkRequiredExtensionVersionPin: vi.fn(
    (_input: unknown): { ok: true } | { ok: false; requiredRange: string; reason: string } => ({ ok: true }),
  ),
}));
vi.mock("../required-in-prod", () => ({
  isPackageRequiredInProd: () => false,
  checkRequiredExtensionVersionPin: (input: unknown) => checkRequiredExtensionVersionPin(input as never),
}));

// --- mocked activate hook (the real-integrity pipeline) ---------------------
const fireExtensionActivate = vi.fn();
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: (...a: unknown[]) => fireExtensionActivate(...(a as [string, string | null])),
}));

import { extensionRegistry } from "../index";
import { makeHandler, makeRef } from "./__mocks__/extension-handler";
import type { Actor } from "../index";

const orgActor: Actor = { actorType: "system", userId: "u1", source: "worker", orgId: "org-1" };

beforeEach(() => {
  extensionRegistry._resetForTesting();
  rows = [];
  callOrder.length = 0;
  withInstallLockAcquisitions.length = 0;
  vi.clearAllMocks();
  // Restore the closure-gate snapshot to its default (empty) after clearAllMocks,
  // so a per-test override never leaks into the next test.
  listInstalledExtensions.mockResolvedValue([]);
});

describe("dispatcher host-install ordering + rollback", () => {
  it("Finding 4: the canonical row is created BEFORE the native handler runs", async () => {
    const handler = makeHandler("connector");
    (handler.install as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("handler.install");
    });
    extensionRegistry.register(handler);
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/a-connector"), orgActor);

    const createIdx = callOrder.findIndex((e) => e.startsWith("createRow:"));
    const handlerIdx = callOrder.indexOf("handler.install");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx, "row created before handler.install").toBeLessThan(handlerIdx);
    // The row was created at the actor's org scope (so the saga/pipeline resolve it).
    expect(rows[0]?.organizationId).toBe("org-1");
  });

  it("Finding 3: a non-finalizing pipeline ROLLS BACK the placeholder row + throws", async () => {
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: false, activated: false, reason: "anchor-refused" });

    await expect(
      extensionRegistry.install("connector", makeRef("@v/b-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);

    // The placeholder row was rolled back — nothing left active-but-non-anchorable.
    expect(rows.filter((r) => r.packageName === "@v/b-connector")).toHaveLength(0);
    expect(_internalDeleteInstalledExtension).toHaveBeenCalledTimes(1);
  });

  it("Finding 3: a re-install after a BROKEN (placeholder) prior row RE-RUNS the pipeline", async () => {
    // Seed a broken prior row (placeholder integrity = pipeline never finalized).
    rows = [
      {
        id: "iext_broken",
        packageName: "@v/c-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "dispatcher-install" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/c-connector"), orgActor);

    // No NEW row was created (the broken row is retried), and the pipeline fired.
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/c-connector", "org-1", "1.0.0");
  });

  it("an already-finalized NON-connector (agent) row short-circuits install — NO pipeline re-run, NO activate hook", async () => {
    rows = [
      {
        id: "iext_ok",
        packageName: "@v/d-agent",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("agent"));

    await extensionRegistry.install("agent", makeRef("@v/d-agent"), orgActor);

    // A non-hot-loadable kind that is already finalized is simply "already
    // installed" — no runtime module to re-activate, no pipeline re-run.
    expect(fireExtensionActivate).not.toHaveBeenCalled();
    expect(installExtensionManifest).not.toHaveBeenCalled();
  });

  it("Finding 1: an already-finalized CONNECTOR row RE-FIRES the activate hook on install (idempotent re-activate; no new row, never deleted)", async () => {
    // A prior install committed (finalized, real provenance) but in-process
    // activation did not register the package — the row is healthy + anchorable.
    rows = [
      {
        id: "iext_ok_conn",
        packageName: "@v/d-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/d-connector"), orgActor);

    // The activate hook RE-FIRES (idempotent re-materialize + replace-in-place
    // re-register) so the connector hot-activates without a restart. No new row
    // is created and the healthy finalized row is never deleted.
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/d-connector", "org-1", "1.0.0");
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("Finding 1: update() RE-RUNS the pipeline against an existing finalized row (and never rolls it back on a failed new digest)", async () => {
    rows = [
      {
        id: "iext_v1",
        packageName: "@v/e-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-v1" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));

    // Happy update: pipeline finalizes the new digest.
    fireExtensionActivate.mockResolvedValueOnce({ finalized: true, activated: true });
    await extensionRegistry.update("connector", makeRef("@v/e-connector"), orgActor);
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/e-connector", "org-1", "1.0.0");

    // Failed update: a non-finalizing new digest THROWS but does NOT delete the
    // previously-working install (ownsRollback:false for an update of a healthy row).
    fireExtensionActivate.mockResolvedValueOnce({ finalized: false, activated: false, reason: "registries-unreachable" });
    await expect(
      extensionRegistry.update("connector", makeRef("@v/e-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === "iext_v1")).toBeDefined();
  });

  it("UPDATE GATE (#180 item 6): a breaking-range update is REFUSED pre-mutation, NAMING the dependents (no row ensure, no handler, no pipeline)", async () => {
    extensionRegistry.register(makeHandler("connector"));
    // A live dependent declares lib@^1.0.0; updating lib to 2.0.0 must refuse.
    listInstalledExtensions.mockResolvedValue([
      {
        id: "iext_dep",
        packageName: "@v/dependent",
        status: "active",
        organizationId: "org-1",
        kind: "connector",
        source: { type: "verdaccio", integrity: "sha512-d", version: "1.0.0", registryUrl: "r", packageName: "@v/dependent" },
        dependencies: [
          {
            packageName: "@v/lib",
            edgeType: "runtime",
            requirement: "required",
            versionConstraint: { kind: "semver-range", range: "^1.0.0" },
          },
        ],
      },
      {
        id: "iext_lib",
        packageName: "@v/lib",
        status: "active",
        organizationId: "org-1",
        kind: "connector",
        source: { type: "verdaccio", integrity: "sha512-l", version: "1.4.0", registryUrl: "r", packageName: "@v/lib" },
        dependencies: [],
      },
    ] as never);
    await expect(
      extensionRegistry.update("connector", { ...makeRef("@v/lib"), version: "2.0.0" }, orgActor),
    ).rejects.toThrow(/Cannot update @v\/lib to 2\.0\.0 .*@v\/dependent requires @v\/lib@"\^1\.0\.0"/);
    // Fully inert: nothing ensured/mutated, no handler call, no pipeline fire.
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();

    // The SAME update at a SATISFYING version proceeds (gate passes).
    fireExtensionActivate.mockResolvedValueOnce({ finalized: true, activated: true });
    rows = [
      {
        id: "iext_lib",
        packageName: "@v/lib",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-l" },
      },
    ];
    await extensionRegistry.update("connector", { ...makeRef("@v/lib"), version: "1.9.0" }, orgActor);
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/lib", "org-1", "1.9.0");
  });

  it("Design B: a CLEAN durable rollback (rolledBack:true, rollbackComplete:true) → calm 'previous version retained' error; old row NOT deleted", async () => {
    rows = [
      {
        id: "iext_v1",
        packageName: "@v/clean-rollback-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-v1" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    // The update's new digest failed live activation; the durable rollback was CLEAN.
    fireExtensionActivate.mockResolvedValue({
      finalized: true,
      activated: false,
      rolledBack: true,
      rollbackComplete: true,
      reason: "failed:register-threw:live-only-boom",
    });

    const cleanErr = await extensionRegistry
      .update("connector", makeRef("@v/clean-rollback-connector"), orgActor)
      .then(() => null, (e: unknown) => e as Error);
    expect(cleanErr, "the op must throw").toBeInstanceOf(Error);
    // The calm "previous version retained" message — NOT the loud manual-recovery one.
    expect(cleanErr!.message).toMatch(/did NOT take/);
    expect(cleanErr!.message).toMatch(/which is retained and remains active/);
    expect(cleanErr!.message).not.toMatch(/manual recovery required/);

    // A clean rollback never deletes the previously-working install (it is retained).
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === "iext_v1")).toBeDefined();
  });

  it("HIGH 3: an INCOMPLETE durable rollback (rolledBack:true, rollbackComplete:false) → LOUD manual-recovery error (NOT the calm 'previous version retained'); old row NOT deleted", async () => {
    rows = [
      {
        id: "iext_v1",
        packageName: "@v/incomplete-rollback-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-v1" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    // The update's new digest failed live activation AND the durable rollback could
    // NOT fully restore the OLD anchor (a restore step failed) → INCOMPLETE.
    fireExtensionActivate.mockResolvedValue({
      finalized: true,
      activated: false,
      rolledBack: true,
      rollbackComplete: false,
      reason: "failed:register-threw (durable rollback INCOMPLETE: failed restore steps: provenance)",
    });

    const err = await extensionRegistry
      .update("connector", makeRef("@v/incomplete-rollback-connector"), orgActor)
      .then(() => null, (e: unknown) => e as Error);

    expect(err, "the op must throw").toBeInstanceOf(Error);
    // The LOUD manual-recovery message — NOT the calm "previous version retained".
    expect(err!.message).toMatch(/durable rollback is INCOMPLETE — manual recovery required/);
    expect(err!.message).not.toMatch(/which is retained and remains active/);
    expect(err!.message, "the failed restore step is surfaced").toMatch(/provenance/);
    // We never delete the OLD row — it is quarantined/restorable + boot-recoverable.
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === "iext_v1")).toBeDefined();
  });

  it("a handler.install throw rolls back the placeholder row it just created", async () => {
    const handler = makeHandler("connector");
    (handler.install as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("handler boom"));
    extensionRegistry.register(handler);

    await expect(
      extensionRegistry.install("connector", makeRef("@v/f-connector"), orgActor),
    ).rejects.toThrow(/handler boom/);
    // The placeholder row was rolled back; the activate hook never fired.
    expect(rows.filter((r) => r.packageName === "@v/f-connector")).toHaveLength(0);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("a non-connector kind (agent) does NOT fire the package-store activate hook", async () => {
    extensionRegistry.register(makeHandler("agent"));
    await extensionRegistry.install("agent", makeRef("@v/g-agent"), orgActor);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // A canonical-store failure on a CONNECTOR install must FAIL CLOSED
  // (throw), never swallow into needsPipeline:false → a false placeholder success
  // (no row, no pipeline, no hot activation).
  // -------------------------------------------------------------------------
  it("Finding 1: a canonical-store READ failure on a connector install THROWS (no silent placeholder success)", async () => {
    readInstalledExtensionsByPackageName.mockRejectedValueOnce(new Error("canonical store unreachable"));
    extensionRegistry.register(makeHandler("connector"));

    await expect(
      extensionRegistry.install("connector", makeRef("@v/store-down-connector"), orgActor),
    ).rejects.toThrow(/could not ensure its canonical install row/);

    // No row was created, the handler/pipeline never ran a silent success.
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("Finding 1: an installExtensionManifest (row-create) failure on a connector install THROWS (no silent placeholder success)", async () => {
    installExtensionManifest.mockRejectedValueOnce(new Error("source provenance invalid"));
    extensionRegistry.register(makeHandler("connector"));

    await expect(
      extensionRegistry.install("connector", makeRef("@v/badrow-connector"), orgActor),
    ).rejects.toThrow(/could not ensure its canonical install row/);

    // The placeholder row never landed (the create threw) and the pipeline never fired.
    expect(rows.filter((r) => r.packageName === "@v/badrow-connector")).toHaveLength(0);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("Finding 1: a canonical-store read failure on a non-hot-loadable kind (agent) is GRANDFATHERED (legacy path) — no throw, no pipeline", async () => {
    readInstalledExtensionsByPackageName.mockRejectedValueOnce(new Error("canonical store unreachable"));
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);

    // The agent handler still ran (legacy per-handler install path); the dispatcher
    // did NOT throw and did NOT create a placeholder row or fire the activate hook.
    await expect(
      extensionRegistry.install("agent", makeRef("@v/agent-store-down"), orgActor),
    ).resolves.toBeUndefined();
    expect(handler.install).toHaveBeenCalledTimes(1);
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // A github/local skill ref (owner/repo — no leading "@", no version)
  // must NOT create a verdaccio placeholder canonical row (it would never finalize
  // and would strand an active non-anchorable row). The handler owns the install.
  // -------------------------------------------------------------------------
  it("Finding 3: a GitHub skill ref (owner/repo) creates NO verdaccio placeholder row + never fires the activate hook", async () => {
    const handler = makeHandler("skill");
    extensionRegistry.register(handler);

    // A bare owner/repo ref with no version = a GitHub-backed skill install.
    await extensionRegistry.install(
      "skill",
      { registryUrl: "", packageName: "acme/cool-skill", version: "" },
      orgActor,
    );

    // The skill handler ran, but NO canonical placeholder row was created (the
    // carve-out), and the package-store activate hook never fired.
    expect(handler.install).toHaveBeenCalledTimes(1);
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.packageName === "acme/cool-skill")).toHaveLength(0);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("Finding 3: a verdaccio skill ref (@scope/pkg with a version) DOES create the canonical row (carve-out is github/local-only)", async () => {
    const handler = makeHandler("skill");
    extensionRegistry.register(handler);

    await extensionRegistry.install(
      "skill",
      { registryUrl: "", packageName: "@acme/cool-skill", version: "2.0.0" },
      orgActor,
    );

    // A scoped verdaccio skill ref is NOT the github/local carve-out → a canonical
    // row is created. (Skill is not in KINDS_USING_ACTIVATE_HOOK, so no pipeline.)
    expect(handler.install).toHaveBeenCalledTimes(1);
    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(rows.filter((r) => r.packageName === "@acme/cool-skill")).toHaveLength(1);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // install/update success MUST be gated on ACTUAL hot activation —
  // a finalized-but-not-activated result is NOT success (placeholder-as-success).
  // -------------------------------------------------------------------------
  it("Finding 1: a finalized-but-NOT-activated install THROWS and does NOT roll back the committed install", async () => {
    extensionRegistry.register(makeHandler("connector"));
    // The pipeline finalized (committed + anchorable) but in-process activation
    // did NOT register the package (anchor refused / activator unavailable).
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false, reason: "anchor-refused" });

    await expect(
      extensionRegistry.install("connector", makeRef("@v/h-connector"), orgActor),
    ).rejects.toThrow(/did NOT\s+hot-activate in-process/);

    // The committed/finalized row is NOT rolled back (it is real + anchorable;
    // the boot loader is the durable path).
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.packageName === "@v/h-connector")).toHaveLength(1);
  });

  it("Finding 1: a RETRY install after a finalized-but-NOT-activated connector RE-FIRES the activate hook (not short-circuited as already-installed)", async () => {
    extensionRegistry.register(makeHandler("connector"));

    // First install: a FRESH connector. The pipeline FINALIZES (the dispatcher's
    // mocked pipeline = fireExtensionActivate) but in-process hot-activation does
    // NOT register the package this call. The dispatcher throws — but the row is
    // real + anchorable, so it is NOT rolled back (ownsRollback honored for the
    // finalized-but-not-activated branch).
    fireExtensionActivate.mockResolvedValueOnce({ finalized: true, activated: false, reason: "anchor-refused" });
    await expect(
      extensionRegistry.install("connector", makeRef("@v/retry-connector"), orgActor),
    ).rejects.toThrow(/did NOT\s+hot-activate in-process/);

    // The row survives (anchorable; boot loader is the durable path) and was NOT
    // rolled back. The first install created exactly one placeholder row.
    expect(rows.filter((r) => r.packageName === "@v/retry-connector")).toHaveLength(1);
    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();

    // The finalized pipeline records REAL provenance on the row; the dispatcher's
    // mock never mutates the seeded source, so mirror that finalized write here so
    // the retry exercises the HEALTHY-finalized-connector re-fire branch (not the
    // broken-placeholder retry branch).
    const seeded = rows.find((r) => r.packageName === "@v/retry-connector")!;
    seeded.source = { type: "verdaccio", integrity: "sha512-real" };

    // RETRY: a second install must RE-FIRE the activate hook (idempotent
    // re-materialize + replace-in-place re-register), NOT short-circuit as
    // "already installed". This time activation succeeds.
    fireExtensionActivate.mockResolvedValueOnce({ finalized: true, activated: true });
    await expect(
      extensionRegistry.install("connector", makeRef("@v/retry-connector"), orgActor),
    ).resolves.toBeUndefined();

    // The hook fired again on the retry (so the package hot-activated without a
    // restart), no SECOND row was created (still exactly one create from step 1),
    // and the healthy finalized row was never deleted.
    expect(fireExtensionActivate).toHaveBeenLastCalledWith("@v/retry-connector", "org-1", "1.0.0");
    expect(fireExtensionActivate).toHaveBeenCalledTimes(2);
    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.packageName === "@v/retry-connector")).toHaveLength(1);
  });

  it("Finding 1: a finalized-but-NOT-activated UPDATE of a healthy row THROWS and never deletes the prior install", async () => {
    rows = [
      {
        id: "iext_upd",
        packageName: "@v/i-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-v1" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false, reason: "register-threw" });

    await expect(
      extensionRegistry.update("connector", makeRef("@v/i-connector"), orgActor),
    ).rejects.toThrow(/did NOT\s+hot-activate in-process/);
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === "iext_upd")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // A missing host hook (no-host-hook → finalized:undefined) is a
  // FAIL-CLOSED regression for a connector — it must THROW (no placeholder-as-
  // success) and roll back a row THIS attempt owns.
  // -------------------------------------------------------------------------
  it("Finding 3: a connector install with NO host hook wired THROWS + rolls back the placeholder row", async () => {
    extensionRegistry.register(makeHandler("connector"));
    // fireExtensionActivate's real no-host-hook contract: { activated:false,
    // reason:"no-host-hook" } with finalized undefined.
    fireExtensionActivate.mockResolvedValue({ activated: false, reason: "no-host-hook" });

    await expect(
      extensionRegistry.install("connector", makeRef("@v/j-connector"), orgActor),
    ).rejects.toThrow(/could not hot-activate in-process/);

    // The placeholder row this attempt created was rolled back.
    expect(rows.filter((r) => r.packageName === "@v/j-connector")).toHaveLength(0);
    expect(_internalDeleteInstalledExtension).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Restoring an archived connector RE-REGISTERS in-process via the
  // activate hook (archive tore down its in-memory registrations).
  // -------------------------------------------------------------------------
  it("Finding 5: explicit restore() of a connector fires the activate hook to RE-REGISTER in-process", async () => {
    rows = [
      {
        id: "iext_arch",
        packageName: "@v/k-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.restore("connector", makeRef("@v/k-connector"), orgActor);

    // The activate hook fired with the actor's org → the package re-registered.
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/k-connector", "org-1", "1.0.0");
  });

  it("Finding 5: restore() of a connector that does NOT re-register THROWS (no silent 'restored but not loaded')", async () => {
    rows = [
      {
        id: "iext_arch2",
        packageName: "@v/l-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false, reason: "anchor-refused" });

    await expect(
      extensionRegistry.restore("connector", makeRef("@v/l-connector"), orgActor),
    ).rejects.toThrow(/did NOT re-register in-process/);
  });

  it("Finding 5: restore() of a NON-connector kind (skill) does NOT fire the activate hook (carve-out intact)", async () => {
    rows = [
      {
        id: "iext_arch3",
        packageName: "@v/m-skill",
        status: "archived",
        organizationId: "org-1",
        source: { type: "github" },
      },
    ];
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.restore("skill", makeRef("@v/m-skill"), orgActor);
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("Finding 5: re-install (install) of an archived connector re-activates the row AND fires the activate hook to re-register", async () => {
    rows = [
      {
        id: "iext_arch4",
        packageName: "@v/n-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/n-connector"), orgActor);

    // The archived row was re-activated (transition) and the activate hook fired
    // to RE-REGISTER in-process — NOT a status-only flip. No new row was created.
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/n-connector", "org-1", "1.0.0");
    // ownsRollback:false for a restore — a successful activation never deletes.
    expect(_internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("wraps the WHOLE install in the per-package install lock (acquired BEFORE the native handler)", async () => {
    // The direct-install path (ensure-row → handler → pipeline-finalize →
    // rollback) must run under withInstallLock(packageName) so a concurrent finalize
    // of the same row cannot race this attempt's rollback (the journal-only TOCTOU).
    // The lock is acquired for THIS package, and BEFORE the native handler runs (so
    // the whole critical section — incl. the finalize + rollback below — is held).
    const handler = makeHandler("connector");
    (handler.install as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("handler.install");
    });
    extensionRegistry.register(handler);
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/locked-connector"), orgActor);

    expect(withInstallLockAcquisitions, "lock acquired for the install's package").toContain(
      "@v/locked-connector",
    );
    const lockIdx = callOrder.indexOf("withInstallLock:@v/locked-connector");
    const handlerIdx = callOrder.indexOf("handler.install");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx, "install lock acquired before the native handler").toBeLessThan(handlerIdx);
  });

  it("an UPDATE also runs under the per-package install lock (acquired BEFORE the native update handler)", async () => {
    rows = [
      {
        id: "iext_lockwrap",
        packageName: "@v/upd-connector",
        status: "active",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    const handler = makeHandler("connector");
    (handler.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("handler.update");
    });
    extensionRegistry.register(handler);
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.update("connector", makeRef("@v/upd-connector"), orgActor);

    expect(withInstallLockAcquisitions, "update holds the per-package lock too").toContain(
      "@v/upd-connector",
    );
    const lockIdx = callOrder.indexOf("withInstallLock:@v/upd-connector");
    const updateIdx = callOrder.indexOf("handler.update");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx, "install lock acquired before the native update handler").toBeLessThan(updateIdx);
  });
});

// A RESTORE is refused when the restored extension's required deps are
// archived/missing. A restore operates on a row whose `.dependencies` are
// already materialized, so the dispatcher's assertCanonicalRestoreClosure runs a
// FORWARD closure check (assertInstallClosure) against the present manifest and
// throws DependencyClosureError(REQUIRED_MISSING) BEFORE the handler.restore /
// activate hook ever run.
describe("restore dependency-closure gate", () => {
  // Full InstalledExtension shape for the closure-gate snapshot (the gate reads
  // .dependencies / .status, unlike the lighter dispatcher `rows` shape).
  function fullRow(
    packageName: string,
    status: "active" | "archived" | "locked",
    deps: { packageName: string; requirement: "required" | "optional" }[] = [],
    orgId = "org-1",
  ) {
    return {
      // Distinct per (package, org) so a multi-scope same-package fixture has
      // unique canonical ids; the default org keeps existing single-scope callers
      // at the historical `id-<pkg>` shape.
      id: orgId === "org-1" ? `id-${packageName}` : `id-${packageName}-${orgId}`,
      packageName,
      ownerLevel: "organization" as const,
      ownerId: orgId,
      organizationId: orgId,
      kind: "connector" as const,
      status,
      source: {
        type: "verdaccio" as const,
        registryUrl: "http://localhost:4873",
        packageName,
        version: "1.0.0",
        integrity: "sha512-real",
      },
      requiredInProd: false,
      dependencies: deps.map((d) => ({
        packageName: d.packageName,
        edgeType: "runtime" as const,
        versionConstraint: { kind: "semver-range" as const, range: "*" },
        requirement: d.requirement,
      })),
      manifestHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("refuses restore when a REQUIRED dep of the restored extension is archived", async () => {
    // The package being restored requires @v/dep-lib, which is archived → broken.
    const target = fullRow("@v/needs-dep-connector", "archived", [
      { packageName: "@v/dep-lib", requirement: "required" },
    ]);
    const archivedDep = fullRow("@v/dep-lib", "archived");
    // The closure-gate snapshot the dispatcher reads:
    listInstalledExtensions.mockResolvedValue([target, archivedDep]);
    // The lighter dispatcher row shape (only used if the gate passed → it won't):
    rows = [
      {
        id: "id-@v/needs-dep-connector",
        packageName: "@v/needs-dep-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    const handler = makeHandler("connector");
    extensionRegistry.register(handler);

    await expect(
      extensionRegistry.restore("connector", makeRef("@v/needs-dep-connector"), orgActor),
    ).rejects.toMatchObject({ name: "DependencyClosureError", code: "REQUIRED_MISSING" });

    // The refusal short-circuits BEFORE the native handler + activate hook.
    expect(handler.restore).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("permits restore when the required deps are present (active/locked)", async () => {
    const target = fullRow("@v/ok-connector", "archived", [
      { packageName: "@v/dep-lib", requirement: "required" },
    ]);
    const activeDep = fullRow("@v/dep-lib", "active");
    listInstalledExtensions.mockResolvedValue([target, activeDep]);
    rows = [
      {
        id: "id-@v/ok-connector",
        packageName: "@v/ok-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.restore("connector", makeRef("@v/ok-connector"), orgActor);

    // Closure passed → the handler restore + activate re-register proceeded.
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/ok-connector", "org-1", "1.0.0");
  });

  it("MULTI-ROW: refuses restore when ANY archived same-package row across org scopes has a broken required dep (the SECOND broken row is not missed)", async () => {
    // A package can have multiple canonical rows across org scopes; a restore
    // re-activates EVERY archived row of that package. The closure gate must
    // therefore validate the forward closure of EACH archived target — not just
    // the first match. Two archived rows for the SAME package:
    //   - rowA (org-1): requires @v/dep-present → ACTIVE  → closure OK
    //   - rowB (org-2): requires @v/dep-broken  → ARCHIVED → closure BROKEN
    // rowA (the OK one) is FIRST in the snapshot, so a first-match-only gate
    // (`allRows.find(...)`) would check rowA, pass, and silently miss rowB. The
    // per-row loop catches rowB and throws REQUIRED_MISSING.
    const rowA = fullRow(
      "@v/multi-scope-connector",
      "archived",
      [{ packageName: "@v/dep-present", requirement: "required" }],
      "org-1",
    );
    const rowB = fullRow(
      "@v/multi-scope-connector",
      "archived",
      [{ packageName: "@v/dep-broken", requirement: "required" }],
      "org-2",
    );
    const depPresent = fullRow("@v/dep-present", "active");
    // The broken dep exists ONLY as an archived row → not "present" for the
    // lookup → counts as missing for rowB's closure.
    const depBroken = fullRow("@v/dep-broken", "archived", [], "org-2");
    // rowA (OK) FIRST so a first-match-only gate would stop at the passing row.
    listInstalledExtensions.mockResolvedValue([rowA, depPresent, rowB, depBroken]);
    rows = [
      {
        id: "id-@v/multi-scope-connector",
        packageName: "@v/multi-scope-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    const handler = makeHandler("connector");
    extensionRegistry.register(handler);

    await expect(
      extensionRegistry.restore("connector", makeRef("@v/multi-scope-connector"), orgActor),
    ).rejects.toMatchObject({ name: "DependencyClosureError", code: "REQUIRED_MISSING" });

    // The broken second row's refusal short-circuits BEFORE the native handler +
    // activate hook (no partial restore).
    expect(handler.restore).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("MULTI-ROW: an unrelated ACTIVE same-package row does not block a valid restore (only archived rows are re-activated)", async () => {
    // Two same-package rows: one ARCHIVED (being restored, deps satisfied) and one
    // already-ACTIVE in a different org scope. The active row is NOT a restore
    // target (only archived rows are re-activated), so it must not be closure-
    // checked in a way that blocks the valid archived restore.
    const archivedTarget = fullRow(
      "@v/mixed-scope-connector",
      "archived",
      [{ packageName: "@v/dep-present", requirement: "required" }],
      "org-1",
    );
    const alreadyActive = fullRow("@v/mixed-scope-connector", "active", [], "org-2");
    const depPresent = fullRow("@v/dep-present", "active");
    listInstalledExtensions.mockResolvedValue([archivedTarget, alreadyActive, depPresent]);
    rows = [
      {
        id: "id-@v/mixed-scope-connector",
        packageName: "@v/mixed-scope-connector",
        status: "archived",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("connector"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.restore("connector", makeRef("@v/mixed-scope-connector"), orgActor);

    // Closure passed → the restore + activate re-register proceeded.
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/mixed-scope-connector", "org-1", "1.0.0");
  });
});

// ---------------------------------------------------------------------------
// REQUIRED-PIN GATE — a package pinned in `cinatra.extensions` may only
// be installed/updated at a concrete version satisfying the pinned range. The
// gate runs at the TOP of the host installer, on EVERY kind's path, BEFORE the
// row-ensure / native handler / pipeline — so a refusal mutates NOTHING.
// ---------------------------------------------------------------------------
describe("dispatcher REQUIRED-PIN GATE (versioned cinatra.extensions)", () => {
  const refusal = {
    ok: false as const,
    requiredRange: "^0.1.0",
    reason:
      'update of @v/pinned-agent@0.2.0 refused: this host pins the required extension to "^0.1.0"',
  };

  it("REFUSES an INSTALL outside the pin BEFORE any mutation (no row, no handler, no pipeline)", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    checkRequiredExtensionVersionPin.mockReturnValueOnce({ ...refusal, reason: refusal.reason.replace("update", "install") });

    await expect(
      extensionRegistry.install("agent", makeRef("@v/pinned-agent"), orgActor),
    ).rejects.toThrow(/pins the required extension to "\^0\.1\.0"/);

    expect(rows).toHaveLength(0); // no canonical row ensured
    expect(handler.install).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
    // The gate saw the dispatched ref (name + version + op).
    expect(checkRequiredExtensionVersionPin).toHaveBeenCalledWith({
      packageName: "@v/pinned-agent",
      version: "1.0.0",
      op: "install",
    });
  });

  it("REFUSES an UPDATE outside the pin the same way (every kind dispatches through here)", async () => {
    const handler = makeHandler("connector");
    extensionRegistry.register(handler);
    checkRequiredExtensionVersionPin.mockReturnValueOnce(refusal);

    await expect(
      extensionRegistry.update("connector", makeRef("@v/pinned-agent"), orgActor),
    ).rejects.toThrow(/pins the required extension/);

    expect(rows).toHaveLength(0);
    expect(handler.update).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
    expect(checkRequiredExtensionVersionPin).toHaveBeenCalledWith({
      packageName: "@v/pinned-agent",
      version: "1.0.0",
      op: "update",
    });
  });

  it("PASSES a pinned-satisfying (or unpinned) ref — install proceeds normally", async () => {
    const handler = makeHandler("connector");
    extensionRegistry.register(handler);
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: true });

    await extensionRegistry.install("connector", makeRef("@v/ok-connector"), orgActor);

    expect(handler.install).toHaveBeenCalledTimes(1);
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/ok-connector", "org-1", "1.0.0");
  });
});
