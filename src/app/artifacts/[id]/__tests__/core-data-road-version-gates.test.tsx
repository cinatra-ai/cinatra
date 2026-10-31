/**
 * NO v3-ONLY FIELD REACHES A v1 OR v2 DISPLAY, ON EITHER MOUNT ROAD (cinatra#4311).
 *
 * The artifact page builds ONE snapshot at the host's ceiling, with the session
 * data road on it, and hands that snapshot to whichever display resolves. Two
 * mount roads hand it on:
 *
 *   · the BUILD-MAP seam (`ExtensionRendererSlot`) narrows it to the version the
 *     loader negotiated, through `artifactRendererPropsAtVersion`;
 *   · the RUNTIME hand-over (`MountedRuntimeDisplay`, through
 *     `runtimeDisplayProps`) hands it to the version the admitted tuple declares.
 *
 * The props contract says the review reading and the data road are "ABSENT
 * BELOW v3", and the decision time is absent below v5. This suite drives the
 * page's own snapshot (the real builder, the real named road) through both real
 * mount components and reads what each display is handed.
 *
 * The review surface builds its snapshot at the declared version already (the
 * binder passes the mount's version to the builder), so its gate is the
 * builder's own and is pinned in `core-data-road-supply.test.ts`.
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

const { loadArtifactRenderer } = vi.hoisted(() => ({ loadArtifactRenderer: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-renderer-loader", () => ({
  loadArtifactRenderer: (args: unknown) => loadArtifactRenderer(args),
}));

import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_SESSION_DATA_ROAD,
  absentArtifactContent,
  buildArtifactRendererProps,
  readOnlyArtifactEdit,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { SerializedRuntimeRendererDescriptor } from "@/lib/artifacts/runtime-renderer-descriptor";
import { MountedRuntimeDisplay } from "../dynamic-renderer-loader";
import { ExtensionRendererSlot } from "../extension-renderer-slot";
import { runtimeDisplayProps } from "../runtime-display-props";

const PKG = "@fixture/dashboard-display";
const DIGEST = "c".repeat(128);
const DECIDED_AT = "2026-10-24T12:00:00.000Z";

const identity = { kind: "extension", extension: PKG } as const;
const artifact = {
  artifactId: "art_4311_gate",
  title: "Pipeline health",
  objectType: `${PKG}:dashboard`,
  mime: "application/vnd.cinatra.dashboard+json",
  size: 10,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: identity,
  presentationIdentity: identity,
} as unknown as ArtifactSummary;

/** The artifact page's snapshot: the ceiling version and the session data road. */
function pageSnapshot(extra: Partial<Parameters<typeof buildArtifactRendererProps>[0]> = {}): ArtifactRendererProps {
  return buildArtifactRendererProps({
    artifact,
    representation: { revisionId: "rev_4311_gate", mime: artifact.mime },
    previewHref: null,
    downloadHref: null,
    content: absentArtifactContent("rev_4311_gate"),
    edit: readOnlyArtifactEdit("read-only-surface"),
    data: ARTIFACT_RENDERER_SESSION_DATA_ROAD,
    ...extra,
  });
}

/** A snapshot that also carries a continued review reading with its decision time. */
function reviewSnapshot(): ArtifactRendererProps {
  return pageSnapshot({ review: { reading: "continued", openLive: "/dashboards/d1", decidedAt: DECIDED_AT } });
}

function descriptor(propsApiVersion: number): SerializedRuntimeRendererDescriptor {
  const tuple: AdmittedClientBundleTuple = {
    packageName: PKG,
    slot: "detail",
    digest: DIGEST,
    entry: "client/detail.js",
    propsApiVersion,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
  };
  return { digestPinnedUrl: `/api/artifact-renderer-assets/${PKG}/detail/${DIGEST}`, tuple };
}

function Probe(): null {
  return null;
}

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** What the real runtime hand-over hands a display that declared `version`. */
function runtimeHanded(props: ArtifactRendererProps, version: number): ArtifactRendererProps {
  const el = MountedRuntimeDisplay({
    Renderer: Probe,
    descriptor: descriptor(version),
    props,
    fallback: "FLOOR",
    onError: () => {},
  }) as ReactElement;
  const child = (el.props as { children: ReactElement }).children;
  expect(child.type).toBe(Probe);
  return child.props as ArtifactRendererProps;
}

