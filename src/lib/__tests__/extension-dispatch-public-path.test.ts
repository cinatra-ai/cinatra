import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PUBLIC-DISPATCH coverage.
//
// The prior dispatcher tests routed through `extensionRegistry.install`/`.update`
// but MOCKED `../activate-hook`, so they never exercised the host's REAL
// activate-hook firer + the REAL install pipeline orchestration. A broken/
// unreachable public path (the firer wired wrong, the pipeline never finalizing,
// a workflow fail-closed regression) would pass those tests.
//
// These tests drive the REAL public surface end-to-end:
//   extensionRegistry.install / extensionRegistry.update  (the public dispatch)
//     → runHostInstall (real ordering + rollback)
//     → the native per-kind handler (real connector / workflow handler)
//     → setExtensionActivateHook(real firer) → installExtensionFromRegistry (real
//       pipeline orchestration: resolveIntegrity → materialize → grant →
//       provenance → finalize → activate)
//
// ONLY the leaf IO is DI-faked: the canonical store + lifecycle primitive (an
// in-memory mutable row set the dispatcher AND the activate hook both read/write),
// and the pipeline's resolveIntegrity / materialize / journal / activateInProcess
// leaves. There is NO real registry / DB / filesystem. The row set is the single
// source of truth shared by both halves, so a finalize that records real
// provenance is OBSERVABLE on the same row the dispatcher created.

// ---------------------------------------------------------------------------
// In-memory canonical store shared by the dispatcher + the activate-hook body.
// ---------------------------------------------------------------------------
type Row = {
  id: string;
  packageName: string;
  status: string;
  organizationId: string | null;
  kind?: string;
  source: {
    type: string;
    registryUrl?: string;
    integrity?: string;
    contentHash?: string;
    version?: string;
  } | null;
};

let rows: Row[] = [];
const events: string[] = [];
// Optional per-test override for installExtensionManifest (a row-create failure
// on a connector install must fail closed). null = default
// (create + push the row); a function replaces the create behavior.
let installManifestImpl: ((row: Row) => Promise<unknown>) | null = null;

function readByName(pkg: string): Row[] {
  return rows.filter((r) => r.packageName === pkg).map((r) => ({ ...r, source: r.source ? { ...r.source } : null }));
}

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async (pkg: string) => readByName(pkg),
  readInstalledExtensionById: async (id: string) => {
    const r = rows.find((x) => x.id === id);
    return r ? { ...r, source: r.source ? { ...r.source } : null } : null;
  },
  _internalDeleteInstalledExtension: async (id: string) => {
    events.push(`deleteRow:${id}`);
    rows = rows.filter((r) => r.id !== id);
  },
  listInstalledExtensions: async () => rows.map((r) => ({ ...r })),
  readEffectiveStatusByPackageNames: async () => new Map(),
}));

vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: async (row: Row) => {
    if (installManifestImpl) return installManifestImpl(row);
    events.push(`createRow:${row.id}`);
    rows.push({ ...row, source: row.source ? { ...row.source } : null });
    return row;
  },
  transitionExtensionLifecycle: async () => null,
  // The rollback-only canonical delete the dispatcher calls on a non-finalized
  // install. The real primitive wraps canonical-store's _internalDeleteInstalledExtension
  // BUT self-enforces a "non-finalized only" contract decided SOLELY by the
  // journal-aware signal (refuses an archived / finalized-healthy row — incl. a
  // finalized admin-lock — but DELETES a non-finalized placeholder regardless of
  // whether its live status is `active` OR `locked`). The dispatcher creates a
  // required-in-prod new install at status `locked` while it still carries
  // placeholder integrity, so a non-finalized `locked` row IS rollbackable. Mirror
  // that guard FAITHFULLY: a non-finalized live (active|locked) placeholder is
  // dropped; any healthy/finalized row throws loudly (the real primitive would
  // too) instead of silently deleting it and masking the regression.
  deleteNonFinalizedCanonicalRow: async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return; // missing → idempotent no-op
    const integrity = typeof row.source?.integrity === "string" ? row.source.integrity : null;
    const PLACEHOLDER = new Set(["", "dispatcher-install", "pending-resolution", "latest", "HEAD"]);
    const nonFinalized =
      (row.status === "active" || row.status === "locked") &&
      integrity !== null &&
      PLACEHOLDER.has(integrity);
    if (!nonFinalized) {
      throw new Error(
        `deleteNonFinalizedCanonicalRow refused — '${id}' is not a non-finalized placeholder (status='${row.status}', integrity='${integrity}')`,
      );
    }
    events.push(`deleteRow:${id}`);
    rows = rows.filter((r) => r.id !== id);
  },
  // The pipeline's default recordProvenance routes through sourceSwitchExtension;
  // here it writes the REAL integrity + contentHash onto the SAME canonical row
  // the dispatcher created — so a finalized row is observable on the row set.
  sourceSwitchExtension: async (id: string, source: Row["source"]) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new Error(`sourceSwitchExtension: no row ${id}`);
    r.source = source ? { ...source } : null;
    events.push(`provenance:${id}:${source?.integrity}`);
  },
}));

