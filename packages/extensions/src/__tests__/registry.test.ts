import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extensionRegistry,
  ActiveDependentError,
  ExpectedInstalledVersionMismatchError,
  resolveLiveInstalledVersionForCas,
  PlatformArtifactLifecycleOrgInstallsError,
} from "../index";
import { setExtensionDataTeardownHook } from "../data-teardown-hook";
import { setExtensionArtifactClaimArchivalHook } from "../artifact-claim-lifecycle-hook";
import { setExtensionArtifactClaimReactivationHook } from "../artifact-claim-lifecycle-hook";
import { setExtensionArtifactClaimArchivalAllScopesHook } from "../artifact-claim-lifecycle-hook";
import { transitionExtensionLifecycle } from "../lifecycle-primitive";
import { makeHandler, makeRef, makeActor } from "./__mocks__/extension-handler";

// ---------------------------------------------------------------------------
// Mock @cinatra-ai/agents for registry predicate and cascade tests
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  countRunsForTemplate: vi.fn(),
  readAgentTemplatesDependingOn: vi.fn(),
  // forceDelete deps (additive — unused by the pre-existing tests). A vi.fn
  // pass-through so cinatra#1837 R4a lock-wrapping can be asserted.
  withInstallLock: vi.fn((_name: string, fn: () => unknown) => fn()),
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
  readInstalledExtensionsByPackageName,
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
  withInstallLock,
} from "@cinatra-ai/agents";

