import { describe, expect, it } from "vitest";

import {
  isSafePortletUrl,
  isUrlBearingKey,
  hasDangerousScheme,
  validatePortletLinks,
  collectUnsafeDashboardLinks,
} from "../portlet-link-guard";

// Build obfuscation chars without embedding escape sequences in source.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);

describe("isSafePortletUrl", () => {
  it("allows http/https/mailto/tel + relative/anchor/query/protocol-relative", () => {
    for (const ok of [
      "https://example.com/x",
      "http://example.com",
      "mailto:a@b.com",
      "tel:+15551234",
      "/relative/path",
      "./rel",
      "../up",
      "#anchor",
      "?q=1",
      "//cdn.example.com/a.png",
      "",
    ]) {
      expect(isSafePortletUrl(ok), ok).toBe(true);
    }
  });

  it("rejects javascript:/data:/vbscript:/blob:/file: and any unknown scheme", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "blob:https://x/1",
      "file:///etc/passwd",
      "chrome://settings",
      "customscheme:whatever",
    ]) {
      expect(isSafePortletUrl(bad), bad).toBe(false);
    }
  });

  it("defeats whitespace/control-char obfuscation of the scheme (browser strips them)", () => {
    expect(isSafePortletUrl("java" + TAB + "script:alert(1)")).toBe(false);
    expect(isSafePortletUrl("java" + LF + "script:alert(1)")).toBe(false);
    expect(isSafePortletUrl("  javascript:alert(1)")).toBe(false);
    expect(isSafePortletUrl(TAB + "javascript:alert(1)")).toBe(false);
  });
});

describe("isUrlBearingKey", () => {
  it("matches url-bearing keys (case-insensitive, suffix-aware)", () => {
    for (const k of ["href", "url", "URL", "uri", "src", "link", "redirect", "action", "imageUrl", "icon_url", "logo.href", "links", "urls", "to", "website", "callbackUrl", "webhook"]) {
      expect(isUrlBearingKey(k), k).toBe(true);
    }
  });
  it("does NOT match plain text keys", () => {
    for (const k of ["title", "label", "value", "name", "description", "curl", "source"]) {
      expect(isUrlBearingKey(k), k).toBe(false);
    }
  });
});

describe("hasDangerousScheme (always-scan denylist)", () => {
  it("flags javascript/vbscript/data/blob with a payload", () => {
    for (const bad of ["javascript:x", "vbscript:x", "data:text/html,x", "blob:https://x/1"]) {
      expect(hasDangerousScheme(bad), bad).toBe(true);
    }
  });
  it("flags javascript/vbscript WITH a space after the colon (leading whitespace is valid JS)", () => {
    expect(hasDangerousScheme("javascript: alert(1)")).toBe(true);
    expect(hasDangerousScheme("vbscript: msgbox(1)")).toBe(true);
    // and even under a non-url key via the walk:
    expect(validatePortletLinks({ instanceId: "x", config: { foo: "javascript: alert(1)" } })).toHaveLength(1);
  });
  it("does NOT flag prose (scheme word with no colon-payload)", () => {
    for (const ok of ["Data: 42", "Note: see below", "javascript is fun", "https://ok.com", "/rel"]) {
      expect(hasDangerousScheme(ok), ok).toBe(false);
    }
  });
});

describe("validatePortletLinks", () => {
  it("flags an unsafe URL under a url-bearing key anywhere in config", () => {
    const errs = validatePortletLinks({ instanceId: "x", config: { href: "javascript:alert(1)" } });
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("portlet_unsafe_url");
    expect(errs[0].message).toContain("javascript");
  });

  it("flags unsafe URLs nested in arrays + objects", () => {
    const errs = validatePortletLinks({
      instanceId: "x",
      config: { items: [{ label: "ok", url: "data:text/html,x" }], nested: { link: "vbscript:x" } },
    });
    expect(errs.length).toBe(2);
  });

  it("passes a clean config (safe links + plain text)", () => {
    const errs = validatePortletLinks({
      instanceId: "x",
      config: { title: "javascript is a language", href: "https://ok.com", items: [{ label: "hi", value: 3 }] },
    });
    expect(errs).toEqual([]);
  });

  it("FLAGS a dangerous scheme even under a NON-url key (denylist defense-in-depth)", () => {
    const errs = validatePortletLinks({ instanceId: "x", config: { title: "javascript:stealCookies()" } });
    expect(errs).toHaveLength(1);
  });

  it("does NOT flag prose that merely contains a scheme word (no colon+payload)", () => {
    expect(validatePortletLinks({ instanceId: "x", config: { title: "javascript is a language" } })).toEqual([]);
    expect(validatePortletLinks({ instanceId: "x", config: { note: "Data: 42 rows returned" } })).toEqual([]);
  });

  it("catches an unsafe value under a PLURAL url key (links[])", () => {
    const errs = validatePortletLinks({ instanceId: "x", config: { links: ["/ok", "javascript:alert(1)"] } });
    expect(errs).toHaveLength(1);
  });
});

describe("collectUnsafeDashboardLinks", () => {
  it("aggregates errors across portlets, prefixed with instanceId", () => {
    const errs = collectUnsafeDashboardLinks({
      portlets: [
        { instanceId: "good", config: { href: "/ok" } },
        { instanceId: "bad", config: { href: "javascript:alert(1)" } },
      ],
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('portlet "bad"');
  });
});
