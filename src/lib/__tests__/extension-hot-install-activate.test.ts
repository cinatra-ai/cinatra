import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import {
  resolveInstallAnchor,
  type ResolveInstallAnchorDeps,
} from "@/lib/extension-install-anchor";
import {
  installExtensionFromRegistry,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { applyExtensionMigrationsFromStore } from "@/lib/extension-migration-host";
import type { MigrationQuery, RunMigrationsResult } from "@/lib/extension-migration-runner";

const REGISTRY = "https://registry.cinatra.ai";

// ===========================================================================
// 1. ANCHOR accept/refuse (DI-unit, no DB)
//    accepts active|locked; refuses non-finalized / placeholder-integrity /
//    missing-contentHash / wrong-org.
// ===========================================================================
describe("resolveInstallAnchor — accepts active|locked, refuses non-finalized / placeholder / missing-contentHash / wrong-org", () => {
  const base: ResolveInstallAnchorDeps = {
    readActiveInstall: async () => ({
      status: "active",
      source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "deadbeef", version: "1.0.0" },
    }),
    readGrant: async () => ({ status: "approved", approvedPorts: ["settings"], orgId: null }),
    readInstallOp: async () => ({ phase: "finalized" }),
  };

  it("ACCEPTS an `active` row (finalized journal + real provenance + approved grant)", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", base);
    expect(a).not.toBeNull();
    expect(a?.integrity).toBe("sha512-abc");
    expect(a?.contentHash).toBe("deadbeef");
    expect(a?.trustDecision).toBe(true);
    expect(a?.approvedPorts).toEqual(["settings"]);
  });

  it("ACCEPTS a `locked` row (removal-protected, still a live install)", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", {
      ...base,
      readActiveInstall: async () => ({
        status: "locked",
        source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "deadbeef" },
      }),
    });
    expect(a).not.toBeNull();
    expect(a?.trustDecision).toBe(true);
  });

  it("REFUSES any non-live status (archived / pending / failed)", async () => {
    for (const status of ["archived", "pending", "failed", "removed"]) {
      const a = await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readActiveInstall: async () => ({
          status,
          source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "deadbeef" },
        }),
      });
      expect(a, `status=${status} must refuse`).toBeNull();
    }
  });

  it("REFUSES a NON-finalized install-op journal phase (half-install)", async () => {
    for (const phase of ["materialized", "granted", "preflighted", "failed", "rolled_back"]) {
      const a = await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readInstallOp: async () => ({ phase }),
      });
      expect(a, `phase=${phase} must refuse`).toBeNull();
    }
    // and no journal row at all
    expect(await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readInstallOp: async () => null })).toBeNull();
  });

  it("REFUSES placeholder integrity (dispatcher-install / pending-resolution / latest / HEAD / empty)", async () => {
    for (const integrity of ["dispatcher-install", "pending-resolution", "latest", "HEAD", ""]) {
      const a = await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readActiveInstall: async () => ({
          status: "active",
          source: { type: "verdaccio", registryUrl: REGISTRY, integrity, contentHash: "deadbeef" },
        }),
      });
      expect(a, `integrity=${integrity || "(empty)"} must refuse`).toBeNull();
    }
  });

  it("REFUSES a missing contentHash (legacy/dispatcher row, not real-pipeline materialized)", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", {
      ...base,
      readActiveInstall: async () => ({
        status: "active",
        source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc" }, // no contentHash
      }),
    });
    expect(a).toBeNull();
  });

  it("REFUSES a wrong-org grant's PORTS — an org-scoped install must not inherit a global (org_id IS NULL) grant's ports", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", {
      orgId: "org-1",
      readActiveInstall: async () => ({
        status: "active",
        source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "ch" },
      }),
      readInstallOp: async () => ({ phase: "finalized" }),
      // the only approved grant belongs to a DIFFERENT scope (global)
      readGrant: async () => ({ status: "approved", approvedPorts: ["db", "secrets"], orgId: null }),
    });
    // Capability split: import-trust is DECOUPLED from the port
    // grant. The row resolves (active + finalized + real provenance), so the
    // install is still import-trusted (`trustDecision: true`) — but the
    // cross-scope global grant contributes ZERO ports (no cross-org escalation).
    expect(a).not.toBeNull();
    expect(a?.trustDecision).toBe(true);
    expect(a?.approvedPorts).toEqual([]);
  });
});

// ===========================================================================
// 2. POST-COMMIT activation throw is NON-FATAL
//    install returns { installed:true, activated:false, reason }.
// ===========================================================================
describe("installExtensionFromRegistry — post-commit activation throw is NON-FATAL", () => {
  function committedDeps(activateInProcess?: InstallPipelineDeps["activateInProcess"]): InstallPipelineDeps {
    return {
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY }),
      materialize: async () => ({ storeDir: "/store/foo/digest", digest: "digest", integrity: "sha512-abc", contentHash: "ch" }),
      readRequestedPorts: async () => [],
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      beginInstallOp: async () => {},
      advanceInstallOpPhase: async () => {},
      ...(activateInProcess ? { activateInProcess } : {}),
    };
  }

  it("a THROWING activator does not roll back the committed install: installed:true, activated:false, reason starts 'activate-threw:'", async () => {
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      committedDeps(async () => {
        throw new Error("registries-unreachable");
      }),
    );
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.reason).toBe("activate-threw:registries-unreachable");
  });

  it("an activator that returns { activated:false, reason } surfaces the reason verbatim (still installed:true)", async () => {
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      committedDeps(async () => ({ activated: false, reason: "anchor-refused" })),
    );
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.reason).toBe("anchor-refused");
  });

  it("no activator wired (unit/test path) ⇒ installed:true, activated:false, reason:'no-activator'", async () => {
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      committedDeps(),
    );
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.reason).toBe("no-activator");
  });

  it("a successful activator ⇒ installed:true, activated:true", async () => {
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      committedDeps(async () => ({ activated: true })),
    );
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Findings 2/3/4: the PRE-FINALIZE activation gate runs BEFORE ANY mutation of
  // the shared (package, org) state — the install-op JOURNAL (Finding 2), the
  // host-port GRANT (Finding 3), and the provenance (Finding 4). A superseding
  // UPDATE whose new digest fails the gate throws having touched NOTHING shared:
  // the previous install's journal row, grant, and provenance are all untouched
  // (so the previous install stays boot-anchorable + keeps its exact access
  // state), and only the bad new digest dir is GC'd.
  // -------------------------------------------------------------------------
  it("Findings 2/3/4: a failing pre-finalize gate on a SUPERSEDING update throws WITHOUT touching the journal, grant, or provenance + GCs the new digest", async () => {
    const phases: string[] = [];
    let beginCalled = false;
    let recordRequestedGrantCalled = false;
    let approveGrantCalled = false;
    let provenanceCalled = false;
    const gcd: string[] = [];
    const deps: InstallPipelineDeps = {
      ...committedDeps(),
      beginInstallOp: async () => {
        beginCalled = true;
      },
      recordRequestedGrant: async () => {
        recordRequestedGrantCalled = true;
      },
      approveGrant: async () => {
        approveGrantCalled = true;
      },
      recordProvenance: async () => {
        provenanceCalled = true;
      },
      advanceInstallOpPhase: async ({ phase }) => {
        phases.push(phase);
      },
      verifyActivatableBeforeFinalize: async () => ({ supersedes: true, ok: false, reason: "register-threw:boom" }),
      gcStoreDir: async (d) => {
        gcd.push(d);
      },
    };

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps),
    ).rejects.toThrow(/could not activate the new digest/);

    // Finding 2: the PREVIOUS install's `finalized` journal op is NEVER touched.
    // `beginInstallOp` is not called (a begin UPSERTs the one (package, org) row to
    // this attempt's op id, breaking the old finalized op), and because no op row
    // exists for this attempt, NOTHING is journaled for it either — advancing a
    // phase would require minting that clobbering op. The previous install stays
    // boot-anchorable; the journal stays its `finalized` row.
    expect(beginCalled, "journal begin NOT called (previous finalized op survives)").toBe(false);
    expect(phases, "no journal phase advanced for this attempt (previous finalized op untouched)").toEqual([]);
    // Finding 3: the grant was NEVER touched — not reset to pending, not re-approved
    // against the new digest's ports.
    expect(recordRequestedGrantCalled, "grant request NOT recorded (prior grant untouched)").toBe(false);
    expect(approveGrantCalled, "grant NOT re-approved (prior grant untouched)").toBe(false);
    // Finding 4: provenance was NOT overwritten; only the bad new digest was GC'd.
    expect(provenanceCalled, "provenance not overwritten").toBe(false);
    expect(gcd, "the failed new digest dir was GC'd").toEqual(["/store/foo/digest"]);
  });

  it("Finding 4: a pre-finalize gate that reports supersedes:false (a fresh install) is a no-op — provenance + finalize proceed", async () => {
    const phases: string[] = [];
    let provenanceCalled = false;
    const deps: InstallPipelineDeps = {
      ...committedDeps(async () => ({ activated: true })),
      recordProvenance: async () => {
        provenanceCalled = true;
      },
      advanceInstallOpPhase: async ({ phase }) => {
        phases.push(phase);
      },
      verifyActivatableBeforeFinalize: async () => ({ supersedes: false }),
    };

    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );
    expect(r.installed).toBe(true);
    expect(provenanceCalled, "fresh install records provenance").toBe(true);
    expect(phases).toContain("finalized");
  });

  it("Finding 4: a SUPERSEDING update whose new digest PASSES the gate finalizes normally", async () => {
    const phases: string[] = [];
    let provenanceCalled = false;
    const deps: InstallPipelineDeps = {
      ...committedDeps(async () => ({ activated: true })),
      recordProvenance: async () => {
        provenanceCalled = true;
      },
      advanceInstallOpPhase: async ({ phase }) => {
        phases.push(phase);
      },
      verifyActivatableBeforeFinalize: async () => ({ supersedes: true, ok: true }),
    };

    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null },
      deps,
    );
    expect(r.installed).toBe(true);
    expect(provenanceCalled, "a passing update records the new provenance").toBe(true);
    expect(phases).toContain("finalized");
  });
});