// Most tests run with NO required-in-prod packages. A single test flips a package
// into this set to drive the dispatcher's required-in-prod NEW-install branch
// (which creates the placeholder canonical row at status `locked`, not `active`).
const requiredInProdPackages = new Set<string>();
vi.mock("../required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => requiredInProdPackages.has(pkg),
}));

// Mock the host uiSurface resolver so the boot-path connector-handler
// wiring (resolveUiSurface → resolveConnectorUiSurfaceForPackage) is exercised
// end-to-end through the real dispatch WITHOUT a registry round-trip. A mutable
// verdict lets one test drive bundled-react; the default is schema-config (so
// other tests in this file that construct their own resolver are unaffected).
let connectorUiSurfaceVerdict: "schema-config" | "bundled-react" | null = "schema-config";
const resolveConnectorUiSurfaceForPackageSpy = vi.fn(async () => connectorUiSurfaceVerdict);
vi.mock("@/lib/connector-runtime-install-surface", () => ({
  resolveConnectorUiSurfaceForPackage: (...a: unknown[]) =>
    resolveConnectorUiSurfaceForPackageSpy(...(a as [])),
}));

// required-in-prod is imported by the dispatcher via `./required-in-prod`; the
// dispatcher lives in the extensions package, so the in-package relative path is
// what must be mocked. From the root vitest scope the dispatcher's own
// `./required-in-prod` resolves to packages/extensions/src/required-in-prod.ts —
// mock that subpath alias too so both resolve to the stub.
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => requiredInProdPackages.has(pkg),
}));

// runHostInstall now wraps the whole direct-install path in the per-package
// install lock (dynamically imported from @cinatra-ai/agents). Stub it as an
// inline passthrough so the heavy real module isn't loaded in this unit scope —
// serialization correctness is covered in the extensions-package dispatcher test.
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: (_packageName: string, fn: () => Promise<unknown>) => fn(),
}));

