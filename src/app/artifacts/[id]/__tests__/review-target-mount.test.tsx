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

import { ReviewTargetMount, reviewTargetFloorDiagnostic } from "../review-target-mount";
import { ExtensionRendererSlot } from "../extension-renderer-slot";
import { DynamicRendererLoader } from "../dynamic-renderer-loader";
import { MarkdownHandler } from "../handlers/markdown-handler";
import { PlainTextHandler } from "../handlers/plain-text-handler";

/** The host's TRUSTED organization scope — supplied by the surface that already
 * authorized the reader, never read from the display props. */
const ORG = "org_mount_test";

function props(): ArtifactRendererProps {
  return {
    propsApiVersion: 1,
    edit: { kind: "read-only" as const, channelVersion: 1, reason: "read-only-surface" as const },
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
    // The content channel (enabler 0.3, cinatra#3027). This fixture predates it
    // and draws from the byte hrefs above, so it carries the NAMED absence — the
    // same answer the props builder yields for a caller that has not built a
    // projection.
    content: { kind: "none", channelVersion: 1, representationRevisionId: "rev_1", reason: "absent" },
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
      edit: { kind: "read-only" as const, channelVersion: 1, reason: "read-only-surface" as const },
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
    const el = (await ReviewTargetMount({ mount, props: props(), orgId: ORG, fallback: "FLOOR" })) as ReactElement;
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
    const el = (await ReviewTargetMount({ mount, props: props(), orgId: ORG, fallback: "FLOOR" })) as ReactElement;
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
    const el = (await ReviewTargetMount({ mount, props: null, orgId: ORG, fallback: "FLOOR" })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBe("requires-rebuild");
    const kids = (el.props as { children: unknown[] }).children;
    // The last child is the caller's generic fallback (never blank).
    expect(kids[kids.length - 1]).toBe("FLOOR");
  });

  // cinatra#2931 W4 — the FORM RUNG (plan (B) §5).
  it("form mount (markdown) → the host's markdown renderer, server-side, on the PINNED revision", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "form",
      slot: "detail",
      arm: "first-party",
      form: "markdown",
    };
    const el = (await ReviewTargetMount({ mount, props: props(), orgId: ORG, fallback: "FLOOR" })) as ReactElement;
    expect(el.type).toBe(MarkdownHandler);
    const p = el.props as { artifactId: string; revisionId: string; orgId: string };
    expect(p.artifactId).toBe("art_1");
    // The gate's frozen revision — never the artifact's latest.
    expect(p.revisionId).toBe("rev_1");
    // The organization scope comes from the HOST, not from the display props.
    expect(p.orgId).toBe(ORG);
  });

  it("form mount (text) → the host's plain-text renderer", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "form",
      slot: "detail",
      arm: "first-party",
      form: "text",
    };
    const el = (await ReviewTargetMount({ mount, props: props(), orgId: ORG, fallback: "FLOOR" })) as ReactElement;
    expect(el.type).toBe(PlainTextHandler);
  });

  it("a form mount with no pinned representation → floor, never an unpinned render", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "form",
      slot: "detail",
      arm: "first-party",
      form: "markdown",
    };
    const bare = { ...props(), representation: null };
    const el = (await ReviewTargetMount({ mount, props: bare, orgId: ORG, fallback: "FLOOR" })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBe("no-representation");
  });

  // cinatra#2931 W4 — the maintainer's answer of 2026-08-23 (Q3): for a target
  // with TRULY no renderer, the short technical line STAYS for now. The plan
  // retires the fallback FACE (the sentence about renderers, the field table,
  // the Preview / Download links) — not the honest one-line diagnostic that says
  // the target could not be shown. This pins the line's exact wording and that
  // it is the whole reading: the card passes no fallback node beneath it.
  it("a target nothing renders keeps the short technical line, and nothing beneath it", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "floor",
      slot: "detail",
      packageName: null,
      reason: "no-semantic-renderer",
    };
    const el = (await ReviewTargetMount({
      mount,
      props: props(),
      orgId: ORG,
      fallback: null,
    })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBe(
      "no-semantic-renderer",
    );
    expect(reviewTargetFloorDiagnostic(null, "detail", "no-semantic-renderer")).toBe(
      'review target unavailable — slot "detail", reason "no-semantic-renderer"',
    );
    const kids = (el.props as { children: unknown[] }).children;
    expect(kids[kids.length - 1]).toBeNull();
  });

  it("a loadable mount whose props are unexpectedly null → floor, never a blank/crash", async () => {
    const mount: ReviewTargetMountDescriptor = {
      kind: "build-map",
      slot: "detail",
      packageName: "@x/ext",
      generatedKey: "@x/ext::detail",
    };
    const el = (await ReviewTargetMount({ mount, props: null, orgId: ORG, fallback: "FLOOR" })) as ReactElement;
    expect((el.props as Record<string, unknown>)["data-review-target-floor"]).toBeDefined();
  });
});