// ===========================================================================
// 3 + 5. IDEMPOTENT RE-ACTIVATION + UPDATE/GC/teardown ordering — end-to-end
//    through the real host loader + real in-memory host registries + a real
//    on-disk materialized store (NO npm/Verdaccio registry: the tarball bytes
//    are injected). The DB-backed anchor resolver is replaced with a DI fake.
// ===========================================================================

// --- import the host modules the activate path drives -----------------------
import {
  materializePackageToStore,
  type MaterializedPackage,
} from "@/lib/extension-package-store";
import { sriForBytes } from "@/lib/extension-package-store-core";
import {
  _resetExtensionMcpForTests,
  listExtensionMcpTools,
  removeExtensionMcpToolsForPackage,
} from "@/lib/extension-mcp-registry";
import {
  __resetCapabilityRegistry,
  resolveCapabilityProviders,
  invalidateProvidersForPackage,
} from "@/lib/extension-capabilities-registry";
import {
  __resetExtensionUiRegistry,
  invalidateExtensionUiForPackage,
} from "@/lib/extension-ui-registry";
import { objectTypeRegistry } from "@cinatra-ai/objects";
import {
  setExtensionCapabilityTeardownHook,
  fireExtensionCapabilityTeardown,
} from "@cinatra-ai/extensions";
import { activateInstalledPackageInProcess, hotUpdateWithDurableRollback } from "@/lib/extension-runtime-activate";

// The fixture's register(ctx) wires one of each dedup-relevant capability so a
// re-activate exercises: MCP replace-by-name, capabilities replace-in-place,
// object-type replace-by-id, UI setup/settings DEDUP. A module-level destroy
// counter + a `globalThis` recorder lets the test observe destroy() + teardown
// ordering across the file:// import boundary.
const PKG = "@cinatra-ai/hot-fixture";
const VERSION = "0.0.1";
const TYPE_ID = "@cinatra-ai/hot-fixture:note";

const REGISTER_MJS = (marker: string) => `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:${marker}");
  ctx.mcp.registerTool({ name: "hot_fixture_tool", handler: () => ({ ok: true }) });
  ctx.capabilities.registerProvider("hot-cap", { packageName: ctx.packageName, impl: { marker: "${marker}" } });
  // The host ctx casts the descriptor straight to objectTypeRegistry.register,
  // which keys on \`type\` (the SDK port's \`typeId\` is the opaque alias) — so the
  // fixture passes the registry's real field names.
  ctx.objects.registerType({ typeId: "${TYPE_ID}", type: "${TYPE_ID}", category: "data", marker: "${marker}" });
  ctx.ui.registerSetupSurface({ id: "setup-main", title: "Setup ${marker}" });
  ctx.ui.registerSettingsSurface({ id: "settings-main", title: "Settings ${marker}" });
}
export function destroy(ctx) {
  globalThis.__hotFixtureEvents.push("destroy:${marker}");
}
`;

declare global {
  // eslint-disable-next-line no-var
  var __hotFixtureEvents: string[] | undefined;
}

// A DI anchor that trusts the fixture package (no DB). Mirrors the shape the
// real makeDefaultInstallAnchorResolver returns.
function trustAnchorFor(name: string, mat: MaterializedPackage) {
  return async (pkg: string) =>
    pkg === name
      ? {
          integrity: mat.integrity,
          contentHash: mat.contentHash,
          registryUrl: REGISTRY,
          trustDecision: true,
          approvedPorts: ["mcp", "capabilities", "objects", "ui"],
          version: VERSION,
          signature: null,
        }
      : null;
}

// Replace the DB-backed default anchor resolver with the DI fake; keep
// pickSingleActiveRow real (the activate path uses it too).
let currentAnchorResolver: (pkg: string) => Promise<unknown> = async () => null;
vi.mock("@/lib/extension-install-anchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-install-anchor")>();
  return {
    ...actual,
    makeDefaultInstallAnchorResolver: async () => (pkg: string) => currentAnchorResolver(pkg),
  };
});

let workDir: string;

async function buildTarball(marker: string, digestSuffix: string): Promise<Buffer> {
  // `digestSuffix` is embedded as a comment so two markers produce DIFFERENT
  // bytes → DIFFERENT digest segments (the UPDATE/GC case needs two digests).
  const src = path.join(workDir, `src-${marker}`, "package");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({
      name: PKG,
      version: VERSION,
      cinatra: {
        kind: "connector",
        serverEntry: "./register.mjs",
        requestedHostPorts: ["mcp", "capabilities", "objects", "ui"],
        sdkAbiRange: "^2",
      },
    }),
  );
  await writeFile(path.join(src, "register.mjs"), REGISTER_MJS(marker) + `\n// digest:${digestSuffix}\n`);
  const out = path.join(workDir, `fixture-${marker}.tgz`);
  await tar.c({ gzip: true, cwd: path.join(workDir, `src-${marker}`), file: out }, ["package"]);
  return readFile(out);
}

