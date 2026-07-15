// artifact-ui mirror parity + publish-gate fail-closed (cinatra#1621, epic #1620).
//
// AC: the `artifact-ui-mirror` block is byte-identical across the canonical
// semantic manifest (packages/objects/src/semantic-manifest.ts) and the
// extensions handler's descriptor copy (packages/extensions/src/
// artifact-handler.ts) — the same lock-step convention the objectTypes block
// uses. And the handler's validate() REJECTS an invalid `ui` block fail-closed
// (unlike the boot path, which degrades-with-diagnostic and keeps the claims).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";
import { ARTIFACT_UI_SDK_ABI_RANGE } from "@cinatra-ai/sdk-extensions/artifact-contract";

// Mock the objects barrel to keep this a leaf-light UNIT test (the
// artifact-handler-generic-vendor precedent). validate() never touches it; the
// `/claims` subpath (a distinct entry the mock does not intercept) and the
// sdk-extensions leaf `parseArtifactUi` both stay REAL.
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));

import { createArtifactExtensionHandler } from "../artifact-handler";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function mirrorBlock(relPath: string): string {
  const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const begin = text.indexOf("// BEGIN artifact-ui-mirror");
  const endMarker = "// END artifact-ui-mirror";
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) {
    throw new Error(`artifact-ui-mirror block not found in ${relPath}`);
  }
  return text.slice(begin, end + endMarker.length);
}

describe("artifact-ui-mirror parity", () => {
  it("the mirror block is byte-identical across the objects manifest and the extensions handler", () => {
    const objectsBlock = mirrorBlock("packages/objects/src/semantic-manifest.ts");
    const extensionsBlock = mirrorBlock("packages/extensions/src/artifact-handler.ts");
    expect(objectsBlock.length).toBeGreaterThan(0);
    expect(extensionsBlock).toBe(objectsBlock);
  });
});

const handler = createArtifactExtensionHandler();
if (!handler.validate) throw new Error("artifact handler must expose validate()");
const validate = handler.validate.bind(handler);

function artifactManifest(ui: unknown) {
  return {
    name: "@third/party-artifact",
    cinatra: {
      kind: "artifact",
      artifact: {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        ...(ui !== undefined ? { ui } : {}),
      },
    },
  };
}

const validUi = {
  abiVersion: 1,
  sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
  renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
};

describe("handler.validate — cinatra.artifact.ui fail-closed at publish", () => {
  it("accepts a valid v1 ui block", async () => {
    const r = await validate(artifactManifest(validUi));
    expect(r.valid).toBe(true);
  });

  it("accepts a manifest with NO ui (unchanged)", async () => {
    const r = await validate(artifactManifest(undefined));
    expect(r.valid).toBe(true);
  });

  it("REJECTS an invalid ui block (wrong abiVersion + empty renderers)", async () => {
    const r = await validate(artifactManifest({ abiVersion: 2, renderers: {} }));
    expect(r.valid).toBe(false);
    expect((r.errors ?? []).join(" ")).toMatch(/cinatra\.artifact\.ui is rejected/);
  });

  it("REJECTS a renderer requesting host ports (v1 declares none)", async () => {
    const r = await validate(
      artifactManifest({
        abiVersion: 1,
        sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
        renderers: { detail: { entry: "./src/d.tsx", propsApiVersion: 1, ports: ["settings"] } },
      }),
    );
    expect(r.valid).toBe(false);
    expect((r.errors ?? []).join(" ")).toMatch(/cinatra\.artifact\.ui is rejected/);
  });

  it("REJECTS a RESERVED slot (listRow) in v1", async () => {
    const r = await validate(
      artifactManifest({
        abiVersion: 1,
        sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
        renderers: { listRow: { entry: "./src/row.tsx", propsApiVersion: 1 } },
      }),
    );
    expect(r.valid).toBe(false);
  });
});
