import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { materializePackageToStore } from "@/lib/extension-package-store";
import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";

// Proves the dispatch→activate wiring:
//   (1) installExtensionFromRegistry runs its POST-COMMIT activateInProcess hook
//       AFTER finalize, with the just-materialized storeDir, and surfaces its
//       { activated, reason } on the (extended) result;
//   (2) the targeted loader (onlyPackage) activates exactly ONE package from a
//       store that holds others — and a duplicate store dir for one package is
//       fail-closed (which is what the hot-update GC prevents).

const PKG = "@cinatra-ai/hot-activate-fixture";
const OTHER = "@cinatra-ai/other-fixture";
const VERSION = "1.0.0";
const REGISTRY = "https://registry.cinatra.ai";
const REGISTER_MJS = `export function register(ctx) { ctx.logger.info("hot-activate fixture registered"); }\n`;

async function packFixture(workDir: string, name: string): Promise<{ bytes: Buffer; integrity: string }> {
  const src = path.join(workDir, name.replace(/[^a-z0-9]/gi, "_"), "src", "package");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({
      name,
      version: VERSION,
      cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: [], sdkAbiRange: "^2" },
    }),
  );
  await writeFile(path.join(src, "register.mjs"), REGISTER_MJS);
  const out = path.join(path.dirname(path.dirname(src)), "fixture.tgz");
  await tar.c({ gzip: true, cwd: path.dirname(src), file: out }, ["package"]);
  const bytes = await readFile(out);
  return { bytes, integrity: sriForBytes(bytes, "sha512") };
}

type InstallState = {
  source?: { type: string; registryUrl: string; integrity: string; contentHash: string };
  grant?: { status: string; approvedPorts: string[]; orgId: string | null };
  journalPhase?: string;
};

function makePipelineDeps(
  state: InstallState,
  tarballBytes: Buffer,
  integrity: string,
  activateInProcess?: InstallPipelineDeps["activateInProcess"],
): InstallPipelineDeps {
  return {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity, registryUrl: REGISTRY }),
    materialize: async (i) => {
      const m = await materializePackageToStore(
        { packageName: i.packageName, version: i.version, expectedIntegrity: i.expectedIntegrity, registryUrl: i.registryUrl, storeRoot: i.storeRoot },
        { fetchTarball: async () => ({ bytes: tarballBytes, integrity }), now: () => "2026-06-04T00:00:00.000Z" },
      );
      return { storeDir: m.storeDir, digest: m.digest, integrity: m.integrity, contentHash: m.contentHash };
    },
    readRequestedPorts: async () => [],
    recordProvenance: async (p) => {
      state.source = { type: "verdaccio", registryUrl: p.registryUrl, integrity: p.integrity, contentHash: p.contentHash };
    },
    recordRequestedGrant: async (g) => {
      state.grant = { status: "pending", approvedPorts: [], orgId: g.orgId };
    },
    approveGrant: async (g) => {
      state.grant = { status: "approved", approvedPorts: g.approvedPorts, orgId: g.orgId };
    },
    beginInstallOp: async () => {
      state.journalPhase = "materialized";
    },
    advanceInstallOpPhase: async ({ phase }) => {
      state.journalPhase = phase;
    },
    // cinatra#158: the happy-path finalize is the supersession seam; reflect it so
    // the post-commit activateInProcess hook sees journalPhase === "finalized".
    finalizeInstallOp: async () => {
      state.journalPhase = "finalized";
    },
    ...(activateInProcess ? { activateInProcess } : {}),
  };
}

describe("hot-activate wiring", () => {
  it("installExtensionFromRegistry fires the POST-COMMIT activateInProcess hook after finalize and surfaces its result", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "cinatra-hot-activate-"));
    try {
      const { bytes, integrity } = await packFixture(workDir, PKG);
      const storeRoot = path.join(workDir, "data", "extensions", "packages");
      const state: InstallState = {};

      const calls: Array<{ packageName: string; orgId: string | null; storeDir: string }> = [];
      const activateInProcess = vi.fn(async (i: { packageName: string; orgId: string | null; storeDir: string }) => {
        // The hook fires AFTER finalize — the journal must already be finalized.
        expect(state.journalPhase).toBe("finalized");
        calls.push(i);
        return { activated: true };
      });

      const result = await installExtensionFromRegistry(
        { packageName: PKG, version: VERSION, orgId: null, storeRoot },
        makePipelineDeps(state, bytes, integrity, activateInProcess),
      );

      expect(result.installed).toBe(true);
      expect(result.activated).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].packageName).toBe(PKG);
      expect(calls[0].orgId).toBeNull();
      expect(calls[0].storeDir).toBe(result.storeDir); // the just-materialized dir
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("a missing activateInProcess hook is a clean no-op (activated:false, reason:no-activator)", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "cinatra-hot-activate-"));
    try {
      const { bytes, integrity } = await packFixture(workDir, PKG);
      const storeRoot = path.join(workDir, "data", "extensions", "packages");
      const state: InstallState = {};
      const result = await installExtensionFromRegistry(
        { packageName: PKG, version: VERSION, orgId: null, storeRoot },
        makePipelineDeps(state, bytes, integrity),
      );
      expect(result.installed).toBe(true);
      expect(result.activated).toBe(false);
      expect(result.reason).toBe("no-activator");
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("targeted onlyPackage activation registers exactly the requested package and ignores others in the store", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "cinatra-hot-activate-"));
    try {
      const a = await packFixture(workDir, PKG);
      const b = await packFixture(workDir, OTHER);
      const storeRoot = path.join(workDir, "data", "extensions", "packages");

      // Materialize BOTH packages into one store.
      const stateA: InstallState = {};
      const stateB: InstallState = {};
      const matA = await makePipelineDeps(stateA, a.bytes, a.integrity).materialize({ packageName: PKG, version: VERSION, expectedIntegrity: a.integrity, registryUrl: REGISTRY, storeRoot });
      const matB = await makePipelineDeps(stateB, b.bytes, b.integrity).materialize({ packageName: OTHER, version: VERSION, expectedIntegrity: b.integrity, registryUrl: REGISTRY, storeRoot });
      stateA.source = { type: "verdaccio", registryUrl: REGISTRY, integrity: matA.integrity, contentHash: matA.contentHash };
      stateA.grant = { status: "approved", approvedPorts: [], orgId: null };
      stateA.journalPhase = "finalized";
      stateB.source = { type: "verdaccio", registryUrl: REGISTRY, integrity: matB.integrity, contentHash: matB.contentHash };
      stateB.grant = { status: "approved", approvedPorts: [], orgId: null };
      stateB.journalPhase = "finalized";

      const resolver = (packageName: string) =>
        resolveInstallAnchor(packageName, {
          orgId: null,
          readActiveInstall: async (pkg) => {
            const s = pkg === PKG ? stateA : stateB;
            return s.source ? { status: "active", source: s.source } : null;
          },
          readGrant: async (pkg) => (pkg === PKG ? stateA.grant : stateB.grant) ?? null,
          readInstallOp: async (pkg) => {
            const phase = pkg === PKG ? stateA.journalPhase : stateB.journalPhase;
            return phase ? { phase } : null;
          },
        });

      const activations = await loadRuntimePackageExtensions(storeRoot, { onlyPackage: PKG, resolveInstallAnchor: resolver });
      // ONLY the requested package is considered.
      expect(activations.every((r) => r.packageName === PKG)).toBe(true);
      expect(activations.some((r) => r.packageName === PKG && r.status === "registered")).toBe(true);
      expect(activations.some((r) => r.packageName === OTHER)).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