async function materialize(storeRoot: string, marker: string, digestSuffix: string): Promise<MaterializedPackage> {
  const bytes = await buildTarball(marker, digestSuffix);
  const integrity = sriForBytes(bytes, "sha512");
  return materializePackageToStore(
    { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
    { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
  );
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-hot-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("hot-activate idempotent re-activation + UPDATE (end-to-end, no registry)", () => {
  beforeEach(() => {
    globalThis.__hotFixtureEvents = [];
    _resetExtensionMcpForTests();
    __resetCapabilityRegistry();
    __resetExtensionUiRegistry();
    objectTypeRegistry._clearForTests();
    // Real capability-teardown hook → drop this package's MCP/capability/UI/
    // object-type registrations (mirrors src/lib/extensions.ts wiring) and record
    // that teardown fired (for the ordering assertion).
    setExtensionCapabilityTeardownHook((pkg) => {
      globalThis.__hotFixtureEvents!.push(`teardown:${pkg}`);
      // emulate the host teardown SYNCHRONOUSLY: drop every in-memory
      // registration for the package (mirrors src/lib/extensions.ts wiring).
      removeExtensionMcpToolsForPackage(pkg);
      invalidateProvidersForPackage(pkg);
      invalidateExtensionUiForPackage(pkg);
      objectTypeRegistry.removeByPackage(pkg);
    });
  });

  it("IDEMPOTENT re-activate of the SAME digest: registries replace-in-place (no duplicates), GC is a no-op", async () => {
    const storeRoot = path.join(workDir, "store-idem");
    const mat = await materialize(storeRoot, "v1", "same");
    currentAnchorResolver = trustAnchorFor(PKG, mat) as never;

    // First activation.
    const first = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: mat.storeDir, storeRoot });
    expect(first.find((r) => r.packageName === PKG)?.status).toBe("registered");

    // Snapshot post-first-activation counts.
    expect(listExtensionMcpTools().filter((t) => t.packageName === PKG)).toHaveLength(1);
    expect(resolveCapabilityProviders("hot-cap").filter((p) => p.packageName === PKG)).toHaveLength(1);
    expect(objectTypeRegistry.getTypesForPackage(PKG)).toEqual([TYPE_ID]);

    // Re-activate the SAME store dir (same digest). The teardown→destroy→GC→
    // re-activate path runs again; the registries must REPLACE, not stack.
    const second = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: mat.storeDir, storeRoot });
    expect(second.find((r) => r.packageName === PKG)?.status).toBe("registered");

    // No duplicate registrations after the second activation.
    expect(
      listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool"),
      "MCP tool replaced by name (no dup)",
    ).toHaveLength(1);
    expect(
      resolveCapabilityProviders("hot-cap").filter((p) => p.packageName === PKG),
      "capability provider replaced in place (no dup)",
    ).toHaveLength(1);
    expect(
      objectTypeRegistry.getTypesForPackage(PKG),
      "object type replaced by id (no dup)",
    ).toEqual([TYPE_ID]);
    expect(objectTypeRegistry.list().filter((d) => d.type === TYPE_ID), "single object-type entry").toHaveLength(1);

    // UI setup/settings surfaces are DEDUPED by id (the registry Maps key by
    // surfaceId) — exactly one setup + one settings surface after re-activation.
    const ui = readUiSurfaceCounts(PKG);
    expect(ui.setup, "setup surface deduped (no dup append)").toBe(1);
    expect(ui.settings, "settings surface deduped (no dup append)").toBe(1);

    // SAME-digest GC is a no-op: the single (current) store dir still exists.
    const digestDirs = await readStoreDigestDirs(storeRoot);
    expect(digestDirs).toHaveLength(1);
    expect(await pathExists(mat.storeDir)).toBe(true);
  });

  it("re-activate fires teardown for the OLD package BEFORE the new register (replace ordering)", async () => {
    const storeRoot = path.join(workDir, "store-order");
    const mat = await materialize(storeRoot, "v1", "same");
    currentAnchorResolver = trustAnchorFor(PKG, mat) as never;

    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: mat.storeDir, storeRoot });
    // reset the event log so we only observe the SECOND activation's ordering
    globalThis.__hotFixtureEvents = [];
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: mat.storeDir, storeRoot });

    const events = globalThis.__hotFixtureEvents!;
    const teardownIdx = events.indexOf(`teardown:${PKG}`);
    const registerIdx = events.indexOf("register:v1");
    expect(teardownIdx, "capability teardown fired").toBeGreaterThanOrEqual(0);
    expect(registerIdx, "re-register fired").toBeGreaterThanOrEqual(0);
    expect(teardownIdx, "teardown precedes the new register").toBeLessThan(registerIdx);
  });

  it("UPDATE (new digest): two store dirs for one package would FAIL-CLOSED; after GC only the new digest remains + activates; OLD module destroy + teardown fire before re-activate", async () => {
    const storeRoot = path.join(workDir, "store-update");
    // OLD digest already materialized + activated.
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    currentAnchorResolver = trustAnchorFor(PKG, oldMat) as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });

    // NEW digest materialized into the SAME package dir (different bytes →
    // different digest). The store now holds TWO dirs for one packageName.
    const newMat = await materialize(storeRoot, "v2", "new-bytes");
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    expect(await readStoreDigestDirs(storeRoot), "two digest dirs present before GC").toHaveLength(2);

    // PROOF of fail-close: the shared activation driver refuses BOTH records for
    // the duplicated name while two dirs coexist (so a hot-update MUST GC the old
    // dir first). Exercise the pure driver directly over the real discovered
    // records (integrity verified true here — the duplicate-name gate, not
    // integrity, is what must refuse).
    const { runRuntimePackageActivation, discoverPackageStoreRecords } = await import("@cinatra-ai/sdk-extensions");
    const driverFs = {
      exists: async (p: string) => pathExists(p),
      isDirectory: async (p: string) => {
        try {
          return (await stat(p)).isDirectory();
        } catch {
          return false;
        }
      },
      readdir: (p: string) => readdir(p),
      readFile: (p: string) => readFile(p, "utf8"),
    };
    const discovered = await discoverPackageStoreRecords(storeRoot, driverFs);
    expect(discovered.filter((r) => r.packageName === PKG), "two records for one name").toHaveLength(2);
    const dupResults = await runRuntimePackageActivation(storeRoot, {
      fs: driverFs,
      records: discovered,
      importModule: async () => ({ register: () => {} }),
      makeContext: ((name: string) => ({ packageName: name })) as never,
      verifyIntegrity: async () => true,
    });
    const dupRow = dupResults.find((r) => r.packageName === PKG);
    expect(dupRow?.status, "ambiguous duplicate name fails closed").toBe("failed");
    expect(String(dupRow?.error)).toMatch(/ambiguous package/);

    // Now run the hot-update activate, keeping the NEW digest. It must:
    //  - fire teardown for the OLD package + destroy the OLD module, THEN
    //  - GC the superseded OLD dir so only the new digest remains, THEN
    //  - re-activate the NEW digest (the duplicate-name gate is now satisfied).
    globalThis.__hotFixtureEvents = [];
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;
    const updated = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: newMat.storeDir, storeRoot });

    // Only ONE dir survives (the new digest) and the new digest activated.
    const remaining = await readStoreDigestDirs(storeRoot);
    expect(remaining, "GC left a single store dir").toHaveLength(1);
    expect(await pathExists(newMat.storeDir), "new digest kept").toBe(true);
    expect(await pathExists(oldMat.storeDir), "old digest GC'd").toBe(false);
    expect(updated.find((r) => r.packageName === PKG)?.status).toBe("registered");

    // Ordering (Finding 2): the NEW digest's register is PROVEN via the pre-verify
    // PROBE register BEFORE the old digest is torn down, and the OLD module destroy
    // + capability teardown both fire BEFORE the FINAL (real) NEW register. The
    // fixture's register() pushes "register:v2" each time it runs, so the event log
    // now holds TWO "register:v2" entries: the probe (first) and the real (last).
    const events = globalThis.__hotFixtureEvents!;
    const destroyIdx = events.indexOf("destroy:v1");
    const teardownIdx = events.indexOf(`teardown:${PKG}`);
    const probeRegisterIdx = events.indexOf("register:v2"); // the FIRST = the probe
    const realRegisterIdx = events.lastIndexOf("register:v2"); // the LAST = the real activation
    expect(destroyIdx, "old module destroy() fired").toBeGreaterThanOrEqual(0);
    expect(teardownIdx, "capability teardown fired").toBeGreaterThanOrEqual(0);
    expect(probeRegisterIdx, "new digest probe-registered").toBeGreaterThanOrEqual(0);
    expect(realRegisterIdx, "new digest re-registered for real").toBeGreaterThan(probeRegisterIdx);
    // The probe register proves the new digest activates BEFORE any teardown.
    expect(probeRegisterIdx, "probe register precedes old teardown").toBeLessThan(teardownIdx);
    expect(probeRegisterIdx, "probe register precedes old destroy").toBeLessThan(destroyIdx);
    // Destroy + teardown of the old precede the FINAL (real) re-register.
    expect(destroyIdx, "destroy precedes the real new register").toBeLessThan(realRegisterIdx);
    expect(teardownIdx, "teardown precedes the real new register").toBeLessThan(realRegisterIdx);

    // Registries hold exactly the NEW digest's single registration (no stale v1).
    expect(listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool")).toHaveLength(1);
    expect(resolveCapabilityProviders("hot-cap").filter((p) => p.packageName === PKG)).toHaveLength(1);
    const v2Provider = resolveCapabilityProviders("hot-cap").find((p) => p.packageName === PKG);
    expect((v2Provider?.impl as { marker?: string })?.marker).toBe("v2");
    expect(objectTypeRegistry.getTypesForPackage(PKG)).toEqual([TYPE_ID]);
  });

  it("Finding 5: the OLD module's destroy(ctx) runs with the package's APPROVED ports (not an empty grant set)", async () => {
    // The bug: teardownAndGcSupersededDigests built the destroy ctx with `[]`
    // grants, so an old module whose destroy releases a resource through an
    // APPROVED host port hit a NOT-GRANTED fail-loud Proxy and its release
    // silently failed (destroy → "destroy-threw"). The fix threads the package's
    // approved ports (from the resolved anchor) into the destroy ctx. This fixture's
    // destroy probes `ctx.settings.get` (approved here) and records whether it was
    // GRANTED vs NOT-GRANTED across the file:// boundary.
    const storeRoot = path.join(workDir, "store-destroy-grant");
    const SETTINGS_FIXTURE = (marker: string) => `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:${marker}");
}
export function destroy(ctx) {
  try {
    // Referencing .get off the settings port throws synchronously when the port
    // is NOT granted (the host's fail-loud Proxy); when granted it is a function.
    const probe = ctx.settings.get;
    globalThis.__hotFixtureEvents.push(
      typeof probe === "function" ? "destroy:settings-GRANTED:${marker}" : "destroy:settings-other:${marker}",
    );
  } catch {
    globalThis.__hotFixtureEvents.push("destroy:settings-NOT-GRANTED:${marker}");
  }
}
`;
    async function materializeSettingsFixture(marker: string, digestSuffix: string): Promise<MaterializedPackage> {
      const src = path.join(workDir, `src-settings-${marker}`, "package");
      await mkdir(src, { recursive: true });
      await writeFile(
        path.join(src, "package.json"),
        JSON.stringify({
          name: PKG,
          version: VERSION,
          cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: ["settings"], sdkAbiRange: "^2" },
        }),
      );
      await writeFile(path.join(src, "register.mjs"), SETTINGS_FIXTURE(marker) + `\n// digest:${digestSuffix}\n`);
      const tgz = path.join(workDir, `fixture-settings-${marker}.tgz`);
      await tar.c({ gzip: true, cwd: path.join(workDir, `src-settings-${marker}`), file: tgz }, ["package"]);
      const bytes = await readFile(tgz);
      const integrity = sriForBytes(bytes, "sha512");
      return materializePackageToStore(
        { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
        { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
      );
    }

    // An anchor that APPROVES the `settings` port (so the old module's destroy
    // should see it granted once the fix threads approved ports into the ctx).
    function settingsAnchorFor(mat: MaterializedPackage) {
      return async (pkg: string) =>
        pkg === PKG
          ? {
              integrity: mat.integrity,
              contentHash: mat.contentHash,
              registryUrl: REGISTRY,
              trustDecision: true,
              approvedPorts: ["settings"],
              version: VERSION,
              signature: null,
            }
          : null;
    }

    // OLD digest materialized + activated.
    const oldMat = await materializeSettingsFixture("v1", "old-bytes");
    currentAnchorResolver = settingsAnchorFor(oldMat) as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });

    // NEW digest, anchor still approves `settings`. Run the hot-update.
    const newMat = await materializeSettingsFixture("v2", "new-bytes");
    currentAnchorResolver = settingsAnchorFor(newMat) as never;
    globalThis.__hotFixtureEvents = [];
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: newMat.storeDir, storeRoot });

    // The OLD module's destroy(ctx) saw `settings` GRANTED — NOT the old empty-grant
    // bug (which would have recorded settings-NOT-GRANTED).
    expect(globalThis.__hotFixtureEvents).toContain("destroy:settings-GRANTED:v1");
    expect(globalThis.__hotFixtureEvents).not.toContain("destroy:settings-NOT-GRANTED:v1");
  });

  it("Finding 5: a BAD new digest (anchor refuses it) leaves the OLD digest + its registrations + its store dir fully intact", async () => {
    const storeRoot = path.join(workDir, "store-bad-update");
    // OLD digest materialized + activated through a trusting anchor.
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    currentAnchorResolver = trustAnchorFor(PKG, oldMat) as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");
    expect(listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool")).toHaveLength(1);

    // NEW digest materialized (two dirs now), but the anchor REFUSES the new one
    // (simulates an integrity/journal/grant failure on the new digest).
    const newMat = await materialize(storeRoot, "v2", "new-bytes");
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    currentAnchorResolver = (async () => null) as never; // anchor refuses everything

    globalThis.__hotFixtureEvents = [];
    const res = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: newMat.storeDir, storeRoot });

    // The new digest was NOT activated, and the update ABORTED before any teardown:
    expect(res.find((r) => r.packageName === PKG)?.status).not.toBe("registered");
    expect(globalThis.__hotFixtureEvents, "no destroy/teardown/register fired").toEqual([]);

    // OLD digest store dir survives + the new digest dir survives (GC never ran).
    expect(await pathExists(oldMat.storeDir), "old digest kept (not GC'd)").toBe(true);
    expect(await pathExists(newMat.storeDir), "new digest not GC'd either").toBe(true);
    // OLD in-memory registrations are STILL live (never torn down).
    expect(
      listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool"),
      "old registration intact after aborted bad update",
    ).toHaveLength(1);
    expect(objectTypeRegistry.getTypesForPackage(PKG)).toEqual([TYPE_ID]);
  });

  it("Finding 2: an UPDATE whose new digest imports + integrity-verifies but whose register(ctx) THROWS aborts BEFORE teardown — old digest + registrations + store dir fully intact", async () => {
    const storeRoot = path.join(workDir, "store-newreg-throws");
    // OLD digest materialized + activated through a trusting anchor.
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    currentAnchorResolver = trustAnchorFor(PKG, oldMat) as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");
    expect(listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool")).toHaveLength(1);

    // NEW digest: imports fine + has a server entry + integrity-verifies, but its
    // register(ctx) THROWS. The pre-verify PROBE register must catch it BEFORE the
    // old digest is torn down (the bug Finding 2 names: a server-entry check alone
    // does NOT prove register succeeds).
    const NEW_REGISTER_THROWS = `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:v2-enter");
  throw new Error("new-digest-register-boom");
}
export function destroy(ctx) { globalThis.__hotFixtureEvents.push("destroy:v2"); }
`;
    const src = path.join(workDir, "src-newreg-throws", "package");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: PKG,
        version: VERSION,
        cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: ["mcp", "capabilities", "objects", "ui"], sdkAbiRange: "^2" },
      }),
    );
    await writeFile(path.join(src, "register.mjs"), NEW_REGISTER_THROWS);
    const tgz = path.join(workDir, "fixture-newreg-throws.tgz");
    await tar.c({ gzip: true, cwd: path.join(workDir, "src-newreg-throws"), file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    const integrity = sriForBytes(bytes, "sha512");
    const newMat = await materializePackageToStore(
      { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
      { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
    );
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    // The anchor TRUSTS the new digest (integrity matches) — so the abort is driven
    // by the probe register throwing, NOT by an anchor/integrity refusal.
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;

    globalThis.__hotFixtureEvents = [];
    const res = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: newMat.storeDir, storeRoot });

    // The update ABORTED before teardown: the probe register entered + threw, and
    // NO destroy/teardown/real-register fired.
    expect(res.find((r) => r.packageName === PKG)?.status).not.toBe("registered");
    expect(globalThis.__hotFixtureEvents).toContain("register:v2-enter"); // probe ran register
    expect(globalThis.__hotFixtureEvents).not.toContain("destroy:v1"); // old NOT destroyed
    expect(globalThis.__hotFixtureEvents).not.toContain(`teardown:${PKG}`); // old NOT torn down

    // OLD digest + the NEW digest store dirs both survive (GC never ran).
    expect(await pathExists(oldMat.storeDir), "old digest kept (not GC'd)").toBe(true);
    expect(await pathExists(newMat.storeDir), "new digest not GC'd").toBe(true);
    // OLD in-memory registrations are STILL live (never torn down).
    expect(
      listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool"),
      "old registration intact after register-throws abort",
    ).toHaveLength(1);
    expect(objectTypeRegistry.getTypesForPackage(PKG)).toEqual([TYPE_ID]);
  });

  it("a register(ctx) that fails inside ctx.objects.registerType surfaces as a FAILED activation (register-threw) — the object type never lands, and the failure is not swallowed", async () => {
    // A fixture whose register() calls ctx.objects.registerType with a descriptor
    // that makes the synchronous host registration THROW. Because registerType is
    // synchronous (the host ctx registers against the eagerly-imported registry —
    // NOT a floating Promise), the throw propagates out of register(ctx), so the
    // loader records `register-threw` and the activation path returns it (the
    // SUM of "object type present before activation returns" + "a failure
    // surfaces"). Proven END-TO-END through activateInstalledPackageInProcess.
    const storeRoot = path.join(workDir, "store-registertype-fail");
    const BAD_REGISTER = `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:bad-start");
  // The host objectTypeRegistry.register reads \`def.type\`; passing null makes it
  // throw synchronously — exactly the "a registration failure must surface" case.
  ctx.objects.registerType(null);
  globalThis.__hotFixtureEvents.push("register:bad-end-NEVER");
}
`;
    // Build + materialize a tarball with the bad register module.
    const src = path.join(workDir, "src-badreg", "package");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: PKG,
        version: VERSION,
        cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: ["objects"], sdkAbiRange: "^2" },
      }),
    );
    await writeFile(path.join(src, "register.mjs"), BAD_REGISTER);
    const tgz = path.join(workDir, "fixture-badreg.tgz");
    await tar.c({ gzip: true, cwd: path.join(workDir, "src-badreg"), file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    const integrity = sriForBytes(bytes, "sha512");
    const mat = await materializePackageToStore(
      { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
      { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
    );
    currentAnchorResolver = trustAnchorFor(PKG, mat) as never;

    const results = await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: mat.storeDir, storeRoot });

    // The activation FAILED with register-threw (the failure surfaced — not swallowed).
    const row = results.find((r) => r.packageName === PKG);
    expect(row?.status, "register failure surfaces as a failed activation").toBe("failed");
    expect(row?.reason).toBe("register-threw");
    // register() entered but the throw aborted it (the post-throw line never ran).
    expect(globalThis.__hotFixtureEvents).toContain("register:bad-start");
    expect(globalThis.__hotFixtureEvents).not.toContain("register:bad-end-NEVER");
    // The object type never landed — the synchronous failure prevented it (so the
    // process is never left with a half-registered package).
    expect(objectTypeRegistry.getTypesForPackage(PKG)).toEqual([]);
  });
});

