/**
 * The TWO-PATH predicate end-to-end (epic #1620 M1 Slice A — cinatra#1630, plan
 * §2.4 / AC-1): a marketplace-installed renderer bound ONLY in the runtime asset
 * registry (NO generated-map entry, i.e. ZERO host rebuild) resolves `loadable`
 * and routes through the byte-unchanged dispatch leaf to `semantic`/
 * `representation`, with the server-serialized runtime descriptor pointing at the
 * dynamic client seam. Archiving the extension (owner ruling 8 revocation) drops
 * the binding and the row degrades to the never-blank `requires-rebuild` floor.
 *
 * GENERATED_ARTIFACT_RENDERERS is the REAL (empty `{}`) map — so a runtime-only
 * key is genuinely absent from the build map, proving the zero-rebuild path.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { RENDERER_ASSET_ROUTE_BASE } from "@/lib/artifacts/runtime-renderer-descriptor";
import {
  resolveArtifactDispatchInputs,
  classifyLoadablePath,
  resolveRuntimeRendererDescriptor,
  _resetFirstPartySeedForTests,
} from "../renderer-resolution";
import { pickArtifactRenderer } from "../renderer-dispatch";

const ORG = "org_dynamic";
const PKG = "@cinatra-ai/json-artifact";

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: PKG,
    slot: "detail",
    digest: "a".repeat(128),
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

function winner(extension: string): EffectiveIdentity {
  return { kind: "extension", extension };
}

function dispatchFor(args: { baseType: string; identity: EffectiveIdentity; mime: string }) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({
      orgId: ORG,
      baseType: args.baseType,
      identity: args.identity,
      mime: args.mime,
    }),
  );
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("AC-1 — a runtime-registered semantic renderer loads with ZERO host rebuild", () => {
  const TYPE = `${PKG}:artifact`;

  it("is NOT in the build map but resolves loadable → semantic via the runtime path", async () => {
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });
    const key = runtimeAssetRegistry.keyFor(PKG, "detail");

    // Before activation: no build entry, no runtime binding → requires-rebuild.
    expect(dispatchFor({ baseType: TYPE, identity: winner(PKG), mime: "application/json" })).toEqual({
      kind: "requires-rebuild",
      packageName: PKG,
      slot: "detail",
    });

    // Activate the runtime binding (marketplace install → admission → activate).
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate })).ok).toBe(true);

    // Now loadable → dispatch routes to semantic (the byte-unchanged leaf).
    expect(dispatchFor({ baseType: TYPE, identity: winner(PKG), mime: "application/json" })).toEqual({
      kind: "semantic",
      packageName: PKG,
      generatedKey: key,
    });

    // ...via the DYNAMIC path, with a serialized digest-pinned descriptor.
    expect(classifyLoadablePath(key)).toBe("runtime");
    const desc = resolveRuntimeRendererDescriptor(key);
    expect(desc).not.toBeNull();
    expect(desc!.tuple).toEqual(tuple());
    expect(desc!.digestPinnedUrl.startsWith(`${RENDERER_ASSET_ROUTE_BASE}/${"a".repeat(128)}/detail/`)).toBe(true);
  });

  it("archive-position (ruling 8): retiring the extension drops the binding → requires-rebuild floor", async () => {
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    expect(dispatchFor({ baseType: TYPE, identity: winner(PKG), mime: "application/json" }).kind).toBe("semantic");

    // Archive/delete lifecycle teardown = revocation (no separate kill-switch).
    runtimeAssetRegistry.retireByPackage(PKG);

    expect(dispatchFor({ baseType: TYPE, identity: winner(PKG), mime: "application/json" })).toEqual({
      kind: "requires-rebuild",
      packageName: PKG,
      slot: "detail",
    });
    expect(classifyLoadablePath(runtimeAssetRegistry.keyFor(PKG, "detail"))).toBe("none");
    expect(resolveRuntimeRendererDescriptor(runtimeAssetRegistry.keyFor(PKG, "detail"))).toBeNull();
  });
});

describe("AC-1 — a runtime-registered representation provider loads with zero rebuild", () => {
  it("routes a matching representation to the dynamic runtime path", async () => {
    // The detail page resolves the representation at slot `detail` (Slice B), so a
    // dynamic representation provider binds + activates at `detail`.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: PKG,
      pattern: "application/json",
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ slot: "detail", entry: "client/detail.js" }),
      generation: 1,
      ...okActivate,
    });
    const key = runtimeAssetRegistry.keyFor(PKG, "detail");
    const floor: EffectiveIdentity = { kind: "no-primary" };

    expect(dispatchFor({ baseType: "@cinatra-ai/artifact:object", identity: floor, mime: "application/json" })).toEqual({
      kind: "representation",
      packageName: PKG,
      generatedKey: key,
      pattern: "application/json",
    });
    expect(classifyLoadablePath(key)).toBe("runtime");
  });
});

describe("dispatch leaf byte-unchanged — an UNregistered dynamic key never leaks", () => {
  it("a runtime binding with no arbitration registry entry is not reachable (winner-bound)", async () => {
    // Activate a runtime binding but register NO semantic/representation entry.
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    // With no registry claim and an unhandled MIME (no first-party default),
    // the row falls through to the generic floor.
    expect(dispatchFor({ baseType: "@other/x:artifact", identity: winner("@other/x"), mime: "application/vnd.unknown-xyz" })).toEqual({
      kind: "fallback",
    });
  });
});
