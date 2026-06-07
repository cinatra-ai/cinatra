import { describe, it, expect } from "vitest";

import {
  BridgeUrlError,
  isYouTubeUrlStrict,
  stripBrackets,
  validateAddress,
  validateExternalUrl,
} from "../_url-validation";

describe("validateExternalUrl — scheme allowlist", () => {
  it("accepts https://", () => {
    expect(() => validateExternalUrl("https://example.com/foo")).not.toThrow();
  });

  it.each([
    ["http://example.com/", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
    ["file:///etc/passwd", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
    ["data:text/plain,abc", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
    ["ftp://example.com/", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
    ["gopher://example.com/", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
    ["blob:https://example.com/x", "BRIDGE-URL-SCHEME-NOT-ALLOWED"],
  ])("rejects non-https scheme %s", (rawUrl, expectedCode) => {
    let caught: unknown;
    try {
      validateExternalUrl(rawUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeUrlError);
    expect((caught as BridgeUrlError).code).toBe(expectedCode);
  });

  it("rejects unparseable URL", () => {
    expect(() => validateExternalUrl("not a url")).toThrow(BridgeUrlError);
  });
});

describe("validateExternalUrl — hostname blocklist", () => {
  it.each([
    "https://localhost/",
    "https://Localhost/",
    "https://LOCALHOST/",
    "https://localhost.localdomain/",
    "https://metadata.google.internal/",
    "https://metadata.aws/",
    "https://metadata.azure.com/",
  ])("rejects blocked hostname %s", (rawUrl) => {
    let caught: unknown;
    try {
      validateExternalUrl(rawUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeUrlError);
    expect((caught as BridgeUrlError).code).toBe("BRIDGE-URL-HOST-BLOCKED");
  });
});

describe("validateExternalUrl — IPv4 literal rejection (upfront, no DNS)", () => {
  it.each([
    "https://0.0.0.0/",
    "https://127.0.0.1/",
    "https://127.255.255.255/",
    "https://10.0.0.1/",
    "https://10.255.255.255/",
    "https://100.64.0.1/",
    "https://169.254.169.254/",
    "https://172.16.0.1/",
    "https://172.31.255.255/",
    "https://192.0.0.1/",
    "https://192.168.1.1/",
    "https://198.18.0.1/",
    "https://224.0.0.1/",
    "https://240.0.0.1/",
  ])("rejects IPv4 literal in blocked range %s", (rawUrl) => {
    let caught: unknown;
    try {
      validateExternalUrl(rawUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeUrlError);
    expect((caught as BridgeUrlError).code).toBe("BRIDGE-URL-HOST-BLOCKED");
  });

  it("accepts public IPv4 literal", () => {
    expect(() => validateExternalUrl("https://8.8.8.8/")).not.toThrow();
  });
});

describe("validateExternalUrl — IPv6 literal rejection", () => {
  // These literals must reject WITHOUT any DNS lookup — the upfront
  // bracket-stripping + net.isIP + validateAddress path is the only enforcement
  // hook for IP literals (Node may skip DNS at connect time).
  it.each([
    "https://[::1]/",
    "https://[::]/",
    "https://[fc00::1]/",
    "https://[fdab::1]/",
    "https://[fe80::1]/",
    "https://[ff00::1]/",
    "https://[64:ff9b::1]/",
    "https://[100::1]/",
    "https://[2001:db8::1]/",
    "https://[2001::1]/",
    // 6to4-encoded loopback: 2002:7f00:0001::  (7f00:0001 == 127.0.0.1)
    "https://[2002:7f00:0001::]/",
    // IPv4-mapped IPv6 — loopback embedded
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
  ])("rejects IPv6 literal in blocked range %s", (rawUrl) => {
    let caught: unknown;
    try {
      validateExternalUrl(rawUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeUrlError);
    expect((caught as BridgeUrlError).code).toBe("BRIDGE-URL-HOST-BLOCKED");
  });

  it("accepts public IPv6 literal (Google DNS)", () => {
    expect(() => validateExternalUrl("https://[2001:4860:4860::8888]/"))
      .not.toThrow();
  });
});

describe("validateAddress — IPv4-mapped IPv6 unmaps and re-checks", () => {
  it("rejects ::ffff:127.0.0.1 via IPv4-mapped path", () => {
    expect(validateAddress("::ffff:127.0.0.1", 6)).toBe(false);
  });
  it("rejects ::ffff:7f00:1 (URL-canonicalized form)", () => {
    expect(validateAddress("::ffff:7f00:1", 6)).toBe(false);
  });
  it("rejects ::ffff:10.0.0.1", () => {
    expect(validateAddress("::ffff:10.0.0.1", 6)).toBe(false);
  });
  it("accepts ::ffff:8.8.8.8 (public IPv4 via mapped)", () => {
    expect(validateAddress("::ffff:8.8.8.8", 6)).toBe(true);
  });
});

describe("validateAddress — 6to4 embedded IPv4 re-checks", () => {
  it("rejects 2002:7f00:0001:: (encoded 127.0.0.1)", () => {
    expect(validateAddress("2002:7f00:0001::", 6)).toBe(false);
  });
  it("rejects 2002:0a00:0001:: (encoded 10.0.0.1)", () => {
    expect(validateAddress("2002:0a00:0001::", 6)).toBe(false);
  });
  // 2002::/16 itself is in the blocked IPv6 set, so any 6to4 address is blocked.
  // The embedded-IPv4 check is defense-in-depth.
  it("blocks all 6to4 by prefix even with public embedded IPv4", () => {
    expect(validateAddress("2002:0808:0808::", 6)).toBe(false);
  });
});

describe("stripBrackets", () => {
  it.each([
    ["[::1]", "::1"],
    ["[fc00::1]", "fc00::1"],
    ["::1", "::1"],
    ["example.com", "example.com"],
    ["[]", ""],
    ["[", "["],
  ])("normalizes %s → %s", (input, expected) => {
    expect(stripBrackets(input)).toBe(expected);
  });
});

describe("isYouTubeUrlStrict (host-allowlist)", () => {
  it.each([
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
  ])("accepts %s", (rawUrl) => {
    expect(isYouTubeUrlStrict(rawUrl)).toBe(true);
  });

  it.each([
    "https://youtube.com.evil.example/x",
    "https://evil.example/youtube.com/x",
    "https://fake-youtube.com/x",
    "https://yt.example/x",
    "not a url",
  ])("rejects spoofing/non-youtube %s", (rawUrl) => {
    expect(isYouTubeUrlStrict(rawUrl)).toBe(false);
  });
});
