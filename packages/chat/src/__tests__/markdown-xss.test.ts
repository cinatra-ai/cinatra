// Regression tests for the chat markdown renderer, which is fed
// untrusted assistant/tool output and the result is injected via
// dangerouslySetInnerHTML. The custom marked renderer replaces marked's
// default text-escaping / URL-cleaning renderers, so these tests pin that the
// three injection vectors stay closed:
//   1. inline code (codespan) must not emit live HTML,
//   2. raw inline/block HTML must be escaped, not passed through,
//   3. link hrefs must be scheme-allowlisted (no javascript:/data:/etc.).
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown-render";

// detectWidgets is required by renderMarkdown; a no-op detector keeps the test
// focused on the markdown→HTML escaping behavior.
const noWidgets = () => [];
const render = (md: string) => renderMarkdown(md, "github-light", noWidgets);

describe("renderMarkdown XSS hardening (#269)", () => {
  it("escapes raw HTML inside inline code (codespan)", () => {
    const html = render("`<img src=x onerror=alert(1)>`");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("onerror=alert(1)&gt;");
  });

  it("escapes raw inline HTML so it cannot execute", () => {
    const html = render("hello <img src=x onerror=alert(1)> world");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes raw block-level HTML", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: link hrefs (renders text without an anchor href)", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<a[^>]*href/i);
    expect(html).toContain("click me");
  });

  it("drops data: link hrefs", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  it("strips control chars that mask a javascript: scheme", () => {
    const html = render("[x](java\tscript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  it("rejects protocol-relative (//host) hrefs as cross-origin", () => {
    const html = render("[x](//evil.example/path)");
    expect(html).not.toContain("//evil.example");
    expect(html).not.toMatch(/<a[^>]*href/i);
    expect(html).toContain("x");
  });

  it("rejects backslash protocol-relative link hrefs (browser-normalized to //)", () => {
    // Browsers normalize a leading backslash pair (and mixed slash/backslash)
    // to "//", so these resolve cross-origin and must NOT pass as internal.
    for (const href of ["/\\evil.example/path", "\\\\evil.example/path", "/\\/evil.example"]) {
      const html = render(`[x](${href})`);
      expect(html, `href=${JSON.stringify(href)}`).not.toMatch(/<a[^>]*href/i);
      expect(html).not.toContain("evil.example");
      expect(html).toContain("x");
    }
  });

  it("rejects backslash protocol-relative image src (browser-normalized to //)", () => {
    for (const src of ["/\\evil.example/a.png", "\\\\evil.example/a.png", "/\\/evil.example"]) {
      const html = render(`![x](${src})`);
      expect(html, `src=${JSON.stringify(src)}`).not.toMatch(/<img[^>]*src/i);
      expect(html).not.toContain("evil.example");
    }
  });

  it("keeps root-relative internal links as anchors", () => {
    const html = render("[home](/campaigns/123)");
    expect(html).toContain('href="/campaigns/123"');
  });

  it("keeps safe http(s) links as anchors", () => {
    const html = render("[ok](https://example.com/page)");
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("keeps mailto links as anchors", () => {
    const html = render("[mail](mailto:a@b.com)");
    expect(html).toContain('href="mailto:a@b.com"');
  });

  it("does not let a crafted link text/href break out of the href attribute", () => {
    const html = render('[t](https://example.com/"><script>alert(1)</script>)');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("drops javascript: image src (renders alt text, no img)", () => {
    const html = render("![x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<img[^>]*src/i);
    expect(html).toContain("x");
  });

  it("drops data: image src", () => {
    const html = render("![x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toMatch(/<img[^>]*src/i);
  });

  it("strips control chars masking a javascript: image src", () => {
    const html = render("![x](java\tscript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).not.toMatch(/<img[^>]*src/i);
  });

  it("rejects protocol-relative (//host) image src as cross-origin", () => {
    const html = render("![x](//evil.example/a.png)");
    expect(html).not.toContain("//evil.example");
    expect(html).not.toMatch(/<img[^>]*src/i);
  });

  it("keeps safe http(s) image src as an img element", () => {
    const html = render("![alt text](https://example.com/a.png)");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="alt text"');
  });

  it("escapes a quote in the image alt so it cannot break out of the attribute", () => {
    // A double-quote inside the alt text must be entity-escaped, otherwise it
    // would close the alt attribute and allow injecting a live handler.
    const html = render('![he said "hi"](https://example.com/a.png)');
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/a\.png"/i);
    // The literal quote must NOT appear unescaped inside the alt attribute.
    expect(html).toContain("&quot;");
    expect(html).toContain('alt="he said &quot;hi&quot;"');
  });

  it("renders ordinary fenced code escaped (existing guard intact)", () => {
    const html = render("```\n<b>not bold</b>\n```");
    expect(html).not.toContain("<b>not bold</b>");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
  });
});
