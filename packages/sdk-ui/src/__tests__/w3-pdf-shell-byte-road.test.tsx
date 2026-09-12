/**
 * THE SHARED PDF SHELL IS ON THE BYTE ROAD — wave 3 of
 * `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087), fix leg.
 *
 * Wave 2 put every pdf reading in this repository behind ONE shell: the
 * embedded viewer, and the download floor beneath it. Wave 3 puts the six media
 * kinds — pdf among them — on the byte road, and a display on that road says so
 * where it draws, so a reader of the surface can tell an island address from a
 * session one without reading the source. The third proof round measured the
 * pdf cell with NO byte-road stamp at all while this change's own partition
 * puts pdf on the road; the half of that reading which lives in this repository
 * is this shell, which drew neither reading with the stamp.
 *
 * THE SENTENCES THIS FILE IS BUILT TO (ratified drawing, artifact-review §XI.2):
 *
 *   "Over pdf the shell is the embedded PDF viewer the pdf extension already
 *    mounts, and both of its readings are that extension's own: the embedded
 *    viewer, where the browser's bundled viewer fills the panel and does its own
 *    scrolling ... and that extension's download floor, where there is no
 *    preview to show, so the panel is never blank."
 *
 *   "No viewer is written for this kind: in both readings the reader is looking
 *    at the pdf extension's own display, and no renderer of ours paints a
 *    document's pages."
 *
 * The sdk-ui environment is `node`, so the readings are measured as rendered
 * markup through `renderToStaticMarkup`, which needs no DOM — the same road the
 * wave-2 contract test takes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PdfDetailShell } from "../artifacts/pdf-detail-shell";

const SRC_DIR = join(__dirname, "..");
const shellSrc = readFileSync(
  join(SRC_DIR, "artifacts", "pdf-detail-shell.tsx"),
  "utf8",
);

async function draw(
  props: Parameters<typeof PdfDetailShell>[0],
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(<PdfDetailShell {...props} />);
}

describe("the embedded viewer names the road its address is on", () => {
  it("stamps the island road when the display was handed island addresses", async () => {
    const markup = await draw({
      previewHref: "https://island.example/bytes/preview",
      downloadHref: "https://island.example/bytes/download",
      slot: "detail",
      road: "island",
    });
    expect(markup).toContain('data-byte-road="island"');
    expect(markup).toContain('type="application/pdf"');
  });

  it("stamps the session road for a first-party surface", async () => {
    const markup = await draw({
      previewHref: "/api/artifacts/a/versions/r/preview",
      downloadHref: "/api/artifacts/a/versions/r/content",
      slot: "detail",
      road: "session",
    });
    expect(markup).toContain('data-byte-road="session"');
  });

  // Convergence finding (codex, this leg): a shell handed no road knows none.
  // A default would stamp `session` on a reading whose own wrapper stamps
  // `island` — two contradictory answers about one document. The shell says
  // nothing where it was told nothing, and the caller's wrapper stays the one
  // place the road is asserted.
  it("stamps no road at all for a caller that names none, rather than guessing one", async () => {
    const markup = await draw({
      previewHref: "/api/artifacts/a/versions/r/preview",
      downloadHref: null,
      slot: "detail",
    });
    expect(markup).not.toContain("data-byte-road");
    expect(markup).toContain('type="application/pdf"');
  });

  it("never answers a road it was not handed, on the floor either", async () => {
    const markup = await draw({
      previewHref: null,
      downloadHref: null,
      slot: "detail",
    });
    expect(markup).not.toContain("data-byte-road");
    expect(markup).toContain("This document has no downloadable content.");
  });
});

describe("the floor is on the road too — a reading is never off it", () => {
  it("stamps the road on the never-blank floor, download and all", async () => {
    const markup = await draw({
      previewHref: null,
      downloadHref: "https://island.example/bytes/download",
      slot: "detail",
      road: "island",
    });
    expect(markup).toContain('data-byte-road="island"');
    expect(markup).toContain("This PDF cannot be previewed here.");
    expect(markup).toContain("Download PDF");
  });

  it("says there is no road where the shell was handed no address at all", async () => {
    const markup = await draw({
      previewHref: null,
      downloadHref: null,
      slot: "detail",
      road: "none",
    });
    expect(markup).toContain('data-byte-road="none"');
    expect(markup).toContain("This document has no downloadable content.");
  });
});

describe("and it still paints no page of its own", () => {
  it("mounts the browser's own viewer and imports no page renderer", () => {
    expect(shellSrc).toContain('type="application/pdf"');
    expect(shellSrc).not.toMatch(/from ["'][^"']*(react-pdf|pdfjs)/);
    expect(shellSrc).not.toContain("<canvas");
  });
});
