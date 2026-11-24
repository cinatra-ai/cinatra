// @vitest-environment jsdom
//
// THE SHARED PDF SHELL IN A SANDBOXED FRAME (cinatra#3459).
//
// The review card draws its target inside an island iframe that carries a
// `sandbox` attribute. Chromium never starts its PDF viewer in a sandboxed
// frame, and it says nothing when it declines: the `<embed>` fires neither
// `load` nor `error`, so the shell's failure fallback never arrives and the
// plate stays blank. Design: specs/app-artifact-review.html §XI.2 / §XI.4 ("the
// embedded viewer, and the download floor beneath it where there is no preview
// to show") and §XI.3 ("never a blank plate").
//
// So in a sandboxed frame the shell draws its download floor - the same words
// and the same download link to the host's byte route - and on the artifact's
// own page (not framed) it keeps the embedded viewer.
//
// red-first-expect: readPdfShellFrame is not a function
// red-first-expect: Element type is invalid
// red-first-expect: to deeply equal { kind: 'floor'

import { act } from "react";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import * as shell from "../artifacts/pdf-detail-shell";

type FrameWindow = shell.PdfShellFrameWindow;

const DOWNLOAD = "/api/artifacts/a-1/download?revision=3";
const PREVIEW = "/api/artifacts/a-1/preview?revision=3";

/** A top-level window: its own parent, held by no frame element. */
function topWindow(): FrameWindow {
  const top = { frameElement: null } as { parent: FrameWindow; frameElement: null };
  top.parent = top;
  return top;
}

/** A window held by a frame element in `parent`, with or without a sandbox. */
function framedIn(parent: FrameWindow, sandbox: string | null): FrameWindow {
  return {
    parent,
    frameElement: { hasAttribute: (name: string) => name === "sandbox" && sandbox !== null },
  };
}

describe("reading the frame the shell sits in", () => {
  it("reads the top-level document as unsandboxed", () => {
    expect(shell.readPdfShellFrame(topWindow())).toBe("unsandboxed");
  });

  it("reads a frame whose element carries a sandbox attribute as sandboxed", () => {
    // The review card's island frame, exactly.
    expect(shell.readPdfShellFrame(framedIn(topWindow(), "allow-scripts allow-same-origin allow-downloads"))).toBe(
      "sandboxed",
    );
    // Any value, even empty: the attribute alone sandboxes the frame.
    expect(shell.readPdfShellFrame(framedIn(topWindow(), ""))).toBe("sandboxed");
  });

  it("reads a same-origin frame with no sandbox anywhere above it as unsandboxed", () => {
    expect(shell.readPdfShellFrame(framedIn(topWindow(), null))).toBe("unsandboxed");
  });

  it("reads a frame nested inside a sandboxed one as sandboxed - the flags are inherited", () => {
    const sandboxed = framedIn(topWindow(), "allow-scripts allow-same-origin");
    expect(shell.readPdfShellFrame(framedIn(sandboxed, null))).toBe("sandboxed");
  });

  it("reads a parent it cannot see into (another origin) as sandboxed", () => {
    // `frameElement` is null for a document framed by another origin.
    expect(shell.readPdfShellFrame({ parent: topWindow(), frameElement: null })).toBe("sandboxed");
  });

  it("reads an accessor that throws as sandboxed", () => {
    const hostile = {
      parent: topWindow(),
      get frameElement(): never {
        throw new Error("SecurityError");
      },
    } as FrameWindow;
    expect(shell.readPdfShellFrame(hostile)).toBe("sandboxed");
  });
});

describe("the reading the shell draws in a sandboxed frame", () => {
  it("is the download floor, with the host's download address, where it would have been the embed", () => {
    expect(
      shell.resolvePdfShellView({ previewHref: PREVIEW, downloadHref: DOWNLOAD, frame: "sandboxed" }),
    ).toEqual({ kind: "floor", reason: "sandboxed-frame", downloadHref: DOWNLOAD });
  });

  it("is still the embedded viewer outside one", () => {
    expect(
      shell.resolvePdfShellView({ previewHref: PREVIEW, downloadHref: DOWNLOAD, frame: "unsandboxed" }),
    ).toEqual({ kind: "embedded", previewHref: PREVIEW, downloadHref: DOWNLOAD });
  });

  it("says the floor's existing sentence, not new words", () => {
    expect(shell.pdfShellFloorMessage("sandboxed-frame")).toBe("This PDF cannot be previewed here.");
  });
});

