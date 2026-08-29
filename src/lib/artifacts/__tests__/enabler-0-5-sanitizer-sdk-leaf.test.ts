/**
 * ENABLER 0.5 — the markdown sanitizer as an SDK leaf entry. The contract-level
 * acceptance test (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE: "The markdown sanitizer reachable from an
 * extension, as an SDK leaf entry, with one implementation shared with the
 * existing readme surface" — fixing that "an extension may depend only on the
 * SDK leaf, and the sanitizer lives in a host extension".
 *
 * TWO THINGS ARE UNDER TEST, and the second is the one that rots first:
 *   1. the leaf sanitizes (the whole boundary, case by case);
 *   2. the README surface renders through THAT leaf and not a second copy.
 */
import { describe, expect, it } from "vitest";

import {
  isSafeMarkdownUrl,
  renderSanitizedMarkdown,
} from "@cinatra-ai/sdk-extensions/markdown-sanitizer";
import { renderReadmeMarkdown } from "@cinatra-ai/agents/readme-render";

describe("enabler 0.5 — the leaf IS the sanitization boundary", () => {
  it("emits no raw HTML, whatever the author writes", () => {
    const out = renderSanitizedMarkdown("<script>alert(1)</script>\n\nhello");
    expect(out).not.toContain("<script");
    expect(out).toContain("hello");
  });

  it("strips raw HTML nested inside link text — the recursion, not the token string", () => {
    const out = renderSanitizedMarkdown("[<script>x</script>](https://example.com)");
    expect(out).not.toContain("<script");
    expect(out).toContain('href="https://example.com"');
  });

  it("keeps the link TEXT but drops an unsafe href", () => {
    const out = renderSanitizedMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("refuses a relative or protocol-relative address — untrusted markdown gains no host context", () => {
    expect(isSafeMarkdownUrl("/configuration")).toBe(false);
    expect(isSafeMarkdownUrl("//evil.example/x")).toBe(false);
    expect(isSafeMarkdownUrl("../wp-admin/foo")).toBe(false);
    expect(isSafeMarkdownUrl("https://example.com")).toBe(true);
    expect(isSafeMarkdownUrl("mailto:a@b.c")).toBe(true);
    expect(isSafeMarkdownUrl("cinatra:install/pkg")).toBe(true);
    expect(isSafeMarkdownUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });

  it("drops a non-http image source and leaves a readable placeholder", () => {
    const out = renderSanitizedMarkdown("![alt](data:image/png;base64,AAAA)");
    expect(out).not.toContain("data:image");
    expect(out).toContain("[image]");
  });

  it("renders nothing at all for absent or blank input", () => {
    expect(renderSanitizedMarkdown(null)).toBe("");
    expect(renderSanitizedMarkdown(undefined)).toBe("");
    expect(renderSanitizedMarkdown("   \n ")).toBe("");
  });

  it("demotes headings only when asked, and demotion does not relax the boundary", () => {
    expect(renderSanitizedMarkdown("# Title")).toContain("<h1>");
    const demoted = renderSanitizedMarkdown("# Title <script>x</script>", { demoteHeadings: true });
    expect(demoted).toContain("<h2>");
    expect(demoted).not.toContain("<script");
  });
});

describe("enabler 0.5 — ONE implementation, shared with the existing readme surface", () => {
  it("renders the README through the leaf, byte for byte", () => {
    const readme = [
      "# Extension",
      "",
      "A [link](https://example.com), a [bad one](javascript:alert(1)),",
      "an ![image](data:image/png;base64,AAAA) and <b>raw markup</b>.",
    ].join("\n");
    for (const options of [undefined, { demoteHeadings: true }, { demoteHeadings: false }]) {
      expect(renderReadmeMarkdown(readme, options)).toBe(renderSanitizedMarkdown(readme, options));
    }
  });

  it("keeps the README surface's own absent-input contract", () => {
    expect(renderReadmeMarkdown(null)).toBe("");
    expect(renderReadmeMarkdown("")).toBe("");
  });
});
