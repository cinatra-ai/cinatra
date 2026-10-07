/**
 * cinatra#3814 — A RUNTIME DISPLAY IS HANDED THE EDIT CHANNEL IT DECLARED.
 *
 * "The channel version moves, and a display that declared the older version
 * keeps the contract it has." Every runtime-installed display is handed its
 * snapshot by the one component that loads it; the hand-over narrows the edit
 * capability to the props version the display's admitted tuple declares, so a
 * display on the older channel version is handed no title road and keeps its
 * text road, and a display on the new channel version is offered both.
 *
 * The hand-over is read two ways, in the node environment: the pure function
 * directly, and the loader's hook-free mounted display called as a plain
 * function with its returned element read by type and props.
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION,
  readOnlyArtifactEdit,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import type { SerializedRuntimeRendererDescriptor } from "@/lib/artifacts/runtime-renderer-descriptor";
import { runtimeDisplayProps } from "../runtime-display-props";
import { MountedRuntimeDisplay } from "../dynamic-renderer-loader";

const PKG = "@fixture/text-display";
const DIGEST = "b".repeat(128);

function tuple(propsApiVersion: number): AdmittedClientBundleTuple {
  return {
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
}

function descriptor(propsApiVersion: number): SerializedRuntimeRendererDescriptor {
  return {
    digestPinnedUrl: `/api/artifact-renderer-assets/${PKG}/detail/${DIGEST}`,
    tuple: tuple(propsApiVersion),
  };
}

/** The capability the artifact page mints for a writer: the text road and the title road. */
const TITLE_ROAD = {
  kind: "editable" as const,
  channelVersion: 2,
  fields: ["text", "title"] as Array<"text" | "title">,
  artifactId: "artifact-1",
  baseRevisionId: "rev-1",
  saveUrl: "/api/artifacts/artifact-1/edit",
  idlePauseMs: 900,
  capBytes: 256 * 1024,
} as ArtifactRendererProps["edit"];

/** The same capability on the older channel version: the text road only, no `fields` key. */
const OLDER_ROAD = {
  kind: "editable" as const,
  channelVersion: 1,
  artifactId: "artifact-1",
  baseRevisionId: "rev-1",
  saveUrl: "/api/artifacts/artifact-1/edit",
  idlePauseMs: 900,
  capBytes: 256 * 1024,
} as ArtifactRendererProps["edit"];

const BYTES = {
  road: "session" as const,
  preview: "/api/artifacts/artifact-1/versions/rev-1/preview",
  download: "/api/artifacts/artifact-1/versions/rev-1/content",
};

function ceilingProps(): ArtifactRendererProps {
  return {
    propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    edit: TITLE_ROAD,
    artifact: {
      id: "artifact-1",
      title: "A draft",
      objectType: `${PKG}:artifact`,
      mime: "text/markdown",
      size: 10,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ownerLevel: "user",
      visibility: "private",
      sourceUrl: null,
    },
    representation: { revisionId: "rev-1", mime: "text/markdown" },
    urls: { preview: BYTES.preview, download: BYTES.download },
    identity: { kind: "extension", extension: PKG },
    actions: { download: BYTES.download, openInSource: null },
    content: { kind: "none", channelVersion: 1, representationRevisionId: "rev-1", reason: "absent" },
    bytes: BYTES,
  };
}

function withoutEdit(props: ArtifactRendererProps): Partial<ArtifactRendererProps> {
  const rest: Partial<ArtifactRendererProps> = { ...props };
  delete rest.edit;
  return rest;
}

function Probe(): null {
  return null;
}

/** The element the loader's mounted display hands the display, read by type and props. */
function handedChild(propsApiVersion: number): ReactElement {
  const el = MountedRuntimeDisplay({
    Renderer: Probe,
    descriptor: descriptor(propsApiVersion),
    props: ceilingProps(),
    fallback: "FLOOR",
    onError: () => {},
  }) as ReactElement;
  return (el.props as { children: ReactElement }).children;
}

describe("cinatra#3814 — the hand-over rule of a runtime display", () => {
  it("P-a a display that declared props version 1 is handed the text road only, and the rest of the snapshot as carried", () => {
    const handed = runtimeDisplayProps(ceilingProps(), 1);
    expect(handed.edit).toEqual(OLDER_ROAD);
    expect(Object.prototype.hasOwnProperty.call(handed.edit, "fields")).toBe(false);
    expect(handed.edit.kind).toBe("editable");
    expect(withoutEdit(handed)).toEqual(withoutEdit(ceilingProps()));
  });

  it.each([3, 2])("P-c a display that declared props version %i is handed the text road only", (version) => {
    const handed = runtimeDisplayProps(ceilingProps(), version);
    expect(handed.edit).toEqual(OLDER_ROAD);
    expect(Object.prototype.hasOwnProperty.call(handed.edit, "fields")).toBe(false);
    expect(handed.edit.kind).toBe("editable");
    expect(withoutEdit(handed)).toEqual(withoutEdit(ceilingProps()));
  });

  it("P-d a refusal is handed on the older channel version with its reason", () => {
    const handed = runtimeDisplayProps({ ...ceilingProps(), edit: readOnlyArtifactEdit("read-only-surface") }, 3);
    expect(handed.edit).toEqual({ kind: "read-only", channelVersion: 1, reason: "read-only-surface" });
  });

  it("P-b a display that declared the title-edit version is handed the snapshot whole", () => {
    const snapshot = ceilingProps();
    const handed = runtimeDisplayProps(snapshot, ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION);
    expect(handed).toBe(snapshot);
    expect(handed.edit).toEqual(TITLE_ROAD);
  });
});

describe("cinatra#3814 — the loader hands a mounted runtime display the channel it declared", () => {
  it.each([3, 2, 1])("L-a a display that declared props version %i is handed no title road", (version) => {
    const child = handedChild(version);
    expect(child.type).toBe(Probe);
    expect(child.props).toEqual({ ...ceilingProps(), edit: OLDER_ROAD });
    expect(child.props).toEqual(runtimeDisplayProps(ceilingProps(), version));
  });

  it("L-b a display that declared the title-edit version is handed the text road and the title road", () => {
    const child = handedChild(ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION);
    expect(child.type).toBe(Probe);
    expect(child.props).toEqual(ceilingProps());
    expect((child.props as ArtifactRendererProps).edit).toEqual(TITLE_ROAD);
  });
});