// ===========================================================================
// DESIGN B — ATOMIC HOT-UPDATE WITH DURABLE-ROLLBACK-FIRST (end-to-end through
//    hotUpdateWithDurableRollback + the real on-disk store + the real loader +
//    real in-memory host registries). The DB-backed anchor resolver is the DI
//    fake; `restoreDurableAnchor` re-pins it to OLD (simulating the durable DB
//    restore the pipeline's closure performs). NO npm/Verdaccio — tarball bytes
//    are injected.
//
//    The KEY scenario: a NEW digest that imports + integrity-verifies + has a
//    server entry, but whose live register(ctx) FAILS for a NON-grant reason the
//    pre-finalize probe could not predict (here we call the activator directly,
//    which is exactly the "probe passed → live failed" regime). The rollback is
//    the guarantee: OLD provenance/journal/grant restored (the closure), partial
//    NEW registrations torn down, OLD store dir restored from quarantine, OLD
//    re-activated, result { rolledBack:true, activated:false } (NOT success).
// ===========================================================================
describe("Design B — atomic hot-update with durable-rollback-first (end-to-end, no registry)", () => {
  beforeEach(() => {
    globalThis.__hotFixtureEvents = [];
    _resetExtensionMcpForTests();
    __resetCapabilityRegistry();
    __resetExtensionUiRegistry();
    objectTypeRegistry._clearForTests();
    setExtensionCapabilityTeardownHook((pkg) => {
      globalThis.__hotFixtureEvents!.push(`teardown:${pkg}`);
      removeExtensionMcpToolsForPackage(pkg);
      invalidateProvidersForPackage(pkg);
      invalidateExtensionUiForPackage(pkg);
      objectTypeRegistry.removeByPackage(pkg);
    });
  });

  // A NEW digest whose register THROWS live (a logic error the probe didn't catch).
  // It still imports + has a server entry + integrity-verifies (the bytes are the
  // materialized tarball), so only the LIVE register fails.
  const NEW_LIVE_THROWS = `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:v2-enter");
  // register SOME capability before throwing — proving the partial-new teardown
  // clears it on rollback.
  ctx.mcp.registerTool({ name: "hot_fixture_tool", handler: () => ({ ok: true }) });
  throw new Error("live-register-logic-error");
}
export function destroy(ctx) { globalThis.__hotFixtureEvents.push("destroy:v2"); }
`;

  // A NEW digest whose register SUCCEEDS but whose BOOTSTRAP throws (HIGH 1). The
  // loader runs register-all THEN bootstrap-all, so this produces TWO results for
  // the package: { status:"registered" } AND { status:"failed", reason:"bootstrap-threw" }.
  // A success determination that keys only on the "registered" result would WRONGLY
  // GC the OLD digest + report activated:true; the fix requires NO "failed" result.
  const NEW_BOOTSTRAP_THROWS = `
globalThis.__hotFixtureEvents ??= [];
export function register(ctx) {
  globalThis.__hotFixtureEvents.push("register:v2-bootstrap-throws");
  ctx.mcp.registerTool({ name: "hot_fixture_tool", handler: () => ({ ok: true }) });
  ctx.capabilities.registerProvider("hot-cap", { packageName: ctx.packageName, impl: { marker: "v2" } });
}
export function bootstrap(ctx) {
  globalThis.__hotFixtureEvents.push("bootstrap:v2-enter");
  throw new Error("bootstrap-logic-error");
}
export function destroy(ctx) { globalThis.__hotFixtureEvents.push("destroy:v2"); }
`;

  async function materializeWithRegister(
    storeRoot: string,
    marker: string,
    digestSuffix: string,
    registerSrc: string,
    ports: string[] = ["mcp", "capabilities", "objects", "ui"],
  ): Promise<MaterializedPackage> {
    const src = path.join(workDir, `src-designb-${marker}-${digestSuffix}`, "package");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: PKG,
        version: VERSION,
        cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: ports, sdkAbiRange: "^2" },
      }),
    );
    await writeFile(path.join(src, "register.mjs"), registerSrc + `\n// digest:${digestSuffix}\n`);
    const tgz = path.join(workDir, `fixture-designb-${marker}-${digestSuffix}.tgz`);
    await tar.c({ gzip: true, cwd: path.join(workDir, `src-designb-${marker}-${digestSuffix}`), file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    const integrity = sriForBytes(bytes, "sha512");
    return materializePackageToStore(
      { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
      { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
    );
  }

  it("UPDATE whose NEW digest FAILS live activation → DURABLE ROLLBACK: OLD store restored from quarantine, partial NEW torn down, OLD re-activated, result rolledBack:true/activated:false (NOT success); OLD is anchorable", async () => {
    const storeRoot = path.join(workDir, "store-designb-rollback");
    // OLD digest (a healthy fixture) materialized + activated.
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    const oldAnchor = trustAnchorFor(PKG, oldMat);
    currentAnchorResolver = oldAnchor as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");
    expect(listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool")).toHaveLength(1);

    // NEW digest whose live register throws (a logic error). Two store dirs now.
    const newMat = await materializeWithRegister(storeRoot, "v2", "new-bytes", NEW_LIVE_THROWS);
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    expect(await readStoreDigestDirs(storeRoot), "two digest dirs present before the update").toHaveLength(2);
    // The anchor TRUSTS the new digest (so the failure is the LIVE register, not a refusal).
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;

    // restoreDurableAnchor re-pins the DI anchor to OLD (the durable DB restore the
    // pipeline's closure performs). Record that it ran for the ordering assertion.
    // Returns a CLEAN DurableRestoreOutcome (every step succeeded).
    let restoreRan = false;
    const restoreDurableAnchor = async () => {
      restoreRan = true;
      currentAnchorResolver = oldAnchor as never;
      return { complete: true };
    };

    globalThis.__hotFixtureEvents = [];
    const res = await hotUpdateWithDurableRollback(PKG, null, newMat.storeDir, { restoreDurableAnchor }, { storeRoot });

    // The update did NOT take: rolled back, not activated, NOT success.
    expect(res.activated).toBe(false);
    expect(res.rolledBack).toBe(true);
    // The durable restore completed cleanly → rollbackComplete:true (HIGH 3).
    expect(res.rollbackComplete).toBe(true);
    expect(res.reason, "the failure reason is surfaced").toMatch(/register-threw|failed/);

    // The durable anchor restore ran (the closure was invoked on the failure path).
    expect(restoreRan).toBe(true);
    // The NEW digest's register entered + threw (partial registration happened)...
    expect(globalThis.__hotFixtureEvents).toContain("register:v2-enter");
    // ...and the OLD digest was re-activated (its register ran again after restore).
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");

    // The OLD store dir was restored from quarantine (it exists again); the failed
    // NEW digest dir was GC'd so ONLY the OLD digest remains discoverable (the OLD
    // re-activation can't trip the loader's duplicate-name gate).
    expect(await pathExists(oldMat.storeDir), "OLD store dir restored from quarantine").toBe(true);
    expect(await pathExists(newMat.storeDir), "failed NEW digest dir GC'd on rollback").toBe(false);
    const digestDirs = await readStoreDigestDirs(storeRoot);
    expect(digestDirs, "post-rollback: only the OLD digest is on disk").toHaveLength(1);
    // No quarantine subtree lingers after the restore.
    expect(await findQuarantineDirs(storeRoot), "no quarantine dir left after restore").toEqual([]);

    // The partial NEW registration was torn down and the OLD registration is the
    // sole live one (the OLD fixture's hot_fixture_tool — a working handler).
    const tools = listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool");
    expect(tools, "exactly one live registration (the re-activated OLD)").toHaveLength(1);
    // The OLD capability provider's marker is v1 (NOT a stale partial v2).
    const provider = resolveCapabilityProviders("hot-cap").find((p) => p.packageName === PKG);
    expect((provider?.impl as { marker?: string })?.marker, "OLD capability re-registered").toBe("v1");

    // OLD is anchorable: the restored DI anchor resolves it (a fresh boot would pick OLD).
    const anchor = await oldAnchor(PKG);
    expect(anchor?.integrity, "OLD anchor resolves (boot-recoverable)").toBe(oldMat.integrity);
  });

  it("HIGH 1: NEW digest REGISTERS but BOOTSTRAP throws → NOT activated:true, OLD NOT GC'd; DURABLE ROLLBACK runs; OLD restored + rolledBack:true", async () => {
    const storeRoot = path.join(workDir, "store-designb-bootstrap-throws");
    // OLD digest (a healthy fixture) materialized + activated.
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    const oldAnchor = trustAnchorFor(PKG, oldMat);
    currentAnchorResolver = oldAnchor as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");

    // NEW digest: register SUCCEEDS, bootstrap THROWS → the loader returns BOTH a
    // "registered" AND a "failed:bootstrap-threw" result for the package.
    const newMat = await materializeWithRegister(storeRoot, "v2", "new-bytes", NEW_BOOTSTRAP_THROWS);
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    expect(await readStoreDigestDirs(storeRoot), "two digest dirs before the update").toHaveLength(2);
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;

    let restoreRan = false;
    const restoreDurableAnchor = async () => {
      restoreRan = true;
      currentAnchorResolver = oldAnchor as never;
      return { complete: true };
    };

    globalThis.__hotFixtureEvents = [];
    const res = await hotUpdateWithDurableRollback(PKG, null, newMat.storeDir, { restoreDurableAnchor }, { storeRoot });

    // The NEW digest registered but its bootstrap threw → it is NOT a clean
    // success. The verdict must be a rollback, NOT activated:true.
    expect(res.activated, "register+bootstrap-throw is NOT a clean activation").toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.rollbackComplete).toBe(true);
    expect(res.reason, "the bootstrap-throw reason is surfaced").toMatch(/bootstrap-threw|failed/);

    // Both register and the throwing bootstrap ran for the NEW digest...
    expect(globalThis.__hotFixtureEvents).toContain("register:v2-bootstrap-throws");
    expect(globalThis.__hotFixtureEvents).toContain("bootstrap:v2-enter");
    // ...the durable restore ran, and the OLD digest was re-activated.
    expect(restoreRan).toBe(true);
    expect(globalThis.__hotFixtureEvents).toContain("register:v1");

    // The OLD store dir was NOT GC'd — it was restored from quarantine; the failed
    // NEW digest dir was GC'd so only OLD remains discoverable.
    expect(await pathExists(oldMat.storeDir), "OLD store dir restored (NOT GC'd)").toBe(true);
    expect(await pathExists(newMat.storeDir), "failed NEW digest dir GC'd on rollback").toBe(false);
    expect(await readStoreDigestDirs(storeRoot), "post-rollback: only OLD remains").toHaveLength(1);
    expect(await findQuarantineDirs(storeRoot), "no quarantine dir left after restore").toEqual([]);

    // The OLD registration (marker v1) is the sole live one — the partial NEW (v2)
    // capability was torn down on rollback.
    const provider = resolveCapabilityProviders("hot-cap").find((p) => p.packageName === PKG);
    expect((provider?.impl as { marker?: string })?.marker, "OLD capability re-registered (not the partial v2)").toBe("v1");
  });

  it("UPDATE with a GOOD new digest → new activates, OLD dir GC'd (not left in quarantine), activated:true (no rollback)", async () => {
    const storeRoot = path.join(workDir, "store-designb-good");
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    currentAnchorResolver = trustAnchorFor(PKG, oldMat) as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });

    // NEW digest is healthy (the standard fixture register, marker v2).
    const newMat = await materialize(storeRoot, "v2", "new-bytes");
    expect(newMat.storeDir).not.toBe(oldMat.storeDir);
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;

    let restoreRan = false;
    const restoreDurableAnchor = async () => { restoreRan = true; return { complete: true }; };

    globalThis.__hotFixtureEvents = [];
    const res = await hotUpdateWithDurableRollback(PKG, null, newMat.storeDir, { restoreDurableAnchor }, { storeRoot });

    expect(res.activated).toBe(true);
    expect(res.rolledBack).toBeUndefined();
    expect(restoreRan, "no rollback on a good update").toBe(false);

    // Only ONE dir survives (the new digest); the OLD quarantine was GC'd (NOT left behind).
    const digestDirs = await readStoreDigestDirs(storeRoot);
    expect(digestDirs, "GC left a single live store dir").toHaveLength(1);
    expect(await pathExists(newMat.storeDir), "new digest kept").toBe(true);
    expect(await pathExists(oldMat.storeDir), "old digest GC'd (not in original location)").toBe(false);
    // No quarantine subtree lingers under the package dir.
    const lingering = await findQuarantineDirs(storeRoot);
    expect(lingering, "no quarantine dir left after a successful GC").toEqual([]);

    // The NEW digest is the sole live registration (marker v2).
    const provider = resolveCapabilityProviders("hot-cap").find((p) => p.packageName === PKG);
    expect((provider?.impl as { marker?: string })?.marker).toBe("v2");
  });

  it("UPDATE where the OLD re-activation ALSO fails after rollback → STILL rolledBack:true/activated:false; durable state = OLD (restoreDurableAnchor ran), recoverable on restart", async () => {
    const storeRoot = path.join(workDir, "store-designb-old-reactivate-fails");
    const oldMat = await materialize(storeRoot, "v1", "old-bytes");
    const oldAnchor = trustAnchorFor(PKG, oldMat);
    currentAnchorResolver = oldAnchor as never;
    await activateInstalledPackageInProcess(PKG, null, { currentStoreDir: oldMat.storeDir, storeRoot });

    // NEW digest whose live register throws.
    const newMat = await materializeWithRegister(storeRoot, "v2", "new-bytes", NEW_LIVE_THROWS);
    currentAnchorResolver = trustAnchorFor(PKG, newMat) as never;

    // restoreDurableAnchor runs (durable DB re-pinned to OLD) BUT we make the OLD
    // re-activation ALSO fail by re-pinning the in-memory anchor to one that REFUSES
    // everything — so the OLD re-activation can't register in-process. The durable
    // state still points to OLD (the closure ran); only the in-process re-activation
    // could not complete. The verdict MUST remain rolledBack:true/activated:false.
    let restoreRan = false;
    const restoreDurableAnchor = async () => {
      restoreRan = true;
      currentAnchorResolver = (async () => null) as never; // OLD re-activation will be refused
      // The DURABLE restore itself succeeded (the DB anchor is re-pinned to OLD) —
      // only the in-process re-activation is refused. So rollbackComplete stays true.
      return { complete: true };
    };

    globalThis.__hotFixtureEvents = [];
    const res = await hotUpdateWithDurableRollback(PKG, null, newMat.storeDir, { restoreDurableAnchor }, { storeRoot });

    // Even though OLD could not re-activate in-process, the verdict is unchanged.
    expect(res.activated).toBe(false);
    expect(res.rolledBack).toBe(true);
    // The DURABLE restore completed cleanly (boot-recoverable) even though the
    // in-process OLD re-activation was refused → rollbackComplete:true.
    expect(res.rollbackComplete).toBe(true);
    // The durable restore DID run (the DB anchor points to OLD; a fresh boot recovers it).
    expect(restoreRan).toBe(true);
    // The OLD store dir was restored from quarantine (boot can re-activate it).
    expect(await pathExists(oldMat.storeDir), "OLD store dir restored (boot-recoverable)").toBe(true);
    // The update did NOT report success — never lost, never reported as success.
    expect(res.activated, "NEVER reported as success even when OLD re-activation failed").toBe(false);
  });

  it("FRESH activation (no prior digest) routed through hotUpdateWithDurableRollback is a plain activate — no quarantine/rollback path", async () => {
    const storeRoot = path.join(workDir, "store-designb-fresh");
    const mat = await materialize(storeRoot, "v1", "fresh");
    currentAnchorResolver = trustAnchorFor(PKG, mat) as never;

    let restoreRan = false;
    const restoreDurableAnchor = async () => { restoreRan = true; return { complete: true }; };

    const res = await hotUpdateWithDurableRollback(PKG, null, mat.storeDir, { restoreDurableAnchor }, { storeRoot });
    expect(res.activated).toBe(true);
    expect(res.rolledBack).toBeUndefined();
    expect(restoreRan, "no rollback on a fresh activate").toBe(false);
    // No quarantine dir created.
    expect(await findQuarantineDirs(storeRoot)).toEqual([]);
    // Single live store dir, package registered.
    expect(await readStoreDigestDirs(storeRoot)).toHaveLength(1);
    expect(listExtensionMcpTools().filter((t) => t.name === "hot_fixture_tool")).toHaveLength(1);
  });
});

