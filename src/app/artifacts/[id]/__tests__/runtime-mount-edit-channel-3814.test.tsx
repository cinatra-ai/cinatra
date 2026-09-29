/**
 * cinatra#3814 — THE RUNTIME SEAM HANDS A DISPLAY THE EDIT CHANNEL IT DECLARED.
 *
 * "The channel version moves, and a display that declared the older version
 * keeps the contract it has." A build-map display is handed its snapshot through
 * `artifactRendererPropsAtVersion`; a RUNTIME-installed display is handed the
 * snapshot by `ExtensionRendererMount` directly, so this seam has to narrow the
 * edit capability to the props version the display's admitted tuple declares —
 * or a display on the older channel version would be handed a title road it
 * never agreed to (and a strict reader of the older version would lose its text
 * road with it).
 */
import type { ReactElement } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

// The same module doubles `runtime-renderer-mount.test.tsx` carries: the fixture
// package is treated as installed, and the build map holds no runtime key.
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => true,
}));
vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/built-ext::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/built-ext",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      edit: { kind: "read-only" as const, channelVersion: 1, reason: "read-only-surface" as const },
      load: async () => ({ default: () => null }),
    },
  },
}));

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import { ExtensionRendererMount } from "../extension-renderer-mount";
import { DynamicRendererLoader } from "../dynamic-renderer-loader";

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

const okActivate = { materialize: async () => {}, verify: async () => true };

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

async function handedTo(propsApiVersion: number): Promise<ArtifactRendererProps> {
  await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(propsApiVersion), generation: 1, ...okActivate });
  const el = (await ExtensionRendererMount({
    generatedKey: runtimeAssetRegistry.keyFor(PKG, "detail"),
    packageName: PKG,
    slot: "detail",
    props: ceilingProps(),
    fallback: null,
  })) as ReactElement;
  expect(el.type).toBe(DynamicRendererLoader);
  return (el.props as { props: ArtifactRendererProps }).props;
}

afterEach(() => {
  runtimeAssetRegistry._clearForTests();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("@/lib/artifacts/artifact-extension-access");
  vi.doUnmock("@/lib/generated/artifact-renderers");
  vi.resetModules();
});

describe("cinatra#3814 — a display on the older channel version is handed no title road", () => {
  it("R-a a runtime display that declared props version 1 is handed the channel at version 1, and its bytes as carried", async () => {
    const handed = await handedTo(1);
    expect(handed.edit.channelVersion).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(handed.edit, "fields")).toBe(false);
    expect(handed.edit.kind).toBe("editable");
    expect(handed.bytes).toEqual(BYTES);
  });

  it("R-b a runtime display that declared the title-edit version is handed the capability whole", async () => {
    const handed = await handedTo(ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION);
    expect(handed.edit).toEqual(TITLE_ROAD);
  });
});
