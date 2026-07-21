import { describe, expect, it } from "vitest";

import {
  selectMeaningTypesAcceptingMime,
  type RegisteredArtifactMeaningType,
} from "../installed-type-picker";

// epic #1883 slice A4, spec design@16efd8d2 §VI.1 — the installed-type picker
// admits only installed, file-accepting types whose `accepts` include the
// DETECTED MIME (a user MEANING assertion, never a re-type).

const types: RegisteredArtifactMeaningType[] = [
  { objectTypeId: "@acme/legal:contract", definer: "@acme/legal", acceptMimes: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  { objectTypeId: "@acme/sales:pricing-sheet", definer: "@acme/sales", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/pdf-artifact:pdf", definer: "@cinatra-ai/pdf-artifact", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/image-artifact:image", definer: "@cinatra-ai/image-artifact", acceptMimes: ["image/*"] },
  { objectTypeId: "@x/floor:object", definer: "@x/floor", acceptMimes: ["*/*"] },
  { objectTypeId: "@y/no-definer:thing", definer: null, acceptMimes: ["application/pdf"] },
  { objectTypeId: "@z/empty:thing", definer: "@z/empty", acceptMimes: [] },
];

describe("selectMeaningTypesAcceptingMime", () => {
  it("returns every installed file-accepting type whose accepts admit the MIME", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf");
    const ids = got.map((t) => t.objectTypeId);
    // contract + pricing-sheet + the pdf base all accept application/pdf.
    expect(ids).toContain("@acme/legal:contract");
    expect(ids).toContain("@acme/sales:pricing-sheet");
    expect(ids).toContain("@cinatra-ai/pdf-artifact:pdf");
  });

  it("humanizes the display name (local part) and the defining-extension label", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf");
    const contract = got.find((t) => t.objectTypeId === "@acme/legal:contract");
    expect(contract).toEqual({
      objectTypeId: "@acme/legal:contract",
      extension: "@acme/legal",
      displayName: "Contract",
      extensionLabel: "Legal",
    });
  });

  it("EXCLUDES the universal catch-all floor (`*/*`) — it is not a meaning", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf");
    expect(got.map((t) => t.objectTypeId)).not.toContain("@x/floor:object");
  });

  it("EXCLUDES a type with no defining package (a meaning is keyed on the extension)", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf");
    expect(got.map((t) => t.objectTypeId)).not.toContain("@y/no-definer:thing");
  });

  it("EXCLUDES a caller-supplied excludeTypeId (the artifact's own base type)", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf", {
      excludeTypeId: "@cinatra-ai/pdf-artifact:pdf",
    });
    expect(got.map((t) => t.objectTypeId)).not.toContain("@cinatra-ai/pdf-artifact:pdf");
    // the meaning packs still surface
    expect(got.map((t) => t.objectTypeId)).toContain("@acme/legal:contract");
  });

  it("is wildcard-aware on a `type/*` accept (image/* admits image/png)", () => {
    const got = selectMeaningTypesAcceptingMime(types, "image/png");
    expect(got.map((t) => t.objectTypeId)).toEqual(["@cinatra-ai/image-artifact:image"]);
  });

  it("normalizes MIME parameters before matching (application/pdf; charset=..)", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf; charset=binary");
    expect(got.map((t) => t.objectTypeId)).toContain("@acme/legal:contract");
  });

  it("returns nothing for an empty / whitespace MIME", () => {
    expect(selectMeaningTypesAcceptingMime(types, "")).toEqual([]);
    expect(selectMeaningTypesAcceptingMime(types, "   ")).toEqual([]);
  });

  it("returns nothing when no installed type accepts the MIME", () => {
    // application/acad matches no accept entry (image/* only covers image/*).
    expect(selectMeaningTypesAcceptingMime(types, "application/acad")).toEqual([]);
  });

  it("is alphabetical by display name, then type id, for a stable surface", () => {
    const got = selectMeaningTypesAcceptingMime(types, "application/pdf");
    const names = got.map((t) => t.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
