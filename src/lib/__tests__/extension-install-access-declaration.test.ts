// cinatra#951 — connector ACCESS-DECLARATION threading through the install
// pipeline: the fail-closed EARLY read (an invalid cinatra/config.json aborts
// the install fully inert, before any durable mutation), the FINALIZE-seam
// persistence (a finalized connector install-op implies a cached
// declaration), and the UPDATE-rollback restore on both unwind paths.
// Pure DI tests — no registry, no DB, no filesystem.

import { describe, it, expect } from "vitest";

import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { ConnectorAccessConfigError } from "@cinatra-ai/sdk-extensions/access-config";
import type { ResolvedConnectorAccessDeclaration } from "@cinatra-ai/extensions/canonical-types";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@cinatra-ai/github-connector";
const VER = "1.0.0";
const INTEGRITY = sriForBytes(Buffer.from("the-connector-tarball"));

const DECLARED: ResolvedConnectorAccessDeclaration = {
  formatVersion: 1,
  mode: "default",
  scope: "user",
  source: "declared",
};
const PRIOR: ResolvedConnectorAccessDeclaration = {
  formatVersion: 1,
  mode: "default",
  scope: "admin",
  source: "absent",
};

function harness(overrides: Partial<InstallPipelineDeps> = {}) {
  const calls = {
    persisted: [] as unknown[],
    begun: [] as unknown[],
    gced: [] as string[],
  };
  const deps: InstallPipelineDeps = {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY }),
    materialize: async () => ({
      storeDir: "/store/dir",
      digest: "dgst",
      integrity: INTEGRITY,
      contentHash: "ch",
    }),
    readRequestedPorts: async () => [],
    beginInstallOp: async (i) => {
      calls.begun.push(i);
    },
    gcStoreDir: async (dir) => {
      calls.gced.push(dir);
    },
    persistAccessDeclaration: async (i) => {
      calls.persisted.push(i);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("install pipeline × connector access declaration (cinatra#951)", () => {
  it("persists the resolved declaration at the finalize seam", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => DECLARED,
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted).toEqual([
      { packageName: PKG, orgId: null, declaration: DECLARED },
    ]);
  });

  it("FAIL-CLOSED: an invalid declaration aborts BEFORE any durable mutation and GCs the store dir", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => {
        throw new ConnectorAccessConfigError(
          `invalid cinatra/config.json for ${PKG}: access.scpoe: unrecognized key`,
        );
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/connector-access-config/);
    expect(calls.begun).toHaveLength(0); // refused before beginInstallOp — fully inert
    expect(calls.persisted).toHaveLength(0);
    expect(calls.gced).toEqual(["/store/dir"]); // the just-materialized dir is GC'd
  });

  it("a non-connector package (declaration null) never triggers a persist", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => null,
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted).toHaveLength(0);
  });

  it("a failed UPDATE restores the PRIOR declaration in the pre-finalize unwind", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => DECLARED,
      // A prior finalized install exists → this run is an UPDATE.
      readInstallOp: async () => ({
        installOpId: "op-1",
        phase: "finalized" as const,
        digest: "old-dgst",
      }),
      readCurrentAccessDeclaration: async () => PRIOR,
      // Blow up AT the finalize seam tail so the catch path runs after the
      // new declaration was persisted.
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    // First write: the NEW declaration (finalize seam). Last write: the PRIOR
    // declaration restored by the unwind.
    expect(calls.persisted.length).toBeGreaterThanOrEqual(2);
    expect(calls.persisted[0]).toEqual({ packageName: PKG, orgId: null, declaration: DECLARED });
    expect(calls.persisted[calls.persisted.length - 1]).toEqual({
      packageName: PKG,
      orgId: null,
      declaration: PRIOR,
    });
  });

  it("a failed UPDATE from a legacy row restores the prior NULL declaration (explicit clear)", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => DECLARED,
      readInstallOp: async () => ({
        installOpId: "op-1",
        phase: "finalized" as const,
        digest: "old-dgst",
      }),
      // Legacy row: no cached declaration.
      readCurrentAccessDeclaration: async () => null,
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    expect(calls.persisted[calls.persisted.length - 1]).toEqual({
      packageName: PKG,
      orgId: null,
      declaration: null, // restored to the legacy NULL — never the failed candidate's value
    });
  });

  it("a FRESH install failure does not attempt a declaration restore (nothing prior to restore)", async () => {
    const { deps, calls } = harness({
      readAccessDeclaration: async () => DECLARED,
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    // Exactly the one forward write — no restore write (priorAccessDeclaration
    // is null on a fresh install).
    expect(calls.persisted).toEqual([
      { packageName: PKG, orgId: null, declaration: DECLARED },
    ]);
  });
});