/** What the real build-map seam hands a display the loader negotiated at `version`. */
async function buildMapHanded(props: ArtifactRendererProps, version: number): Promise<ArtifactRendererProps> {
  loadArtifactRenderer.mockResolvedValue({ ok: true, Component: Probe, negotiatedPropsApiVersion: version });
  const el = (await ExtensionRendererSlot({
    generatedKey: `${PKG}:detail`,
    packageName: PKG,
    slot: "detail",
    props,
    fallback: "FLOOR",
  })) as ReactElement;
  expect(el.type).toBe(Probe);
  return el.props as ArtifactRendererProps;
}

describe("the page's snapshot carries the data road at the ceiling", () => {
  it("is built at the ceiling version with the session data road", () => {
    const props = pageSnapshot();
    expect(props.propsApiVersion).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
    expect(props.data).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });
});

describe("the RUNTIME hand-over hands no v3-only field below v3", () => {
  it.each([2, 1])("a runtime display that declared version %i is handed no data key", (version) => {
    const handed = runtimeHanded(pageSnapshot(), version);
    expect(has(handed, "data")).toBe(false);
  });

  it.each([2, 1])("a runtime display that declared version %i is handed no review key", (version) => {
    const handed = runtimeHanded(reviewSnapshot(), version);
    expect(has(handed, "review")).toBe(false);
    expect(has(handed, "data")).toBe(false);
  });

  it.each([3, 4])("a runtime display that declared version %i is handed no decision time", (version) => {
    const handed = runtimeHanded(reviewSnapshot(), version);
    expect(handed.review).toEqual({ reading: "continued", openLive: "/dashboards/d1" });
    expect(handed.data).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });

  it.each([3, 4, 5])("a runtime display that declared version %i is handed the data road", (version) => {
    const handed = runtimeHanded(pageSnapshot(), version);
    expect(handed.data).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });

  it("a runtime display at the ceiling is handed the snapshot whole, decision time included", () => {
    const snapshot = reviewSnapshot();
    expect(runtimeDisplayProps(snapshot, ARTIFACT_RENDERER_PROPS_API_VERSION)).toBe(snapshot);
    expect(snapshot.review?.decidedAt).toBe(DECIDED_AT);
  });

  it("narrows nothing else: the byte reference and propsApiVersion stay as carried, the edit rule is cinatra#3814's", () => {
    const snapshot = pageSnapshot({
      previewHref: "/api/artifacts/art_4311_gate/versions/rev_4311_gate/preview",
      downloadHref: null,
    });
    const handed = runtimeDisplayProps(snapshot, 2);
    const rest = (p: ArtifactRendererProps) => {
      const copy: Partial<ArtifactRendererProps> = { ...p };
      delete copy.data;
      delete copy.edit;
      return copy;
    };
    expect(handed.propsApiVersion).toBe(snapshot.propsApiVersion);
    expect(handed.bytes).toEqual(snapshot.bytes);
    expect(rest(handed)).toEqual(rest(snapshot));
  });

  it("never changes the snapshot it was handed", () => {
    const snapshot = reviewSnapshot();
    const before = JSON.stringify(snapshot);
    runtimeDisplayProps(snapshot, 1);
    runtimeDisplayProps(snapshot, 3);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe("the BUILD-MAP seam hands no v3-only field below v3 (reference: it already narrows)", () => {
  it.each([2, 1])("a build-map display negotiated at version %i is handed no data or review key", async (version) => {
    const handed = await buildMapHanded(reviewSnapshot(), version);
    expect(handed.propsApiVersion).toBe(version);
    expect(has(handed, "data")).toBe(false);
    expect(has(handed, "review")).toBe(false);
  });

  it("a build-map display negotiated at version 3 is handed the data road", async () => {
    const handed = await buildMapHanded(pageSnapshot(), 3);
    expect(handed.data).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });
});
