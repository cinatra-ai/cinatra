/**
 * MOUNTING the dynamic seam end-to-end (epic #1620 M1 Slice A/B — cinatra#1630,
 * plan §2.4–§2.5, AC-1/AC-5/AC-7). `ExtensionRendererMount` is the piece that
 * WIRES the resolved dispatch into an actual mount: it classifies the loadable
 * path and routes a build-map claimant to the server-only `ExtensionRendererSlot`
 * (SSR fast path) and a runtime-installed claimant to the main-realm
 * `DynamicRendererLoader` with a server-serialized descriptor + bound freshness
 * preflight — and floors (never blank) when the binding vanished.
 *
 * `resolveRuntimeRendererForRoute` attaches the server-known PRE-IMPORT floor
 * reason (peer/ABI/archived/quarantine) as descriptor side data, so an
 * incompatible renderer degrades BEFORE `import()` — never a misleading
 * requires-rebuild.
 */
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

// A live install row is not reachable in the unit graph — the mount's route
// resolver + preflight both consult the lifecycle gate; treat the fixture package
// as installed/active so the dynamic path is exercised, not floored on lifecycle.
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => true,
}));

// A build-map key for the build-map branch; the runtime key is deliberately
// ABSENT from this map (zero host rebuild) and lives only in the runtime registry.
const BUILD_MAP_KEY = "@fixture/built-ext::detail";
vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/built-ext::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/built-ext",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: async () => ({ default: () => null }),
    },
  },
}));

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import { ExtensionRendererMount } from "../extension-renderer-mount";
import { resolveRuntimeRendererForRoute } from "../runtime-renderer-route";
import { ExtensionRendererSlot } from "../extension-renderer-slot";
import { DynamicRendererLoader } from "../dynamic-renderer-loader";
import { RendererDegradedNotice } from "../renderer-degraded-notice";

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

function props(propsApiVersion = 1): ArtifactRendererProps {
  return {
    propsApiVersion,
    artifact: {
      id: "art_1",
      title: "t",
      objectType: `${PKG}:artifact`,
      mime: "application/json",
      size: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ownerLevel: "organization",
      visibility: "organization",
      sourceUrl: null,
    },
    representation: { revisionId: "rev_1", mime: "application/json" },
    urls: { preview: "/p", download: "/d" },
    identity: { kind: "extension", extension: PKG },
    actions: { download: "/d", openInSource: null },
  };
}

afterEach(() => {
  runtimeAssetRegistry._clearForTests();
});

describe("ExtensionRendererMount — classifies + mounts the loadable path", () => {
  it("build-map claimant → mounts the server-only ExtensionRendererSlot (SSR fast path)", async () => {
    const el = (await ExtensionRendererMount({
      generatedKey: BUILD_MAP_KEY,
      packageName: "@fixture/built-ext",
      slot: "detail",
      props: props(),
      fallback: null,
    })) as ReactElement;
    expect(el.type).toBe(ExtensionRendererSlot);
    expect((el.props as { generatedKey: string }).generatedKey).toBe(BUILD_MAP_KEY);
  });

  it("runtime-admitted claimant → mounts the main-realm DynamicRendererLoader with the serialized descriptor + bound preflight", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    const key = runtimeAssetRegistry.keyFor(PKG, "detail");

    const el = (await ExtensionRendererMount({
      generatedKey: key,
      packageName: PKG,
      slot: "detail",
      props: props(),
      fallback: null,
    })) as ReactElement;

    expect(el.type).toBe(DynamicRendererLoader);
    const p = el.props as {
      descriptor: { tuple: AdmittedClientBundleTuple; reason?: string };
      preflight: () => Promise<unknown>;
    };
    // The exact admitted tuple is serialized down; a healthy tuple carries NO
    // pre-import floor reason (peer/ABI/lifecycle all green → import proceeds).
    expect(p.descriptor.tuple).toEqual(tuple());
    expect(p.descriptor.reason).toBeUndefined();
    expect(typeof p.preflight).toBe("function");
  });

  it("a retired runtime binding (archive race between dispatch and mount) → never blank floor", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    const key = runtimeAssetRegistry.keyFor(PKG, "detail");
    runtimeAssetRegistry.retireByPackage(PKG); // revocation-via-lifecycle (ruling 8)

    const el = (await ExtensionRendererMount({
      generatedKey: key,
      packageName: PKG,
      slot: "detail",
      props: props(),
      fallback: "FLOOR",
    })) as ReactElement;

    // A fragment: the requires-rebuild notice + the generic floor (never blank).
    const kids = (el.props as { children: ReactElement[] }).children;
    expect(kids[0].type).toBe(RendererDegradedNotice);
    expect((kids[0].props as { failureClass: string }).failureClass).toBe("not-built");
    expect(kids[1]).toBe("FLOOR");
  });
});

describe("resolveRuntimeRendererForRoute — attaches the server-known pre-import floor reason", () => {
  it("healthy admitted binding → descriptor with NO reason (import proceeds)", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    const desc = await resolveRuntimeRendererForRoute(runtimeAssetRegistry.keyFor(PKG, "detail"), 1);
    expect(desc).not.toBeNull();
    expect(desc!.reason).toBeUndefined();
  });

  it("React-peer-incompatible tuple → `react-peer-incompatible` BEFORE import (not requires-rebuild)", async () => {
    // Host react is 19.x; a renderer pinning ^18 must degrade with a distinct
    // peer reason, computed server-side against the live host React version.
    const incompatible = tuple({ reactPeerRange: "^18.0.0", reactDomPeerRange: "^18.0.0" });
    await runtimeAssetRegistry.admitAndActivate({ tuple: incompatible, generation: 1, ...okActivate });
    const desc = await resolveRuntimeRendererForRoute(runtimeAssetRegistry.keyFor(PKG, "detail"), 1);
    expect(desc!.reason).toBe("react-peer-incompatible");
  });

  it("props-API-version skew → `abi-incompatible` BEFORE import", async () => {
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });
    // The host snapshot expects props v2; the renderer pinned v1 → ABI floor.
    const desc = await resolveRuntimeRendererForRoute(runtimeAssetRegistry.keyFor(PKG, "detail"), 2);
    expect(desc!.reason).toBe("abi-incompatible");
  });

  it("no live runtime binding → null (caller floors as requires-rebuild)", async () => {
    expect(await resolveRuntimeRendererForRoute(runtimeAssetRegistry.keyFor(PKG, "detail"), 1)).toBeNull();
  });
});
