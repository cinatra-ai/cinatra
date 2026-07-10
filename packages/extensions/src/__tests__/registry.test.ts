import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extensionRegistry,
  ActiveDependentError,
} from "../index";
import { setExtensionDataTeardownHook } from "../data-teardown-hook";
import { makeHandler, makeRef, makeActor } from "./__mocks__/extension-handler";

// ---------------------------------------------------------------------------
// Mock @cinatra-ai/agents for registry predicate and cascade tests
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  countRunsForTemplate: vi.fn(),
  readAgentTemplatesDependingOn: vi.fn(),
  // forceDelete deps (additive — unused by the pre-existing tests):
  withInstallLock: (_name: string, fn: () => unknown) => fn(),
  removeReferencingRunRows: vi.fn(async () => {}),
}));

// forceDelete writes an audit row + computes dangling refs before destruction.
// Mock so the dispatch-fires-teardown test runs without a live DB.
vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({})),
  writeExtensionLifecycleAuditEntry: vi.fn(async () => {}),
  // P5 (cinatra#1130): the durable per-transition audit written by the
  // row-scoped archive/restore/soft-uninstall path.
  writeExtensionLifecycleTransitionAudit: vi.fn(async () => {}),
}));

// The dispatcher reads/writes the canonical manifest
// (assertNoLockedCanonicalRow, assertCanonicalArchiveClosure,
// syncCanonicalManifestTransition, checkDependents → readEffectiveStatus).
// Mock the canonical store so these tests isolate the DISPATCH contract without
// a live DB. Defaults: no installed rows (no lock, no closure block), empty
// effective-status map (dependents default to "active" = fail-safe block).
// P5 (cinatra#1130): the destructive dispatcher now RESOLVES a single canonical
// row (org-equality) + gates standing before transitioning. Seed ONE platform
// NULL-org row per package so the default platform-admin contract actor
// resolves a target and the pre-existing branch/predicate assertions still run
// (a NULL-org row is addressable only by a platform admin — makeActor is one).
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async (pkg: string) => [
    {
      id: "iext_seed",
      packageName: pkg,
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
      kind: "agent",
      status: "active",
      source: { type: "verdaccio", version: "1.0.0" },
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]),
  readInstalledExtensionById: vi.fn(async () => null),
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map<string, "active" | "archived">()),
}));

// cinatra#793: the store-routed kinds (agent/skill/artifact/connector) ensure a
// canonical row + fire the store pipeline on install/update. Mock the lifecycle
// primitive + activate hook so these DISPATCH-contract tests stay DB-free (the
// ordering/rollback/compensation semantics are pinned in
// dispatcher-install-ordering.test.ts, not here).
vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: vi.fn(async () => ({})),
  transitionExtensionLifecycle: vi.fn(async () => null),
  deleteNonFinalizedCanonicalRow: vi.fn(async () => {}),
}));
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: vi.fn(async () => ({
    finalized: true,
    activated: false,
    reason: "metadata-only-kind",
  })),
}));

import {
  readEffectiveStatusByPackageNames,
} from "../canonical-store";
// Mocked audit helpers (see vi.mock("../audit-log") above) — imported so the
// provenance-parity tests can assert the dispatcher's calls into them.
import {
  writeExtensionLifecycleAuditEntry,
  computeDanglingReferences,
} from "../audit-log";

// ---------------------------------------------------------------------------
// Helper to set up the predicate mocks for a given scenario
// ---------------------------------------------------------------------------
import {
  readAgentTemplateByPackageName,
  countRunsForTemplate,
  readAgentTemplatesDependingOn,
} from "@cinatra-ai/agents";

