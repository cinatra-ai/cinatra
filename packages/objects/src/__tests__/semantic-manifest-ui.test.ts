// Boot-path tolerance for cinatra.artifact.ui (cinatra#1621, epic #1620).
//
// The bug this slice fixes: an unknown/invalid `ui` block used to fail the
// WHOLE strict parse, dropping the extension's type registration + objectTypes
// claims at boot. Here we pin the new contract: a valid `ui` is attached
// (typed); an invalid `ui` DEGRADES (dropped + diagnostic) while the claims and
// every other field survive; a legacy manifest (no `ui`) parses exactly as
// before; unknown NON-`ui` keys keep the strict whole-parse rejection.
import { describe, it, expect } from "vitest";
import { ARTIFACT_UI_SDK_ABI_RANGE } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { parseSemanticArtifactManifest } from "../semantic-manifest";

const validUi = {
  abiVersion: 1,
  sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
  renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
};

describe("parseSemanticArtifactManifest — cinatra.artifact.ui tolerance", () => {
  it("accepts the activated listRow slot through the mirror parse (S7/M2, cinatra#1631)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      ui: {
        abiVersion: 1,
        sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
        renderers: { listRow: { entry: "./src/row.tsx", propsApiVersion: 1 } },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.ui?.renderers?.listRow?.entry).toBe("./src/row.tsx");
      expect(r.diagnostics).toBeUndefined();
    }
  });

  it("attaches a valid ui block (typed) with no diagnostics", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      ui: validUi,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.ui).toBeDefined();
      expect(r.manifest.ui?.renderers?.detail?.entry).toBe("./src/detail.tsx");
      expect(r.diagnostics).toBeUndefined();
    }
  });

  it("DEGRADES an invalid ui block — ui dropped + diagnostic, claims INTACT", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      objectTypes: [{ type: "@vendor/pkg:thing", claim: "dedicated" }],
      ui: { abiVersion: 2, renderers: {} }, // wrong abiVersion + empty renderers
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Degraded: ui dropped, NOT a whole-parse rejection.
      expect(r.manifest.ui).toBeUndefined();
      // The extension's claims survive — this is the whole point.
      expect(r.manifest.objectTypes).toEqual([{ type: "@vendor/pkg:thing", claim: "dedicated" }]);
      // And the representation forms survive too.
      expect(r.manifest.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
      expect(r.diagnostics?.length).toBeGreaterThan(0);
      expect(r.diagnostics?.join(" ")).toMatch(/cinatra\.artifact\.ui is invalid/);
    }
  });

  it("degrades a renderer built for an incompatible SDK ABI (claims intact)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { dashboard: true },
      objectTypes: [{ type: "@vendor/pkg:thing", claim: "dedicated" }],
      ui: { abiVersion: 1, sdkAbiRange: "^99.0.0", renderers: { detail: { entry: "./d.tsx", propsApiVersion: 1 } } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.ui).toBeUndefined();
      expect(r.manifest.objectTypes).toHaveLength(1);
      expect(r.diagnostics?.join(" ")).toMatch(/does not satisfy/);
    }
  });

  it("a LEGACY manifest (no ui) parses exactly as before — no ui, no diagnostics", () => {
    const legacy = {
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      satisfies: ["@cinatra-ai/marketing-icp-artifact"],
      objectTypes: [{ type: "@vendor/pkg:thing", claim: "dedicated" }],
    };
    const r = parseSemanticArtifactManifest(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.ui).toBeUndefined();
      expect(r.diagnostics).toBeUndefined();
      expect(r.manifest).toEqual(legacy);
    }
  });

  it("still REJECTS an unknown NON-ui key (strict whole-parse rejection preserved)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { dashboard: true },
      oas: { nodes: [] },
      ui: validUi,
    });
    expect(r.ok).toBe(false);
  });
});
