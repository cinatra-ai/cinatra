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
    expect(dispatchFor("text/markdown")).toEqual({ kind: "mime", handler: "markdown" });
    expect(dispatchFor("text/plain")).toEqual({ kind: "mime", handler: "text" });
  });
});