function mockNeverUsedNoDepScenario() {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

function mockUsedScenario() {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-1" });
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

function mockActiveDependentScenario(depName = "dep-agent") {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([
    { extensionLifecycleStatus: "active", name: depName, packageName: depName },
  ]);
}

// Never used (0 runs) but a template row EXISTS → platform-admin hard-delete
// branch with a non-null destroyed-row snapshot to prove the provenance entry
// carries it.
function mockNeverUsedWithTemplateScenario() {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-x" });
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

function mockArchivedDependentOnlyScenario() {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([
    { name: "dep-archived", packageName: "dep-archived" },
  ]);
  // checkDependents resolves status from the canonical manifest, not the
  // per-kind field. Mark the dependent archived.
  (readEffectiveStatusByPackageNames as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map<string, "active" | "archived">([["dep-archived", "archived"]]),
  );
}

describe("ExtensionRegistry", () => {
  beforeEach(() => {
    extensionRegistry._resetForTesting();
    vi.clearAllMocks();
  });

  it("install dispatches to the registered handler with ref and actor", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.install("agent", ref, actor);
    // install receives options?: {destination?} as third arg; undefined is forwarded.
    expect(handler.install).toHaveBeenCalledWith(ref, actor, undefined);
  });

  it("update dispatches to the registered handler with ref and actor", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.update("agent", ref, actor);
    expect(handler.update).toHaveBeenCalledWith(ref, actor);
  });

  it("uninstall calls handler.uninstall when extension never used and no dependents", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    mockNeverUsedNoDepScenario();
    await extensionRegistry.uninstall("agent", ref, actor);
    expect(handler.uninstall).toHaveBeenCalledWith(ref, actor);
    expect(handler.archive).not.toHaveBeenCalled();
  });

  it("uninstall calls handler.archive when extensionHasBeenUsed returns true", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    mockUsedScenario();
    await extensionRegistry.uninstall("agent", ref, actor);
    expect(handler.archive).toHaveBeenCalledWith(ref, actor);
    expect(handler.uninstall).not.toHaveBeenCalled();
  });

  it("uninstall throws ActiveDependentError when readAgentTemplatesDependingOn returns an active dep", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    mockActiveDependentScenario("dep-agent");
    await expect(extensionRegistry.uninstall("agent", ref, actor)).rejects.toThrow(
      ActiveDependentError,
    );
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(handler.archive).not.toHaveBeenCalled();
  });

  it("uninstall calls handler.archive when only archived deps exist and the extension itself is unused (closure preservation)", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    mockArchivedDependentOnlyScenario();
    await extensionRegistry.uninstall("agent", ref, actor);
    expect(handler.archive).toHaveBeenCalledWith(ref, actor);
    expect(handler.uninstall).not.toHaveBeenCalled();
  });

  it("archive method delegates to handler.archive without predicate/cascade checks", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.archive("agent", ref, actor);
    expect(handler.archive).toHaveBeenCalledWith(ref, actor);
    // No @cinatra-ai/agents calls should have been made
    expect(readAgentTemplatesDependingOn).not.toHaveBeenCalled();
    expect(readAgentTemplateByPackageName).not.toHaveBeenCalled();
  });

  it("restore method delegates to handler.restore", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.restore("agent", ref, actor);
    expect(handler.restore).toHaveBeenCalledWith(ref, actor);
  });

  // cinatra#1036 — the dispatcher is the fail-closed BACKSTOP for the removal
  // rule (behind the user-facing action guards): a host-declared system
  // extension is refused on every destructive primitive by MEMBERSHIP, even
  // when the canonical store reports NO locked row (the mock returns []), and
  // the per-kind handler is never reached. Uses a real system package name.
  describe("system-extension removal backstop", () => {
    const SYSTEM_PKG = "@cinatra-ai/nango-connector";
    const REMOVAL_COPY = /can be updated but not deleted/;

    it("uninstall refuses a system extension (membership, not row-lock) and never calls the handler", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const actor = makeActor();
      await expect(
        extensionRegistry.uninstall("agent", makeRef(SYSTEM_PKG), actor),
      ).rejects.toThrow(REMOVAL_COPY);
      expect(handler.uninstall).not.toHaveBeenCalled();
      expect(handler.archive).not.toHaveBeenCalled();
    });

    it("archive refuses a system extension and never calls the handler", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      await expect(
        extensionRegistry.archive("agent", makeRef(SYSTEM_PKG), makeActor()),
      ).rejects.toThrow(REMOVAL_COPY);
      expect(handler.archive).not.toHaveBeenCalled();
    });

    it("forceDelete refuses a system extension and never calls the handler", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      await expect(
        extensionRegistry.forceDelete("agent", makeRef(SYSTEM_PKG), makeActor()),
      ).rejects.toThrow(REMOVAL_COPY);
      expect(handler.uninstall).not.toHaveBeenCalled();
    });

    // Non-system packages are UNAFFECTED — the backstop keys on host membership,
    // not on being "an extension". (update-in-place for a system extension is
    // proven end-to-end against a mocked registry in the actions suite.)
    it("uninstall of a non-system package is NOT blocked by the system backstop", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      mockNeverUsedNoDepScenario();
      await extensionRegistry.uninstall("agent", makeRef("@acme/normal-ext"), makeActor());
      expect(handler.uninstall).toHaveBeenCalled();
    });
  });

  // Durable data-teardown wiring: the dispatcher must fire the host-injected
  // data-teardown hook on HARD removal (uninstall hard-delete branch +
  // forceDelete) and must NOT fire it on the archive branch (archived
  // extensions are restorable and keep their org-scoped config).
  describe("durable data-teardown firing", () => {
    let fired: string[];
    beforeEach(() => {
      fired = [];
      setExtensionDataTeardownHook((pkg) => {
        fired.push(pkg);
      });
    });
    afterEach(() => setExtensionDataTeardownHook(null));

    it("uninstall HARD-DELETE branch fires the data-teardown hook", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      mockNeverUsedNoDepScenario();
      await extensionRegistry.uninstall("agent", ref, makeActor());
      expect(handler.uninstall).toHaveBeenCalled();
      expect(fired).toEqual([ref.packageName]);
    });

    it("uninstall ARCHIVE branch does NOT fire the data-teardown hook (config preserved for restore)", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      mockUsedScenario(); // used → archive, not hard-delete
      await extensionRegistry.uninstall("agent", ref, makeActor());
      expect(handler.archive).toHaveBeenCalled();
      expect(handler.uninstall).not.toHaveBeenCalled();
      expect(fired).toEqual([]);
    });

    it("forceDelete fires the data-teardown hook", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      await extensionRegistry.forceDelete("agent", ref, makeActor());
      expect(handler.uninstall).toHaveBeenCalled();
      expect(fired).toEqual([ref.packageName]);
    });
  });

  // cinatra#1276 — audit-entry parity for the platform-admin hard-delete
  // uninstall branch. That path tears down the handler backing AND fires durable
  // org-scoped data teardown, so it must write the same richer pre-destruction
  // provenance entry forceDelete writes (destroyed-row snapshot + dangling
  // references + resolved-row identities) BEFORE the destructive calls — a
  // provenance-write failure aborts the destroy. The archive (soft) branch
  // writes NO such entry, and forceDelete's force_delete provenance is unchanged.
  describe("hard-delete uninstall provenance parity (#1276)", () => {
    let fired: string[];
    beforeEach(() => {
      fired = [];
      setExtensionDataTeardownHook((pkg) => {
        fired.push(pkg);
      });
    });
    afterEach(() => setExtensionDataTeardownHook(null));

    it("writes the uninstall provenance entry (snapshot + dangling refs) BEFORE handler.uninstall and data-teardown", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      const actor = makeActor();
      mockNeverUsedWithTemplateScenario();
      const dangling = {
        agent_runs_count: 0,
        agent_runs_count_capped: false,
        dependent_extensions: [],
        dependent_extensions_capped: false,
      };
      (computeDanglingReferences as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dangling);

      await extensionRegistry.uninstall("agent", ref, actor);

      // Persisted with operation "uninstall", the destroyed-row snapshot, the
      // computed dangling references, the resolvable actor (identity carrier),
      // and the resolved-row identities of every canonical row removed.
      expect(writeExtensionLifecycleAuditEntry).toHaveBeenCalledTimes(1);
      expect(writeExtensionLifecycleAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          actor,
          operation: "uninstall",
          packageRef: ref,
          destroyedRowSnapshot: { id: "tpl-x" },
          danglingReferences: dangling,
          resolvedRows: expect.any(Array),
        }),
      );
      // Provenance is written BEFORE the destructive calls (so a write failure
      // aborts the destroy).
      const writeOrder = (writeExtensionLifecycleAuditEntry as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const uninstallOrder = (handler.uninstall as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(uninstallOrder);
      expect(fired).toEqual([ref.packageName]);
    });

    it("aborts the destroy when the provenance write fails (handler.uninstall + data-teardown never run)", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      mockNeverUsedWithTemplateScenario();
      (writeExtensionLifecycleAuditEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("audit insert failed"),
      );

      await expect(
        extensionRegistry.uninstall("agent", ref, makeActor()),
      ).rejects.toThrow("audit insert failed");

      expect(handler.uninstall).not.toHaveBeenCalled();
      expect(fired).toEqual([]);
    });

    it("does NOT write an uninstall provenance entry on the archive (soft) branch", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      mockUsedScenario(); // used → archive, not hard-delete

      await extensionRegistry.uninstall("agent", ref, makeActor());

      expect(handler.archive).toHaveBeenCalled();
      expect(handler.uninstall).not.toHaveBeenCalled();
      expect(writeExtensionLifecycleAuditEntry).not.toHaveBeenCalled();
      expect(fired).toEqual([]);
    });

    it("forceDelete still writes its force_delete provenance entry (unchanged)", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      const ref = makeRef();
      mockNeverUsedNoDepScenario();

      await extensionRegistry.forceDelete("agent", ref, makeActor());

      expect(writeExtensionLifecycleAuditEntry).toHaveBeenCalledTimes(1);
      expect(writeExtensionLifecycleAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "force_delete", packageRef: ref }),
      );
    });
  });

  it("install rejects with clear error when no handler is registered for typeId", async () => {
    await expect(
      extensionRegistry.install("missing", makeRef(), makeActor()),
    ).rejects.toThrow(
      `No extension handler registered for typeId: "missing"`,
    );
  });

  it("update rejects with clear error when no handler is registered for typeId", async () => {
    await expect(
      extensionRegistry.update("missing", makeRef(), makeActor()),
    ).rejects.toThrow(
      `No extension handler registered for typeId: "missing"`,
    );
  });

  it("uninstall rejects with clear error when no handler is registered for typeId", async () => {
    // No mocks needed — resolve fails before predicate is called
    await expect(
      extensionRegistry.uninstall("missing", makeRef(), makeActor()),
    ).rejects.toThrow(
      `No extension handler registered for typeId: "missing"`,
    );
  });

  it("registering a second handler for the same typeId replaces the first (idempotent set semantics)", async () => {
    const handlerA = makeHandler("agent");
    const handlerB = makeHandler("agent");
    extensionRegistry.register(handlerA);
    extensionRegistry.register(handlerB);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.install("agent", ref, actor);
    // install receives options?: {destination?} as third arg; undefined is forwarded.
    expect(handlerB.install).toHaveBeenCalledWith(ref, actor, undefined);
    expect(handlerA.install).not.toHaveBeenCalled();
  });

  it("validate delegates to handler.validate when present", async () => {
    const handler = {
      ...makeHandler("skill"),
      validate: vi.fn().mockResolvedValue({ valid: false, errors: ["bad"] }),
    };
    extensionRegistry.register(handler);
    const result = await extensionRegistry.validate("skill", { foo: "bar" });
    expect(result).toEqual({ valid: false, errors: ["bad"] });
  });

  it("validate returns {valid:true} when handler has no validate method", async () => {
    extensionRegistry.register(makeHandler("connector"));
    const result = await extensionRegistry.validate("connector", {});
    expect(result).toEqual({ valid: true });
  });

  it("validate rejects when no handler registered for typeId", async () => {
    await expect(extensionRegistry.validate("missing", {})).rejects.toThrow(
      `No extension handler registered for typeId: "missing"`,
    );
  });
});