// ---------------------------------------------------------------------------
// Real modules under test.
// ---------------------------------------------------------------------------
import { extensionRegistry, setExtensionActivateHook } from "@cinatra-ai/extensions";
import {
  installExtensionFromRegistry,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { createConnectorExtensionHandler, ConnectorRequiresRebuildError } from "@cinatra-ai/extensions/connector-handler";
import type { Actor, PackageRef } from "@cinatra-ai/extensions";

const orgActor: Actor = { actorType: "system", userId: "u1", source: "worker", orgId: "org-1" } as Actor;
const ref = (name: string): PackageRef => ({ registryUrl: "https://registry.cinatra.ai", packageName: name, version: "1.0.0" });

// A real-shaped activate-hook body that drives the REAL install pipeline. Mirrors
// `runHostExtensionInstallAndActivate`: resolve the canonical row → reject a
// non-verdaccio source → run installExtensionFromRegistry → map installed→finalized.
// `pipelineLeaves` injects the registry/materialize/journal/activate leaves so the
// PIPELINE ORCHESTRATION is real, only its IO is faked.
function wireRealActivateHook(pipelineLeaves: () => Partial<InstallPipelineDeps>): void {
  setExtensionActivateHook(async (packageName, orgId) => {
    const target = rows.find(
      (r) => r.packageName === packageName && (r.organizationId ?? null) === (orgId ?? null) && (r.status === "active" || r.status === "locked"),
    );
    if (!target) return { finalized: false, activated: false, reason: "no-active-canonical-row" };
    if (!target.source || target.source.type !== "verdaccio") {
      return { activated: false, reason: "non-verdaccio-source" };
    }
    const version = target.source.version || "0.0.0";
    try {
      const deps: InstallPipelineDeps = {
        resolveIntegrity: async () => ({ integrity: "sha512-real", registryUrl: "https://registry.cinatra.ai" }),
        materialize: async () => ({ storeDir: `/store/${packageName}/digest`, digest: "digest", integrity: "sha512-real", contentHash: "real-content-hash" }),
        readRequestedPorts: async () => [],
        // The real default recordProvenance routes through sourceSwitchExtension —
        // here it writes onto the shared row set so the finalized row is observable.
        recordProvenance: async (p) => {
          const r = rows.find((x) => x.packageName === p.packageName && (x.organizationId ?? null) === (orgId ?? null) && (x.status === "active" || x.status === "locked"));
          if (!r) throw new Error("recordProvenance: no active row");
          r.source = { type: "verdaccio", registryUrl: p.registryUrl, integrity: p.integrity, contentHash: p.contentHash, version: p.version };
          events.push(`provenance:${r.id}:${p.integrity}`);
        },
        recordRequestedGrant: async () => {},
        approveGrant: async () => {},
        beginInstallOp: async () => { events.push(`journal:begin:${packageName}`); },
        advanceInstallOpPhase: async ({ phase }) => { events.push(`journal:${phase}:${packageName}`); },
        ...pipelineLeaves(),
      };
      const result = await installExtensionFromRegistry({ packageName, version, orgId: orgId ?? null }, deps);
      return { finalized: result.installed === true, activated: result.activated, ...(result.reason ? { reason: result.reason } : {}) };
    } catch (err) {
      return { finalized: false, activated: false, reason: `pipeline-threw:${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

beforeEach(() => {
  extensionRegistry._resetForTesting();
  rows = [];
  events.length = 0;
  installManifestImpl = null;
});

afterEach(() => {
  setExtensionActivateHook(null);
});

// ===========================================================================
// 1. A verdaccio NEW install through the REAL dispatch: row created, native
//    handler ran, real integrity recorded, journal finalized, activated — all
//    without restart (no mocked activate-hook).
// ===========================================================================
describe("public dispatch — verdaccio NEW connector install (real activate-hook + real pipeline)", () => {
  it("creates the row, runs the handler, records REAL integrity, finalizes the journal, and hot-activates", async () => {
    const handler = createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" });
    const installSpy = vi.spyOn(handler, "install");
    extensionRegistry.register(handler);
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));

    await extensionRegistry.install("connector", ref("@v/new-connector"), orgActor);

    // A single canonical row exists, finalized with the REAL provenance (the
    // placeholder `dispatcher-install` integrity was REPLACED by sha512-real).
    const final = rows.filter((r) => r.packageName === "@v/new-connector");
    expect(final).toHaveLength(1);
    expect(final[0].status).toBe("active");
    expect(final[0].source?.integrity).toBe("sha512-real");
    expect(final[0].source?.contentHash).toBe("real-content-hash");
    expect(final[0].organizationId, "row created at the actor's org scope").toBe("org-1");

    // The native handler ran (the model-B connector no-op), the journal reached
    // `finalized`, and the dispatch did NOT roll the row back.
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(events).toContain("journal:finalized:@v/new-connector");
    expect(events.some((e) => e.startsWith("deleteRow:"))).toBe(false);

    // Ordering: the canonical row was created BEFORE the journal began (so the
    // pipeline's provenance/finalize resolve the same row the dispatcher made).
    const createIdx = events.findIndex((e) => e.startsWith("createRow:"));
    const journalBeginIdx = events.indexOf("journal:begin:@v/new-connector");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(journalBeginIdx).toBeGreaterThan(createIdx);
  });
});

// ===========================================================================
// 2. Pipeline FAILURE on a NEW install (resolveIntegrity throws / materialize
//    fails) through the REAL dispatch: NO active placeholder row survives as a
//    success, install does NOT falsely report success, and a retry RE-RUNS the
//    pipeline (not skipped).
// ===========================================================================
describe("public dispatch — pipeline failure on a NEW install is truthful + retryable", () => {
  it("resolveIntegrity throws ⇒ dispatch throws, the placeholder row is rolled back, and a retry RE-RUNS the pipeline", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));

    // First attempt: the pipeline's resolveIntegrity throws BEFORE finalize.
    wireRealActivateHook(() => ({
      resolveIntegrity: async () => {
        throw new Error("registry unreachable");
      },
    }));

    await expect(
      extensionRegistry.install("connector", ref("@v/fail-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);

    // No active-but-non-anchorable row survives — the placeholder was rolled back.
    expect(rows.filter((r) => r.packageName === "@v/fail-connector"), "rolled back, nothing left as success").toHaveLength(0);
    expect(events.some((e) => e.startsWith("deleteRow:"))).toBe(true);

    // Second attempt: a healthy pipeline now finalizes. Because the prior row was
    // rolled back, this RE-CREATES + RE-RUNS the pipeline (a NEW createRow event).
    events.length = 0;
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));
    await extensionRegistry.install("connector", ref("@v/fail-connector"), orgActor);

    expect(events.some((e) => e.startsWith("createRow:")), "retry re-created the row").toBe(true);
    expect(events).toContain("journal:finalized:@v/fail-connector");
    const final = rows.filter((r) => r.packageName === "@v/fail-connector");
    expect(final).toHaveLength(1);
    expect(final[0].source?.integrity).toBe("sha512-real");
  });

  it("materialize fails ⇒ dispatch throws, the placeholder is rolled back, and a BROKEN non-finalized row left by an earlier crash is RE-RUN (not skipped)", async () => {
    // Seed a BROKEN prior row (placeholder integrity = a crash that never
    // finalized). A retry must RE-RUN the pipeline against it, not skip it.
    rows = [
      { id: "iext_broken", packageName: "@v/broken-connector", status: "active", organizationId: "org-1", source: { type: "verdaccio", integrity: "dispatcher-install", version: "1.0.0" } },
    ];
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));

    // First retry: materialize fails before finalize.
    wireRealActivateHook(() => ({
      materialize: async () => {
        throw new Error("materialize: SRI mismatch");
      },
    }));
    await expect(
      extensionRegistry.install("connector", ref("@v/broken-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);
    // The broken row was retried (no NEW createRow) and then rolled back on failure.
    expect(events.some((e) => e.startsWith("createRow:")), "broken row retried, not re-created").toBe(false);
    expect(rows.filter((r) => r.packageName === "@v/broken-connector"), "broken row rolled back").toHaveLength(0);

    // Second retry now succeeds: the pipeline finalizes a fresh row.
    events.length = 0;
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));
    await extensionRegistry.install("connector", ref("@v/broken-connector"), orgActor);
    expect(events).toContain("journal:finalized:@v/broken-connector");
    expect(rows.filter((r) => r.packageName === "@v/broken-connector")[0].source?.integrity).toBe("sha512-real");
  });
});

// ===========================================================================
// 3. WORKFLOW-kind install through the REAL dispatch: the canonical row exists
//    BEFORE the handler's provenance step, and the activate
//    hook is NOT fired (the workflow saga owns finalize) — no fail-closed
//    regression (a non-throwing handler completes the install).
// ===========================================================================
describe("public dispatch — WORKFLOW-kind install (row before provenance; no activate-hook; no fail-closed regression)", () => {
  it("the canonical row exists when the workflow handler runs, and the package-store activate hook never fires", async () => {
    let rowVisibleToHandler: Row | undefined;
    // A workflow handler stub that, like the real saga, reads the canonical row at
    // install time (its recordProvenance step needs it to already exist).
    const workflowHandler = {
      typeId: "workflow",
      install: vi.fn(async (r: PackageRef) => {
        events.push("workflow.install");
        rowVisibleToHandler = rows.find((x) => x.packageName === r.packageName);
      }),
      update: vi.fn(async () => {}),
      uninstall: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
    };
    extensionRegistry.register(workflowHandler);

    const activateSpy = vi.fn();
    setExtensionActivateHook(async (...a) => {
      activateSpy(...a);
      return { finalized: true, activated: true };
    });

    await extensionRegistry.install("workflow", ref("@v/a-workflow"), orgActor);

    // The handler saw the canonical row already created (row-before-handler).
    expect(workflowHandler.install).toHaveBeenCalledTimes(1);
    expect(rowVisibleToHandler, "canonical row existed before the workflow handler ran").toBeDefined();
    expect(rowVisibleToHandler?.organizationId).toBe("org-1");
    const createIdx = events.findIndex((e) => e.startsWith("createRow:"));
    const handlerIdx = events.indexOf("workflow.install");
    expect(createIdx).toBeLessThan(handlerIdx);

    // workflow is NOT in KINDS_USING_ACTIVATE_HOOK — the package-store activate
    // hook must NOT fire (the saga already finalized). No fail-closed regression:
    // the install completed without throwing and the row survives.
    expect(activateSpy, "workflow does not fire the package-store activate hook").not.toHaveBeenCalled();
    expect(rows.filter((r) => r.packageName === "@v/a-workflow")).toHaveLength(1);
  });
});

// ===========================================================================
// 4. schema-config (model-B) connector install through the REAL dispatch is
//    REACHABLE (does not throw); a bundled-react connector surfaces an explicit
//    requires-rebuild result (the typed ConnectorRequiresRebuildError) at the
//    dispatch boundary, never a generic crash.
// ===========================================================================
describe("public dispatch — connector model-B reachable / bundled-react requires-rebuild", () => {
  it("schema-config connector install is reachable through the dispatch (does not throw; row finalized)", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));

    await expect(
      extensionRegistry.install("connector", ref("@v/schema-connector"), orgActor),
    ).resolves.toBeUndefined();
    expect(rows.filter((r) => r.packageName === "@v/schema-connector")[0].source?.integrity).toBe("sha512-real");
  });

  it("bundled-react connector install surfaces the TYPED requires-rebuild at the dispatch (code REQUIRES_REBUILD), and rolls back the placeholder row", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "bundled-react" }));
    // The activate hook would finalize, but the handler throws FIRST (the dispatch
    // never reaches the activate hook for a bundled-react connector).
    const activateSpy = vi.fn();
    setExtensionActivateHook(async (...a) => {
      activateSpy(...a);
      return { finalized: true, activated: true };
    });

    await expect(
      extensionRegistry.install("connector", ref("@v/react-connector"), orgActor),
    ).rejects.toBeInstanceOf(ConnectorRequiresRebuildError);

    // The handler threw before the activate hook — and the placeholder row the
    // dispatch created this attempt was rolled back.
    expect(activateSpy, "activate hook never fired (handler threw first)").not.toHaveBeenCalled();
    expect(rows.filter((r) => r.packageName === "@v/react-connector"), "placeholder rolled back on handler throw").toHaveLength(0);
  });

  it("the connector handler wired EXACTLY as the boot paths wire it (resolveUiSurface → resolveConnectorUiSurfaceForPackage) surfaces requires-rebuild for bundled-react", async () => {
    // Proves the boot-path wiring SHAPE end-to-end through the REAL dispatch: a
    // connector handler whose resolveUiSurface delegates to the host
    // resolveConnectorUiSurfaceForPackage (the shape both src/lib/extensions.ts AND
    // packages/extensions/src/handler-bootstrap.ts use) reliably produces the typed
    // requires-rebuild — NOT a deps-less fail-open handler that enters the pipeline.
    connectorUiSurfaceVerdict = "bundled-react";
    resolveConnectorUiSurfaceForPackageSpy.mockClear();

    extensionRegistry.register(
      createConnectorExtensionHandler({
        resolveUiSurface: async (r) => {
          const { resolveConnectorUiSurfaceForPackage } = await import(
            "@/lib/connector-runtime-install-surface"
          );
          return resolveConnectorUiSurfaceForPackage(r.packageName, r.version);
        },
      }),
    );
    const activateSpy = vi.fn();
    setExtensionActivateHook(async (...a) => {
      activateSpy(...a);
      return { finalized: true, activated: true };
    });

    try {
      await expect(
        extensionRegistry.install("connector", ref("@v/wired-react-connector"), orgActor),
      ).rejects.toBeInstanceOf(ConnectorRequiresRebuildError);

      expect(resolveConnectorUiSurfaceForPackageSpy).toHaveBeenCalled();
      expect(activateSpy, "activate hook never fired — bundled-react gated before pipeline").not.toHaveBeenCalled();
      expect(
        rows.filter((r) => r.packageName === "@v/wired-react-connector"),
        "placeholder rolled back",
      ).toHaveLength(0);
    } finally {
      connectorUiSurfaceVerdict = "schema-config";
    }
  });
});

// ===========================================================================
// 5. extensions UPDATE through the REAL dispatch: a happy update re-runs the
//    pipeline + finalizes a NEW digest against the SAME row; a NEW-DIGEST-THAT-
//    FAILS-TO-FINALIZE leaves the previously-working install intact (ownsRollback
//    is false for an update of a healthy finalized row).
// ===========================================================================
describe("public dispatch — UPDATE re-runs the pipeline; a failing new digest leaves the old install intact", () => {
  it("update() of a healthy finalized row re-runs the pipeline + records the new provenance against the SAME row", async () => {
    rows = [
      { id: "iext_v1", packageName: "@v/upd-connector", status: "active", organizationId: "org-1", source: { type: "verdaccio", integrity: "sha512-v1", contentHash: "ch-v1", version: "1.0.0" } },
    ];
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    wireRealActivateHook(() => ({
      resolveIntegrity: async () => ({ integrity: "sha512-v2", registryUrl: "https://registry.cinatra.ai" }),
      materialize: async () => ({ storeDir: "/store/upd/v2", digest: "v2", integrity: "sha512-v2", contentHash: "ch-v2" }),
      recordProvenance: async (p) => {
        const r = rows.find((x) => x.id === "iext_v1");
        if (!r) throw new Error("no v1 row");
        r.source = { type: "verdaccio", registryUrl: p.registryUrl, integrity: "sha512-v2", contentHash: "ch-v2", version: p.version };
      },
      activateInProcess: async () => ({ activated: true }),
    }));

    await extensionRegistry.update("connector", ref("@v/upd-connector"), orgActor);

    // The SAME row was re-used (no new createRow) and now carries the v2 provenance.
    expect(events.some((e) => e.startsWith("createRow:")), "update reuses the existing row, never creates a new one").toBe(false);
    const r = rows.find((x) => x.id === "iext_v1");
    expect(r?.source?.integrity).toBe("sha512-v2");
    expect(r?.source?.contentHash).toBe("ch-v2");
  });

  it("a NEW digest that FAILS to finalize throws but leaves the previously-working install INTACT (no rollback of a healthy row)", async () => {
    rows = [
      { id: "iext_v1", packageName: "@v/upd-fail-connector", status: "active", organizationId: "org-1", source: { type: "verdaccio", integrity: "sha512-v1", contentHash: "ch-v1", version: "1.0.0" } },
    ];
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    // The new digest's materialize fails (pipeline never finalizes the v2 row).
    wireRealActivateHook(() => ({
      materialize: async () => {
        throw new Error("v2 materialize failed");
      },
    }));

    await expect(
      extensionRegistry.update("connector", ref("@v/upd-fail-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);

    // The previously-working install survives untouched — NOT rolled back, NOT
    // overwritten with v2 provenance (the recordProvenance never ran).
    expect(events.some((e) => e.startsWith("deleteRow:")), "healthy row never deleted on a failed update").toBe(false);
    const r = rows.find((x) => x.id === "iext_v1");
    expect(r, "old install row intact").toBeDefined();
    expect(r?.source?.integrity, "old v1 provenance preserved").toBe("sha512-v1");
    expect(r?.source?.contentHash).toBe("ch-v1");
  });

  it("an UPDATE whose NEW digest fails the PRE-FINALIZE activation gate throws BEFORE provenance/finalize — the old v1 provenance + store dir survive, and the bad new digest is GC'd", async () => {
    rows = [
      { id: "iext_v1", packageName: "@v/upd-prefinalize-connector", status: "active", organizationId: "org-1", source: { type: "verdaccio", integrity: "sha512-v1", contentHash: "ch-v1", version: "1.0.0" } },
    ];
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));

    let recordProvenanceCalled = false;
    let finalizeReached = false;
    const gcdDirs: string[] = [];
    wireRealActivateHook(() => ({
      resolveIntegrity: async () => ({ integrity: "sha512-v2", registryUrl: "https://registry.cinatra.ai" }),
      materialize: async () => ({ storeDir: "/store/upd-prefinalize/v2", digest: "v2", integrity: "sha512-v2", contentHash: "ch-v2" }),
      // The pre-finalize gate: this materialize SUPERSEDES the v1 digest, and the
      // new v2 digest does NOT activate (its register(ctx) throws).
      verifyActivatableBeforeFinalize: async () => ({ supersedes: true, ok: false, reason: "register-threw:new-digest-boom" }),
      gcStoreDir: async (dir: string) => {
        gcdDirs.push(dir);
      },
      // recordProvenance / advanceInstallOpPhase("finalized") must NEVER run for a
      // failed pre-finalize gate.
      recordProvenance: async () => {
        recordProvenanceCalled = true;
      },
      advanceInstallOpPhase: async ({ phase }: { phase: string }) => {
        if (phase === "finalized") finalizeReached = true;
        events.push(`journal:${phase}:@v/upd-prefinalize-connector`);
      },
      activateInProcess: async () => ({ activated: true }),
    }));

    await expect(
      extensionRegistry.update("connector", ref("@v/upd-prefinalize-connector"), orgActor),
    ).rejects.toThrow(/did not finalize|could not activate the new digest/);

    // The pre-finalize gate fired BEFORE provenance + finalize: neither ran.
    expect(recordProvenanceCalled, "provenance NOT overwritten on a failed pre-finalize gate").toBe(false);
    expect(finalizeReached, "journal NOT finalized on a failed pre-finalize gate").toBe(false);
    // NO journal write for this attempt: `beginInstallOp` never ran (it would
    // upsert-clobber the old install's `finalized` op), so nothing is journaled
    // for the failed attempt — the journal stays the OLD install's `finalized`
    // row. The bad new digest is GC'd.
    expect(events).not.toContain("journal:begin:@v/upd-prefinalize-connector");
    expect(events).not.toContain("journal:failed:@v/upd-prefinalize-connector");
    expect(gcdDirs, "the failed new digest dir was GC'd").toContain("/store/upd-prefinalize/v2");

    // The previously-working install survives untouched — old v1 provenance pinned,
    // row never deleted.
    expect(events.some((e) => e.startsWith("deleteRow:")), "healthy row never deleted").toBe(false);
    const r = rows.find((x) => x.id === "iext_v1");
    expect(r?.source?.integrity, "old v1 provenance preserved (durably intact)").toBe("sha512-v1");
    expect(r?.source?.contentHash).toBe("ch-v1");
  });

  it("a FRESH install (no superseding digest) is unaffected by the pre-finalize gate — it finalizes + activates", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    let finalizeReached = false;
    wireRealActivateHook(() => ({
      // A fresh install: no superseding digest → the gate is a no-op (supersedes:false).
      verifyActivatableBeforeFinalize: async () => ({ supersedes: false }),
      advanceInstallOpPhase: async ({ phase }: { phase: string }) => {
        if (phase === "finalized") finalizeReached = true;
        events.push(`journal:${phase}:@v/fresh-prefinalize-connector`);
      },
      activateInProcess: async () => ({ activated: true }),
    }));

    await extensionRegistry.install("connector", ref("@v/fresh-prefinalize-connector"), orgActor);

    expect(finalizeReached, "a fresh install still finalizes").toBe(true);
    const final = rows.filter((r) => r.packageName === "@v/fresh-prefinalize-connector");
    expect(final).toHaveLength(1);
    expect(final[0].source?.integrity).toBe("sha512-real");
  });
});

// ===========================================================================
// 6. The activate-hook returning finalized:false (anchor refused the NEW digest)
//    through the REAL dispatch on a fresh install rolls back the placeholder; on
//    an UPDATE of a healthy row it throws but preserves the old install.
// ===========================================================================
describe("public dispatch — anchor-refused (finalized:false) new install rolls back; update preserves the old", () => {
  it("a fresh connector install that FINALIZES but whose in-process activation is REFUSED THROWS (no placeholder-as-success) and leaves the committed install intact", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    // The pipeline finalizes (installed:true) but in-process activation is refused
    // (activated:false). The owner-locked invariant is "install MUST hot-activate
    // in-process with NO restart" — so a finalized-but-not-activated connector is
    // NOT a success: the dispatch THROWS a truthful "did NOT hot-activate" error.
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: false, reason: "anchor-refused" }) }));

    await expect(
      extensionRegistry.install("connector", ref("@v/refused-connector"), orgActor),
    ).rejects.toThrow(/did NOT\s+hot-activate in-process/);

    // The COMMITTED + finalized install is NOT rolled back (it is real + anchorable;
    // the boot loader is the durable path) — only the in-process load missed.
    const final = rows.filter((r) => r.packageName === "@v/refused-connector");
    expect(final).toHaveLength(1);
    expect(final[0].source?.integrity).toBe("sha512-real");
    expect(events).toContain("journal:finalized:@v/refused-connector");
    expect(events.some((e) => e.startsWith("deleteRow:")), "finalized row NOT rolled back").toBe(false);
  });
});

// ===========================================================================
// 7. A github/local skill ref (owner/repo) through the REAL dispatch
//    creates NO verdaccio placeholder canonical row (the carve-out) and never
//    fires the activate hook; the handler owns the install.
// ===========================================================================
describe("public dispatch — github/local skill carve-out (no verdaccio placeholder row)", () => {
  it("a GitHub skill ref (owner/repo, no version) creates NO canonical row + never fires the activate hook", async () => {
    const installSpy = vi.fn(async () => {
      events.push("skill.install");
    });
    const skillHandler = {
      typeId: "skill",
      install: installSpy,
      update: vi.fn(async () => {}),
      uninstall: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
    };
    extensionRegistry.register(skillHandler);
    const activateSpy = vi.fn();
    setExtensionActivateHook(async (...a) => {
      activateSpy(...a);
      return { finalized: true, activated: true };
    });

    await extensionRegistry.install(
      "skill",
      { registryUrl: "", packageName: "acme/cool-skill", version: "" },
      orgActor,
    );

    // The handler ran (it owns the github install) — but NO verdaccio placeholder
    // canonical row was ever created, and the activate hook never fired.
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.startsWith("createRow:")), "no placeholder canonical row").toBe(false);
    expect(rows.filter((r) => r.packageName === "acme/cool-skill"), "no stranded verdaccio row").toHaveLength(0);
    expect(activateSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8. A canonical-store failure on a CONNECTOR install through the
//    REAL dispatch FAILS CLOSED (throws), never a silent placeholder success.
// ===========================================================================
describe("public dispatch — canonical-store failure on a connector install fails closed", () => {
  it("a row-create failure (installExtensionManifest throws) on a connector install THROWS — no pipeline, no silent success", async () => {
    extensionRegistry.register(createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }));
    const activateSpy = vi.fn();
    setExtensionActivateHook(async (...a) => {
      activateSpy(...a);
      return { finalized: true, activated: true };
    });
    // Force the canonical row-create to fail (e.g. provenance validation) — the
    // dispatcher must NOT swallow this into a placeholder success for a connector.
    installManifestImpl = async () => {
      throw new Error("source provenance invalid");
    };

    await expect(
      extensionRegistry.install("connector", ref("@v/store-fail-connector"), orgActor),
    ).rejects.toThrow(/could not ensure its canonical install row/);

    // No row landed, the pipeline never fired.
    expect(rows.filter((r) => r.packageName === "@v/store-fail-connector")).toHaveLength(0);
    expect(activateSpy).not.toHaveBeenCalled();
    installManifestImpl = null;
  });
});

// ===========================================================================
// 9. A REQUIRED-IN-PROD new install creates its
//    placeholder canonical row at status `locked` (not `active`) in non-dev mode.
//    A non-finalizing pipeline MUST still roll that LOCKED placeholder back —
//    otherwise a failed prod install strands a live `locked` non-anchorable row
//    that (a) the rollback-only primitive would refuse to drop and (b) the
//    required-in-prod boot verification (which counts any active|locked row as
//    installed) would falsely treat as satisfied. Drives the REAL public dispatch.
// ===========================================================================
describe("public dispatch — required-in-prod LOCKED placeholder rollback", () => {
  const PRIOR_MODE = process.env.CINATRA_RUNTIME_MODE;
  beforeEach(() => {
    // Force non-dev so the dispatcher's `requiredInProd && !isDev` branch creates
    // the placeholder at status `locked`.
    process.env.CINATRA_RUNTIME_MODE = "production";
  });
  afterEach(() => {
    requiredInProdPackages.clear();
    if (PRIOR_MODE === undefined) delete process.env.CINATRA_RUNTIME_MODE;
    else process.env.CINATRA_RUNTIME_MODE = PRIOR_MODE;
  });

  it("a non-finalizing pipeline ROLLS BACK the LOCKED placeholder (no stranded non-anchorable locked row) and a retry RE-RUNS the pipeline to finalize", async () => {
    requiredInProdPackages.add("@v/required-connector");
    extensionRegistry.register(
      createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }),
    );

    // First attempt: the pipeline fails before finalize (resolveIntegrity throws).
    wireRealActivateHook(() => ({
      resolveIntegrity: async () => {
        throw new Error("registry unreachable");
      },
    }));

    await expect(
      extensionRegistry.install("connector", ref("@v/required-connector"), orgActor),
    ).rejects.toThrow(/did not finalize/);

    // The placeholder was created at status `locked` (required-in-prod) AND was
    // still rolled back — nothing left as a live-but-non-anchorable locked row.
    // (The rollback primitive must NOT refuse a non-finalized locked row, or it
    // would strand it.)
    expect(events.some((e) => e.startsWith("createRow:")), "locked placeholder created").toBe(true);
    expect(events.some((e) => e.startsWith("deleteRow:")), "locked placeholder rolled back").toBe(true);
    expect(
      rows.filter((r) => r.packageName === "@v/required-connector"),
      "no stranded locked non-anchorable row",
    ).toHaveLength(0);

    // Retry: a healthy pipeline finalizes. The placeholder is re-created at `locked`
    // again and the pipeline records REAL provenance → the row is genuinely anchorable.
    events.length = 0;
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));
    await extensionRegistry.install("connector", ref("@v/required-connector"), orgActor);

    expect(events).toContain("journal:finalized:@v/required-connector");
    const final = rows.filter((r) => r.packageName === "@v/required-connector");
    expect(final).toHaveLength(1);
    expect(final[0].status, "required-in-prod row stays locked").toBe("locked");
    expect(final[0].source?.integrity).toBe("sha512-real");
  });

  it("a BROKEN (placeholder-integrity) LOCKED row left by an earlier crash is RE-RUN by a retry, not skipped or stranded", async () => {
    requiredInProdPackages.add("@v/required-broken-connector");
    // Seed a broken prior row at status `locked` with placeholder integrity — a
    // required-in-prod install that crashed between create and finalize.
    rows = [
      {
        id: "iext_req_broken",
        packageName: "@v/required-broken-connector",
        status: "locked",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "dispatcher-install", version: "1.0.0" },
      },
    ];
    extensionRegistry.register(
      createConnectorExtensionHandler({ resolveUiSurface: async () => "schema-config" }),
    );
    wireRealActivateHook(() => ({ activateInProcess: async () => ({ activated: true }) }));

    await extensionRegistry.install("connector", ref("@v/required-broken-connector"), orgActor);

    // The broken locked row was RETRIED (no NEW createRow) and the pipeline
    // finalized it with REAL provenance — it is now genuinely anchorable.
    expect(events.some((e) => e.startsWith("createRow:")), "broken locked row retried, not re-created").toBe(false);
    expect(events).toContain("journal:finalized:@v/required-broken-connector");
    const final = rows.filter((r) => r.packageName === "@v/required-broken-connector");
    expect(final).toHaveLength(1);
    expect(final[0].source?.integrity).toBe("sha512-real");
  });
});
