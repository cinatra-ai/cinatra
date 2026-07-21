/**
 * G2 CUTOVER of the four system `-artifact` base arms (epic #1620 M1 Slice B,
 * cinatra#1630 §5.1 / §5.3). The proof that removing the legacy host pdf/image/
 * audio/video DETAIL arms is safe:
 *
 *   1. PER-ARM cutover matrix — each base arm drives the REAL precedence leaf
 *      across every G2 world-state and reports `ready` (the contract a wave must
 *      satisfy BEFORE deleting the legacy arm).
 *   2. END-TO-END flip — with the host pickHandler arm removed, an ALLOWLISTED
 *      row of each family now dispatches to its build-bundled base renderer
 *      (representation → build-map fast path), through the real resolution seam +
 *      arbitration registry + generated build map. This is the behavior the
 *      cutover lands.
 *   3. NEVER-BLANK — a MIME family with no host floor and no covering base hits
 *      the generic floor, never a blank.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import {
  resolveArtifactDispatchInputs,
  classifyLoadablePath,
  _resetFirstPartySeedForTests,
} from "../../renderer-resolution";
import { pickArtifactRenderer } from "../../renderer-dispatch";
import { evaluateArtifactDetailArmCutover } from "../artifact-detail-cutover-probe";
import type { HandlerKind } from "../../pick-handler";

const ORG = "org_g2_cutover";
const floor: EffectiveIdentity = { kind: "no-primary" };

function dispatchFor(mime: string) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({ orgId: ORG, baseType: "@cinatra-ai/artifact:object", identity: floor, mime }),
  );
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

// The four base DETAIL arms being cut, with the handler they migrated FROM.
const ARMS: ReadonlyArray<{ pkg: string; mime: string; family: string; firstPartyHandler: Exclude<HandlerKind, "fallback"> }> = [
  { pkg: "@cinatra-ai/pdf-artifact", mime: "application/pdf", family: "application/pdf", firstPartyHandler: "pdf" },
  { pkg: "@cinatra-ai/image-artifact", mime: "image/png", family: "image/*", firstPartyHandler: "image" },
  { pkg: "@cinatra-ai/audio-artifact", mime: "audio/mpeg", family: "audio/*", firstPartyHandler: "audio" },
  { pkg: "@cinatra-ai/video-artifact", mime: "video/mp4", family: "video/*", firstPartyHandler: "video" },
];

describe("G2 — each system base arm is cutover-ready across the whole matrix", () => {
  it.each(ARMS)("$family arm is cutover-ready (drives the real precedence leaf)", ({ family, firstPartyHandler, pkg }) => {
    const report = evaluateArtifactDetailArmCutover({
      system: "representation-viewer",
      mime: family,
      firstPartyHandler,
      packageName: pkg,
      generatedKey: `${pkg}::detail`,
    });
    expect(report.ready, JSON.stringify(report.unmet)).toBe(true);
  });
});

describe("G2 — the cutover FLIP: allowlisted rows now dispatch to the system base", () => {
  it.each(ARMS)("$mime → representation via $pkg::detail (build-map), no host handler shadow", ({ mime, pkg }) => {
    const dispatch = dispatchFor(mime);
    expect(dispatch).toEqual({
      kind: "representation",
      packageName: pkg,
      generatedKey: `${pkg}::detail`,
      pattern: expect.any(String),
    });
    expect(classifyLoadablePath(`${pkg}::detail`)).toBe("build-map");
  });
});

describe("G2 — never-blank guardrail", () => {
  it("a MIME family with no host floor and no covering base hits the generic floor", () => {
    // application/zip: not allowlisted, no system base covers it.
    expect(dispatchFor("application/zip")).toEqual({ kind: "fallback" });
  });

  it("the core-owned floor survives the cutover (markdown/plain-text still host-rendered)", () => {
    // The REPRESENTATION path (a markdown/plain-text REPRESENTATION of a row NOT
    // typed to a text base) keeps the host floor: text-artifact declares
    // representations=[text/csv] ONLY, so it registers no representation provider
    // for text/plain or text/markdown and cannot displace this floor.
    expect(dispatchFor("text/markdown")).toEqual({ kind: "mime", handler: "markdown" });
    expect(dispatchFor("text/plain")).toEqual({ kind: "mime", handler: "text" });
  });
});

// The SEMANTIC (by object-type) path is distinct from the representation path
// above (epic #1883 A1). A row TYPED to a required text/JSON base renders via THAT
// pack's own detail renderer regardless of its representation MIME — the base owns
// its typed rows. text-artifact's `representations=[text/csv]` subset bounds only
// the mime-keyed REPRESENTATION path (preserving the host floor above); it does
// NOT change that a text-artifact-TYPED row mounts text-artifact::detail. Pinned
// here so the two paths' interaction is deliberate, not accidental.
describe("G2 — a required text base owns its OWN typed rows via the semantic path", () => {
  const TEXT_PKG = "@cinatra-ai/text-artifact";
  const TEXT_TYPE = "@cinatra-ai/text-artifact:artifact";

  function dispatchTyped(baseType: string, mime: string) {
    return pickArtifactRenderer(
      resolveArtifactDispatchInputs({
        orgId: ORG,
        baseType,
        identity: { kind: "extension", extension: TEXT_PKG },
        mime,
      }),
    );
  }

  it("a text-artifact-TYPED markdown/plain/csv row mounts text-artifact::detail (semantic, build-map)", () => {
    // The bridge registers the pack's detail renderer semantically for its owned
    // type; text-artifact::detail is a real system entry in the generated build map.
    semanticRendererRegistry.register({ objectTypeId: TEXT_TYPE, packageName: TEXT_PKG });
    for (const mime of ["text/markdown", "text/plain", "text/csv"]) {
      expect(dispatchTyped(TEXT_TYPE, mime)).toEqual({
        kind: "semantic",
        packageName: TEXT_PKG,
        generatedKey: `${TEXT_PKG}::detail`,
      });
    }
    expect(classifyLoadablePath(`${TEXT_PKG}::detail`)).toBe("build-map");
    // The floor still owns a markdown REPRESENTATION of a row NOT typed to the base.
    expect(dispatchFor("text/markdown")).toEqual({ kind: "mime", handler: "markdown" });
  });
});