describe("what the server paints", () => {
  it("paints the floor, never the embed, on a page that declares a sandboxed frame", () => {
    const html = renderToStaticMarkup(
      <shell.PdfShellFrameProvider frame="sandboxed">
        <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />
      </shell.PdfShellFrameProvider>,
    );
    expect(html).not.toContain("<embed");
    expect(html).toContain('data-floor="sandboxed-frame"');
    expect(html).toContain("This PDF cannot be previewed here.");
    expect(html).toContain(`href="${DOWNLOAD}"`);
    expect(html).toContain("download");
    expect(html).toContain("Download PDF");
  });

  it("is never a blank plate in a sandboxed frame, even with nothing to download", () => {
    const html = renderToStaticMarkup(
      <shell.PdfShellFrameProvider frame="sandboxed">
        <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={null} slot="preview" />
      </shell.PdfShellFrameProvider>,
    );
    expect(html).not.toContain("<embed");
    expect(html).toContain("This PDF cannot be previewed here.");
    expect(html).toContain("This document has no downloadable content.");
  });

  it("paints the embedded viewer on a page that declares nothing - the artifact's own page", () => {
    const html = renderToStaticMarkup(
      <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />,
    );
    expect(html).toContain("<embed");
    expect(html).toContain('type="application/pdf"');
    expect(html).not.toContain("data-floor");
  });
});

describe("what the page shows once it runs - the frame it is actually in decides", () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    while (restore.length > 0) restore.pop()!();
    document.body.innerHTML = "";
  });

  /** Make this jsdom window read as a document inside a sandboxed iframe. */
  function sitInSandboxedFrame(): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
    const fakeTop = topWindow();
    for (const [key, value] of [
      ["frameElement", frame],
      ["parent", fakeTop],
    ] as const) {
      const own = Object.getOwnPropertyDescriptor(window, key);
      Object.defineProperty(window, key, { configurable: true, get: () => value });
      restore.push(() => {
        if (own) Object.defineProperty(window, key, own);
        else delete (window as unknown as Record<string, unknown>)[key];
      });
    }
  }

  async function hydrate(served: string, element: ReactElement) {
    const container = document.createElement("div");
    container.innerHTML = served;
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, element, { onRecoverableError: (error) => recoverable.push(error) });
    });
    return { container, recoverable };
  }

  it("keeps the served floor on the island, with no hydration mismatch", async () => {
    sitInSandboxedFrame();
    const element = (
      <shell.PdfShellFrameProvider frame="sandboxed">
        <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />
      </shell.PdfShellFrameProvider>
    );
    const { container, recoverable } = await hydrate(renderToString(element), element);
    expect(recoverable).toEqual([]);
    expect(container.querySelector("embed")).toBeNull();
    const link = container.querySelector("a[download]");
    expect(link?.getAttribute("href")).toBe(DOWNLOAD);
    expect(container.textContent).toContain("This PDF cannot be previewed here.");
  });

  it("turns a served embed into the floor in a sandboxed frame no page declared", async () => {
    sitInSandboxedFrame();
    const element = <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />;
    const served = renderToString(element);
    expect(served).toContain("<embed");
    const { container, recoverable } = await hydrate(served, element);
    expect(recoverable).toEqual([]);
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("a[download]")?.getAttribute("href")).toBe(DOWNLOAD);
  });

  it("keeps the embedded viewer on the artifact's own page, which no frame holds", async () => {
    const element = <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />;
    const { container, recoverable } = await hydrate(renderToString(element), element);
    expect(recoverable).toEqual([]);
    expect(container.querySelector("embed")?.getAttribute("src")).toBe(PREVIEW);
    expect(container.querySelector("[data-floor]")).toBeNull();
  });
});
