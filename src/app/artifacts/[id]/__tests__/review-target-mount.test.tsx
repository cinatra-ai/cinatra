/**
 * The client artifact-MOUNT BRIDGE for the review surface (cinatra#1795, epic
 * #1620 S12, item 3; AC-2). Proves the bridge mounts a build-map claimant and a
 * runtime claimant, floors (never blank) on the floor descriptor, and has NO
 * client-supplied renderer-id path — the renderer identity crosses ONLY as the
 * host-produced mount descriptor. Server-component-as-function (mirrors
 * runtime-renderer-mount.test.tsx).
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import type { SerializedRuntimeRendererDescriptor } from "@/lib/artifacts/runtime-renderer-descriptor";
import type { ReviewTargetMount as ReviewTargetMountDescriptor } from "@/lib/artifacts/artifact-review-preparation";

import { ReviewTargetMount } from "../review-target-mount";
import { ExtensionRendererSlot } from "../extension-renderer-slot";
import { DynamicRendererLoader } from "../dynamic-renderer-loader";

function props(): ArtifactRendererProps {
  return {
    propsApiVersion: 1,
    artifact: {
      id: "art_1",
      title: "t",
      objectType: "@x/ext:artifact",
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
    identity: { kind: "extension", extension: "@x/ext" },
    actions: { download: "/d", openInSource: null },
  };
}

function descriptor(): SerializedRuntimeRendererDescriptor {
  return {
    digestPinnedUrl: "/api/artifact-renderer-assets/@x%2Fext/detail/dddd",
    tuple: {
      packageName: "@x/ext",
      slot: "detail",
      digest: "d".repeat(64),
      entry: "client/detail.js",
      propsApiVersion: 1,
      sdkAbiRange: "^2.4.0",
      reactPeerRange: "^19.0.0",
      reactDomPeerRange: "^19.0.0",
      tokenModuleAbi: "1.0.0",
    },
  } as SerializedRuntimeRendererDescriptor;
}

describe("ReviewTargetMount — mounts the host mount descriptor (no client renderer-id path)", () => {
  it("build-map mount → the server-only ExtensionRendererSlot, host generatedKey passed through", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "build-map",
      slot: "detail",
      packageName: "@x/ext",
      generatedKey: "@x/ext::detail",
    };
    const el = (await ReviewTargetMount({ mount, props: props(), fallback: "FLOOR" })) as ReactElement;
    expect(el.type).toBe(ExtensionRendererSlot);
    expect((el.props as { generatedKey: string }).generatedKey).toBe("@x/ext::detail");
  });

  it("runtime mount → the main-realm DynamicRendererLoader with the host descriptor + a BOUND preflight", async () => {
    const desc = descriptor();
    const mount: ReviewTargetMountDescriptor = {
      kind: "runtime",
      slot: "detail",
      packageName: "@x/ext",
      descriptor: desc,
    };
    const el = (await ReviewTargetMount({ mount, props: props(), fallback: "FLOOR" })) as ReactElement;
    expect(el.type).toBe(DynamicRendererLoader);
    const p = el.props as { descriptor: SerializedRuntimeRendererDescriptor; preflight: () => Promise<unknown> };
    expect(p.descriptor).toBe(desc);
    expect(typeof p.preflight).toBe("function");
  });

  it("floor mount → never blank: a sanitized diagnostic + the caller's fallback", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "floor",
      slot: "detail",
      packageName: "@x/ext",
      reason: "requires-rebuild",
    };
    const el = (await ReviewTargetMount({ mount, props: null, fallback: "FLOOR" })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBe("requires-rebuild");
    const kids = (el.props as { children: unknown[] }).children;
    // The last child is the caller's generic fallback (never blank).
    expect(kids[kids.length - 1]).toBe("FLOOR");
  });

  it("a loadable mount whose props are unexpectedly null → floor, never a blank/crash", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "build-map",
      slot: "detail",
      packageName: "@x/ext",
      generatedKey: "@x/ext::detail",
    };
    const el = (await ReviewTargetMount({ mount, props: null, fallback: "FLOOR" })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBeDefined();
  });
});
