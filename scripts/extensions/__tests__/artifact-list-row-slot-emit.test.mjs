// THE LIST-ROW SLOT AS A PER-EXTENSION OPTION
// (Lifecycle D W7, cinatra#3095 — plan §3.4 wave 7 item 1.)
//
// An artifact extension MAY declare `cinatra.artifact.ui.renderers.listRow`.
// This pins the two ends of that declaration inside the generator: the
// PACKAGING RULE it must satisfy (the extension publishes the renderer through
// its own `exports`, and the host can resolve it), and the BUILD MAP the
// generator emits from it — the table the artifacts library resolves a claimed
// row's glyph through.
//
// Nothing here makes the slot REQUIRED: an extension that declares no `listRow`
// emits no entry, and the review-floor gate reads the `detail` slot alone.

import { describe, it, expect } from "vitest";

import {
  emitArtifactRenderers,
  assertArtifactRendererPackaging,
} from "../generate-extension-manifest.mjs";

// The declaration the email pack carries, in the shape the generator's
// collector produces from its package.json.
const DECLARED_LIST_ROW = {
  packageName: "@cinatra-ai/email-artifacts",
  slot: "listRow",
  specifier: "@cinatra-ai/email-artifacts/src/renderers/list-row",
  representations: [],
  propsApiVersion: 1,
  resolution: "guardedOptional",
};

describe("the packaging rule for a declared listRow renderer", () => {
  const base = {
    packageName: "@cinatra-ai/email-artifacts",
    slot: "listRow",
    specifier: "@cinatra-ai/email-artifacts/src/renderers/list-row",
    exportsKey: "./src/renderers/list-row",
    hasExportsEntry: true,
    hasAliasRoad: true,
    hasDependencyEdge: false,
  };

  it("accepts a pack that publishes the renderer through its own exports", () => {
    expect(() => assertArtifactRendererPackaging(base)).not.toThrow();
  });

  it("REFUSES a pack that declares the slot but publishes no exports entry", () => {
    expect(() => assertArtifactRendererPackaging({ ...base, hasExportsEntry: false })).toThrow(
      /is not published by its own package/,
    );
  });

  it("REFUSES a declaration the host has no road to resolve", () => {
    expect(() =>
      assertArtifactRendererPackaging({ ...base, hasAliasRoad: false, hasDependencyEdge: false }),
    ).toThrow(/no resolution road/);
  });
});

describe("the declared listRow reaches the generated build map", () => {
  const emitted = emitArtifactRenderers([DECLARED_LIST_ROW]);

  it("emits the entry under the `<package>::<slot>` key the host resolves", () => {
    expect(emitted).toContain('"@cinatra-ai/email-artifacts::listRow"');
    expect(emitted).toContain('"slot":"listRow"');
  });

  it("loads it from the package's OWN subpath, through the guarded import", () => {
    expect(emitted).toContain(
      'guardedExtensionImport("@cinatra-ai/email-artifacts/src/renderers/list-row"',
    );
    expect(emitted).not.toContain("extensions/cinatra-ai/email-artifacts");
  });

  it("carries the declared props-contract version", () => {
    expect(emitted).toContain('"propsApiVersion":1');
  });

  it("declares listRow in the entry type, beside detail and preview", () => {
    expect(emitted).toContain('slot: "detail" | "preview" | "listRow";');
  });

  it("emits NOTHING for a fleet in which no extension declares a renderer", () => {
    const empty = emitArtifactRenderers([]);
    expect(empty).toContain(
      "export const GENERATED_ARTIFACT_RENDERERS: Record<string, GeneratedArtifactRendererEntry> = {\n};",
    );
  });
});
