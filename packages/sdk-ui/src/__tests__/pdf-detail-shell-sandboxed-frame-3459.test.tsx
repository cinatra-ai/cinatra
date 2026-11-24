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
// red-first-expect: readPdfShellDownloads is not a function

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
    frameElement: {
      hasAttribute: (name: string) => name === "sandbox" && sandbox !== null,
      getAttribute: (name: string) => (name === "sandbox" ? sandbox : null),
    },
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
      <shell.PdfShellFrameProvider frame="sandboxed" downloads="link">
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
      <shell.PdfShellFrameProvider frame="sandboxed" downloads="link">
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
      <shell.PdfShellFrameProvider frame="sandboxed" downloads="link">
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

// WHERE A DOWNLOAD CANNOT WORK, THE FLOOR OFFERS NONE.
//
// Two things stop a download inside the card's frame. The widget's byte
// addresses are sealed capabilities whose serving route refuses a link
// navigation, so a plain download link to one is dead. And the sandbox of every
// frame above the document applies to a download started inside it, so a frame
// above without `allow-downloads` blocks any download, from a link or from a
// saved blob. The shell can read a frame above only when it is same-origin. So
// the floor offers a download only where the page says its addresses take a
// link and every frame above can be read and allows downloads; in every other
// case it keeps its sentence and draws no download control.
describe("the floor offers no download control where a download cannot work", () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    while (restore.length > 0) restore.pop()!();
    document.body.innerHTML = "";
  });

  function sitIn(frameElement: Element | null, parent: FrameWindow): void {
    for (const [key, value] of [
      ["frameElement", frameElement],
      ["parent", parent],
    ] as const) {
      const own = Object.getOwnPropertyDescriptor(window, key);
      Object.defineProperty(window, key, { configurable: true, get: () => value });
      restore.push(() => {
        if (own) Object.defineProperty(window, key, own);
        else delete (window as unknown as Record<string, unknown>)[key];
      });
    }
  }

  function iframeWithSandbox(tokens: string): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", tokens);
    return frame;
  }

  async function serveAndHydrate(element: ReactElement) {
    const served = renderToString(element);
    const container = document.createElement("div");
    container.innerHTML = served;
    document.body.appendChild(container);
    const before = container.innerHTML;
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, element, { onRecoverableError: (error) => recoverable.push(error) });
    });
    return { served, before, container, recoverable };
  }

  function expectNoDownloadControl(root: ParentNode | string): void {
    const html = typeof root === "string" ? root : (root as Element).innerHTML;
    expect(html).toContain("This PDF cannot be previewed here.");
    expect(html).not.toContain("<embed");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<button[\s>]/);
    expect(html).not.toContain(DOWNLOAD);
    expect(html).not.toContain("Download PDF");
    // Not the "nothing to download" note either: there IS a document, it just
    // cannot be saved from here.
    expect(html).not.toContain("This document has no downloadable content.");
  }

  const widgetElement = (
    <shell.PdfShellFrameProvider frame="sandboxed" downloads="none">
      <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />
    </shell.PdfShellFrameProvider>
  );
  const inAppElement = (
    <shell.PdfShellFrameProvider frame="sandboxed" downloads="link">
      <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />
    </shell.PdfShellFrameProvider>
  );

  it("resolves a floor with no download address where downloads are blocked", () => {
    expect(
      shell.resolvePdfShellView({
        previewHref: PREVIEW,
        downloadHref: DOWNLOAD,
        frame: "sandboxed",
        downloads: "blocked",
      }),
    ).toEqual({ kind: "floor", reason: "sandboxed-frame", downloadHref: null, download: "blocked" });
  });

  it("widget target in a sandboxed frame: the sentence and no link or button to the capability address", async () => {
    expectNoDownloadControl(renderToStaticMarkup(widgetElement));
    sitIn(iframeWithSandbox("allow-scripts allow-same-origin allow-downloads"), topWindow());
    const { before, container, recoverable } = await serveAndHydrate(widgetElement);
    expect(recoverable).toEqual([]);
    expect(container.innerHTML).toBe(before);
    expectNoDownloadControl(container);
  });

  it("in-app card: the Download button with the host's address stays, and the server and the client agree", async () => {
    sitIn(iframeWithSandbox("allow-scripts allow-same-origin allow-downloads"), topWindow());
    const { before, container, recoverable } = await serveAndHydrate(inAppElement);
    expect(recoverable).toEqual([]);
    expect(container.innerHTML).toBe(before);
    const link = container.querySelector("a[download]");
    expect(link?.getAttribute("href")).toBe(DOWNLOAD);
    expect(link?.textContent).toContain("Download PDF");
  });

  it("reads downloads as allowed only up a readable chain whose sandboxed frames all allow them", () => {
    expect(shell.readPdfShellDownloads(topWindow())).toBe("allowed");
    expect(shell.readPdfShellDownloads(framedIn(topWindow(), null))).toBe("allowed");
    expect(
      shell.readPdfShellDownloads(framedIn(topWindow(), "allow-scripts allow-same-origin allow-downloads")),
    ).toBe("allowed");
    // Tokens are matched without regard to case, as the browser does.
    expect(shell.readPdfShellDownloads(framedIn(topWindow(), "allow-scripts ALLOW-DOWNLOADS"))).toBe("allowed");
  });

  it("an unreadable frame above: downloads read as blocked", () => {
    // `frameElement` is null for a document framed by another origin: the CMS.
    const card = framedIn({ parent: topWindow(), frameElement: null }, "allow-scripts allow-same-origin allow-downloads");
    expect(shell.readPdfShellDownloads(card)).toBe("blocked");
    expect(shell.readPdfShellDownloads({ parent: topWindow(), frameElement: null })).toBe("blocked");
    const hostile = {
      parent: topWindow(),
      get frameElement(): never {
        throw new Error("SecurityError");
      },
    } as FrameWindow;
    expect(shell.readPdfShellDownloads(hostile)).toBe("blocked");
  });

  it("an unreadable frame above: no download control once the page runs", async () => {
    sitIn(null, topWindow());
    const { container, recoverable } = await serveAndHydrate(inAppElement);
    expect(recoverable).toEqual([]);
    expectNoDownloadControl(container);
  });

  it("a readable sandboxed frame above without the downloads token: downloads read as blocked", () => {
    expect(shell.readPdfShellDownloads(framedIn(topWindow(), "allow-scripts allow-same-origin"))).toBe("blocked");
    expect(shell.readPdfShellDownloads(framedIn(topWindow(), ""))).toBe("blocked");
    // Inherited: the outer frame withholds it, so the inner frame's token does not help.
    const outer = framedIn(topWindow(), "allow-scripts allow-same-origin");
    expect(
      shell.readPdfShellDownloads(framedIn(outer, "allow-scripts allow-same-origin allow-downloads")),
    ).toBe("blocked");
  });

  it("a readable sandboxed frame above without the downloads token: no download control once the page runs", async () => {
    sitIn(iframeWithSandbox("allow-scripts allow-same-origin"), topWindow());
    const { container, recoverable } = await serveAndHydrate(inAppElement);
    expect(recoverable).toEqual([]);
    expectNoDownloadControl(container);
  });

  it("the artifact's own page keeps the embedded viewer, unchanged", async () => {
    const element = <shell.PdfDetailShell previewHref={PREVIEW} downloadHref={DOWNLOAD} slot="detail" />;
    const { before, container, recoverable } = await serveAndHydrate(element);
    expect(recoverable).toEqual([]);
    expect(container.innerHTML).toBe(before);
    expect(container.querySelector("embed")?.getAttribute("src")).toBe(PREVIEW);
  });
});