// ===========================================================================
// 4 (migrations). Re-activation does NOT re-apply an already-applied migration:
//    the extension_migrations ledger skips it (no duplicate DDL). Uses a real
//    `cinatra.migrations[]` consumer fixture + an injected in-memory ledger (no
//    DB) — the migration-runner half of "no duplicate registrations on re-activate".
// ===========================================================================
describe("re-activation migration ledger-skip — already-applied migration is not re-run (no dup DDL)", () => {
  const CONSUMER_DIR = path.join(process.cwd(), "src/lib/__tests__/fixtures/migration-store/notes-connector");

  function makeLedgerRecorder() {
    const ledger = new Map<string, string>();
    const ddl: string[] = [];
    const query: MigrationQuery = async <T = unknown>(text: string, values?: readonly unknown[]) => {
      if (text.includes("SELECT migration_hash") && text.includes("extension_migrations")) {
        const key = `${String(values?.[0])}|${String(values?.[1])}`;
        return (ledger.has(key) ? [{ migration_hash: ledger.get(key)! }] : []) as T[];
      }
      if (text.includes("INSERT INTO") && text.includes("extension_migrations")) {
        const key = `${String(values?.[0])}|${String(values?.[1])}`;
        ledger.set(key, String(values?.[2]));
        return [] as T[];
      }
      ddl.push(text);
      return [] as T[];
    };
    const runLocked = (run: (q: MigrationQuery) => Promise<RunMigrationsResult>) => run(query);
    return { ledger, ddl, runLocked };
  }

  it("first activation applies the migration; a second (re-activation) pass over the SAME ledger skips it with no new DDL", async () => {
    const rec = makeLedgerRecorder();
    // First activation: applies the migration once.
    const first = await applyExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR }, { runLocked: rec.runLocked });
    expect(first.applied).toEqual(["0001-create-notes"]);
    expect(first.skipped).toEqual([]);
    const ddlAfterFirst = rec.ddl.length;
    expect(ddlAfterFirst).toBeGreaterThan(0);

    // Re-activation: the SAME ledger now records the migration → it is SKIPPED,
    // and NO new DDL is emitted (idempotent — no duplicate table creation).
    const second = await applyExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR }, { runLocked: rec.runLocked });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001-create-notes"]);
    expect(rec.ddl.length, "no new DDL on the idempotent re-activation").toBe(ddlAfterFirst);
  });
});

