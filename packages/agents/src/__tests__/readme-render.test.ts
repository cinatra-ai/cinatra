// Unit tests for the sanitized README
// Markdown renderer. The renderer is the security boundary between
// untrusted vendor input (the README in the package tarball) and the
// detail screen's `dangerouslySetInnerHTML` call site.
//
// Coverage targets:
//   - Empty/null input → empty string (caller hides the section)
//   - Standard Markdown renders to expected HTML
//   - Raw HTML in input is stripped (vendor can't inject markup)
//   - Unsafe link schemes (javascript:, data:) lose their href
//   - Unsafe image schemes drop the <img> and surface a placeholder
//   - Safe links gain rel="noopener noreferrer nofollow" + target="_blank"
//   - The `cinatra:` install deep-link scheme is allowed
//   - `demoteHeadings` demotes every heading one level (h1→h2 … h5→h6, h6
//     capped at h6) without weakening sanitization; default keeps author
//     levels (the artifact markdown preview relies on that)

import { describe, expect, it } from "vitest";
import { renderReadmeMarkdown } from "../readme-render";

describe("renderReadmeMarkdown — graceful empty handling", () => {
  it("returns empty string for null input", () => {
    expect(renderReadmeMarkdown(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(renderReadmeMarkdown(undefined)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(renderReadmeMarkdown("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(renderReadmeMarkdown("   \n\t\n   ")).toBe("");
  });
});

describe("renderReadmeMarkdown — standard Markdown", () => {
  it("renders headings", () => {
    const html = renderReadmeMarkdown("# Hello\n\n## Subhead");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<h2");
    expect(html).toContain("Subhead");
  });

  it("renders paragraphs", () => {
    const html = renderReadmeMarkdown("First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("renders inline code", () => {
    const html = renderReadmeMarkdown("Use `cinatra install` to add it.");
    expect(html).toContain("<code>cinatra install</code>");
  });

  it("renders fenced code blocks", () => {
    const html = renderReadmeMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders unordered lists", () => {
    const html = renderReadmeMarkdown("- one\n- two\n- three");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });
});

describe("renderReadmeMarkdown — security boundary", () => {
  it("strips raw HTML script tags from vendor input", () => {
    const malicious = "# Title\n\n<script>alert('xss')</script>\n\nNormal text.";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert('xss')");
    expect(html).toContain("Normal text.");
  });

  it("strips raw HTML iframe tags", () => {
    const malicious = "<iframe src=\"https://evil.example.com\"></iframe>";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example.com");
  });

  it("strips inline event handlers", () => {
    const malicious = "<img src=\"x\" onerror=\"alert(1)\" />";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("drops the href when the link scheme is javascript:", () => {
    const malicious = "[Click me](javascript:alert(1))";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=\"javascript:");
    // The link text is preserved in a <span> so context isn't lost.
    expect(html).toContain("Click me");
  });

  it("drops the href when the link scheme is data:", () => {
    const malicious = "[Click](data:text/html,<script>alert(1)</script>)";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<script");
  });

  it("drops the img src when the scheme is javascript:", () => {
    const malicious = "![bad](javascript:alert(1))";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("[image]");
  });

  it("drops the img src when the scheme is data:", () => {
    const malicious = "![bad](data:image/png;base64,AAAA)";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("<img");
  });
});

describe("renderReadmeMarkdown — link-body recursion (XSS regression guard)", () => {
  it("strips raw HTML inside link text (recursive render through constrained renderer)", () => {
    const malicious = "[<img src=x onerror=alert(1)>text](https://example.com)";
    const html = renderReadmeMarkdown(malicious);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
    expect(html).toContain("https://example.com");
    expect(html).toContain("text");
  });

  it("strips <script> tags inside link text (script body text may remain as harmless prose)", () => {
    const malicious = "[<script>alert(1)</script>label](https://example.com)";
    const html = renderReadmeMarkdown(malicious);
    // The actual XSS surface is the `<script>` open tag — once that's stripped
    // by the html() override, the residual text content of the script body is
    // harmless prose (not executed). The link href is safe + the label survives.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("label");
  });
});

describe("renderReadmeMarkdown — URL strictness", () => {
  it("drops relative-path link hrefs (no implicit base resolution)", () => {
    const html = renderReadmeMarkdown("[admin](/configuration)");
    expect(html).not.toContain('href="/configuration"');
    expect(html).toContain("admin");
  });

  it("drops protocol-relative link hrefs", () => {
    const html = renderReadmeMarkdown("[evil](//evil.example/path)");
    expect(html).not.toContain('href="//evil.example/path"');
    expect(html).not.toContain("evil.example");
    expect(html).toContain("evil");
  });

  it("drops ../ traversal link hrefs", () => {
    const html = renderReadmeMarkdown("[traverse](../wp-admin/foo)");
    expect(html).not.toContain('href="../wp-admin/foo"');
    expect(html).toContain("traverse");
  });

  it("drops relative image srcs", () => {
    const html = renderReadmeMarkdown("![rel](/assets/img.png)");
    expect(html).not.toContain('src="/assets/img.png"');
    expect(html).toContain("[image]");
  });
});

describe("renderReadmeMarkdown — heading demotion (demoteHeadings)", () => {
  const demote = { demoteHeadings: true } as const;

  it("demotes h1 to h2 so a README title never collides with the page <h1>", () => {
    const html = renderReadmeMarkdown("# Title", demote);
    expect(html).toContain("<h2>Title</h2>");
    expect(html).not.toContain("<h1");
  });

  it("demotes every level by exactly one (h1→h2 … h5→h6)", () => {
    const html = renderReadmeMarkdown(
      "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five",
      demote,
    );
    expect(html).toContain("<h2>One</h2>");
    expect(html).toContain("<h3>Two</h3>");
    expect(html).toContain("<h4>Three</h4>");
    expect(html).toContain("<h5>Four</h5>");
    expect(html).toContain("<h6>Five</h6>");
    expect(html).not.toContain("<h1");
  });

  it("caps demotion at h6 (h6 stays h6)", () => {
    const html = renderReadmeMarkdown("###### Deep", demote);
    expect(html).toContain("<h6>Deep</h6>");
    expect(html).not.toContain("<h7");
  });

  it("preserves inline markdown inside demoted headings", () => {
    const html = renderReadmeMarkdown("# Hello **world** `code`", demote);
    expect(html).toContain("<h2>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("keeps stripping raw HTML inside demoted heading text (sanitization not weakened)", () => {
    const html = renderReadmeMarkdown("# Title <script>alert(1)</script>", demote);
    expect(html).toContain("<h2>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
  });

  it("keeps dropping unsafe link hrefs inside demoted heading text", () => {
    const html = renderReadmeMarkdown("## [click](javascript:alert(1))", demote);
    expect(html).toContain("<h3>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("does not demote by default (artifact markdown preview keeps author levels)", () => {
    const html = renderReadmeMarkdown("# Title\n\n## Subhead");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Subhead</h2>");
  });

  it("still returns empty string for empty input when demotion is requested", () => {
    expect(renderReadmeMarkdown("", demote)).toBe("");
    expect(renderReadmeMarkdown(null, demote)).toBe("");
  });
});

describe("renderReadmeMarkdown — safe URL handling", () => {
  it("preserves https:// links with rel + target", () => {
    const html = renderReadmeMarkdown("[example](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("example");
  });

  it("preserves http:// links with rel + target", () => {
    const html = renderReadmeMarkdown("[plain](http://example.com)");
    expect(html).toContain('href="http://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("preserves mailto: links", () => {
    const html = renderReadmeMarkdown("[reach out](mailto:support@example.com)");
    expect(html).toContain('href="mailto:support@example.com"');
  });

  it("preserves cinatra: install deep-links", () => {
    const html = renderReadmeMarkdown("[Install](cinatra://install/@acme/widget@1.0.0)");
    expect(html).toContain('href="cinatra://install/@acme/widget@1.0.0"');
    expect(html).toContain("Install");
  });

  it("preserves https:// image src with lazy-loading + no-referrer", () => {
    const html = renderReadmeMarkdown("![logo](https://example.com/logo.png)");
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('alt="logo"');
  });
});
