import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE ONE SHARED PDF SHELL (wave 2 of `PLAN: Agents Lifecycle (D) - Review`,
 * cinatra#3090 / epic #3087).
 *
 * IN THE PLAN'S OWN WORDS: "the pdf reading is the embedded PDF previewer the
 * pdf extension already uses - the browser's own PDF view over the preview
 * address, and the download floor where there is nothing to preview - no inline
 * fallback viewer. One shared pdf shell around that previewer - an SDK-leaf
 * helper or a registry item - so seven extensions do not fork seven of them."
 *
 * The mixed kinds each branch on the content form and hand the pdf branch to
 * THIS module. It is a leaf: React and nothing else, so an artifact display may
 * depend on it without pulling a host package in behind it.
 *
 * The sdk-ui vitest environment is `node`, so the drawn states are proved three
 * ways: as a pure view resolver, as a source-text contract over the markup (the
 * same shape the Tabs primitive's contract test takes), and - for the readings a
 * person actually meets - as RENDERED markup through `renderToStaticMarkup`,
 * which needs no DOM. A words-only assertion accepts markup that has drifted
 * away from the drawing while still carrying the sentence.
 */

const SRC_DIR = join(__dirname, "..");
const PKG_DIR = join(SRC_DIR, "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");
const read = (abs: string) => readFileSync(abs, "utf8");

const shellSrc = read(join(SRC_DIR, "artifacts", "pdf-detail-shell.tsx"));
const pkg = JSON.parse(read(join(PKG_DIR, "package.json"))) as {
  exports: Record<string, string>;
  files: string[];
};

describe("the shared pdf shell - the module", () => {
  it("loads in node and exports the shell with its view resolver", async () => {
    const mod = await import("../artifacts/pdf-detail-shell");
    expect(typeof mod.PdfDetailShell).toBe("function");
    expect(typeof mod.resolvePdfShellView).toBe("function");
    expect(typeof mod.pdfShellFloorMessage).toBe("function");
  });

  it("is published at a real subpath of the package, not a path only this repository resolves", () => {
    expect(pkg.exports["./artifacts/pdf-detail-shell"]).toBe(
      "./src/artifacts/pdf-detail-shell.tsx",
    );
  });

  it("is aliased for the compiler and for the build under that same specifier", () => {
    const tsconfig = read(join(REPO_ROOT, "tsconfig.json"));
    const buildConfig = read(join(REPO_ROOT, "config", "build-config.manifest.json"));
    expect(tsconfig).toContain("@cinatra-ai/sdk-ui/artifacts/pdf-detail-shell");
    expect(buildConfig).toContain("@cinatra-ai/sdk-ui/artifacts/pdf-detail-shell");
  });
});

describe("the shared pdf shell - the readings the drawing draws", () => {
  it("draws the embedded viewer when there is a preview address", async () => {
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    expect(
      resolvePdfShellView({ previewHref: "/a/preview", downloadHref: "/a/download" }),
    ).toEqual({
      kind: "embedded",
      previewHref: "/a/preview",
      downloadHref: "/a/download",
    });
  });

  it("falls to the download floor when there is nothing to preview", async () => {
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    expect(resolvePdfShellView({ previewHref: null, downloadHref: "/a/download" })).toEqual({
      kind: "floor",
      reason: "no-representation",
      downloadHref: "/a/download",
    });
  });

  it("treats an empty preview address as nothing to preview, never as an address", async () => {
    // A blank string is an address the browser resolves to the page itself,
    // which is how a shell paints an empty panel instead of drawing its floor.
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    expect(resolvePdfShellView({ previewHref: "", downloadHref: null })).toEqual({
      kind: "floor",
      reason: "no-representation",
      downloadHref: null,
    });
  });

  it("keeps the floor a floor when the embedded viewer itself failed to load", async () => {
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    expect(
      resolvePdfShellView({
        previewHref: "/a/preview",
        downloadHref: "/a/download",
        previewFailed: true,
      }),
    ).toEqual({
      kind: "floor",
      reason: "preview-failed",
      downloadHref: "/a/download",
    });
  });
});

describe("the shared pdf shell - the browser's own view, never a viewer of its own", () => {
  it("mounts the browser's own PDF view over the preview address", () => {
    expect(shellSrc).toMatch(/<embed/);
    expect(shellSrc).toContain('type="application/pdf"');
    expect(shellSrc).toContain("src={view.previewHref}");
  });

  it("ships NO inline fallback viewer - the plan took it off this road", () => {
    expect(shellSrc).not.toMatch(/react-pdf/i);
    expect(shellSrc).not.toMatch(/pdfjs/i);
    expect(shellSrc).not.toMatch(/pdfViewerEnabled/);
    expect(shellSrc).not.toMatch(/InlineFallback/);
    expect(shellSrc).not.toMatch(/workerSrc/);
  });

  it("is a leaf: React and this package's own primitives, never a host import", () => {
    const imports = [...shellSrc.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(["react", "../ui/download-link"]).toContain(specifier);
    }
  });
});

describe("the shared pdf shell - the floor is never blank", () => {
  it("says the drawing's words and offers the drawing's affordance", () => {
    expect(shellSrc).toContain("This PDF cannot be previewed here.");
    expect(shellSrc).toContain("Download PDF");
  });

  it("degrades to a plain note rather than a dead link when there is nothing to download", () => {
    expect(shellSrc).toContain("This document has no downloadable content.");
  });

  it("names both floor reasons, so a surface can say WHY it drew a floor", async () => {
    const { pdfShellFloorMessage } = await import("../artifacts/pdf-detail-shell");
    expect(pdfShellFloorMessage("no-representation")).toBe(
      "This PDF cannot be previewed here.",
    );
    expect(pdfShellFloorMessage("preview-failed")).toBe(
      "This PDF cannot be previewed here.",
    );
  });
});

describe("the shared pdf shell - one chrome, travelling to every surface", () => {
  it("takes the slot it is drawn in and marks it, so page, card and run page agree", () => {
    expect(shellSrc).toContain('data-artifact-renderer="pdf-shell"');
    expect(shellSrc).toContain("data-slot={slot}");
    expect(shellSrc).toContain("data-floor=");
  });

  it("clips in the compact slot instead of growing the card it sits in", () => {
    expect(shellSrc).toContain("compact");
  });
});

describe("the shared pdf shell - a blank address is not an address", () => {
  it("reads a whitespace-only preview address as nothing to preview", async () => {
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    expect(resolvePdfShellView({ previewHref: "   ", downloadHref: "/a/download" })).toEqual({
      kind: "floor",
      reason: "no-representation",
      downloadHref: "/a/download",
    });
  });

  it("never hands a caller a blank download address it would turn into a dead link", async () => {
    const { resolvePdfShellView } = await import("../artifacts/pdf-detail-shell");
    // An empty download address reached the caller as "" before, which reads as
    // present to anyone testing for null and links to the page itself.
    expect(resolvePdfShellView({ previewHref: "/a/preview", downloadHref: "" })).toEqual({
      kind: "embedded",
      previewHref: "/a/preview",
      downloadHref: null,
    });
    expect(resolvePdfShellView({ previewHref: null, downloadHref: "  " })).toEqual({
      kind: "floor",
      reason: "no-representation",
      downloadHref: null,
    });
  });

  it("trims an address it does keep, so one document is one address", async () => {
    const { normalizePdfShellHref } = await import("../artifacts/pdf-detail-shell");
    expect(normalizePdfShellHref(" /a/preview ")).toBe("/a/preview");
    expect(normalizePdfShellHref("")).toBeNull();
    expect(normalizePdfShellHref(null)).toBeNull();
  });
});

describe("the shared pdf shell - a failure belongs to the document that failed", () => {
  it("keeps the floor for the document whose embed failed", async () => {
    const { pdfShellPreviewFailed } = await import("../artifacts/pdf-detail-shell");
    expect(
      pdfShellPreviewFailed({ failedHref: "/a/preview", previewHref: "/a/preview" }),
    ).toBe(true);
  });

  it("does NOT carry that floor onto the next document the same shell draws", async () => {
    // The run page walks a list and the review card moves to the next target
    // through ONE mounted shell. A remembered flag would strand a perfectly
    // previewable document on the previous one's floor until a reload.
    const { pdfShellPreviewFailed } = await import("../artifacts/pdf-detail-shell");
    expect(
      pdfShellPreviewFailed({ failedHref: "/a/preview", previewHref: "/b/preview" }),
    ).toBe(false);
    expect(pdfShellPreviewFailed({ failedHref: null, previewHref: "/b/preview" })).toBe(
      false,
    );
  });

  it("remembers the address, not a flag - the source carries no bare failure boolean", () => {
    expect(shellSrc).toContain("useState<string | null>(null)");
    expect(shellSrc).toContain("pdfShellPreviewFailed({ failedHref, previewHref })");
    expect(shellSrc).not.toContain("useState(false)");
  });
});

describe("the shared pdf shell - what it actually renders", () => {
  // Rendered markup, not a source substring: the readings below are the ones a
  // person meets, and a substring assertion accepts markup that has drifted
  // away from them while still carrying the words.
  const renderShell = async (props: {
    previewHref: string | null;
    downloadHref: string | null;
    slot: "detail" | "preview";
  }) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PdfDetailShell } = await import("../artifacts/pdf-detail-shell");
    return renderToStaticMarkup(<PdfDetailShell {...props} />);
  };

  it("draws the browser's own view over the preview address, in the pdf chrome", async () => {
    const html = await renderShell({
      previewHref: "/a/preview",
      downloadHref: "/a/download",
      slot: "detail",
    });
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain('src="/a/preview"');
    expect(html).toContain('data-artifact-renderer="pdf-shell"');
    expect(html).toContain('data-slot="detail"');
    // The chrome the pdf extension's own detail display already draws.
    expect(html).toContain("soft-panel rounded-card overflow-hidden p-0");
    // No page counter, no Previous and no Next - the browser's viewer scrolls.
    expect(html).not.toMatch(/Previous|Next|Page \d/);
  });

  it("draws the floor's own words and the download affordance, with no viewer", async () => {
    const html = await renderShell({
      previewHref: null,
      downloadHref: "/a/download",
      slot: "detail",
    });
    expect(html).toContain("This PDF cannot be previewed here.");
    expect(html).toContain('href="/a/download"');
    expect(html).toContain("Download PDF");
    expect(html).toContain('data-floor="no-representation"');
    expect(html).not.toContain("<embed");
  });

  it("degrades the affordance to a note rather than a dead link", async () => {
    const html = await renderShell({
      previewHref: null,
      downloadHref: "",
      slot: "detail",
    });
    expect(html).toContain("This document has no downloadable content.");
    expect(html).not.toContain("<a ");
  });

  it("clips in the compact slot and fills the panel in the full one", async () => {
    const compact = await renderShell({
      previewHref: "/a/preview",
      downloadHref: null,
      slot: "preview",
    });
    expect(compact).toContain('data-compact="true"');
    expect(compact).toContain("h-72 w-full");
    const full = await renderShell({
      previewHref: "/a/preview",
      downloadHref: null,
      slot: "detail",
    });
    expect(full).not.toContain('data-compact="true"');
    expect(full).toContain("h-[75vh] w-full");
  });
});
