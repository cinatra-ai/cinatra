/**
 * The fail-closed freshness PREFLIGHT server action (epic #1620 M1 Slice A/B —
 * cinatra#1630, plan §2.5, owner ruling 8). The client loader calls this — bound
 * to the descriptor's tuple — immediately before importing a (possibly cached)
 * bundle; only a green verdict permits `import()`. Every revocation signal is the
 * EXISTING archive/delete lifecycle (installed/active + active-digest), never a
 * separate kill-switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

let installedActive = true;
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => installedActive,
}));

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { runRuntimeRendererFreshnessPreflight } from "../runtime-renderer-preflight";

const PKG = "@cinatra-ai/json-artifact";
const DIGEST = "a".repeat(128);

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: PKG,
    slot: "detail",
    digest: DIGEST,
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}

const okActivate = { materialize: async () => {}, verify: async () => true };

beforeEach(() => {
  installedActive = true;
});
afterEach(() => {
  runtimeAssetRegistry._clearForTests();
});

describe("runRuntimeRendererFreshnessPreflight", () => {
  it("green when the exact admitted binding is still active + installed", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    expect(await runRuntimeRendererFreshnessPreflight(tuple())).toEqual({ ok: true });
  });

  it("archived (ruling 8) when the extension is no longer installed/active", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    installedActive = false;
    expect(await runRuntimeRendererFreshnessPreflight(tuple())).toEqual({ ok: false, reason: "archived" });
  });

  it("archived when the binding was retired (no active digest for the key)", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    runtimeAssetRegistry.retireByPackage(PKG);
    expect(await runRuntimeRendererFreshnessPreflight(tuple())).toEqual({ ok: false, reason: "archived" });
  });

  it("archived when the descriptor's digest is superseded by a newer active digest", async () => {
    await runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ digest: "b".repeat(128) }),
      generation: 2,
      ...okActivate,
    });
    // The client holds a stale descriptor pinned to the OLD digest.
    expect(await runRuntimeRendererFreshnessPreflight(tuple())).toEqual({ ok: false, reason: "archived" });
  });

  it("quarantined when the exact digest tripped the best-effort 3-strike counter", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    runtimeAssetRegistry.recordDigestFailure(DIGEST);
    runtimeAssetRegistry.recordDigestFailure(DIGEST);
    runtimeAssetRegistry.recordDigestFailure(DIGEST);
    expect(await runRuntimeRendererFreshnessPreflight(tuple())).toEqual({ ok: false, reason: "quarantined" });
  });
});
