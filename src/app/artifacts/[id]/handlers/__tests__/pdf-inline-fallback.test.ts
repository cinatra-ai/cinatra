/**
 * #70 — PDF preview inline fallback for iOS Safari.
 *
 * Three layers, all node-env (no jsdom — mirrors the sibling
 * source-assertion convention):
 *   1. pure unit matrix for `needsPdfInlineFallback` / `isIosUserAgent`;
 *   2. source assertions pinning the structural guarantees (embed path
 *      kept, dynamic({ssr:false}) fallback, no CDN worker, layers off,
 *      polyfill import order, page wiring);
 *   3. dependency parity: the root `pdfjs-dist` pin MUST equal the
 *      version react-pdf depends on — drift would mean two pdfjs
 *      instances and an "API version does not match Worker version"
 *      runtime error that only ever fires on the iOS fallback path.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  isIosUserAgent,
  needsPdfInlineFallback,
} from "../pdf-inline-support";

const HANDLER_SOURCE = readFileSync(
  "src/app/artifacts/[id]/handlers/pdf-handler.tsx",
  "utf-8",
);
const VIEWER_SOURCE = readFileSync(
  "src/app/artifacts/[id]/handlers/pdf-fallback-viewer.tsx",
  "utf-8",
);
const PAGE_SOURCE = readFileSync("src/app/artifacts/[id]/page.tsx", "utf-8");

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.51 Mobile/15E148 Safari/604.1",
  ipadLegacy:
    "Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36",
} as const;

describe("isIosUserAgent", () => {
  it("matches iPhone / iPad / iOS-Chrome user agents", () => {
    expect(isIosUserAgent(UA.iphoneSafari)).toBe(true);
    expect(isIosUserAgent(UA.iphoneChrome)).toBe(true);
    expect(isIosUserAgent(UA.ipadLegacy)).toBe(true);
  });

  it("does not match desktop user agents (incl. real Macs)", () => {
    expect(isIosUserAgent(UA.macSafari)).toBe(false);
    expect(isIosUserAgent(UA.windowsChrome)).toBe(false);
    expect(isIosUserAgent(UA.androidChrome)).toBe(false);
  });
});

describe("needsPdfInlineFallback", () => {
  it("always falls back on iOS UAs — even if pdfViewerEnabled claims true", () => {
    // pdfViewerEnabled reflects top-level PDF navigation, which iOS
    // Safari HAS; the <embed> path is what is broken. iOS wins first.
    for (const pdfViewerEnabled of [true, false, undefined]) {
      expect(
        needsPdfInlineFallback({
          userAgent: UA.iphoneSafari,
          maxTouchPoints: 5,
          pdfViewerEnabled,
        }),
      ).toBe(true);
    }
  });

  it("falls back on iPadOS masquerading as a Mac (touch points)", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.macSafari,
        maxTouchPoints: 5,
        pdfViewerEnabled: true,
      }),
    ).toBe(true);
  });

  it("keeps the embed on a real Mac (no touch points)", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.macSafari,
        maxTouchPoints: 0,
        pdfViewerEnabled: true,
      }),
    ).toBe(false);
  });

  it("keeps the embed on desktop Chrome with an inline viewer", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.windowsChrome,
        maxTouchPoints: 0,
        pdfViewerEnabled: true,
      }),
    ).toBe(false);
  });

  it("ignores touch points on non-Macintosh UAs (touch-screen Windows laptop)", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.windowsChrome,
        maxTouchPoints: 10,
        pdfViewerEnabled: true,
      }),
    ).toBe(false);
  });

  it("falls back when the engine reports pdfViewerEnabled === false (Android Chrome)", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.androidChrome,
        maxTouchPoints: 5,
        pdfViewerEnabled: false,
      }),
    ).toBe(true);
  });

  it("keeps the embed when the capability signal is absent on desktop", () => {
    expect(
      needsPdfInlineFallback({
        userAgent: UA.windowsChrome,
        maxTouchPoints: 0,
        pdfViewerEnabled: undefined,
      }),
    ).toBe(false);
  });
});

describe("pdf-handler source contract", () => {
  it("keeps the lightweight <embed type=\"application/pdf\"> path", () => {
    expect(HANDLER_SOURCE).toMatch(/<embed/);
    expect(HANDLER_SOURCE).toMatch(/type="application\/pdf"/);
    expect(HANDLER_SOURCE).toMatch(/aria-label="PDF preview"/);
  });

  it("loads the fallback via next/dynamic with ssr disabled (heavy-components guardrail)", () => {
    expect(HANDLER_SOURCE).toMatch(/^"use client";/);
    expect(HANDLER_SOURCE).toMatch(
      /dynamic\(\(\) => import\("\.\/pdf-fallback-viewer"\)/,
    );
    expect(HANDLER_SOURCE).toMatch(/ssr:\s*false/);
  });

  it("does NOT statically import react-pdf (the chunk must stay lazy)", () => {
    expect(HANDLER_SOURCE).not.toMatch(/from\s+"react-pdf"/);
    expect(HANDLER_SOURCE).not.toMatch(/from\s+"pdfjs-dist/);
  });
});

describe("pdf-fallback-viewer source contract", () => {
  it("serves the pdf.js worker from our origin via import.meta.url — never a CDN", () => {
    expect(VIEWER_SOURCE).toMatch(
      /new URL\(\s*"pdfjs-dist\/build\/pdf\.worker\.min\.mjs",\s*import\.meta\.url,?\s*\)/,
    );
    // No remote-code escape hatch anywhere in the viewer (the app is
    // auth-gated; preview traffic must not leave the origin).
    expect(VIEWER_SOURCE).not.toMatch(/https?:\/\//);
  });

  it("evaluates the Promise.withResolvers polyfill before react-pdf", () => {
    const polyfillAt = VIEWER_SOURCE.indexOf(
      '"./pdf-promise-with-resolvers-polyfill"',
    );
    const reactPdfAt = VIEWER_SOURCE.indexOf('"react-pdf"');
    expect(polyfillAt).toBeGreaterThan(-1);
    expect(reactPdfAt).toBeGreaterThan(-1);
    expect(polyfillAt).toBeLessThan(reactPdfAt);
  });

  it("bounds per-page work: layers off, devicePixelRatio capped, batched pages", () => {
    expect(VIEWER_SOURCE).toMatch(/renderTextLayer=\{false\}/);
    expect(VIEWER_SOURCE).toMatch(/renderAnnotationLayer=\{false\}/);
    expect(VIEWER_SOURCE).toMatch(/MAX_DEVICE_PIXEL_RATIO/);
    expect(VIEWER_SOURCE).toMatch(/PAGE_BATCH_SIZE/);
  });

  it("offers the passed-in download link on failure (never derives /content)", () => {
    expect(VIEWER_SOURCE).toMatch(/downloadHref/);
    expect(VIEWER_SOURCE).not.toMatch(/replace\([^)]*preview/);
  });
});

describe("page wiring", () => {
  it("seeds the handler with the request-UA fallback hint and the download href", () => {
    expect(PAGE_SOURCE).toMatch(/isIosUserAgent\(/);
    expect(PAGE_SOURCE).toMatch(/initialFallback=\{pdfInitialFallback\}/);
    expect(PAGE_SOURCE).toMatch(/downloadHref=\{downloadHref as string\}/);
  });
});

describe("pdfjs-dist version parity", () => {
  it("root pin equals react-pdf's own pdfjs-dist dependency", () => {
    const rootPkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies: Record<string, string>;
    };
    const reactPdfPkg = JSON.parse(
      readFileSync("node_modules/react-pdf/package.json", "utf-8"),
    ) as { dependencies: Record<string, string> };
    const rootPin = rootPkg.dependencies["pdfjs-dist"];
    const reactPdfPin = reactPdfPkg.dependencies["pdfjs-dist"];
    expect(rootPin).toBeTruthy();
    expect(reactPdfPin).toBeTruthy();
    expect(rootPin).toBe(reactPdfPin);
  });
});
