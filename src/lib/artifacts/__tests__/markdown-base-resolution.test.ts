// ---------------------------------------------------------------------------
// Item 0.19 of the readiness plan, over the LIVE pinned extension tree:
//
//   "Two base extensions: markdown, accepting `text/markdown` alone … and
//    binary, accepting `application/octet-stream` alone … the text base gives
//    markdown up in the same re-pin."
//
// and item 0.18's install-time rule: "Two installed bases claiming one form is
// a packaging defect refused at install, never a run-time guess."
//
// So this asserts BOTH halves of the move: `text/markdown` reaches the markdown
// base, and it reaches NOTHING ELSE — the text base has given it up and still
// answers for `text/plain` and `text/csv`. It runs the REAL registry bridge
// over the REAL `extensions/` tree at the committed pins, so a lock that
// re-pins markdown back into the text base fails here.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPackageRequiredInProd } from "@cinatra-ai/extensions/required-in-prod";
import {
  mimeAcceptedByAccepts,
  resolveUploadArtifactTypeFromCandidates,
  selectRequiredArtifactUploadCandidates,
  type RegisteredArtifactType,
  type UploadArtifactTypeCandidate,
} from "../upload-artifact-type-map";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

const MARKDOWN_TYPE = "@cinatra-ai/markdown-artifact:artifact";
const TEXT_TYPE = "@cinatra-ai/text-artifact:artifact";
const BINARY_TYPE = "@cinatra-ai/binary-artifact:artifact";

/** The upload-resolution candidate set the host would compute at runtime, built
 *  from the REAL bridge over the REAL pinned tree and the REAL required set. */
function liveRequiredCandidates(): UploadArtifactTypeCandidate[] {
  objectTypeRegistry._clearForTests();
  registerArtifactExtensions(EXT_ROOT);
  const types: RegisteredArtifactType[] = objectTypeRegistry.listArtifacts().map((def) => ({
    objectTypeId: def.type,
    definer: objectTypeRegistry.getRegisteringPackage(def.type),
    acceptMimes: def.isArtifact?.accepts?.file?.mimeTypes,
  }));
  return selectRequiredArtifactUploadCandidates(types, isPackageRequiredInProd);
}

describe("text/markdown resolves to the markdown base alone (live pinned tree)", () => {
  it("has the companion extension tree on disk (the pins are what this suite reads)", () => {
    expect(existsSync(EXT_ROOT)).toBe(true);
    expect(liveRequiredCandidates().length).toBeGreaterThan(0);
  });

  it("resolves text/markdown to the markdown base", () => {
    expect(resolveUploadArtifactTypeFromCandidates("text/markdown", liveRequiredCandidates())).toEqual({
      ok: true,
      objectTypeId: MARKDOWN_TYPE,
    });
  });

  it("resolves text/plain and text/csv to the text base", () => {
    const candidates = liveRequiredCandidates();
    expect(resolveUploadArtifactTypeFromCandidates("text/plain", candidates)).toEqual({
      ok: true,
      objectTypeId: TEXT_TYPE,
    });
    expect(resolveUploadArtifactTypeFromCandidates("text/csv", candidates)).toEqual({
      ok: true,
      objectTypeId: TEXT_TYPE,
    });
  });

  it("resolves application/octet-stream to the binary base", () => {
    expect(
      resolveUploadArtifactTypeFromCandidates("application/octet-stream", liveRequiredCandidates()),
    ).toEqual({ ok: true, objectTypeId: BINARY_TYPE });
  });

  it("leaves no overlap: exactly one required base accepts each of the four forms", () => {
    const candidates = liveRequiredCandidates();
    for (const mime of ["text/markdown", "text/plain", "text/csv", "application/octet-stream"]) {
      const accepting = candidates
        .filter((c) => mimeAcceptedByAccepts(c.acceptMimes, mime))
        .map((c) => c.objectTypeId)
        .sort();
      expect(accepting, mime).toHaveLength(1);
    }
  });

  it("the text base no longer accepts text/markdown, and the markdown base accepts nothing else", () => {
    const candidates = liveRequiredCandidates();
    const text = candidates.find((c) => c.objectTypeId === TEXT_TYPE);
    const markdown = candidates.find((c) => c.objectTypeId === MARKDOWN_TYPE);
    const binary = candidates.find((c) => c.objectTypeId === BINARY_TYPE);
    expect(text?.acceptMimes.slice().sort()).toEqual(["text/csv", "text/plain"]);
    expect(markdown?.acceptMimes).toEqual(["text/markdown"]);
    expect(binary?.acceptMimes).toEqual(["application/octet-stream"]);
  });
});
