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
}));

// The dispatcher reads/writes the canonical manifest
// (assertNoLockedCanonicalRow, assertCanonicalArchiveClosure,
// syncCanonicalManifestTransition, checkDependents → readEffectiveStatus).
// Mock the canonical store so these tests isolate the DISPATCH contract without
// a live DB. Defaults: no installed rows (no lock, no closure block), empty
// effective-status map (dependents default to "active" = fail-safe block).
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => []),
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map<string, "active" | "archived">()),
}));

import {
  readEffectiveStatusByPackageNames,
} from "../canonical-store";

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
