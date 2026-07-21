import { describe, expect, it } from "vitest";

import {
  selectMeaningTypesAcceptingMime,
  selectMatcherChannelMeaningTypesAcceptingMime,
  unionMeaningTypesAcceptingMime,
  type RegisteredArtifactMeaningType,
  type MatcherChannelMeaningType,
  type InstalledMeaningType,
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

// ---------------------------------------------------------------------------
// A4-seam (cinatra#1892, over A3 cinatra#1891): the matcher-manifest channel is
// a SECOND candidate source — package-keyed meaning surfaces the picker unions
// in so a post-#1785 meaning pack (which mints no own-namespace object type) is
// selectable. `brand-voice` declares fileMimeTypes [markdown, plain, pdf].
// ---------------------------------------------------------------------------

const channel: MatcherChannelMeaningType[] = [
  {
    packageName: "@cinatra-ai/brand-voice",
    fileMimeTypes: ["text/markdown", "text/plain", "application/pdf"],
  },
  { packageName: "@acme/gtm", fileMimeTypes: ["text/plain"] },
  { packageName: "@x/catch-all", fileMimeTypes: ["*/*"] },
  { packageName: "@y/empty", fileMimeTypes: [] },
  // A pack ALSO present in the object-type channel (hybrid) — same extension.
  { packageName: "@acme/legal", fileMimeTypes: ["application/pdf"] },
];

describe("selectMatcherChannelMeaningTypesAcceptingMime", () => {
  it("selects channel packs whose fileMimeTypes admit the MIME, keyed by PACKAGE NAME with a null objectTypeId", () => {
    const got = selectMatcherChannelMeaningTypesAcceptingMime(channel, "application/pdf");
    const bv = got.find((t) => t.extension === "@cinatra-ai/brand-voice");
    expect(bv).toEqual({
      objectTypeId: null,
      extension: "@cinatra-ai/brand-voice",
      displayName: "Brand Voice",
      extensionLabel: "Brand Voice",
    });
  });

  it("EXCLUDES an any/any catch-all channel pack — it is not a specific meaning", () => {
    const got = selectMatcherChannelMeaningTypesAcceptingMime(channel, "application/pdf");
    expect(got.map((t) => t.extension)).not.toContain("@x/catch-all");
  });

  it("EXCLUDES a channel pack with no fileMimeTypes, and one whose MIME does not match", () => {
    const got = selectMatcherChannelMeaningTypesAcceptingMime(channel, "application/pdf");
    expect(got.map((t) => t.extension)).not.toContain("@y/empty");
    // @acme/gtm only classifies text/plain
    expect(got.map((t) => t.extension)).not.toContain("@acme/gtm");
  });

  it("EXCLUDES a caller-supplied excludeExtension (the artifact's own base-type definer)", () => {
    const got = selectMatcherChannelMeaningTypesAcceptingMime(channel, "application/pdf", {
      excludeExtension: "@cinatra-ai/brand-voice",
    });
    expect(got.map((t) => t.extension)).not.toContain("@cinatra-ai/brand-voice");
  });

  it("returns nothing for an empty MIME", () => {
    expect(selectMatcherChannelMeaningTypesAcceptingMime(channel, "")).toEqual([]);
  });
});

describe("unionMeaningTypesAcceptingMime", () => {
  const objectTypeCandidates: InstalledMeaningType[] = [
    {
      objectTypeId: "@acme/legal:contract",
      extension: "@acme/legal",
      displayName: "Contract",
      extensionLabel: "Legal",
    },
  ];
  const matcherCandidates = selectMatcherChannelMeaningTypesAcceptingMime(
    channel,
    "application/pdf",
  );

  it("PRESENTS a matcher-only pack (brand-voice) that has no object type", () => {
    const got = unionMeaningTypesAcceptingMime(objectTypeCandidates, matcherCandidates);
    expect(got.map((t) => t.extension)).toContain("@cinatra-ai/brand-voice");
  });

  it("DEDUPES by extension, preferring the concrete object-type candidate for a hybrid pack", () => {
    const got = unionMeaningTypesAcceptingMime(objectTypeCandidates, matcherCandidates);
    const legal = got.filter((t) => t.extension === "@acme/legal");
    expect(legal).toHaveLength(1);
    // the object-type candidate (concrete id + specific label) wins the dedup.
    expect(legal[0]).toMatchObject({
      objectTypeId: "@acme/legal:contract",
      displayName: "Contract",
    });
  });

  it("is alphabetical by display name for a stable surface across both channels", () => {
    const got = unionMeaningTypesAcceptingMime(objectTypeCandidates, matcherCandidates);
    const names = got.map((t) => t.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("excludeExtension drops EVERY candidate for the base's defining extension across BOTH channels (a MIME-compatible sibling type too)", () => {
    // The base is @acme/legal:contract (definer @acme/legal). @acme/legal also
    // defines a SIBLING type :nda accepting the MIME — asserting it would assert
    // the SAME extension as the base's namespace owner (a no-op).
    const withSibling: InstalledMeaningType[] = [
      ...objectTypeCandidates,
      {
        objectTypeId: "@acme/legal:nda",
        extension: "@acme/legal",
        displayName: "Nda",
        extensionLabel: "Legal",
      },
    ];
    const got = unionMeaningTypesAcceptingMime(withSibling, matcherCandidates, {
      excludeExtension: "@acme/legal",
    });
    expect(got.map((t) => t.extension)).not.toContain("@acme/legal");
    // an unrelated matcher pack still surfaces
    expect(got.map((t) => t.extension)).toContain("@cinatra-ai/brand-voice");
  });
});