function mockNeverUsedNoDepScenario() {
  (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (countRunsForTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (readAgentTemplatesDependingOn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

// Restore the module-default platform (NULL-org) seed row. A `mockImplementation`
// override survives `vi.clearAllMocks()` (which clears calls, not implementations),
// so any block that reseeds `readInstalledExtensionsByPackageName` must restore
// this default in beforeEach + afterEach or it leaks into later tests (cinatra#1837).
function restoreDefaultInstalledRows() {
  vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async (pkg: string) => [
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
    } as never,
  ]);
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

  // #1042 slice-1: expected-version CAS threaded through the shared registry
  // dispatch. The seeded canonical row is version "1.0.0" at NULL-org scope
  // (makeActor is a NULL-org platform admin).
  it("update with a MATCHING expectedInstalledVersion proceeds (handler.update runs)", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    await extensionRegistry.update("agent", ref, actor, { expectedInstalledVersion: "1.0.0" });
    expect(handler.update).toHaveBeenCalledWith(ref, actor);
  });

  it("update with a STALE expectedInstalledVersion refuses (CAS) BEFORE the handler — fail-closed, no double-apply", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const ref = makeRef();
    const actor = makeActor();
    // The live installed version is "1.0.0" (seed); the caller expected "0.9.0"
    // (a concurrent update already advanced it) → refuse without mutating.
    await expect(
      extensionRegistry.update("agent", ref, actor, { expectedInstalledVersion: "0.9.0" }),
    ).rejects.toBeInstanceOf(ExpectedInstalledVersionMismatchError);
    expect(handler.update).not.toHaveBeenCalled();
  });

  it("update CAS fails closed when the scope has more than one live row (ambiguous)", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const canonicalStore = await import("../canonical-store");
    vi.mocked(canonicalStore.readInstalledExtensionsByPackageName).mockResolvedValueOnce([
      {
        id: "r1",
        packageName: "@cinatra/my-pkg",
        organizationId: null,
        status: "active",
        source: { type: "verdaccio", version: "1.0.0" },
      },
      {
        id: "r2",
        packageName: "@cinatra/my-pkg",
        organizationId: null,
        status: "active",
        source: { type: "verdaccio", version: "1.0.0" },
      },
    ] as never);
    await expect(
      extensionRegistry.update("agent", makeRef(), makeActor(), {
        expectedInstalledVersion: "1.0.0",
      }),
    ).rejects.toBeInstanceOf(ExpectedInstalledVersionMismatchError);
    expect(handler.update).not.toHaveBeenCalled();
  });

  it("update WITHOUT expectedInstalledVersion never runs the CAS (byte-unchanged manual path)", async () => {
    const handler = makeHandler("agent");
    extensionRegistry.register(handler);
    const canonicalStore = await import("../canonical-store");
    // Even with a wildly different live version, no option → no CAS → proceeds.
    vi.mocked(canonicalStore.readInstalledExtensionsByPackageName).mockResolvedValueOnce([
      {
        id: "r1",
        packageName: "@cinatra/my-pkg",
        organizationId: null,
        status: "active",
        source: { type: "verdaccio", version: "5.5.5" },
      },
    ] as never);
    await extensionRegistry.update("agent", makeRef(), makeActor());
    expect(handler.update).toHaveBeenCalled();
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

  // cinatra#1454 — the dispatcher fires the FAIL-CLOSED artifact claim-archival
  // seam on the archive transition of a `kind:"artifact"` extension BEFORE it
  // commits the durable row transition, so an archival failure aborts the archive
  // (the extension is never archived while its object-type claims / governed rows
  // stay live). The ORG-SCOPED path fires the org:<id> scope. The PLATFORM
  // (NULL-org) path is gated by the OWNER RULING 2026-07-22 (groganz): it REFUSES
  // while any org still has the extension installed (naming those orgs) and only
  // otherwise proceeds at the platform scope. Never fires for a non-artifact kind.
  describe("artifact claim-archival firing (#1454)", () => {
    // An ORG-ADMIN actor + an org-scoped canonical row so the dispatcher resolves
    // an org:<id> claim scope (the scope-exact, wired path).
    const ORG = "org-7";
    const orgAdmin = {
      actorType: "system" as const,
      userId: "user-9",
      source: "worker" as const,
      orgId: ORG,
      orgRole: "org_admin" as const,
    };
    // Seed an ORG row for the wired-path tests (implementation-based so it cleanly
    // overrides the default within a single test).
    const seedOrgRow = (pkg: string) =>
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async () => [
        {
          id: "iext_org",
          packageName: pkg,
          ownerLevel: "org",
          ownerId: null,
          organizationId: ORG,
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "2.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      ]);
    // Restore the module-default platform (NULL-org) seed row so neither an
    // intra-describe nor a cross-describe test inherits a `seedOrgRow` override.
    const restoreDefaultRows = () =>
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async (pkg: string) => [
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
        } as never,
      ]);

    let fired: unknown[];
    beforeEach(() => {
      fired = [];
      setExtensionArtifactClaimArchivalHook((input) => {
        fired.push(input);
      });
      restoreDefaultRows();
    });
    afterEach(() => {
      setExtensionArtifactClaimArchivalHook(null);
      restoreDefaultRows();
    });

    it("explicit ORG-SCOPED archive of a kind:'artifact' extension fires the seam (scope = the org row)", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgRow("@v/pkg-artifact");
      await extensionRegistry.archive("artifact", makeRef("@v/pkg-artifact"), orgAdmin);
      expect(fired).toEqual([
        expect.objectContaining({
          packageName: "@v/pkg-artifact",
          organizationId: ORG,
          installId: "iext_org",
          extensionVersion: "2.0.0", // source.version precedence
          actorPrincipalId: "user-9",
        }),
      ]);
    });

    it("an ORG-ADMIN soft uninstall (archive path) fires the claim-archival seam", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgRow("@v/pkg-artifact");
      await extensionRegistry.uninstall("artifact", makeRef("@v/pkg-artifact"), orgAdmin);
      expect(fired).toEqual([expect.objectContaining({ packageName: "@v/pkg-artifact", organizationId: ORG })]);
    });

    it("OWNER RULING: a platform (NULL-org) archive PROCEEDS at platform scope when NO org has it installed", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      // The default seed is the SOLE platform (NULL-org) row — no org install to
      // block. A platform admin resolves it; the archival fires at platform scope.
      await extensionRegistry.archive("artifact", makeRef("@v/pkg-artifact"), makeActor());
      expect(fired).toEqual([
        expect.objectContaining({ packageName: "@v/pkg-artifact", organizationId: null }),
      ]);
    });

    it("OWNER RULING: a platform (NULL-org) archive REFUSES while an org still has it installed (names the migration list, no fire, no transition)", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      // A platform (NULL-org) row a platform admin resolves + a live org-scoped
      // install that must migrate off first.
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async (pkg: string) => [
        {
          id: "iext_plat",
          packageName: pkg,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "1.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        {
          id: "iext_orgblock",
          packageName: pkg,
          ownerLevel: "org",
          ownerId: null,
          organizationId: "org-block-1",
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "1.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      ]);
      vi.mocked(transitionExtensionLifecycle).mockClear();
      const err = await extensionRegistry
        .archive("artifact", makeRef("@v/pkg-artifact"), makeActor())
        .then(() => null)
        .catch((e) => e);
      expect(err).toBeInstanceOf(PlatformArtifactLifecycleOrgInstallsError);
      expect(err.operation).toBe("archive");
      expect(err.organizations.map((o: { id: string }) => o.id)).toEqual(["org-block-1"]);
      // No claim archival fired, and the durable row transition never ran.
      expect(fired).toEqual([]);
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });

    it("does NOT fire for a non-artifact kind (agent archive)", async () => {
      extensionRegistry.register(makeHandler("agent"));
      await extensionRegistry.archive("agent", makeRef(), makeActor());
      expect(fired).toEqual([]);
    });

    it("FAIL-CLOSED: a throwing seam aborts the org-scoped archive BEFORE the durable row transition", async () => {
      setExtensionArtifactClaimArchivalHook(() => {
        throw new Error("claim retirement failed");
      });
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgRow("@v/pkg-artifact");
      vi.mocked(transitionExtensionLifecycle).mockClear();
      await expect(
        extensionRegistry.archive("artifact", makeRef("@v/pkg-artifact"), orgAdmin),
      ).rejects.toThrow("claim retirement failed");
      // The row transition never ran — the archive aborted fail-closed.
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });

    it("FAIL-CLOSED: an UNWIRED seam throws on an org-scoped kind:'artifact' archive (no silent drop)", async () => {
      setExtensionArtifactClaimArchivalHook(null); // simulate a worker missing the wiring
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgRow("@v/pkg-artifact");
      vi.mocked(transitionExtensionLifecycle).mockClear();
      await expect(
        extensionRegistry.archive("artifact", makeRef("@v/pkg-artifact"), orgAdmin),
      ).rejects.toThrow(/not wired/i);
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });
  });

  // cinatra#1837 R3 — the dispatcher fires the FAIL-CLOSED artifact claim-
  // REACTIVATION seam on the restore of a `kind:"artifact"` extension, BEFORE it
  // commits the `activate` row transition, so a failed reactivation aborts the
  // restore (the row stays archived, never active with dead claims). The
  // ORG-SCOPED path (the shipped R3 substrate) is UNTOUCHED. The PLATFORM
  // (NULL-org) path is symmetric with the ruled archive (OWNER RULING 2026-07-22,
  // groganz): it REFUSES while any org still has the extension installed and only
  // otherwise proceeds at the platform scope. Never fires for a non-artifact kind.
  describe("artifact claim-reactivation firing (R3)", () => {
    const ORG = "org-7";
    const orgAdmin = {
      actorType: "system" as const,
      userId: "user-9",
      source: "worker" as const,
      orgId: ORG,
      orgRole: "org_admin" as const,
    };
    const seedOrgArtifactRow = (pkg: string) =>
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async () => [
        {
          id: "iext_org",
          packageName: pkg,
          ownerLevel: "org",
          ownerId: null,
          organizationId: ORG,
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "2.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      ]);
    const seedPlatformArtifactRow = (pkg: string) =>
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async () => [
        {
          id: "iext_plat",
          packageName: pkg,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "1.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      ]);

    let fired: unknown[];
    beforeEach(() => {
      fired = [];
      setExtensionArtifactClaimReactivationHook((input) => {
        fired.push(input);
      });
      restoreDefaultInstalledRows();
    });
    afterEach(() => {
      setExtensionArtifactClaimReactivationHook(null);
      restoreDefaultInstalledRows();
    });

    it("ORG-SCOPED restore of a kind:'artifact' extension fires the reactivation seam (scope = the org row)", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgArtifactRow("@v/pkg-artifact");
      await extensionRegistry.restore("artifact", makeRef("@v/pkg-artifact"), orgAdmin);
      expect(fired).toEqual([
        expect.objectContaining({
          packageName: "@v/pkg-artifact",
          organizationId: ORG,
          installId: "iext_org",
          extensionVersion: "2.0.0", // source.version precedence
          actorPrincipalId: "user-9",
        }),
      ]);
    });

    it("reactivation fires BEFORE the row transition (mirror of the archive seam ordering)", async () => {
      const order: string[] = [];
      setExtensionArtifactClaimReactivationHook(() => {
        order.push("reactivate");
      });
      vi.mocked(transitionExtensionLifecycle).mockImplementation(async () => {
        order.push("transition");
        return undefined as never;
      });
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgArtifactRow("@v/pkg-artifact");
      await extensionRegistry.restore("artifact", makeRef("@v/pkg-artifact"), orgAdmin);
      expect(order).toEqual(["reactivate", "transition"]);
    });

    it("OWNER RULING: a platform (NULL-org) restore PROCEEDS at platform scope when NO org has it installed (symmetric with archive)", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      seedPlatformArtifactRow("@v/pkg-artifact"); // SOLE platform row — no org install
      await extensionRegistry.restore("artifact", makeRef("@v/pkg-artifact"), makeActor());
      expect(fired).toEqual([
        expect.objectContaining({ packageName: "@v/pkg-artifact", organizationId: null }),
      ]);
    });

    it("OWNER RULING: a platform (NULL-org) restore REFUSES while an org still has it installed (symmetric refusal, no fire, no transition)", async () => {
      extensionRegistry.register(makeHandler("artifact"));
      // The platform row being restored is archived; a live org-scoped install
      // still exists, so the symmetric restore refusal fires.
      vi.mocked(readInstalledExtensionsByPackageName).mockImplementation(async (pkg: string) => [
        {
          id: "iext_plat",
          packageName: pkg,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: "artifact",
          status: "archived",
          source: { type: "verdaccio", version: "1.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        {
          id: "iext_orgblock",
          packageName: pkg,
          ownerLevel: "org",
          ownerId: null,
          organizationId: "org-block-2",
          kind: "artifact",
          status: "active",
          source: { type: "verdaccio", version: "1.0.0" },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      ]);
      vi.mocked(transitionExtensionLifecycle).mockClear();
      const err = await extensionRegistry
        .restore("artifact", makeRef("@v/pkg-artifact"), makeActor())
        .then(() => null)
        .catch((e) => e);
      expect(err).toBeInstanceOf(PlatformArtifactLifecycleOrgInstallsError);
      expect(err.operation).toBe("restore");
      expect(err.organizations.map((o: { id: string }) => o.id)).toEqual(["org-block-2"]);
      expect(fired).toEqual([]);
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });

    it("does NOT fire for a non-artifact kind (agent restore)", async () => {
      extensionRegistry.register(makeHandler("agent"));
      await extensionRegistry.restore("agent", makeRef(), makeActor());
      expect(fired).toEqual([]);
    });

    it("FAIL-CLOSED: a throwing reactivation seam aborts the restore BEFORE the transition", async () => {
      setExtensionArtifactClaimReactivationHook(() => {
        throw new Error("reactivation failed");
      });
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgArtifactRow("@v/pkg-artifact");
      vi.mocked(transitionExtensionLifecycle).mockClear();
      await expect(
        extensionRegistry.restore("artifact", makeRef("@v/pkg-artifact"), orgAdmin),
      ).rejects.toThrow("reactivation failed");
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });

    it("FAIL-CLOSED: an UNWIRED reactivation seam throws on an org-scoped artifact restore", async () => {
      setExtensionArtifactClaimReactivationHook(null);
      extensionRegistry.register(makeHandler("artifact"));
      seedOrgArtifactRow("@v/pkg-artifact");
      vi.mocked(transitionExtensionLifecycle).mockClear();
      await expect(
        extensionRegistry.restore("artifact", makeRef("@v/pkg-artifact"), orgAdmin),
      ).rejects.toThrow(/not wired/i);
      expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    });
  });

  // cinatra#1837 R2 — the dispatcher fires the FAIL-CLOSED ALL-SCOPES artifact
  // claim-archival seam on a package-GLOBAL destruction (platform-admin hard-delete
  // + forceDelete) of a `kind:"artifact"` extension, BEFORE it destroys the package
  // backing, so an incomplete retirement aborts the destroy (no orphaned live
  // claim). Never fires for a non-artifact kind.
  describe("all-scopes artifact claim-archival firing (R2)", () => {
    let fired: unknown[];
    beforeEach(() => {
      fired = [];
      setExtensionArtifactClaimArchivalAllScopesHook((input) => {
        fired.push(input);
      });
      restoreDefaultInstalledRows();
    });
    afterEach(() => {
      setExtensionArtifactClaimArchivalAllScopesHook(null);
      restoreDefaultInstalledRows();
    });

    it("platform-admin HARD-DELETE of a kind:'artifact' extension fires the all-scopes seam BEFORE handler.uninstall", async () => {
      const order: string[] = [];
      setExtensionArtifactClaimArchivalAllScopesHook(() => {
        order.push("retire");
      });
      const handler = makeHandler("artifact");
      (handler.uninstall as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push("uninstall");
      });
      extensionRegistry.register(handler);
      mockNeverUsedNoDepScenario();
      await extensionRegistry.uninstall("artifact", makeRef("@v/pkg-artifact"), makeActor());
      expect(order).toEqual(["retire", "uninstall"]);
    });

    it("forceDelete of a kind:'artifact' extension fires the all-scopes seam BEFORE handler.uninstall", async () => {
      const order: string[] = [];
      setExtensionArtifactClaimArchivalAllScopesHook((input) => {
        order.push("retire");
        fired.push(input);
      });
      const handler = makeHandler("artifact");
      (handler.uninstall as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push("uninstall");
      });
      extensionRegistry.register(handler);
      await extensionRegistry.forceDelete("artifact", makeRef("@v/pkg-artifact"), makeActor());
      expect(order).toEqual(["retire", "uninstall"]);
      expect(fired).toEqual([
        expect.objectContaining({ packageName: "@v/pkg-artifact" }),
      ]);
    });

    it("does NOT fire for a non-artifact kind (agent hard-delete)", async () => {
      const handler = makeHandler("agent");
      extensionRegistry.register(handler);
      mockNeverUsedNoDepScenario();
      await extensionRegistry.uninstall("agent", makeRef(), makeActor());
      expect(fired).toEqual([]);
    });

    it("FAIL-CLOSED: a throwing all-scopes seam aborts the hard-delete BEFORE handler.uninstall", async () => {
      setExtensionArtifactClaimArchivalAllScopesHook(() => {
        throw new Error("all-scopes retirement failed");
      });
      const handler = makeHandler("artifact");
      extensionRegistry.register(handler);
      mockNeverUsedNoDepScenario();
      await expect(
        extensionRegistry.uninstall("artifact", makeRef("@v/pkg-artifact"), makeActor()),
      ).rejects.toThrow("all-scopes retirement failed");
      expect(handler.uninstall).not.toHaveBeenCalled();
    });
  });

  // cinatra#1837 R4a — archive / uninstall / restore now hold the install-
  // lifecycle lock (the same lock install/update/forceDelete take), so a
  // concurrent install/update cannot interleave with claim retirement/reactivation.
  describe("install-lifecycle lock over archive/uninstall/restore (R4a)", () => {
    beforeEach(() => {
      setExtensionArtifactClaimReactivationHook(() => {});
      restoreDefaultInstalledRows();
    });
    afterEach(() => {
      setExtensionArtifactClaimReactivationHook(null);
      restoreDefaultInstalledRows();
    });

    it("archive holds withInstallLock for the package", async () => {
      extensionRegistry.register(makeHandler("agent"));
      await extensionRegistry.archive("agent", makeRef("@v/pkg"), makeActor());
      expect(withInstallLock).toHaveBeenCalledWith("@v/pkg", expect.any(Function));
    });

    it("uninstall holds withInstallLock for the package", async () => {
      extensionRegistry.register(makeHandler("agent"));
      mockUsedScenario();
      await extensionRegistry.uninstall("agent", makeRef("@v/pkg"), makeActor());
      expect(withInstallLock).toHaveBeenCalledWith("@v/pkg", expect.any(Function));
    });

    it("restore holds withInstallLock for the package", async () => {
      extensionRegistry.register(makeHandler("agent"));
      await extensionRegistry.restore("agent", makeRef("@v/pkg"), makeActor());
      expect(withInstallLock).toHaveBeenCalledWith("@v/pkg", expect.any(Function));
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

describe("resolveLiveInstalledVersionForCas (#1042 slice-1 — fail-closed)", () => {
  const row = (over: Partial<{
    organizationId: string | null;
    status: string;
    version?: string;
    source?: { version?: string } | null;
  }> = {}) => ({
    organizationId: null,
    status: "active",
    source: { version: "1.0.0" },
    ...over,
  });

  it("a single live row at the scope resolves its version", () => {
    expect(resolveLiveInstalledVersionForCas([row()], null)).toBe("1.0.0");
  });

  it("prefers the canonical `version` field, falling back to source.version", () => {
    expect(resolveLiveInstalledVersionForCas([row({ version: "2.0.0" })], null)).toBe("2.0.0");
    expect(resolveLiveInstalledVersionForCas([{ organizationId: null, status: "active", source: { version: "3.0.0" } }], null)).toBe("3.0.0");
  });

  it("a `locked` row still counts as live", () => {
    expect(resolveLiveInstalledVersionForCas([row({ status: "locked" })], null)).toBe("1.0.0");
  });

  it("ZERO live rows at the scope → null (fail-closed)", () => {
    expect(resolveLiveInstalledVersionForCas([], null)).toBeNull();
    // archived-only → not live.
    expect(resolveLiveInstalledVersionForCas([row({ status: "archived" })], null)).toBeNull();
  });

  it("MORE THAN ONE live row at the scope → null (ambiguous, fail-closed)", () => {
    expect(resolveLiveInstalledVersionForCas([row(), row({ version: "1.1.0" })], null)).toBeNull();
  });

  it("filters by scope — a row in a DIFFERENT scope is not counted", () => {
    // The candidate is NULL-org; an org-1 row of the same package is ignored.
    expect(
      resolveLiveInstalledVersionForCas([row(), row({ organizationId: "org-1", version: "9.9.9" })], null),
    ).toBe("1.0.0");
    // Asking for the org-1 scope resolves the org-1 row.
    expect(
      resolveLiveInstalledVersionForCas([row(), row({ organizationId: "org-1", version: "9.9.9" })], "org-1"),
    ).toBe("9.9.9");
  });

  it("a missing version resolves to null (cannot prove)", () => {
    expect(resolveLiveInstalledVersionForCas([{ organizationId: null, status: "active", source: null }], null)).toBeNull();
  });
});

describe("ExpectedInstalledVersionMismatchError (#1042 slice-1)", () => {
  it("carries the stable discriminant `code` and a descriptive message", () => {
    const err = new ExpectedInstalledVersionMismatchError("@acme/foo", "1.0.0", "2.0.0");
    expect(err.code).toBe("EXPECTED_VERSION_MISMATCH");
    expect(err.name).toBe("ExpectedInstalledVersionMismatchError");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("@acme/foo");
    expect(err.message).toContain("1.0.0");
    expect(err.message).toContain("2.0.0");
  });

  it("renders a `(no single live row)` message when the actual version is null", () => {
    const err = new ExpectedInstalledVersionMismatchError("@acme/foo", "1.0.0", null);
    expect(err.message).toContain("no single live row");
  });
});