/** Introspect the UI registry's per-package surface Maps via its documented
 *  cross-compilation singleton Symbol — the surfaces have no public getter, but
 *  the registry keys both Maps by surfaceId, so the Map size IS the deduped count. */
function readUiSurfaceCounts(packageName: string): { setup: number; settings: number } {
  const KEY = Symbol.for("@cinatra-ai/host:extension-ui-registry/v1");
  const holder = globalThis as unknown as {
    [k: symbol]: Map<string, { setupSurfaces: Map<string, unknown>; settingsSurfaces: Map<string, unknown> }> | undefined;
  };
  const entry = holder[KEY]?.get(packageName);
  return { setup: entry?.setupSurfaces.size ?? 0, settings: entry?.settingsSurfaces.size ?? 0 };
}

// --- small fs helpers ---------------------------------------------------------
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Find any `.cinatra-quarantine` subtree dirs under the store root (Design B). A
 *  successful GC / restore must leave NONE behind. */
async function findQuarantineDirs(storeRoot: string): Promise<string[]> {
  const out: string[] = [];
  let pkgDirs: string[];
  try {
    pkgDirs = await readdir(storeRoot);
  } catch {
    return [];
  }
  for (const pkgDir of pkgDirs) {
    const qRoot = path.join(storeRoot, pkgDir, ".cinatra-quarantine");
    if (await pathExists(qRoot)) {
      try {
        const subs = await readdir(qRoot);
        for (const s of subs) out.push(path.join(qRoot, s));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** The materialize layout is `<root>/<pkg@ver>/<digest>/` — return the digest
 *  subdirs that currently hold a package.json (i.e. live materialized records). */
async function readStoreDigestDirs(storeRoot: string): Promise<string[]> {
  const out: string[] = [];
  let pkgDirs: string[];
  try {
    pkgDirs = await readdir(storeRoot);
  } catch {
    return [];
  }
  for (const pkgDir of pkgDirs) {
    const abs = path.join(storeRoot, pkgDir);
    if (!(await stat(abs)).isDirectory()) continue;
    for (const sub of await readdir(abs)) {
      const subAbs = path.join(abs, sub);
      if ((await stat(subAbs)).isDirectory() && (await pathExists(path.join(subAbs, "package.json")))) {
        out.push(subAbs);
      }
    }
  }
  return out;
}

// ===========================================================================
// summarizeActivation — the SHARED success verdict (no false activated:true on a
// register-passes/bootstrap-throws package). Both the hot-update no-supersede
// early-out AND the pipeline's fresh-install activateInProcess route through it,
// so the success rule cannot drift between paths.
// ===========================================================================
import { summarizeActivation, restoreQuarantined } from "@/lib/extension-runtime-activate";
import type { ActivationResult } from "@cinatra-ai/sdk-extensions";

describe("summarizeActivation — requires a registration AND no failure", () => {
  const PKG = "@cinatra-ai/foo";
  it("registered, no failure → activated:true", () => {
    expect(summarizeActivation([{ packageName: PKG, status: "registered" }] as ActivationResult[], PKG)).toEqual({ activated: true });
  });
  it("registered THEN failed (bootstrap-threw) → activated:false with the bootstrap reason, NOT a false activated:true", () => {
    const r = summarizeActivation(
      [
        { packageName: PKG, status: "registered" },
        { packageName: PKG, status: "failed", reason: "bootstrap-threw" },
      ] as ActivationResult[],
      PKG,
    );
    expect(r.activated).toBe(false);
    expect(r.reason).toBe("failed:bootstrap-threw");
  });
  it("failed only → activated:false", () => {
    expect(
      summarizeActivation([{ packageName: PKG, status: "failed", reason: "register-threw" }] as ActivationResult[], PKG).activated,
    ).toBe(false);
  });
  it("no result for the package (anchor refused) → activated:false, reason anchor-refused", () => {
    expect(summarizeActivation([{ packageName: "@other/x", status: "registered" }] as ActivationResult[], PKG)).toEqual({
      activated: false,
      reason: "anchor-refused",
    });
  });
});

// ===========================================================================
// restoreQuarantined — reports on-disk store-restore success so the hot-update
// rollback can fold it into rollbackComplete (a failed disk restore must NOT be
// reported as a clean rollback).
// ===========================================================================
describe("restoreQuarantined — reports {ok, failed} so a disk-restore failure blocks a clean-rollback claim", () => {
  it("ok:true on a real round-trip — the quarantined dir is moved back to its original path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rq-ok-"));
    const originalDir = path.join(root, "pkg", "active");
    const quarantineDir = path.join(root, "pkg", ".cinatra-quarantine", "digest");
    await mkdir(quarantineDir, { recursive: true });
    await writeFile(path.join(quarantineDir, "marker.txt"), "old");
    const res = await restoreQuarantined([{ originalDir, quarantineDir }]);
    expect(res).toEqual({ ok: true, failed: [] });
    expect(await pathExists(originalDir)).toBe(true);
    expect(await pathExists(path.join(originalDir, "marker.txt"))).toBe(true);
    expect(await pathExists(quarantineDir)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("ok:false + names the dir when the quarantine source is missing (rename fails) — the rollback is NOT clean", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rq-fail-"));
    const originalDir = path.join(root, "pkg", "active");
    const quarantineDir = path.join(root, "pkg", ".cinatra-quarantine", "gone"); // never created → rename throws
    const res = await restoreQuarantined([{ originalDir, quarantineDir }]);
    expect(res.ok).toBe(false);
    expect(res.failed).toContain(originalDir);
    await rm(root, { recursive: true, force: true });
  });
});
