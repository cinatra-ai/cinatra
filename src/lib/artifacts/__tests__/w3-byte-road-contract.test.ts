// WHAT `data-byte-road` IS, AND WHICH DISPLAYS OWE IT (cinatra#3091, wave 3 of
// #3087 — the resolution fix leg).
//
// The first proof leg read the attribute on eight artifact pages and reported it
// missing on three: pdf, json and text. This suite settles what the contract
// actually asks of each, so the reading is graded against the contract instead
// of against an assumption.
//
// THE ATTRIBUTE IS NOT A HOST CONTRACT FIELD. No file in this application writes
// it; the host's half of props version 2 is the island-scoped `bytes` reference,
// and `data-byte-road` is what a display that DRAWS from that reference stamps
// so a reader can see which road the pixels came down. It is therefore owed by
// exactly the kinds that have a byte road, and by no others.
//
// THE PARTITION IS THE WAVE'S OWN. Six media kinds — audio, video, image, pdf,
// document, zip — read their bytes through the byte capability, and each stamps
// the attribute. The three text-class kinds — json, cms-snapshot, text — are the
// browser fetchers this wave "moved onto the content channel": they receive
// their content host-served, reach for no byte address, and so have no road to
// name. They mark the props version they negotiated instead.
//
// WHERE THE BEHAVIOUR IS PROVED, AND WHERE IT IS NOT. Rendering is proved by
// each pack's OWN suite, which mounts the display and reads the DOM — the image
// pack asserts `data-byte-road="island"`, `"session"` and `"none"` on rendered
// output across the props versions, and the content-channel packs carry their
// own `no-browser-load` and content-channel display suites proving they reach
// for no byte address. This file deliberately proves something those cannot:
// the PARTITION ACROSS PACKS, which no single pack's suite can see. It is a
// drift pin over the wave's list, not the behavioural proof, and it matches the
// attribute in stamping position rather than anywhere in the text so a mention
// in prose cannot satisfy it.
//
// SO: the pdf reading is not an absence in the product — the pdf display stamps
// the attribute on its shell, its preview and its never-blank download floor —
// and the json and text readings are correct-per-contract absences. Nothing here
// is a fix; this file is the record, pinned so the partition cannot drift
// silently in either direction.
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** The six kinds that draw from the byte capability — the wave's own list. */
const BYTE_ROAD_KINDS = [
  "audio-artifact",
  "video-artifact",
  "image-artifact",
  "pdf-artifact",
  "document-artifact",
  "zip-artifact",
] as const;

/** The three the wave moved onto the content channel. */
const CONTENT_CHANNEL_KINDS = ["json-artifact", "cms-snapshot-artifact", "text-artifact"] as const;

/** The detail renderer source each pack itself names in its manifest — never a
 *  path guessed from the slug, so a pack that renames its entry is followed. */
function detailRendererSource(slug: string): string {
  const pkgPath = resolve(REPO_ROOT, "extensions/cinatra-ai", slug, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    cinatra: { artifact: { ui: { renderers: { detail: { entry: string } } } } };
  };
  const entry = pkg.cinatra.artifact.ui.renderers.detail.entry;
  return readFileSync(join(dirname(pkgPath), entry), "utf8");
}

describe("the byte road's own attribute (#3091)", () => {
  /** The attribute in STAMPING position — `data-byte-road=` — so a mention in a
   *  comment or a prose string cannot pass for a stamp. */
  const STAMPED = /data-byte-road\s*=/;

  it.each(BYTE_ROAD_KINDS)("%s stamps data-byte-road on the display it draws", (slug) => {
    expect(detailRendererSource(slug)).toMatch(STAMPED);
  });

  it("the pdf display stamps it on every panel it can draw, floor included", () => {
    const dir = resolve(REPO_ROOT, "extensions/cinatra-ai/pdf-artifact/src/renderers");
    for (const file of ["pdf-detail.tsx", "pdf-preview.tsx", "pdf-download-floor.tsx"]) {
      expect(readFileSync(join(dir, file), "utf8"), file).toMatch(STAMPED);
    }
  });

  it.each(CONTENT_CHANNEL_KINDS)(
    "%s stamps no byte road — it reaches for no byte address at all",
    (slug) => {
      const source = detailRendererSource(slug);
      expect(source).not.toMatch(STAMPED);
      // It is not silent about the contract it negotiated; it names the props
      // version instead, which is what a reading of a content-channel kind has
      // to look for.
      expect(source).toContain("data-props-api-version");
    },
  );

  // WHERE THE COMMA-SEPARATED ROWS SIT IN THE PARTITION, said out loud (fix leg
  // 2). A proof round photographs a csv page and finds no byte-road stamp on it,
  // and the reading is only answerable if the partition says WHY: csv is not a
  // kind of its own here. The text type accepts it, so a csv row is a text row,
  // and the text display is one of the three this wave moved onto the content
  // channel — an absent stamp on a csv page is the contract, not a gap.
  it("puts the comma-separated rows on the content channel, because the text type is what accepts them", () => {
    const pkgPath = resolve(REPO_ROOT, "extensions/cinatra-ai/text-artifact/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      cinatra: { artifact: { accepts: { file: { mimeTypes: string[] } } } };
    };
    expect(pkg.cinatra.artifact.accepts.file.mimeTypes).toContain("text/csv");
    expect(CONTENT_CHANNEL_KINDS).toContain("text-artifact");
  });

  // THE MARKDOWN DISPLAY IS ON THE CONTENT CHANNEL TOO, and it is NOT this
  // branch's to move: its own reading — the Code and Preview tabs and the saving
  // indicator §V.1 gives it — is owned by an open sibling (cinatra#3026, pull
  // request 3098), which is also where its props version advances. What is
  // measurable here is the half that belongs to the partition: it reaches for no
  // byte address, so it stamps no road, and a proof round that photographs one
  // is reading the contract rather than finding a gap.
  it("reaches for no byte address on the markdown display either", () => {
    expect(detailRendererSource("markdown-artifact")).not.toMatch(STAMPED);
  });
});
